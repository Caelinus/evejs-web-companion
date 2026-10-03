"use strict";

// ── The game client: the companion speaking the game port itself ─────────────
//
// Talks to the eve.js game port (26000) the way the retail client does: the
// same framing, handshake, login and call packets (CCP calls this protocol
// machoNet). It exists for the few actions the web gateway does not carry and
// the retail client performs over this connection - today, moving planetary
// goods into a customs office (invbroker.ImportExportWithPlanet on the bound
// customs office inventory).
//
// ⚠ ONE CHARACTER, ONE CONNECTION. The server lets a character be in game on
// one session only (charService SelectCharacterID, loginTakeoverEnabled): a
// character selected here EVICTS the gateway's bridge session for it, and the
// gateway selecting it again evicts this one. Eviction runs the normal logoff,
// which in space is an emergency-warp logoff - so this client is only ever used
// for a DOCKED pilot, for a few seconds, and closed straight after.
//
// ⚠ NO CREDENTIALS, BY DESIGN. eve.js is a single-player server with no real
// credentials: it does not check the password hash (devSkipPasswordValidation)
// and accepts an unencrypted session ("placebo"). The companion's gateway login
// already relies on exactly that; this client sends an empty hash for the same
// reason, on the operator's explicit say-so.
//
// The wire format (all read from the server's own code, src/network/tcp):
//   frame      4-byte little-endian length, then a marshal stream
//   handshake  server version tuple -> client echoes it -> (None, "VK", key)
//              -> ("placebo", {}) -> server "OK CC"
//              -> (None, {user_name, user_password_hash, user_languageid})
//              -> server 2, then CryptoServerHandshake -> client result tuple
//              -> server CryptoHandshakeAck {session_init, user_clientid, ...}
//   calls      CallReq object: [6, src, dest, userID, payload, None, ...]
//              src  address client [2, clientID, callID, None]
//              dest address any    [8, service, None]
//              payload [[0|1, substream([remote, method, args, kwargs])]]
//              where remote is 1 for a service call, or the bound object's
//              "N=..." id for a call on a bound object.
//   replies    CallRsp (type 7), matched by the callID in its dest address;
//              ErrorResponse (type 15) for a refusal. Everything else the
//              server pushes (notifications, session changes) is ignored.

const net = require("net");
const { marshalEncode, marshalDecode, wrapPacket } = require("./gameProtocol/marshal");

const DEFAULT_GAME_PORT = 26000;
const CALL_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;

const PACKET_CALL_REQ = 6;
const PACKET_CALL_RSP = 7;
const PACKET_ERROR_RESPONSE = 15;

const PACKET_NAMESPACE = "carbon.common.script.net.machoNetPacket";

function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && (value.type === "wstring" || value.type === "token")) return value.value;
  return null;
}

function dictValue(dict, key) {
  if (!dict || dict.type !== "dict" || !Array.isArray(dict.entries)) return undefined;
  for (const [k, v] of dict.entries) {
    if (text(k) === key) return v;
  }
  return undefined;
}

function numberOf(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && value.type === "long") return Number(value.value);
  return null;
}

function address(tuple) {
  return { type: "object", name: `${PACKET_NAMESPACE}.MachoAddress`, args: tuple };
}

function unwrapObject(value) {
  return value && typeof value === "object" && value.type === "object" && Array.isArray(value.args) ? value.args : value;
}

function unwrapSubstream(value) {
  return value && typeof value === "object" && value.type === "substream" ? value.value : value;
}

/** The best one-line reading of an exception payload the server raised. */
function describeError(payload) {
  const seen = [];
  const walk = (value, depth) => {
    if (depth > 6 || seen.length > 8 || value === null || value === undefined) return;
    const t = text(value);
    if (t !== null) {
      if (t.length > 0 && t.length < 120) seen.push(t);
      return;
    }
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
    else if (typeof value === "object") {
      if (value.type === "object") {
        walk(value.name, depth + 1);
        walk(value.args, depth + 1);
      } else if (value.type === "dict") value.entries.forEach(([k, v]) => { walk(k, depth + 1); walk(v, depth + 1); });
      else if (value.type === "substream" || value.type === "substruct") walk(value.value, depth + 1);
      else if (value.type === "list") value.items.forEach((entry) => walk(entry, depth + 1));
    }
  };
  walk(payload, 0);
  return seen.length > 0 ? seen.join(" / ") : "no reason given";
}

