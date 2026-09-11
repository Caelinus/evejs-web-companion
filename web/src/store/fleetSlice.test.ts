import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "./clientStore.ts";
import { decodeFleetCenter } from "../bridge/fleetCenter.ts";
import {
  decodeFleetBroadcastNotification,
  decodeFleetStateChangeNotification,
  type FleetBroadcast,
} from "../bridge/fleetBroadcasts.ts";
import type { OnlineCharacterState } from "./types.ts";

const readNames = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

function noFleet() {
  return decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: Object.fromEntries(
      readNames.map((name) => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
    ),
  });
}

/** A "ready" fleet read whose GetInitState answers the given fleetID. */
/** Every read failed for a TRANSPORT reason - the "unavailable" arm. */
function unreadableFleet() {
  return decodeFleetCenter({
    ok: false,
    characterID: 140000005,
    fleetID: null,
    reads: Object.fromEntries(
      readNames.map((name) => [name, { error: "GATEWAY_TIMEOUT", message: "timed out" }]),
    ),
  });
}

test("an UNREADABLE fleet read is not a fleet switch, and keeps the tags", () => {
  // ⚠ THE REGRESSION THIS PINS IS SILENT AND LONG-LIVED. "unavailable" carries
  // a null fleetID, so comparing ids alone reads a gateway blip as "you left
  // fleet 1 and joined nothing" and clears the tags. Back at null they mean
  // "never received", and tags only arrive again when the commander CHANGES
  // one - possibly many minutes into a fight. One failed read would switch
  // tag-following off and leave it off, with nothing in the readout saying so.
  //
  // Could-not-look is never evidence of a change.
  const store = createClientStore();
  const joined = readyFleet(90000002);
  store.apply({ type: "fleet/loaded", ...joined, readError: null, refreshedAtMs: 1 });
  store.apply({ type: "fleet/target-tags", tags: new Map([[90000010, "A"]]) });
  assert.equal(store.get().fleet.targetTags?.size, 1, "the tags landed");

  const blip = unreadableFleet();
  assert.equal(blip.availability, "unavailable", "fixture really is the unreadable arm");
  assert.equal(blip.fleet.fleetID, null, "and it really does carry a null fleetID");
  store.apply({ type: "fleet/loaded", ...blip, readError: "timed out", refreshedAtMs: 2 });
  assert.equal(store.get().fleet.targetTags?.size, 1, "a failed read must not clear the tags");

  // ...but a genuine switch, authoritatively read, still clears them.
  const elsewhere = readyFleet(90000003);
  store.apply({ type: "fleet/loaded", ...elsewhere, readError: null, refreshedAtMs: 3 });
  assert.equal(store.get().fleet.targetTags, null, "a real switch still clears");
});

function readyFleet(fleetID: number) {
  return decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID,
    reads: {
      GetInitState: { result: { type: "dict", entries: [["fleetID", fleetID]] } },
      GetWings: { result: { type: "dict", entries: [] } },
      GetMotd: { result: "" },
      GetJoinRequests: { result: { type: "dict", entries: [] } },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  });
}

/** A decoded "Target" broadcast, receivedAtMs stamped so last-write-wins is checkable. */
function targetBroadcast(receivedAtMs: number): FleetBroadcast {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["Target", 3, 90000001, 30000142, 90000050, 670],
    receivedAtMs,
  );
  assert.notEqual(broadcast, null);
  return broadcast!;
}

/** A decoded itemID -> tag map with one entry, via the bare-dict fallback shape. */
function oneTag(): ReadonlyMap<number, string> {
  const tags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    { type: "dict", entries: [[90000001, "Primary"]] },
  ]);
  assert.notEqual(tags, null);
  return tags!;
}

const ONLINE_CHARACTER: OnlineCharacterState = {
  characterID: 140000005,
  characterName: "Test Five",
  stationID: 60000004,
  structureID: null,
  solarSystemID: 30000142,
  corporationID: 1000002,
};

