"use strict";

// Local + Corp chat over XMPP — the transport the retail client itself uses.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// R7 chat used to be two gateway routes (`POST /_evejs-web/v1/chat/read` and
// `/chat/send`) backed by `gatewayServices/webChatGatewayService.js`. EveJS
// v0.12.8 deleted all three, and in the same drop marked every browser-backed
// session as having LEFT Local:
//
//     // Browser-backed sessions still participate in ordinary online, station,
//     // and space authority, but the companion no longer participates in Local
//     // or Corp chat.
//     session._localChatDeparted = true;      // evejsWebGatewayRuntime.js
//
// So the BFF's chat reads began 404ing every two seconds, `chatMessages` was
// permanently empty, and every chat-ordered companion behaviour (`follow`,
// `stop`, `target`, `salvage`, `loot`, `destination`) went silently dead.
//
// The chat itself did not go anywhere. `chatHub.js` says where it lives:
// "Local/corp/fleet chat runs over XMPP MUC (member roster + messages) and the
// protobuf local-chat gateway". The XMPP stub server
// (`services/chat/xmppStubServer.js`) is untouched, listens on 5222, and is the
// same door the game client comes through. This module is a small XMPP client
// that walks through it as the held session's own character.
//
// ⚠ THAT CHOICE IS THE POINT, NOT AN IMPLEMENTATION DETAIL. Restoring the
// deleted routes as a fork patch would work until the next vendor drop deletes
// them again — which is exactly what just happened. Speaking the protocol the
// retail client speaks depends on nothing this project can be denied.
//
// ─── THE FOUR FACTS THIS MODULE IS BUILT ON ─────────────────────────────────
//
// All four are the stub's own behaviour, read from its source and confirmed
// against a live server's `logs/xmpp-stub.log`:
//
//   1. SASL PLAIN is accepted WITHOUT CHECKING THE PASSWORD, and the JID's local
//      part IS the identity: `findSessionForClient` parses it as a character id
//      and looks up that character's live session (`xmppStubServer.js:546`).
//      ⚠ THEREFORE THIS MODULE MUST ONLY EVER CONNECT AS THE CHARACTER THE
//      HELD SESSION ALREADY OWNS. The caller passes that id; it must never come
//      from anything a browser sent. There is no credential to get wrong here,
//      which is precisely why the identity must be got right.
//
//   2. `local`, `corp` and `fleet` are ACCEPTED AS ROOM ALIASES and resolved
//      server-side from the session (`normalizeRoomJid`, `:389`). So this module
//      never computes a room name: it addresses `local@conference.<domain>` and
//      the server answers with the real room, which is what keeps wormhole,
//      Triglavian and no-local systems right without copying `channelRules.js`.
//
//   3. A MUC nick IS the sender's character id, filled in server-side from the
//      session (`handleGroupMessage`, `:2876`). That is the unspoofable key the
//      companion's chat-order gate needs — the same property the old backlog
//      read had, over a different transport.
//
//   4. Joining un-does the v0.12.8 departure by itself: the join path calls
//      `chatRuntime.joinLocalLsc(session)`, whose first act is
//      `markSessionLocalDeparted(session, false)` (`chatRuntime.js:1498`). The
//      companion is back in Local because it joined Local, not because anything
//      was patched.
//
// ⚠ AND THAT IS VISIBLE IN THE WORLD. A joined companion appears in other
// players' Local member list and its presence is broadcast to the room, exactly
// like any other pilot in the system. That is the honest state of affairs — the
// ship IS there — but it is a change other people can see, not an internal one.
//
// ─── WHAT THIS MODULE DOES NOT DO ───────────────────────────────────────────
//
// No reconnect storm, no queue, no offline buffer. A session that cannot reach
// the chat server reports that to its caller and the caller fails the read, so
// "chat is unreadable" stays distinguishable from "nobody said anything" — the
// distinction the 404s destroyed for two silent weeks.

const net = require("net");
const tls = require("tls");

class XmppChatError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "XmppChatError";
    this.code = options.code || "CHAT_TRANSPORT_ERROR";
    this.statusCode = options.statusCode || 502;
  }
}