/** A refusal the server sent back for a call (an ErrorResponse). */
class GameCallError extends Error {
  constructor(method, payload) {
    super(`${method} was refused by the server: ${describeError(payload)}`);
    this.code = "GAME_CALL_REFUSED";
    this.payload = payload;
  }
}

class GameClient {
  constructor({ host, port = DEFAULT_GAME_PORT, connectImpl = net.connect } = {}) {
    this.host = host;
    this.port = port;
    this.connectImpl = connectImpl;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.inbox = [];
    this.pending = new Map();
    this.nextCallID = 1;
    this.clientID = null;
    this.userID = null;
    this.closed = false;
    this.handshakeDone = false;
  }

  /** Connect, run the handshake and log in as `userName`. */
  async login(userName) {
    await this._connect();
    const version = await this._readRaw();
    if (!Array.isArray(version) || version.length < 6) {
      throw new Error("The game server did not open with a version exchange.");
    }
    // Echo the server's own version tuple: it compares birthday and protocol
    // version only, and only to warn.
    this._writeRaw(version.slice(0, 6));
    this._writeRaw([null, "VK", ""]);
    this._writeRaw(["placebo", { type: "dict", entries: [] }]);
    const ok = text(await this._readRaw());
    if (ok !== "OK CC") throw new Error(`The game server refused the connection (${ok ?? "no answer"}).`);
    this._writeRaw([null, {
      type: "dict",
      entries: [
        ["user_name", userName],
        ["user_password_hash", ""],
        ["user_languageid", "EN"],
      ],
    }]);
    const passwordVersion = await this._readRaw();
    if (passwordVersion !== 2) {
      throw new Error(`The game server refused the login: ${describeError(passwordVersion)}`);
    }
    const serverHandshake = await this._readRaw();
    if (!Array.isArray(serverHandshake)) {
      throw new Error(`The game server refused the login: ${describeError(serverHandshake)}`);
    }
    this._writeRaw(["", "", null]);
    const ack = await this._readRaw();
    const sessionInit = dictValue(ack, "session_init");
    this.userID = numberOf(dictValue(sessionInit, "userid"));
    const clientID = dictValue(ack, "user_clientid");
    this.clientID = clientID && typeof clientID === "object" && clientID.type === "long" ? clientID.value : numberOf(clientID);
    if (this.userID === null || this.clientID === null) {
      throw new Error("The game server's login answer carried no session.");
    }
    this.handshakeDone = true;
    // From here every frame is a game packet; replies are routed by callID.
    for (const value of this.inbox.splice(0)) this._dispatch(value);
  }

  /** Call `service.method(args, kwargs)` and return its result. */
  call(service, method, args = [], kwargs = null) {
    return this._call({ service, remote: 1, bound: false, method, args, kwargs });
  }

  /** Call `method` on a bound object, by the "N=..." id `bind` returned. */
  callBound(objectID, method, args = [], kwargs = null) {
    return this._call({ service: null, remote: objectID, bound: true, method, args, kwargs });
  }

  /**
   * Bind `service`'s object for `bindParams` (MachoBindObject) and return its id.
   * The reply is [substruct(substream([oid, timestamp])), nestedResult].
   */
  async bind(service, bindParams) {
    const reply = await this.call(service, "MachoBindObject", [bindParams, null]);
    const tuple = unwrapObject(reply);
    const head = Array.isArray(tuple) ? tuple[0] : null;
    const inner = head && typeof head === "object" && head.type === "substruct" ? head.value : head;
    const pair = unwrapSubstream(inner);
    const oid = Array.isArray(pair) ? text(pair[0]) : text(pair);
    if (!oid || !oid.startsWith("N=")) {
      throw new Error(`${service} did not return a bound object.`);
    }
    return oid;
  }

