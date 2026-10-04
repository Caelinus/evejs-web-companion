"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { GameClient, GameCallError } = require("../src/gameClient");
const { marshalEncode, marshalDecode, wrapPacket } = require("../src/gameProtocol/marshal");

const frame = (value) => wrapPacket(marshalEncode(value));
const dict = (entries) => ({ type: "dict", entries });
const address = (args) => ({ type: "object", name: "carbon.common.script.net.machoNetPacket.MachoAddress", args });
const immediate = () => new Promise((resolve) => setImmediate(resolve));

async function listener(context, onConnection, options = {}) {
  const sockets = new Set();
  const server = net.createServer(options, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test("close cancels a stalled handshake without waiting for the peer's FIN", { timeout: 2000 }, async (context) => {
  let accepted;
  const connected = new Promise((resolve) => { accepted = resolve; });
  const port = await listener(context, (socket) => accepted(socket), { allowHalfOpen: true });
  const client = new GameClient({ host: "127.0.0.1", port });
  context.after(() => client.close());
  let result = null;
  const login = client.login("fixture").catch((error) => { result = error; });
  const peer = await connected;
  try {
    await immediate();
    client.close();
    await immediate();
    assert.match(result?.message ?? "still waiting", /connection closed/i);
    assert.equal(client.waiters.length, 0);
  } finally {
    peer.destroy();
    await login;
  }
});

test("a handshake timeout removes its waiter before a later frame arrives", { timeout: 2000 }, async (context) => {
  const port = await listener(context, () => {});
  const client = new GameClient({ host: "127.0.0.1", port });
  context.after(() => client.close());
  await client._connect();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const first = assert.rejects(client._readRaw(), /stopped answering/);
  context.mock.timers.tick(20_000);
  await first;
  assert.equal(client.waiters.length, 0);
  const next = client._readRaw();
  client._onData(frame("next frame"));
  assert.equal((await next).toString(), "next frame");
});

test("close immediately rejects an unanswered game call and releases its timer", { timeout: 2000 }, async (context) => {
  const port = await listener(context, () => {});
  const client = new GameClient({ host: "127.0.0.1", port });
  context.after(() => client.close());
  await client._connect();
  client.handshakeDone = true;
  client.clientID = 1;
  client.userID = 42;
  const answer = assert.rejects(client.call("map", "Read"), /connection closed/i);
  client.close();
  await answer;
  assert.equal(client.pending.size, 0);
  assert.equal(client.socket.destroyed, true);
});

test("fragmented and coalesced game frames complete login, calls, binds, and refusals", { timeout: 3000 }, async (context) => {
  const received = [];
  const port = await listener(context, (socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const version = frame([170472, 551, 1, { type: "real", value: 23.02 }, 1, "EVE-EVE-RELEASE", null]);
    socket.write(version.subarray(0, 2));
    setImmediate(() => socket.write(version.subarray(2)));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const value = marshalDecode(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        if (stage < 5) {
          stage += 1;
          if (stage === 3) socket.write(frame("OK CC"));
          if (stage === 4) socket.write(Buffer.concat([frame(2), frame(["", [], dict([]), dict([])])]));
          if (stage === 5) socket.write(Buffer.concat([
            frame(dict([["session_init", dict([["userid", 42]])], ["user_clientid", { type: "long", value: 42000001n }]])),
            frame({ type: "object", name: "SessionInitialStateNotification", args: [18, null, null, null, []] }),
          ]));
          continue;
        }
        const tuple = value.args;
        const source = tuple[1].args;
        const body = tuple[4][0][1].value;
        const method = body[1].toString();
        received.push({ bound: tuple[4][0][0], service: tuple[2].args[1]?.toString() ?? null, method, remote: body[0] });
        const refused = method === "Refuse";
        const result = method === "MachoBindObject"
          ? [{ type: "substruct", value: { type: "substream", value: ["N=1:2", 0] } }, null]
          : "answer";
        socket.write(frame({
          type: "object", name: refused ? "ErrorResponse" : "CallRsp",
          args: [refused ? 15 : 7, address([8, null, null]), address([2, source[1], source[2], null]), 42,
            refused ? [6, 2, [{ type: "substream", value: "TaxChanged" }]] : [{ type: "substream", value: result }], null],
        }));
      }
    });
  });
  const client = new GameClient({ host: "127.0.0.1", port });
  context.after(() => client.close());
  await client.login("fixture");
  assert.equal((await client.call("map", "Read")).toString(), "answer");
  const bound = await client.bind("invbroker", [123]);
  assert.equal(bound, "N=1:2");
  assert.equal((await client.callBound(bound, "Export")).toString(), "answer");
  await assert.rejects(client.call("map", "Refuse"), (error) => error instanceof GameCallError && /TaxChanged/.test(error.message));
  assert.deepEqual(received.map(({ bound, service, method }) => [bound, service, method]), [
    [0, "map", "Read"], [0, "invbroker", "MachoBindObject"], [1, null, "Export"], [0, "map", "Refuse"],
  ]);
  assert.equal(received[2].remote.toString(), "N=1:2");
  assert.equal(client.pending.size, 0);
});