const DEFAULT_XMPP_PORT = 5222;
const DEFAULT_XMPP_DOMAIN = "localhost";
// The resource the retail client binds is `eveclient`. This one is deliberately
// different: nothing keys on it, and a transcript that says which connection is
// the companion is worth more than a perfect impersonation.
const XMPP_RESOURCE = "evejs-web-companion";
const CONNECT_TIMEOUT_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 4000;
// How long a join is given to come back with its self-presence before a read
// gives up waiting and answers with whatever it has. A join is a round trip to
// a process on the same bridge network; this is generous.
const JOIN_TIMEOUT_MS = 2500;
const PING_INTERVAL_MS = 30_000;
// Per room. Local is chatty and the readers only ever want the tail: the Chat
// panel renders the last page and the companion filters by freshness.
const MAX_BUFFERED_MESSAGES = 200;
// A failed connect is not retried on the very next tick. The companion reads
// chat every two seconds, and a chat server that is down should cost one
// connect attempt every few seconds, not thirty.
const RECONNECT_COOLDOWN_MS = 5000;
// Corp rooms deliver backlog on join (Local does not — `handleJoinPresence`
// skips history for local rooms, matching retail, where Local has no history).
const CORP_HISTORY_SECONDS = 900;

function trimmedEnv(name) {
  return String(process.env[name] || "").trim();
}

/**
 * The chat server's host.
 *
 * Defaults to the gateway's own host because they are the same process: the
 * gateway URL is how this BFF is already told where EveJS lives (a container
 * DNS name under Docker, a loopback address natively), and the XMPP listener is
 * a second port on it. `EVEJS_XMPP_HOST` overrides for the split case.
 */