  close() {
    this._rejectWaiters(new Error("The game connection closed."));
    // A finished hop must release its local connection even when the peer
    // keeps its writable side open after our FIN.
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }

  _rejectWaiters(error) {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.inbox = [];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = this.connectImpl({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`The game server at ${this.host}:${this.port} did not answer.`));
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        this._rejectWaiters(error);
        reject(error);
      });
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => {
        clearTimeout(timer);
        const error = new Error("The game connection closed.");
        this._rejectWaiters(error);
        reject(error);
      });
      this.socket = socket;
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const frame = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value;
      try {
        value = marshalDecode(frame);
      } catch {
        continue;
      }
      if (!this.handshakeDone) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.inbox.push(value);
      } else {
        this._dispatch(value);
      }
    }
  }

  _readRaw() {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift());
    if (this.closed) return Promise.reject(new Error("The game connection closed."));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(new Error("The game server stopped answering the handshake."));
      }, CALL_TIMEOUT_MS);
      this.waiters.push(waiter);
    });
  }

  _writeRaw(value) {
    this.socket.write(wrapPacket(marshalEncode(value)));
  }

  _call({ service, remote, bound, method, args, kwargs }) {
    if (!this.handshakeDone || this.closed) {
      return Promise.reject(new Error("The game connection is not logged in."));
    }
    const callID = this.nextCallID++;
    const body = [remote, method, args, kwargs ?? { type: "dict", entries: [] }];
    const packet = {
      type: "object",
      name: `${PACKET_NAMESPACE}.CallReq`,
      args: [
        PACKET_CALL_REQ,
        address([2, typeof this.clientID === "bigint" ? { type: "long", value: this.clientID } : this.clientID, callID, null]),
        address([8, service, null]),
        this.userID,
        [[bound ? 1 : 0, { type: "substream", value: body }]],
        null,
        null, null, null, null, null, null, null, null,
      ],
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callID);
        reject(new Error(`${method} got no answer from the game server.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(callID, { method, resolve, reject, timer });
      this._writeRaw(packet);
    });
  }

  _dispatch(value) {
    const tuple = unwrapObject(value);
    if (!Array.isArray(tuple) || tuple.length < 5) return;
    const type = tuple[0];
    if (type !== PACKET_CALL_RSP && type !== PACKET_ERROR_RESPONSE) return;
    const dest = unwrapObject(tuple[2]);
    const callID = Array.isArray(dest) ? numberOf(dest[2]) : null;
    const waiter = callID === null ? undefined : this.pending.get(callID);
    if (!waiter) return;
    this.pending.delete(callID);
    clearTimeout(waiter.timer);
    const payload = tuple[4];
    if (type === PACKET_ERROR_RESPONSE) {
      // [errorType, errorCode, [substream(exception)]]
      const detail = Array.isArray(payload) ? payload[2] : payload;
      waiter.reject(new GameCallError(waiter.method, detail));
      return;
    }
    const result = Array.isArray(payload) ? unwrapSubstream(payload[0]) : unwrapSubstream(payload);
    waiter.resolve(result);
  }
}

/**
 * The game server's host. Defaults to the gateway's own host - they are the same
 * process - exactly as the XMPP chat client resolves its host. EVEJS_GAME_HOST
 * and EVEJS_GAME_PORT override it.
 */
function gameEndpoint(env = process.env) {
  const explicitHost = String(env.EVEJS_GAME_HOST || "").trim();
  let host = explicitHost;
  if (!host) {
    try {
      host = new URL(String(env.EVEJS_GATEWAY_URL || "")).hostname || "127.0.0.1";
    } catch {
      host = "127.0.0.1";
    }
  }
  const port = Number(env.EVEJS_GAME_PORT) || DEFAULT_GAME_PORT;
  return { host, port };
}

module.exports = { GameClient, GameCallError, gameEndpoint, describeError, dictValue, text, numberOf };
