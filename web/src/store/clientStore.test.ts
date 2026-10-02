// Unit tests for the client-state store skeleton (goal R1b): typed
// session/character slices, the subscribe/read API for pure readers, and the
// feed-adapter seam that hides the event transport.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore, type ClientState } from "./clientStore.ts";
import { MemoryFeedAdapter, type FeedAdapter, type FeedSink } from "./feed.ts";
import type { CharacterSummary } from "./types.ts";
import { decodeGetAllInfo } from "../bridge/boundDogma.ts";

function summary(characterID: number, characterName: string): CharacterSummary {
  return {
    characterID,
    characterName,
    gender: 1,
    typeID: 1373,
    corporationID: 1000009,
    allianceID: null,
    stationID: 60000004,
    solarSystemID: 30000142,
    regionID: 10000002,
    balance: 100000,
    skillPoints: 50000,
    shipTypeID: 606,
    shipName: "Velator",
    securityStatus: 0,
    title: "",
    unreadMailCount: 0,
    logoffDate: null,
    skillTypeID: null,
    toLevel: null,
    trainingStartTime: null,
    trainingEndTime: null,
    queueEndTime: null,
  };
}

test("dogma reads update the UI slice and fitting mirror together", () => {
  const store = createClientStore();
  const snapshot = decodeGetAllInfo({ type: "object", name: "util.KeyVal", args: {
    type: "dict", entries: [["activeShipID", 90000010], ["shipInfo", { type: "dict", entries: [] }]],
  } });
  assert.ok(snapshot);
  store.apply({ type: "dogma/loaded", allInfo: snapshot, error: null });
  assert.deepEqual(store.dogma.get(), { allInfo: snapshot, loaded: true, error: null });
  assert.equal(store.fitting.get().dogma, snapshot);
  assert.equal(store.fitting.get().dogmaError, null);

  store.apply({ type: "dogma/loaded", allInfo: null, error: "Dogma read failed" });
  assert.deepEqual(store.dogma.get(), { allInfo: snapshot, loaded: true, error: "Dogma read failed" });
  assert.equal(store.fitting.get().dogma, snapshot);
  assert.equal(store.fitting.get().dogmaError, "Dogma read failed");

  store.apply({ type: "dogma/loaded", allInfo: snapshot, error: null });
  assert.equal(store.dogma.get().error, null);
  assert.equal(store.fitting.get().dogmaError, null);
  store.apply({ type: "fitting/cleared" });
  assert.deepEqual(store.dogma.get(), { allInfo: null, loaded: false, error: null });
  assert.equal(store.fitting.get().dogma, null);
});

test("a first dogma read failure completes the loading state with its error", () => {
  const store = createClientStore();
  store.apply({ type: "dogma/loaded", allInfo: null, error: "Dogma read failed" });
  assert.deepEqual(store.dogma.get(), { allInfo: null, loaded: true, error: "Dogma read failed" });
});

test("the initial state is logged out with no characters and an idle feed", () => {
  const store = createClientStore();
  assert.deepEqual(store.get().session, {
    phase: "logged-out",
    accountID: null,
    username: null,
    accountCreated: false,
  });
  assert.deepEqual(store.get().character, {
    selectedCharacterID: null,
    characters: [],
  });
  assert.deepEqual(store.get().feed, { adapter: null, status: "idle" });
});

test("session and character events reduce into their typed slices", () => {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 4, username: "ceo" });
  store.apply({
    type: "character/list",
    characters: [summary(91, "Pilot A"), summary(92, "Pilot B")],
  });
  store.apply({ type: "character/selected", characterID: 92 });

  assert.deepEqual(store.session.get(), {
    phase: "logged-in",
    accountID: 4,
    username: "ceo",
    // Absent on the event = an ordinary sign-in, never "created".
    accountCreated: false,
  });
  assert.equal(store.character.get().characters.length, 2);
  assert.equal(store.character.get().selectedCharacterID, 92);
});