function xmppHost() {
  const explicit = trimmedEnv("EVEJS_XMPP_HOST");
  if (explicit) {
    return explicit;
  }
  const gatewayUrl = trimmedEnv("EVEJS_GATEWAY_URL");
  if (gatewayUrl) {
    try {
      return new URL(gatewayUrl).hostname || "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }
  return "127.0.0.1";
}

function xmppPort() {
  const configured = Number(trimmedEnv("EVEJS_XMPP_PORT"));
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_XMPP_PORT;
}

/**
 * The XMPP domain and the conference (MUC) domain.
 *
 * ⚠ THESE MUST MATCH THE SERVER'S `config/server.json` `xmpp` BLOCK, because
 * the stub compares conference JIDs against its own configured domain
 * (`isXmppConferenceJid`). The defaults here are that file's defaults
 * (`xmppDomain: "localhost"`, and an empty `xmppConferenceDomain` meaning
 * `conference.<xmppDomain>`), so a stock server needs no configuration at all.
 */
function xmppDomain() {
  return trimmedEnv("EVEJS_XMPP_DOMAIN") || DEFAULT_XMPP_DOMAIN;
}

function xmppConferenceDomain() {
  return trimmedEnv("EVEJS_XMPP_CONFERENCE_DOMAIN") || `conference.${xmppDomain()}`;
}

/**
 * Open the socket the chat edge is actually listening on.
 *
 * ⚠ IT IS TLS, AND NOT STARTTLS. `edge/chat/chatEdgeProcess.worker.js` builds
 * the listener with `tls.createServer({...readXmppTlsCredentials(), minVersion:
 * "TLSv1"})` and the boot log calls it `tls://<host>:<port>`, so the very first
 * byte on the wire is a ClientHello — a plaintext stream header gets the
 * connection dropped with nothing sent back and nothing written to
 * `logs/xmpp-stub.log`, because the edge never hands the socket to the stub at
 * all. (That is exactly how this was found: a plaintext probe against the live
 * server closed silently while the game client's own traffic kept flowing.)
 *
 * ⚠ THE CERTIFICATE IS NOT VERIFIED, DELIBERATELY. It is the server's own
 * locally generated credential (`edge/chat/xmppTlsCredentials.js`) for a
 * listener reached over loopback or the compose bridge, and there is no CA in
 * this picture to check it against — the retail client accepts the same
 * credential. `EVEJS_XMPP_TLS_REJECT_UNAUTHORIZED=1` turns verification on for a
 * deployment that has put a real certificate there.
 *
 * `EVEJS_XMPP_TLS=0` drops to a plain TCP socket. That exists for the tests
 * (whose fake stub would otherwise need a certificate fixture to maintain) and
 * for a server old enough to predate the TLS edge; the framing above it is
 * identical either way.
 */
function connectChatSocket(host, port, onReady) {
  if (trimmedEnv("EVEJS_XMPP_TLS") === "0") {
    return net.createConnection({ host, port }, onReady);
  }
  return tls.connect(
    {
      host,
      port,
      servername: xmppDomain(),
      rejectUnauthorized: trimmedEnv("EVEJS_XMPP_TLS_REJECT_UNAUTHORIZED") === "1",
    },
    onReady,
  );
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(xml, name) {
  const match = new RegExp(`\\b${name}=['"]([^'"]*)['"]`, "i").exec(xml);
  return match ? decodeXml(match[1]) : "";
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The next complete stanza in `buffer`, or null.
 *
 * ⚠ DELIBERATELY THE SAME SHAPE AS THE SERVER'S OWN SPLITTER
 * (`extractNextReadyStanza`): earliest match wins, and everything before it is
 * dropped. Both ends of this connection are generated by hand rather than by an
 * XML library, so tolerating a frame nobody can parse — by skipping it — beats
 * stalling the stream on it.
 *
 * ⚠ SELF-CLOSING IS TESTED ON THE OPENING TAG ALONE. The server's presence
 * frames carry `<item ... />` children, so a pattern that accepted the first
 * `/>` it found would cut a presence in half and lose its MUC payload.
 */
function nextStanza(buffer) {
  let best = null;
  for (const name of ["message", "presence", "iq", "success", "failure"]) {
    const open = new RegExp(`<${name}\\b[^>]*>`, "i").exec(buffer);
    if (!open) {
      continue;
    }
    const selfClosing = open[0].endsWith("/>");
    let xml = null;
    if (selfClosing) {
      xml = open[0];
    } else {
      const close = buffer.indexOf(`</${name}>`, open.index + open[0].length);
      if (close === -1) {
        continue;
      }
      xml = buffer.slice(open.index, close + name.length + 3);
    }
    if (!best || open.index < best.index) {
      best = { index: open.index, xml };
    }
  }
  return best;
}

/**
 * One character's chat connection: the socket, the rooms it has joined, and the
 * tail of what was said in them.
 *
 * One of these belongs to one held bridge session and lives as long as it does.
 * It is opened lazily — a session nobody reads chat for never connects, and so
 * never appears in Local.
 */
class XmppChatSession {
  constructor(options = {}) {
    this.characterID = positiveInt(options.characterID);
    if (!this.characterID) {
      throw new XmppChatError("A chat session needs the held character id.", {
        code: "CHAT_NO_CHARACTER",
        statusCode: 500,
      });
    }
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.socket = null;
    this.buffer = "";
    this.ready = false;
    this.readyPromise = null;
    this.closed = false;
    this.lastConnectFailureAtMs = 0;
    this.lastConnectError = null;
    this.pingTimer = null;
    this.stanzaCounter = 0;
    // channel -> { roomJid, roomName, joinedAtMs, joinedFor, pending }
    this.rooms = new Map();
    // roomName -> Map(characterID -> { name, corporationID, allianceID })
    this.rosters = new Map();
    // roomName -> [{ characterID, characterName, message, createdAtMs }]
    this.messages = new Map();
  }

  nextID(prefix) {
    this.stanzaCounter += 1;
    return `${prefix}-${this.stanzaCounter}`;
  }

  jid() {
    return `${this.characterID}@${xmppDomain()}/${XMPP_RESOURCE}`;
  }

  aliasJid(channel) {
    return `${channel}@${xmppConferenceDomain()}/${this.characterID}`;
  }

  write(xml) {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    this.socket.write(xml);
    return true;
  }

  /**
   * Connect, authenticate, bind, and come up ready — or reject.
   *
   * Concurrent callers share one attempt: the companion's tick and the Chat
   * panel's poll can land in the same millisecond, and two half-open
   * handshakes as the same character would leave a ghost in the room list.
   */
  ensureReady() {
    if (this.closed) {
      return Promise.reject(
        new XmppChatError("This chat session has been released.", {
          code: "CHAT_SESSION_CLOSED",
          statusCode: 409,
        }),
      );
    }
    if (this.ready) {
      return Promise.resolve(this);
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    const sinceFailureMs = Date.now() - this.lastConnectFailureAtMs;
    if (this.lastConnectFailureAtMs > 0 && sinceFailureMs < RECONNECT_COOLDOWN_MS) {
      // ⚠ THE LAST ERROR, NOT A NEW GENERIC ONE. A caller that is told "chat is
      // not reachable" every two seconds should be told WHY the one attempt
      // that ran actually failed.
      return Promise.reject(
        this.lastConnectError ||
          new XmppChatError("The chat server is not reachable.", {
            code: "CHAT_TRANSPORT_UNAVAILABLE",
          }),
      );
    }
    this.readyPromise = this.handshake()
      .then((session) => {
        this.readyPromise = null;
        this.lastConnectFailureAtMs = 0;
        this.lastConnectError = null;
        return session;
      })
      .catch((error) => {
        this.readyPromise = null;
        this.lastConnectFailureAtMs = Date.now();
        this.lastConnectError = error;
        this.teardownSocket();
        throw error;
      });
    return this.readyPromise;
  }

  handshake() {
    return new Promise((resolve, reject) => {
      const host = xmppHost();
      const port = xmppPort();
      const domain = xmppDomain();
      let stage = "connect";
      let settled = false;
      // ⚠ THE READY CALLBACK, NOT A `connect` LISTENER. On a TLS socket the
      // stream is not usable until `secureConnect`, and `connect` fires before
      // the handshake — a stream header written there goes out before the
      // cipher is up. Both connectors take this callback and fire it on their
      // own ready event, which is the one line that keeps the plain and TLS
      // paths identical above the socket.
      const socket = connectChatSocket(host, port, () => {
        stage = "stream";
        this.write(
          `<?xml version='1.0'?><stream:stream to='${escapeXml(domain)}' ` +
            "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>",
        );
      });
      this.socket = socket;
      this.buffer = "";
      socket.setKeepAlive(true, 15_000);
      socket.setEncoding("utf8");

      const fail = (code, message) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new XmppChatError(message, { code }));
      };

      const timer = setTimeout(() => {
        fail(
          "CHAT_TRANSPORT_TIMEOUT",
          `The chat server at ${host}:${port} did not finish the handshake (stage ${stage}).`,
        );
      }, CONNECT_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS);

      // ⚠ ONLY THE CURRENT SOCKET MAY TEAR THIS SESSION DOWN. A dropped socket
      // emits `error` AND then `close`, and a reconnect can have happened in
      // between — a second, late event from the dead socket would otherwise
      // clear `ready` and the room list belonging to the live one, leaving a
      // session that is connected and joined but believes it is neither.
      const goneIfCurrent = () => {
        if (this.socket === socket) {
          this.onSocketGone();
        }
      };
      socket.on("error", (error) => {
        fail(
          "CHAT_TRANSPORT_UNAVAILABLE",
          `The chat server at ${host}:${port} is not reachable: ${error.message}`,
        );
        goneIfCurrent();
      });
      socket.on("close", () => {
        fail(
          "CHAT_TRANSPORT_UNAVAILABLE",
          `The chat server at ${host}:${port} closed the connection during the handshake.`,
        );
        goneIfCurrent();
      });

      socket.on("data", (chunk) => {
        this.buffer += chunk;
        if (settled) {
          this.drain();
          return;
        }
        // ⚠ ONE HANDSHAKE STEP PER REPLY, NEVER PIPELINED. The stub clears its
        // own read buffer at each stage (`client.buffer = ""`), so a client that
        // sent the next step before the previous reply arrived would have that
        // step thrown away and hang.
        if (stage === "stream" && this.buffer.includes("</stream:features>")) {
          if (!/PLAIN/i.test(this.buffer)) {
            fail("CHAT_TRANSPORT_REFUSED", "The chat server did not offer SASL PLAIN.");
            return;
          }
          this.buffer = "";
          stage = "auth";
          // ⚠ AN EMPTY PASSWORD, ON PURPOSE. `parsePlainAuth` reads the
          // authorization identity and ignores the secret entirely — the JID's
          // local part is the whole of the identity. Sending a made-up secret
          // would imply a check that does not exist; the real protection is
          // that `characterID` comes from the held session and from nowhere
          // else.
          const payload = Buffer.from(`\u0000${this.characterID}\u0000`, "utf8").toString(
            "base64",
          );
          this.write(
            `<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${payload}</auth>`,
          );
          return;
        }
        if (stage === "auth" && this.buffer.includes("<success")) {
          this.buffer = "";
          stage = "stream2";
          this.write(
            `<?xml version='1.0'?><stream:stream to='${escapeXml(domain)}' ` +
              "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>",
          );
          return;
        }
        if (stage === "auth" && this.buffer.includes("<failure")) {
          fail("CHAT_TRANSPORT_REFUSED", "The chat server refused the SASL exchange.");
          return;
        }
        if (stage === "stream2" && this.buffer.includes("</stream:features>")) {
          this.buffer = "";
          stage = "bind";
          this.write(
            `<iq type='set' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>` +
              `<resource>${escapeXml(XMPP_RESOURCE)}</resource></bind></iq>`,
          );
          return;
        }
        if (stage === "bind" && this.buffer.includes("</bind>")) {
          this.buffer = "";
          stage = "session";
          this.write(
            "<iq type='set' id='sess'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>",
          );
          return;
        }
        if (stage === "session" && /<iq[^>]*type=['"]result['"]/i.test(this.buffer)) {
          this.buffer = "";
          stage = "ready";
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          this.startPing();
          this.log(
            `[chat] connected to ${host}:${port} as character ${this.characterID}`,
          );
          resolve(this);
        }
      });
    });
  }

  startPing() {
    this.stopPing();
    // `handleReadyIq` answers `urn:xmpp:ping` with a result, so this is a real
    // round trip rather than a write into a socket that may already be dead.
    this.pingTimer = setInterval(() => {
      this.write(
        `<iq type='get' id='${this.nextID("ping")}' to='${escapeXml(xmppDomain())}'>` +
          "<ping xmlns='urn:xmpp:ping'/></iq>",
      );
    }, PING_INTERVAL_MS);
    if (typeof this.pingTimer.unref === "function") {
      this.pingTimer.unref();
    }
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  onSocketGone() {
    this.ready = false;
    this.stopPing();
    // ⚠ THE ROOMS GO WITH THE SOCKET. MUC membership is per connection, so a
    // reconnect has to join again — remembering a room jid across a dropped
    // socket would leave a session that believes it is listening to a room the
    // server has already forgotten it left.
    for (const room of this.rooms.values()) {
      if (!room.pending) {
        continue;
      }
      const pending = room.pending;
      room.pending = null;
      pending.reject(
        new XmppChatError("The chat connection dropped before the join completed.", {
          code: "CHAT_TRANSPORT_UNAVAILABLE",
        }),
      );
    }
    this.rooms.clear();
  }

  teardownSocket() {
    this.stopPing();
    this.ready = false;
    this.rooms.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  drain() {
    while (true) {
      const stanza = nextStanza(this.buffer);
      if (!stanza) {
        break;
      }
      this.buffer = this.buffer.slice(stanza.index + stanza.xml.length);
      const xml = stanza.xml;
      if (/^<presence\b/i.test(xml)) {
        this.onPresence(xml);
      } else if (/^<message\b/i.test(xml)) {
        this.onMessage(xml);
      }
      // Everything else (iq results, ping answers, disco) needs no reaction:
      // this client asks no questions whose answers it acts on.
    }
  }

  /**
   * A room occupant arrived, left, or was announced when we joined.
   *
   * The MUC nick is the character id (fact 3), and `<eve_user_data info=...>`
   * carries the same `[charID, name, typeID, gender, ownerNameID]` tuple the
   * retail client reads names from — so the roster this builds is the server's
   * own answer, not a guess assembled from message senders.
   */
  onPresence(xml) {
    const from = attr(xml, "from");
    const slash = from.indexOf("/");
    if (slash === -1) {
      return;
    }
    const roomJid = from.slice(0, slash);
    const nick = from.slice(slash + 1);
    const characterID = positiveInt(nick);
    const roomName = roomJid.split("@")[0];
    if (!roomName) {
      return;
    }
    // Our own join answer names the room the server RESOLVED our alias to.
    // That is the only way this client ever learns a real room name.
    this.resolveJoin(attr(xml, "id"), roomJid, roomName);
    if (!characterID) {
      return;
    }
    if (!this.rosters.has(roomName)) {
      this.rosters.set(roomName, new Map());
    }
    const roster = this.rosters.get(roomName);
    if (/\btype=['"]unavailable['"]/i.test(xml)) {
      roster.delete(characterID);
      return;
    }
    let name = "";
    const info = attr(xml, "info");
    if (info) {
      try {
        const parsed = JSON.parse(info);
        if (Array.isArray(parsed) && typeof parsed[1] === "string") {
          name = parsed[1];
        }
      } catch {
        // A name we cannot read is not a reason to drop an occupant; the id is
        // the part every caller keys on.
      }
    }
    roster.set(characterID, {
      name: name || `Character ${characterID}`,
      corporationID: positiveInt(attr(xml, "corpid")) || null,
      allianceID: positiveInt(attr(xml, "allianceid")) || null,
    });
  }

  /**
   * Somebody spoke.
   *
   * ⚠ THE ARRIVAL TIME IS THE TIMESTAMP, AND IT IS HONEST. The stub sends no
   * `<delay>`, so there is no server clock on the wire to read. Live delivery is
   * immediate, which makes arrival time accurate to the millisecond for every
   * line said while this session was listening — and the companion's freshness
   * window is the only consumer that cares.
   *
   * Local has no join history at all (`handleJoinPresence` delivers backlog only
   * for non-local rooms, matching retail), so for the channel the chat orders
   * live on there is no older-than-we-know case to mis-stamp. A corp room does
   * replay its backlog on join, and those lines land stamped with the join
   * instant — which is why the companion reads Local and not Corp.
   */
  onMessage(xml) {
    const from = attr(xml, "from");
    const slash = from.indexOf("/");
    if (slash === -1) {
      return;
    }
    const roomJid = from.slice(0, slash);
    const nick = from.slice(slash + 1);
    const roomName = roomJid.split("@")[0];
    const bodyMatch = /<body>([\s\S]*?)<\/body>/i.exec(xml);
    if (!roomName || !bodyMatch) {
      return;
    }
    const body = decodeXml(bodyMatch[1]);
    let characterID = positiveInt(nick);
    let text = body;
    if (!characterID && nick === "admin") {
      // The room's own voice: MOTD, join notices, refusals. It arrives as a
      // JSON admin command rather than as prose.
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        return;
      }
      if (!payload || payload.cmd !== "speak") {
        return;
      }
      characterID = positiveInt(payload.charid) || 1;
      text = String(payload.messageText || "");
    }
    if (!text || !characterID) {
      // ⚠ NO SPEAKER, NO MESSAGE. Every line the stub sends carries either a
      // character id or the `admin` voice as its nick, so this cannot happen
      // against a server behaving as read — and if it ever does, an entry
      // attributed to "Character 0" would be this client inventing a speaker
      // for a line whose sender it could not read. The order gate keys on that
      // id; it must never be filled in with a guess.
      return;
    }
    const roster = this.rosters.get(roomName);
    const known = roster ? roster.get(characterID) : null;
    const entry = {
      characterID,
      characterName: known ? known.name : `Character ${characterID}`,
      message: text,
      createdAtMs: Date.now(),
    };
    if (!this.messages.has(roomName)) {
      this.messages.set(roomName, []);
    }
    const log = this.messages.get(roomName);
    log.push(entry);
    if (log.length > MAX_BUFFERED_MESSAGES) {
      log.splice(0, log.length - MAX_BUFFERED_MESSAGES);
    }
  }

  /**
   * Match a self-presence to the join that asked for it, BY STANZA ID.
   *
   * ⚠ THE ID IS THE ONLY HONEST CORRELATION. `handleJoinPresence` echoes the
   * join presence's own `id` back on the self-presence it answers with, while
   * every other presence it sends carries a server-minted id. Correlating on
   * anything else — "the first pending join", or the room name's prefix —
   * guesses, and guesses wrong the moment Local and Corp are joined together:
   * an alias resolves to a room name this client deliberately cannot predict,
   * so there is nothing about `local_30000142` that says which join it answers
   * except the id it came back with.
   */
  resolveJoin(stanzaID, roomJid, roomName) {
    if (!stanzaID) {
      return;
    }
    for (const [channel, room] of this.rooms.entries()) {
      if (!room.pending || room.pending.joinID !== stanzaID) {
        continue;
      }
      room.roomJid = roomJid;
      room.roomName = roomName;
      room.joinedAtMs = Date.now();
      // ⚠ THE SYSTEM THIS ROOM IS FOR COMES BACK FROM THE SERVER, not from what
      // the caller thought it was when it asked. A join issued before the held
      // session knew its system would otherwise latch `joinedFor: 0` and the
      // move check below could never fire again.
      if (channel === "local") {
        room.joinedFor = positiveInt(roomName.split("_").pop());
      }
      const pending = room.pending;
      room.pending = null;
      this.rooms.set(channel, room);
      pending.resolve(room);
      return;
    }
  }

  /**
   * Make sure this session is in `channel`'s room, and that it is the RIGHT
   * room.
   *
   * ⚠ `solarSystemID` IS A CHANGE DETECTOR, NEVER A ROOM NAME. The server
   * resolves `local@conference` from the session itself, which is what keeps
   * wormhole/Triglavian/no-local systems correct without this file knowing the
   * first thing about them. But retail's own auto-move
   * (`chatHub.moveLocalSession`) rides on `sendSessionChange`, which is a
   * capture stub for a browser-backed session and never fires — so a companion
   * that jumps would sit in its old system's Local for ever unless something
   * noticed. The held session's tracked system id is that something: when it
   * changes, leave and re-join, and the server picks the new room.
   */
  async ensureChannel(channel, context = {}) {
    await this.ensureReady();
    const solarSystemID = positiveInt(context.solarSystemID);
    const existing = this.rooms.get(channel) || null;
    if (existing && !existing.pending) {
      const moved =
        channel === "local" &&
        solarSystemID > 0 &&
        existing.joinedFor > 0 &&
        existing.joinedFor !== solarSystemID;
      if (!moved) {
        return existing;
      }
      this.leaveRoom(existing);
    }
    if (existing && existing.pending) {
      return existing.pending.promise;
    }
    return this.joinChannel(channel, solarSystemID);
  }

  joinChannel(channel, solarSystemID) {
    let resolve = null;
    let reject = null;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const joinID = this.nextID("join");
    const room = {
      channel,
      roomJid: null,
      roomName: null,
      alias: this.aliasJid(channel),
      joinedAtMs: 0,
      joinedFor: solarSystemID,
      pending: { promise, resolve, reject, joinID },
    };
    this.rooms.set(channel, room);
    const history =
      channel === "local"
        ? ""
        : `<history seconds='${CORP_HISTORY_SECONDS}'/>`;
    this.write(
      `<presence id='${escapeXml(joinID)}' to='${escapeXml(this.aliasJid(channel))}'>` +
        `<x xmlns='http://jabber.org/protocol/muc'>${history}</x></presence>`,
    );
    const timer = setTimeout(() => {
      if (room.pending) {
        const pending = room.pending;
        room.pending = null;
        this.rooms.delete(channel);
        pending.reject(
          new XmppChatError(`The chat server did not answer the ${channel} join.`, {
            code: "CHAT_JOIN_TIMEOUT",
          }),
        );
      }
    }, JOIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return promise.finally(() => clearTimeout(timer));
  }

  leaveRoom(room) {
    if (!room || !room.roomJid) {
      return;
    }
    this.write(
      `<presence type='unavailable' to='${escapeXml(room.roomJid)}/${this.characterID}'/>`,
    );
    this.rooms.delete(room.channel);
    // The tail of what was said in a system this pilot has left is not this
    // pilot's chat any more.
    this.messages.delete(room.roomName);
    this.rosters.delete(room.roomName);
  }

  /**
   * The channel as the browser's decoder expects it: roster, message tail, and
   * the room the server resolved.
   */
  snapshot(channel, limit) {
    const room = this.rooms.get(channel) || null;
    const roomName = room && room.roomName ? room.roomName : null;
    const roster = roomName ? this.rosters.get(roomName) || new Map() : new Map();
    const log = roomName ? this.messages.get(roomName) || [] : [];
    const capped = Math.max(1, Math.min(Number(limit) || 50, MAX_BUFFERED_MESSAGES));
    // The room name carries the id the room is FOR — `local_<solarSystemID>`,
    // `corp_<corporationID>` — so this is read back from the server's answer
    // rather than echoed from what we asked for.
    const suffix = roomName ? positiveInt(roomName.split("_").pop()) : 0;
    return {
      channel,
      roomName,
      solarSystemID: channel === "local" ? suffix || null : null,
      corporationID: channel === "corp" ? suffix || null : null,
      roster: [...roster.entries()].map(([characterID, member]) => ({
        characterID,
        name: member.name,
        corporationID: member.corporationID,
        allianceID: member.allianceID,
        solarSystemID: channel === "local" ? suffix || null : null,
      })),
      messages: log.slice(-capped),
    };
  }

  async read(channel, context = {}) {
    await this.ensureChannel(channel, context);
    return this.snapshot(channel, context.limit);
  }

  async send(channel, message, context = {}) {
    const room = await this.ensureChannel(channel, context);
    const text = String(message || "").trim();
    if (!text) {
      throw new XmppChatError("A chat message cannot be empty.", {
        code: "CHAT_EMPTY_MESSAGE",
        statusCode: 400,
      });
    }
    this.write(
      `<message type='groupchat' id='${this.nextID("msg")}' ` +
        `to='${escapeXml(room.roomJid || room.alias)}'><body>${escapeXml(text)}</body></message>`,
    );
    // ⚠ PROVISIONAL, AND SAID SO BY BEING BUILT HERE. The server echoes the
    // real line back to every occupant including us, and that echo — not this
    // object — is what lands in the buffer a later read returns. This is the
    // acknowledgement that the write went out, nothing more.
    return {
      channel,
      roomName: room.roomName,
      sent: true,
      entry: {
        characterID: this.characterID,
        characterName:
          (this.rosters.get(room.roomName) || new Map()).get(this.characterID)?.name ||
          `Character ${this.characterID}`,
        message: text,
        createdAtMs: Date.now(),
      },
    };
  }

  close() {
    this.closed = true;
    // Politeness, not bookkeeping: the server drops us from every room on the
    // socket's own close (`removeClientFromRooms`), so this only spares it the
    // half-open reap and makes the transcript read like a client leaving.
    this.write("</stream:stream>");
    this.teardownSocket();
    this.messages.clear();
    this.rosters.clear();
  }
}

function createXmppChatSession(options) {
  return new XmppChatSession(options);
}

module.exports = {
  createXmppChatSession,
  XmppChatSession,
  XmppChatError,
  // Exported for the tests, which stand up a fake stub server on an ephemeral
  // port and need to address it the way the real one is addressed.
  xmppHost,
  xmppPort,
  xmppDomain,
  xmppConferenceDomain,
};