test("fleet slice keeps not-in-fleet distinct from unread and unavailable", () => {
  const store = createClientStore();
  assert.equal(store.get().fleet.loaded, false);
  assert.equal(store.get().fleet.availability, "unknown");

  const snapshot = noFleet();
  store.apply({ type: "fleet/loading" });
  store.apply({
    type: "fleet/loaded",
    ...snapshot,
    readError: null,
    refreshedAtMs: 100,
  });
  assert.equal(store.get().fleet.loaded, true);
  assert.equal(store.get().fleet.loading, false);
  assert.equal(store.get().fleet.availability, "not-in-fleet");
});
test("fleet actions and invitations settle without erasing the authoritative read", () => {
  const store = createClientStore();
  const snapshot = noFleet();
  store.apply({
    type: "fleet/loaded",
    ...snapshot,
    readError: null,
    refreshedAtMs: 100,
  });
  store.apply({
    type: "fleet/pending-invite",
    invite: { fleetID: 654500010000, inviterID: 140000002, receivedAtMs: 200 },
  });
  store.apply({ type: "fleet/action-started", action: "accept" });
  store.apply({ type: "fleet/action-finished", error: "The invitation expired." });

  const fleet = store.get().fleet;
  assert.equal(fleet.availability, "not-in-fleet");
  assert.equal(fleet.pendingInvite?.fleetID, 654500010000);
  assert.equal(fleet.activeAction, null);
  assert.equal(fleet.actionError, "The invitation expired.");
});

test("fleet broadcasts and target tags start null and last-write-wins", () => {
  const store = createClientStore();
  assert.equal(store.get().fleet.lastBroadcast, null);
  assert.equal(store.get().fleet.targetTags, null);

  store.apply({ type: "fleet/broadcast", broadcast: targetBroadcast(1000) });
  assert.equal(store.get().fleet.lastBroadcast?.receivedAtMs, 1000);

  // A later call replaces the earlier one outright — last-write-wins, no merge.
  store.apply({ type: "fleet/broadcast", broadcast: targetBroadcast(2000) });
  assert.equal(store.get().fleet.lastBroadcast?.receivedAtMs, 2000);

  // An authoritative "nothing tagged" answer must stay distinct from "never received".
  const emptyTags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    { type: "dict", entries: [] },
  ]);
  assert.notEqual(emptyTags, null);
  store.apply({ type: "fleet/target-tags", tags: emptyTags! });
  assert.notEqual(store.get().fleet.targetTags, null);
  assert.equal(store.get().fleet.targetTags?.size, 0);

  store.apply({ type: "fleet/target-tags", tags: oneTag() });
  assert.deepEqual([...(store.get().fleet.targetTags ?? new Map())], [[90000001, "Primary"]]);
});

test("fleet/loaded clears the broadcast and tags only when the fleetID actually switches", () => {
  const store = createClientStore();
  store.apply({
    type: "fleet/loaded",
    ...readyFleet(900000001),
    readError: null,
    refreshedAtMs: 100,
  });
  store.apply({ type: "fleet/broadcast", broadcast: targetBroadcast(1000) });
  store.apply({ type: "fleet/target-tags", tags: oneTag() });
  assert.notEqual(store.get().fleet.lastBroadcast, null);
  assert.notEqual(store.get().fleet.targetTags, null);

  // A refresh of the SAME fleet (fleetID unchanged) must not disturb either field.
  store.apply({
    type: "fleet/loaded",
    ...readyFleet(900000001),
    readError: null,
    refreshedAtMs: 200,
  });
  assert.notEqual(store.get().fleet.lastBroadcast, null, "same fleetID must keep the broadcast");
  assert.notEqual(store.get().fleet.targetTags, null, "same fleetID must keep the tags");

  // A DIFFERENT fleetID is the real hazard: a call or tag from the old fleet
  // must not survive into the window before the new fleet's own state lands.
  store.apply({
    type: "fleet/loaded",
    ...readyFleet(900000002),
    readError: null,
    refreshedAtMs: 300,
  });
  assert.equal(store.get().fleet.lastBroadcast, null, "a different fleetID must clear the broadcast");
  assert.equal(store.get().fleet.targetTags, null, "a different fleetID must clear the tags");
});

test("offline, logout, coming online, and clearing all reset character-specific fleet state", () => {
  for (const event of [
    { type: "character/offline" } as const,
    { type: "character/online", character: ONLINE_CHARACTER, station: null } as const,
    { type: "session/logged-out" } as const,
    { type: "fleet/cleared" } as const,
  ]) {
    const store = createClientStore();
    store.apply({
      type: "fleet/loaded",
      ...readyFleet(900000001),
      readError: null,
      refreshedAtMs: 100,
    });
    store.apply({ type: "fleet/broadcast", broadcast: targetBroadcast(1000) });
    store.apply({ type: "fleet/target-tags", tags: oneTag() });
    store.apply(event);
    assert.equal(store.get().fleet.loaded, false);
    assert.equal(store.get().fleet.availability, "unknown");
    assert.equal(store.get().fleet.lastBroadcast, null);
    assert.equal(store.get().fleet.targetTags, null);
  }
});
