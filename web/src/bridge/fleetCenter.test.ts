import test from "node:test";
import assert from "node:assert/strict";

import {
  authoritativeFleetMemberCharacterIDs,
  decodeFleetCenter,
  decodeFleetInviteNotification,
} from "./fleetCenter.ts";

const READS = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

function errorReads(message: string): Record<string, unknown> {
  return Object.fromEntries(
    READS.map((name) => [name, { error: "CALL_REFUSED", message }]),
  );
}

test("Fleet Center distinguishes an authoritative fleetless answer from an outage", () => {
  const none = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotFound"),
  } as never);
  assert.equal(none.availability, "not-in-fleet");
  assert.equal(none.fleet.initState.message, "FleetNotFound");

  const failed = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("Gateway unavailable"),
  } as never);
  assert.equal(failed.availability, "unavailable");
});

test("Fleet Center reads the member gate's FleetNotInFleet refusal as fleetless", () => {
  // The bound reads pass fleetObjectHandler's member gate before the fleet
  // runtime, so a fleetless character is refused FleetNotInFleet on all five.
  const gated = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotInFleet"),
  } as never);
  assert.equal(gated.availability, "not-in-fleet");
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(gated), []);

  // Either fleetless refusal, mixed across reads, is still one settled answer.
  const mixed = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: { ...errorReads("FleetNotInFleet"), GetMotd: { error: "CALL_REFUSED", message: "FleetNotFound" } },
  } as never);
  assert.equal(mixed.availability, "not-in-fleet");

  // One read failing for any other reason keeps the whole answer unknown.
  const partial = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: { ...errorReads("FleetNotInFleet"), GetWings: { error: "READ_FAILED", message: "timed out" } },
  } as never);
  assert.equal(partial.availability, "unavailable");
});

test("Fleet Center requires a successful GetInitState before calling a cached fleet ready", () => {
  const decoded = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: 999000001,
    reads: errorReads("Read timed out"),
  } as never);
  assert.equal(decoded.availability, "unavailable");
});

test("bot fleet-member IDs distinguish a missing roster from an authoritative empty roster", () => {
  const unavailable = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: 999000001,
    reads: errorReads("Read timed out"),
  } as never);
  assert.equal(authoritativeFleetMemberCharacterIDs(unavailable), null);

  const none = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotFound"),
  } as never);
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(none), []);

  const ready = {
    availability: "ready",
    fleet: {
      initState: {
        value: {
          members: [
            { charID: 140000002 },
            { charID: "140000005" },
            { charID: 140000002 },
            { charID: null },
          ],
        },
      },
    },
  } as never;
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(ready), [140000002, 140000005]);
});

test("fleet invite notification retains the authoritative fleet and inviter IDs", () => {
  assert.deepEqual(
    decodeFleetInviteNotification(
      "OnFleetInvite",
      [{ type: "long", value: "654500010000" }, 140000002, "AskJoinFleet", {}],
      1234,
    ),
    { fleetID: 654500010000, inviterID: 140000002, receivedAtMs: 1234 },
  );
  assert.equal(decodeFleetInviteNotification("OnFleetJoin", [1, 2], 1234), null);
  assert.equal(decodeFleetInviteNotification("OnFleetInvite", [0, 2], 1234), null);
});
