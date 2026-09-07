// Goal R10: the browser end of the live event channel. The flow subscribes to
// the BFF's SSE route when a character comes online and feeds what arrives into
// the store — the session notifications the page used to throw away.
//
// What these cover: the stream opens on select and closes when the session
// ends; pushed notifications land in the live slice with their cursor; an
// unreplayable snapshot resets that cursor rather than pretending the backlog is
// continuous; and a stream that cannot open leaves the page on its polls instead
// of failing.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

interface FakeSource extends EventSourceLike {
  readonly url: string;
  closed: boolean;
  emit(frame: unknown): void;
  open(): void;
  fail(): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (url: string): EventSourceLike => {
    const source: FakeSource = {
      url,
      closed: false,
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      open() {
        source.onopen?.();
      },
      fail() {
        source.onerror?.();
      },
      close() {
        source.closed = true;
      },
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

const SELECT_RESPONSE = {
  ok: true,
  character: {
    characterID: 7,
    characterName: "Test Pilot",
    stationID: 60003760,
    structureID: null,
    solarSystemID: 30000142,
    corporationID: 98000000,
  },
  station: null,
  notifications: [],
};

function makeFakeFetch(): { fetch: typeof fetch } {
  const fakeFetch = (async (input: unknown, init?: { method?: string }) => {
    const path = String(input);
    let body: unknown = { ok: true };
    if (path === "/api/bridge/select") {
      body = SELECT_RESPONSE;
    } else if (path === "/api/bridge/call") {
      body = { ok: true, service: "s", method: "m", result: null, notifications: [] };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch };
}

async function onlineFlow() {
  const store = createClientStore();
  const { fetch } = makeFakeFetch();
  const { factory, sources } = makeFakeEventSource();
  const flow = createAppFlow(store, { fetch, eventSource: factory });
  await flow.selectCharacter(7);
  const source = sources[0];
  assert.ok(source, "selecting a character must open the live event channel");
  return { store, flow, source, sources };
}

function gatewayFrame(event: unknown, sequence: number) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "epoch-1", sequence },
    event,
  };
}

test("selecting a character opens the live event channel", async () => {
  const { source, sources, store } = await onlineFlow();
  assert.equal(sources.length, 1);
  assert.equal(source.url, "/api/bridge/events");
  source.open();
  assert.equal(store.get().live.status, "live");
});

test("pushed session notifications land in the live slice with their cursor", async () => {
  const { source, store } = await onlineFlow();
  source.emit(
    gatewayFrame(
      { kind: "notification", notification: { kind: "service", service: "OnX", method: "Notify" } },
      3,
    ),
  );
  source.emit(
    gatewayFrame(
      { kind: "notification", notification: { kind: "sessionchange", method: "OnSessionChanged" } },
      4,
    ),
  );

  const live = store.get().live;
  assert.equal(live.status, "live");
  assert.equal(live.epoch, "epoch-1");
  assert.equal(live.sequence, 4);
  assert.deepEqual(
    live.notifications.map((n) => n.kind),
    ["service", "sessionchange"],
  );
  assert.equal(live.notifications[0]?.service, "OnX");
});

test("an unreplayable snapshot resets the cursor and drops the stale notification tail", async () => {
  const { source, store } = await onlineFlow();
  source.emit(
    gatewayFrame(
      { kind: "notification", notification: { kind: "service", service: "OnX", method: "Notify" } },
      3,
    ),
  );
  assert.equal(store.get().live.notifications.length, 1);

  source.emit({
    source: "evejs-web-gateway",
    type: "snapshot",
    reason: "cursor_not_replayable",
    cursor: { epoch: "epoch-2", sequence: 12 },
  });

  assert.equal(store.get().live.epoch, "epoch-2");
  assert.equal(store.get().live.sequence, 12);
  assert.deepEqual(store.get().live.notifications, []);
});

test("an opening snapshot records the fresh cursor without a notification", async () => {
  const { source, store } = await onlineFlow();
  source.emit({
    source: "evejs-web-gateway",
    type: "snapshot",
    reason: "no_cursor",
    cursor: { epoch: "epoch-1", sequence: 0 },
  });
  assert.equal(store.get().live.epoch, "epoch-1");
  assert.equal(store.get().live.sequence, 0);
  assert.deepEqual(store.get().live.notifications, []);
});

test("a BFF status frame drives the live status (so the page can fall back to polling)", async () => {
  const { source, store } = await onlineFlow();
  source.emit({ source: "evejs-web-bff", type: "stream-status", state: "degraded" });
  assert.equal(store.get().live.status, "degraded");
  source.emit({ source: "evejs-web-bff", type: "stream-status", state: "live" });
  assert.equal(store.get().live.status, "live");
});

test("a stream error marks the channel degraded rather than throwing", async () => {
  const { source, store } = await onlineFlow();
  source.fail();
  assert.equal(store.get().live.status, "degraded");
});

test("releasing the session closes the stream and clears the live slice", async () => {
  const { source, store, flow } = await onlineFlow();
  source.emit(
    gatewayFrame({ kind: "notification", notification: { kind: "service" } }, 1),
  );
  assert.equal(store.get().live.notifications.length, 1);

  await flow.releaseSession();
  assert.equal(source.closed, true);
  assert.deepEqual(store.get().live.notifications, []);
  assert.equal(store.get().live.status, "idle");
});

test("a malformed frame is ignored, not thrown at the page", async () => {
  const { source, store } = await onlineFlow();
  source.onmessage?.({ data: "{not json" });
  source.emit({ source: "somebody-else", type: "event", event: { kind: "notification" } });
  source.emit(gatewayFrame({ kind: "unknown-kind" }, 1));
  assert.equal(store.get().live.notifications.length, 0);
});

test("with no EventSource available the page stays on its polls", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch();
  // No `eventSource` injected and none on globalThis under node:test.
  const flow = createAppFlow(store, { fetch });
  await flow.selectCharacter(7);
  assert.equal(
    store.get().live.status,
    "degraded",
    "an unavailable channel must be reported, not silently treated as live",
  );
});
