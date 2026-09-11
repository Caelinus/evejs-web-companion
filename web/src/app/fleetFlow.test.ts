import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const READ_NAMES = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

function noFleet() {
  return {
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: Object.fromEntries(
      READ_NAMES.map((name) => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
    ),
  };
}

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

function populatedFleet() {
  const emptyDict = { type: "dict", entries: [] };
  return {
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", "Ready up."],
          ["fleetID", 654500010000],
          ["members", emptyDict],
          ["squads", emptyDict],
          ["wings", emptyDict],
        ]),
      },
      GetWings: { result: emptyDict },
      GetMotd: { result: "Ready up." },
      GetJoinRequests: { result: emptyDict },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  };
}

const FLEET_SNAPSHOT_INVALIDATIONS = [
  "OnFleetJoin",
  "OnFleetLeave",
  "OnFleetDisbanded",
  "OnFleetMemberChanged",
  "OnFleetMove",
  "OnFleetWingAdded",
  "OnFleetWingDeleted",
  "OnFleetWingNameChanged",
  "OnFleetSquadAdded",
  "OnFleetSquadDeleted",
  "OnFleetSquadNameChanged",
  "OnFleetMotdChanged",
  "OnFleetOptionsChanged",
  "OnFleetJoinRequest",
  "OnFleetJoinRejected",
] as const;

interface FakeSource extends EventSourceLike {
  emit(frame: unknown): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (): EventSourceLike => {
    const source: FakeSource = {
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      close() {},
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

function notificationFrame(method: string, sequence: number, args: readonly unknown[] = []) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "fleet-epoch", sequence },
    event: {
      kind: "notification",
      notification: { kind: "client", service: null, method, args, kwargs: null },
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function onlineFleetFlow(
  fleetRead: (readNumber: number) => Promise<Response> | Response = () => json(populatedFleet()),
) {
  const store = createClientStore();
  const { factory, sources } = makeFakeEventSource();
  const state = { fleetReads: 0, activeFleetReads: 0, peakFleetReads: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/bridge/select") {
      return json({
        ok: true,
        character: {
          characterID: 140000005,
          characterName: "Fleet Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000001,
        },
        station: null,
        notifications: [],
      });
    }
    if (url === "/api/bridge/bound-fleet") {
      state.fleetReads += 1;
      state.activeFleetReads += 1;
      state.peakFleetReads = Math.max(state.peakFleetReads, state.activeFleetReads);
      try {
        return await fleetRead(state.fleetReads);
      } finally {
        state.activeFleetReads -= 1;
      }
    }
    if (url === "/api/bridge/call") {
      const request = JSON.parse(String(init?.body)) as { service: string; method: string };
      return json({
        ok: true,
        service: request.service,
        method: request.method,
        result: null,
        notifications: [],
      });
    }
    if (url === "/api/names") {
      return json({ ok: true, names: {} });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const flow = createAppFlow(store, { fetch, eventSource: factory });
  await flow.selectCharacter(140000005);
  const source = sources[0];
  assert.ok(source, "selecting a character must open the live Fleet event source");
  return { store, source, state };
}

test("loadFleet preserves the verified FleetNotFound state", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: async () => json(noFleet()) });
  await flow.loadFleet();
  assert.equal(store.get().fleet.availability, "not-in-fleet");
  assert.equal(store.get().fleet.readError, null);
});

test("formFleet confirms through a follow-up bound-fleet read", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/api/bridge/fleet/create")) {
      return json({ ok: true, applied: true });
    }
    if (url.endsWith("/api/bridge/bound-fleet")) return json(populatedFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  await createAppFlow(store, { fetch }).formFleet();

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/bridge/fleet/create",
    "/api/bridge/bound-fleet",
  ]);
  assert.deepEqual(calls[0]!.body, { confirm: true });
  assert.equal(store.get().fleet.availability, "ready");
  assert.equal(store.get().fleet.actionError, null);
});

