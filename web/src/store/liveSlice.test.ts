// Goal R10: the store's live-channel slice. The push channel's frames reduce
// into state exactly like every other feed event — the UI stays a pure reader.
// These pin the reducer semantics the flow relies on: bounded notification
// history, chat-message dedup against the poll, cursor tracking, the
// resynchronize contract, and lifecycle clearing.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "./clientStore.ts";
import type { ChatMessage } from "./types.ts";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    characterID: 9,
    characterName: "Neighbor",
    message: "o7",
    createdAtMs: 1,
    ...overrides,
  };
}

function notification(kind = "service") {
  return { kind, service: "OnX", method: "Notify", receivedAtMs: 100, args: [] };
}

test("live/notification records the cursor and marks the channel live", () => {
  const store = createClientStore();
  store.apply({
    type: "live/notification",
    notification: notification(),
    epoch: "e1",
    sequence: 7,
  });
  const live = store.get().live;
  assert.equal(live.status, "live");
  assert.equal(live.epoch, "e1");
  assert.equal(live.sequence, 7);
  assert.equal(live.notifications.length, 1);
  assert.equal(live.lastEventAtMs, 100);
});

test("the notification tail is bounded (it is a liveness record, not a log)", () => {
  const store = createClientStore();
  for (let index = 0; index < 120; index += 1) {
    store.apply({
      type: "live/notification",
      notification: { ...notification(), method: `M${index}` },
      epoch: "e1",
      sequence: index + 1,
    });
  }
  const live = store.get().live;
  assert.equal(live.notifications.length, 50);
  // The tail kept is the most recent one.
  assert.equal(live.notifications.at(-1)?.method, "M119");
  assert.equal(live.sequence, 120);
});

test("chat/message appends to the right channel and leaves the other alone", () => {
  const store = createClientStore();
  store.apply({ type: "chat/message", channel: "local", message: message() });
  store.apply({
    type: "chat/message",
    channel: "corp",
    message: message({ message: "corp only", createdAtMs: 2 }),
  });
  assert.equal(store.get().chat.local.messages.length, 1);
  assert.equal(store.get().chat.corp.messages.at(-1)?.message, "corp only");
  assert.equal(store.get().chat.local.loaded, true);
});

test("chat/message dedupes an entry the poll already delivered", () => {
  const store = createClientStore();
  store.apply({
    type: "chat/loaded",
    channel: "local",
    channelState: {
      roomName: "local_30000142",
      corporationID: null,
      solarSystemID: 30000142,
      roster: [],
      messages: [message()],
      loaded: true,
    },
  });
  store.apply({ type: "chat/message", channel: "local", message: message() });
  assert.equal(store.get().chat.local.messages.length, 1);

  // A genuinely different message still appends — dedup must not swallow
  // repeats of the same text at a different time.
  store.apply({
    type: "chat/message",
    channel: "local",
    message: message({ createdAtMs: 2 }),
  });
  assert.equal(store.get().chat.local.messages.length, 2);
});

test("live/resynchronize adopts the new cursor and drops the stale tail", () => {
  const store = createClientStore();
  store.apply({
    type: "live/notification",
    notification: notification(),
    epoch: "e1",
    sequence: 3,
  });
  store.apply({ type: "live/resynchronize", epoch: "e2", sequence: 40 });

  const live = store.get().live;
  assert.equal(live.epoch, "e2");
  assert.equal(live.sequence, 40);
  assert.deepEqual(
    live.notifications,
    [],
    "the stream said it cannot replay; keeping the old tail would imply continuity it does not have",
  );
});

test("live/status moves the channel state without touching the buffer", () => {
  const store = createClientStore();
  store.apply({
    type: "live/notification",
    notification: notification(),
    epoch: "e1",
    sequence: 1,
  });
  store.apply({ type: "live/status", status: "degraded" });
  assert.equal(store.get().live.status, "degraded");
  assert.equal(store.get().live.notifications.length, 1);
});

test("going offline or logging out clears the live slice", () => {
  for (const event of [
    { type: "character/offline" } as const,
    { type: "session/logged-out" } as const,
  ]) {
    const store = createClientStore();
    store.apply({
      type: "live/notification",
      notification: notification(),
      epoch: "e1",
      sequence: 1,
    });
    store.apply(event);
    assert.deepEqual(store.get().live.notifications, []);
    assert.equal(store.get().live.status, "idle");
    assert.equal(store.get().live.epoch, null);
  }
});

test("whole-store subscribers see one notification per live event", () => {
  const store = createClientStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  notifications = 0; // discard the synchronous initial call
  store.apply({
    type: "live/notification",
    notification: notification(),
    epoch: "e1",
    sequence: 1,
  });
  store.apply({ type: "chat/message", channel: "local", message: message() });
  assert.equal(notifications, 2);
  unsubscribe();
});
