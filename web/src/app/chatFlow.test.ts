// The R7 chat controller against a faked BFF: loadChat reads a channel's roster
// + backlog into the store; sendChatMessage posts then refreshes the backlog;
// setChatChannel switches the active tab; a read/send failure surfaces through
// the chat slice (the panel stays put); a lost session unwinds to offline.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

const LOCAL_CHAT = {
  channel: "local",
  roomName: "local_30000142",
  solarSystemID: 30000142,
  corporationID: null,
  roster: [{ characterID: 7, name: "Me", corporationID: 98000000 }],
  messages: [{ characterID: 9, characterName: "Neighbor", message: "o7", createdAtMs: 1 }],
};
const CORP_CHAT = {
  channel: "corp",
  roomName: "corp_98000000",
  solarSystemID: 30000142,
  corporationID: 98000000,
  roster: [{ characterID: 7, name: "Me", corporationID: 98000000 }],
  messages: [],
};

test("loadChat reads a channel's roster + backlog into the store", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/chat/local") {
      return { status: 200, body: { ok: true, chat: LOCAL_CHAT, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadChat("local");

  assert.equal(requests[0]?.path, "/api/bridge/chat/local");
  const chat = store.chat.get();
  assert.equal(chat.local.loaded, true);
  assert.equal(chat.local.roomName, "local_30000142");
  assert.equal(chat.local.roster.length, 1);
  assert.equal(chat.local.roster[0]?.name, "Me");
  assert.equal(chat.local.messages[0]?.message, "o7");
  assert.equal(chat.error, null);
});

test("loadChat corp fills the corp channel slice independently", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/chat/corp") {
      return { status: 200, body: { ok: true, chat: CORP_CHAT, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadChat("corp");

  const chat = store.chat.get();
  assert.equal(chat.corp.loaded, true);
  assert.equal(chat.corp.corporationID, 98000000);
  assert.equal(chat.local.loaded, false, "the local channel is untouched");
});

test("sendChatMessage posts the message then refreshes the backlog", async () => {
  const store = createClientStore();
  const sentEcho = {
    channel: "local",
    roomName: "local_30000142",
    sent: true,
    entry: { characterID: 7, characterName: "Me", message: "hello local", createdAtMs: 2 },
  };
  const withMine = {
    ...LOCAL_CHAT,
    messages: [...LOCAL_CHAT.messages, { characterID: 7, characterName: "Me", message: "hello local", createdAtMs: 2 }],
  };
  const { fetch, requests } = makeFakeFetch((path, method) => {
    if (path === "/api/bridge/chat/local/send" && method === "POST") {
      return { status: 200, body: { ok: true, chat: sentEcho, notifications: [] } };
    }
    if (path === "/api/bridge/chat/local") {
      return { status: 200, body: { ok: true, chat: withMine, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.sendChatMessage("local", "hello local");

  const send = requests.find((r) => r.path === "/api/bridge/chat/local/send");
  assert.ok(send, "the message was POSTed");
  assert.equal(send?.body.message, "hello local");
  // A refresh followed the send.
  assert.ok(requests.some((r) => r.path === "/api/bridge/chat/local" && r.method === "GET"));
  const chat = store.chat.get();
  assert.ok(chat.local.messages.some((m) => m.message === "hello local"));
});

test("an empty message is a no-op (no POST)", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(() => {
    throw new Error("must not fetch");
  });
  const flow = createAppFlow(store, { fetch });

  await flow.sendChatMessage("local", "   ");
  assert.equal(requests.length, 0);
});

test("setChatChannel switches the active tab", () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: (async () => {}) as unknown as typeof fetch });
  assert.equal(store.chat.get().activeChannel, "local");
  flow.setChatChannel("corp");
  assert.equal(store.chat.get().activeChannel, "corp");
});

test("a read failure surfaces through the chat slice (panel stays put)", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 502,
    body: { ok: false, error: "CALL_FAILED", message: "boom" },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadChat("local");
  const chat = store.chat.get();
  // R31 — the failure is still surfaced; it is just no longer a code.
  assert.equal(chat.error, "The game server hit an error carrying that out.");
  assert.equal(chat.local.loaded, false);
});

test("a lost session unwinds to offline and rethrows", async () => {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: 7,
      characterName: "Me",
      stationID: 60003760,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 98000000,
    },
    station: null,
  });
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(() => flow.loadChat("local"));
  assert.equal(store.station.get().online, null, "the character went offline");
});