test("acceptFleetInvite uses the fleetID from OnFleetInvite and re-reads", async () => {
  let acceptedBody: Record<string, unknown> | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/bridge/fleet/invite/accept")) {
      acceptedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ ok: true, applied: true });
    }
    if (url.endsWith("/api/bridge/bound-fleet")) return json(populatedFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  store.apply({
    type: "fleet/pending-invite",
    invite: { fleetID: 654500010000, inviterID: 140000002, receivedAtMs: 100 },
  });
  await createAppFlow(store, { fetch }).acceptFleetInvite();

  assert.deepEqual(acceptedBody, { fleetID: 654500010000, confirm: true });
  assert.equal(store.get().fleet.availability, "ready");
  assert.equal(store.get().fleet.pendingInvite, null);
});

test("leaveFleet does not trust the write ack and lands the no-fleet reread", async () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/bridge/fleet/leave")) return json({ ok: true, applied: true });
    if (url.endsWith("/api/bridge/bound-fleet")) return json(noFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  await createAppFlow(store, { fetch }).leaveFleet();
  assert.deepEqual(calls, ["/api/bridge/fleet/leave", "/api/bridge/bound-fleet"]);
  assert.equal(store.get().fleet.availability, "not-in-fleet");
  assert.equal(store.get().fleet.actionError, null);
});

test("every Fleet snapshot invalidation notification triggers an authoritative reread", async () => {
  const { store, source, state } = await onlineFleetFlow();

  for (const [index, method] of FLEET_SNAPSHOT_INVALIDATIONS.entries()) {
    source.emit(notificationFrame(method, index + 1));
    const expectedReads = index + 1;
    await waitFor(
      () =>
        state.fleetReads === expectedReads &&
        store.get().fleet.loaded &&
        !store.get().fleet.loading,
      `${method} did not finish its Fleet snapshot reread`,
    );
    // Let drainFleetRefreshes clear its worker before issuing the next distinct
    // event. This test checks each name independently; burst behavior is below.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  source.emit(notificationFrame("OnFleetInviteExpired", 100));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    FLEET_SNAPSHOT_INVALIDATIONS.length,
    "an unrecognized Fleet-like event must not invent a roster invalidation",
  );
});

test("a same-turn burst of Fleet invalidations coalesces into one reread", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(notificationFrame("OnFleetMemberChanged", 1));
  source.emit(notificationFrame("OnFleetMove", 2));
  source.emit(notificationFrame("OnFleetMotdChanged", 3));

  await waitFor(
    () => state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the coalesced Fleet reread did not finish",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 1);
  assert.equal(state.peakFleetReads, 1);
});

test("an invalidation during a Fleet read queues one non-concurrent follow-up", async () => {
  const firstRead = deferred<Response>();
  const { store, source, state } = await onlineFleetFlow((readNumber) =>
    readNumber === 1 ? firstRead.promise : json(populatedFleet()),
  );

  source.emit(notificationFrame("OnFleetMemberChanged", 1));
  await waitFor(
    () => state.fleetReads === 1 && state.activeFleetReads === 1,
    "first Fleet read never started",
  );

  source.emit(notificationFrame("OnFleetMove", 2));
  source.emit(notificationFrame("OnFleetOptionsChanged", 3));
  source.emit(notificationFrame("OnFleetJoinRequest", 4));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 1, "the in-flight read must not be overlapped");
  assert.equal(state.peakFleetReads, 1);

  firstRead.resolve(json(populatedFleet()));
  await waitFor(
    () =>
      state.fleetReads === 2 &&
      state.activeFleetReads === 0 &&
      store.get().fleet.loaded &&
      !store.get().fleet.loading,
    "the dirty Fleet worker did not finish exactly one follow-up read",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 2);
  assert.equal(state.peakFleetReads, 1, "Fleet bound reads must remain single-flight");
});

// --- R24: the two pushed notifications with a real payload, plus the
// __MultiEvent unwrap that was silently dropping fleet member-change batches
// before applyPushedNotification learned to open them. ------------------------