test("selecting an unknown character resolves to no selection", () => {
  const store = createClientStore();
  store.apply({ type: "character/list", characters: [summary(91, "Pilot A")] });
  store.apply({ type: "character/selected", characterID: 999 });
  assert.equal(store.character.get().selectedCharacterID, null);
});

test("a character list that drops the selected character clears the selection", () => {
  const store = createClientStore();
  store.apply({ type: "character/list", characters: [summary(91, "Pilot A")] });
  store.apply({ type: "character/selected", characterID: 91 });
  store.apply({ type: "character/list", characters: [summary(92, "Pilot B")] });
  assert.equal(store.character.get().selectedCharacterID, null);
});

test("logging out resets the character context with the session", () => {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 4, username: "ceo" });
  store.apply({ type: "character/list", characters: [summary(91, "Pilot A")] });
  store.apply({ type: "session/logged-out" });
  assert.equal(store.session.get().phase, "logged-out");
  assert.deepEqual(store.character.get(), {
    selectedCharacterID: null,
    characters: [],
  });
});

test("whole-store subscribe fires immediately, then exactly once per applied event", () => {
  const store = createClientStore();
  const states: ClientState[] = [];
  const unsubscribe = store.subscribe((state) => states.push(state));
  assert.equal(states.length, 1, "immediate call with the current state");

  // session/logged-out from the initial state touches two slices but must
  // produce a single whole-store notification.
  store.apply({ type: "session/logged-in", accountID: 4, username: "ceo" });
  store.apply({ type: "session/logged-out" });
  assert.equal(states.length, 3);

  unsubscribe();
  store.apply({ type: "session/logged-in", accountID: 4, username: "ceo" });
  assert.equal(states.length, 3, "no notifications after unsubscribe");
});

test("slice subscriptions are granular: session listeners ignore character events", () => {
  const store = createClientStore();
  let sessionCalls = 0;
  let characterCalls = 0;
  store.session.subscribe(() => {
    sessionCalls += 1;
  });
  store.character.subscribe(() => {
    characterCalls += 1;
  });
  store.apply({ type: "character/list", characters: [summary(91, "Pilot A")] });
  assert.equal(sessionCalls, 1, "immediate call only");
  assert.equal(characterCalls, 2, "immediate call plus the character event");
});

test("attachFeed starts the adapter, tracks connectivity, and feeds events through the seam", () => {
  const store = createClientStore();
  const adapter = new MemoryFeedAdapter("memory-test");

  const detach = store.attachFeed(adapter);
  assert.deepEqual(store.feed.get(), { adapter: "memory-test", status: "connected" });
  assert.equal(adapter.started, true);

  adapter.emit({ type: "session/logged-in", accountID: 4, username: "ceo" });
  assert.equal(store.session.get().phase, "logged-in");

  detach();
  assert.equal(adapter.started, false, "detach stops the adapter");
  assert.deepEqual(store.feed.get(), { adapter: "memory-test", status: "disconnected" });
  assert.throws(() => adapter.emit({ type: "session/logged-out" }));
});

test("events published by a detached adapter are ignored by the store", () => {
  const store = createClientStore();
  const leak: { sink: FeedSink | null } = { sink: null };
  const leakyAdapter: FeedAdapter = {
    name: "leaky",
    start(sink) {
      leak.sink = sink;
      sink.setStatus("connected");
    },
    stop() {
      // Deliberately keeps its sink to simulate a straggling transport callback.
    },
  };

  const detach = store.attachFeed(leakyAdapter);
  detach();
  assert.ok(leak.sink, "adapter captured its sink");
  leak.sink.publish({ type: "session/logged-in", accountID: 4, username: "ceo" });
  assert.equal(store.session.get().phase, "logged-out", "stale publish ignored");
});

test("attaching a second feed detaches the first", () => {
  const store = createClientStore();
  const first = new MemoryFeedAdapter("first");
  const second = new MemoryFeedAdapter("second");
  store.attachFeed(first);
  store.attachFeed(second);
  assert.equal(first.started, false);
  assert.equal(second.started, true);
  assert.deepEqual(store.feed.get(), { adapter: "second", status: "connected" });
});
