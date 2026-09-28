// The R7 chat decoder: turn the BFF's plain-JSON `chat` object (roster =
// buildCharacterSummary rows, messages = backlog entries) into the typed
// ChatChannelState, tolerating malformed rows and decoding numerics long-aware.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeChatChannel,
  decodeChatChannelName,
  decodeSentMessage,
  decodeChatSendAck,
} from "./chat.ts";
import type { JsonValue } from "./wire.ts";

const RAW_LOCAL = {
  channel: "local",
  roomName: "local_30000142",
  solarSystemID: 30000142,
  corporationID: null,
  roster: [
    { characterID: 140000003, name: "Test Three", corporationID: 98000000, allianceID: 99000000, solarSystemID: 30000142 },
    { characterID: 900000731, name: "Neighbor", corporationID: 98000731, allianceID: null, solarSystemID: 30000142 },
  ],
  messages: [
    { characterID: 900000731, characterName: "Neighbor", message: "o7", createdAtMs: 1700000000000 },
    { characterID: 140000003, characterName: "Test Three", message: "hi all", createdAtMs: 1700000000500 },
  ],
};

test("decodeChatChannel decodes the roster + messages", () => {
  const state = decodeChatChannel(RAW_LOCAL);
  assert.equal(state.loaded, true);
  assert.equal(state.roomName, "local_30000142");
  assert.equal(state.solarSystemID, 30000142);
  assert.equal(state.roster.length, 2);
  assert.equal(state.roster[0]?.characterID, 140000003);
  assert.equal(state.roster[0]?.name, "Test Three");
  assert.equal(state.roster[0]?.corporationID, 98000000);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1]?.message, "hi all");
  assert.equal(state.messages[1]?.characterName, "Test Three");
});

test("decodeChatChannel drops malformed rows without throwing", () => {
  const state = decodeChatChannel({
    channel: "local",
    roomName: "local_30000142",
    roster: [
      { characterID: 0, name: "Ghost" }, // no valid characterID -> dropped
      { name: "Nameless but no id" }, // dropped
      { characterID: 7, name: "Keep" },
    ],
    messages: [
      { characterID: 7, characterName: "Keep", message: "" }, // empty -> dropped
      { characterID: 7, characterName: "Keep", message: "real" },
      "not-an-object",
    ],
  });
  assert.equal(state.roster.length, 1);
  assert.equal(state.roster[0]?.name, "Keep");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.message, "real");
});

test("decodeChatChannel handles long-encoded numeric IDs", () => {
  const state = decodeChatChannel({
    channel: "corp",
    roomName: "corp_98000000",
    corporationID: { type: "long", value: "98000000" },
    roster: [
      { characterID: { type: "long", value: 140000003 }, name: "Long ID" },
    ],
    messages: [
      { characterID: { type: "long", value: "140000003" }, characterName: "Long ID", message: "corp hi", createdAtMs: { type: "long", value: 1700000000000 } },
    ],
  });
  assert.equal(state.corporationID, 98000000);
  assert.equal(state.roster[0]?.characterID, 140000003);
  assert.equal(state.messages[0]?.characterID, 140000003);
  assert.equal(state.messages[0]?.createdAtMs, 1700000000000);
});

test("decodeChatChannel tolerates an empty / absent payload", () => {
  const empty = decodeChatChannel(undefined);
  assert.equal(empty.roomName, null);
  assert.deepEqual([...empty.roster], []);
  assert.deepEqual([...empty.messages], []);
  assert.equal(empty.loaded, true);
});

test("decodeChatChannelName returns the payload channel or the fallback", () => {
  assert.equal(decodeChatChannelName({ channel: "corp" }, "local"), "corp");
  assert.equal(decodeChatChannelName({ channel: "bogus" }, "local"), "local");
  assert.equal(decodeChatChannelName(undefined, "corp"), "corp");
});

test("decodeSentMessage reads the echoed send entry", () => {
  const entry = decodeSentMessage({
    channel: "local",
    roomName: "local_30000142",
    sent: true,
    entry: { characterID: 7, characterName: "Me", message: "hello", createdAtMs: 2 },
  });
  assert.ok(entry);
  assert.equal(entry.message, "hello");
  assert.equal(entry.characterName, "Me");
  assert.equal(decodeSentMessage({ channel: "local", sent: true }), null);
});

// --- R88 write ack (Phase-3 LSC.SendMessage WRITE) ---------------------------

/** The ordinary JSON object emitted by the BFF's Express response. */
function plainAck(fields: Record<string, JsonValue>): JsonValue {
  return { ...fields };
}

test("R88 — a chat send ack decodes to {ok, applied}", () => {
  const ack = decodeChatSendAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("R88 — a declined chat send is read as not-applied, not a throw", () => {
  const ack = decodeChatSendAck(plainAck({ ok: true, applied: false }));
  assert.equal(ack.ok, true);
  assert.equal(ack.applied, false);
});

test("a roster that lists the same member twice shows them once", () => {
  // A keyed `{#each ... (member.characterID)}` throws on a repeated key and
  // takes the render flush with it, so the repeat has to die at the decoder.
  const state = decodeChatChannel({
    roomName: "Local",
    roster: [
      { characterID: 140000005, characterName: "Farmer" },
      { characterID: 140000006, characterName: "Miner" },
      { characterID: 140000005, characterName: "Farmer" },
    ],
    messages: [],
  } as unknown as JsonValue);
  assert.deepEqual(state.roster.map((m) => m.characterID), [140000005, 140000006]);
});