test("a pushed OnFleetBroadcast lands on the fleet slice", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.equal(store.get().fleet.lastBroadcast, null);

  source.emit(
    notificationFrame("OnFleetBroadcast", 1, [
      "EnemySpotted",
      3,
      "90000002",
      30000142,
      1000000000042,
      32872,
    ]),
  );

  await waitFor(
    () => store.get().fleet.lastBroadcast !== null,
    "the pushed OnFleetBroadcast never landed on the fleet slice",
  );
  const broadcast = store.get().fleet.lastBroadcast;
  assert.equal(broadcast?.name, "EnemySpotted");
  assert.equal(broadcast?.scope, 3);
  // The bare decimal string case (⚠ in fleetBroadcasts.ts) — our own gateway's
  // actual shape for a passthrough id, not the {type:"long"} wrapper.
  assert.equal(broadcast?.senderCharID, 90000002);
  assert.equal(broadcast?.senderSolarSystemID, 30000142);
  assert.equal(broadcast?.itemID, 1000000000042);
  assert.equal(broadcast?.typeID, 32872);
});

test("a pushed OnFleetStateChange lands, and an empty tag map stays distinct from null", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.equal(store.get().fleet.targetTags, null);

  source.emit(
    notificationFrame("OnFleetStateChange", 1, [
      keyVal([["targetTags", { type: "dict", entries: [[1000000000042, "A"]] }]]),
    ]),
  );
  await waitFor(
    () => store.get().fleet.targetTags !== null,
    "the pushed target-tag map never landed on the fleet slice",
  );
  assert.equal(store.get().fleet.targetTags?.get(1000000000042), "A");
  assert.equal(store.get().fleet.targetTags?.size, 1);

  // A second push with NOTHING tagged must still land as an EMPTY MAP, never
  // null — null means "never received", and this fleet plainly has.
  source.emit(
    notificationFrame("OnFleetStateChange", 2, [
      keyVal([["targetTags", { type: "dict", entries: [] }]]),
    ]),
  );
  await waitFor(
    () => store.get().fleet.targetTags?.size === 0,
    "the empty tag map never replaced the populated one",
  );
  assert.notEqual(store.get().fleet.targetTags, null);
});

test("a __MultiEvent batching two OnFleetMemberChanged pairs coalesces into one dropped-today refresh", async () => {
  const { store, source, state } = await onlineFleetFlow();

  // The server's only call site for __MultiEvent (notifyFleetMultiEvent) wraps
  // exactly this: more than one OnFleetMemberChanged landing in the same tick.
  // Member-change args are irrelevant to the invalidation path (it only ever
  // schedules a reread), so placeholders are enough here.
  source.emit(
    notificationFrame("__MultiEvent", 1, [
      ["OnFleetMemberChanged", []],
      ["OnFleetMemberChanged", []],
    ]),
  );

  await waitFor(
    () =>
      state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the __MultiEvent batch never triggered a Fleet reread — the bug this fixes",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    1,
    "two member-changed pairs in one batch must coalesce to ONE reread, not two",
  );
  assert.equal(state.peakFleetReads, 1);
});

test("a nested __MultiEvent is refused, not expanded, while its sibling pair still dispatches", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(
    notificationFrame("__MultiEvent", 1, [
      // Pathological: the server never actually wraps its own wrapper.
      ["__MultiEvent", [["OnFleetMemberChanged", []]]],
      ["OnFleetMemberChanged", []],
    ]),
  );

  await waitFor(
    () =>
      state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the sibling OnFleetMemberChanged pair never triggered its reread",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    1,
    "a nested __MultiEvent must be refused outright, never expanded into its own reread",
  );
});

test("an unrecognised method still invents no refresh (unaffected by the new dispatch)", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(notificationFrame("OnFleetInviteExpired", 1));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state.fleetReads, 0, "an unrecognised Fleet-like event must not invent a roster invalidation");
  assert.equal(store.get().fleet.lastBroadcast, null);
  assert.equal(store.get().fleet.targetTags, null);
});
