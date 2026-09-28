import test from "node:test";
import assert from "node:assert/strict";

import {
  JAM_ASSUMED_DURATION_MS,
  JAM_REFRESH_GRACE_MS,
  TACKLE_JAMMING_TYPES,
  applyJamEvent,
  decodeJamNotification,
  isJamLive,
  isTackleJammingType,
  tacklersHolding,
  type ActiveJam,
} from "./jamNotifications.ts";

// A synthetic aggressor, its module, and this ship. Nothing here is a real
// id: 90000001 is the documented example id, and the ball ids are obviously
// made up.
const AGGRESSOR = 9001;
const AGGRESSOR_MODULE = 9002;
const OTHER_MODULE = 9003;
const SECOND_AGGRESSOR = 9004;
const MY_SHIP = 90000001;

test("decodes an OnJamStart with its six positional args", () => {
  const event = decodeJamNotification(
    "OnJamStart",
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, "warpScramblerMWD", 133_000_000_000_000_000, 5_000],
    1_000,
  );
  assert.deepEqual(event, {
    active: true,
    sourceBallID: AGGRESSOR,
    moduleID: AGGRESSOR_MODULE,
    targetBallID: MY_SHIP,
    jammingType: "warpScramblerMWD",
    receivedAtMs: 1_000,
    durationMs: 5_000,
  });
});

test("decodes an OnJamEnd, which carries only the first four args", () => {
  const event = decodeJamNotification(
    "OnJamEnd",
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, "warpScrambler"],
    2_000,
  );
  assert.deepEqual(event, {
    active: false,
    sourceBallID: AGGRESSOR,
    moduleID: AGGRESSOR_MODULE,
    targetBallID: MY_SHIP,
    jammingType: "warpScrambler",
    receivedAtMs: 2_000,
    durationMs: null,
  });
});

// The gateway's encodeJsonSafeCallValue turns a bigint into `.toString()`, so a
// bare decimal string is a shape this client really receives — the same trap
// fleetBroadcasts.ts carries its own test for.
test("decodes ids arriving as bare decimal strings and as {type:long} wrappers", () => {
  const asStrings = decodeJamNotification(
    "OnJamStart",
    [String(AGGRESSOR), String(AGGRESSOR_MODULE), String(MY_SHIP), "warpScrambler", 0, 5_000],
    1_000,
  );
  assert.equal(asStrings?.sourceBallID, AGGRESSOR);
  assert.equal(asStrings?.targetBallID, MY_SHIP);

  const asLongs = decodeJamNotification(
    "OnJamStart",
    [
      { type: "long", value: String(AGGRESSOR) },
      { type: "long", value: String(AGGRESSOR_MODULE) },
      { type: "long", value: String(MY_SHIP) },
      "warpScrambler",
      0,
      5_000,
    ],
    1_000,
  );
  assert.equal(asLongs?.sourceBallID, AGGRESSOR);
  assert.equal(asLongs?.moduleID, AGGRESSOR_MODULE);
});

test("ignores a method that is not a jam notification", () => {
  assert.equal(decodeJamNotification("OnFleetBroadcast", ["Target", 3], 1_000), null);
  assert.equal(decodeJamNotification(null, [], 1_000), null);
  assert.equal(decodeJamNotification("OnEwarStart", [1, 2, 3, "webify"], 1_000), null);
});

// ⚠ The point of this read is that the aggressor NAMES ITSELF. A record whose
// source failed to decode names nothing, and a caller holding it would believe
// it is tackled by something it can never tag.
test("drops a jam whose source, module, target or type is unreadable", () => {
  const bad = [
    [null, AGGRESSOR_MODULE, MY_SHIP, "warpScrambler"],
    [AGGRESSOR, 0, MY_SHIP, "warpScrambler"],
    [AGGRESSOR, AGGRESSOR_MODULE, -1, "warpScrambler"],
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, ""],
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, "   "],
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, 42],
  ];
  for (const args of bad) {
    assert.equal(decodeJamNotification("OnJamStart", args, 1_000), null, JSON.stringify(args));
  }
});

// The server always sends `Math.max(1, …)`, so an unreadable duration means a
// shape we did not expect — recorded as null, never as zero, because zero would
// expire the jam the instant it arrived.
test("an unreadable duration decodes to null, not to zero", () => {
  const event = decodeJamNotification(
    "OnJamStart",
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, "warpScrambler", 0, "not a number"],
    1_000,
  );
  assert.equal(event?.durationMs, null);
});

test("the tackle allowlist holds exactly the scram and the disruptor", () => {
  assert.deepEqual([...TACKLE_JAMMING_TYPES], ["warpScramblerMWD", "warpScrambler"]);
  assert.equal(isTackleJammingType("warpScramblerMWD"), true);
  assert.equal(isTackleJammingType("warpScrambler"), true);
});

// ⚠ THE ALLOWLIST IS THE POINT. These all arrive on the same notification and
// none of them stops a ship warping out; treating any as tackle would letter a
// ship the fleet is not pinned by.
test("webs, paints, damps, neuts and disruptors are NOT tackle", () => {
  for (const type of [
    "webify",
    "ewTargetPaint",
    "ewRemoteSensorDamp",
    "ewEnergyNeut",
    "ewEnergyVampire",
    "ewTrackingDisrupt",
    "ewGuidanceDisrupt",
    "electronic", // a type that does not exist yet — an allowlist must refuse it
  ]) {
    assert.equal(isTackleJammingType(type), false, type);
  }
});

function jamStart(
  sourceBallID: number,
  moduleID: number,
  jammingType: string,
  receivedAtMs: number,
  durationMs: number | null = 5_000,
): ReturnType<typeof decodeJamNotification> {
  return {
    active: true,
    sourceBallID,
    moduleID,
    targetBallID: MY_SHIP,
    jammingType,
    receivedAtMs,
    durationMs,
  };
}

test("a start adds a jam and an end removes it", () => {
  const started = applyJamEvent([], jamStart(AGGRESSOR, AGGRESSOR_MODULE, "warpScrambler", 1_000)!);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.sourceBallID, AGGRESSOR);

  const ended = applyJamEvent(started, {
    active: false,
    sourceBallID: AGGRESSOR,
    moduleID: AGGRESSOR_MODULE,
    targetBallID: MY_SHIP,
    jammingType: "warpScrambler",
    receivedAtMs: 2_000,
    durationMs: null,
  });
  assert.deepEqual(ended, []);
});

// A running module re-sends OnJamStart every cycle. Without the refresh the set
// would grow one entry per cycle; with a wrong identity it would grow one entry
// per cycle under a different key.
test("a re-cycle REFRESHES the same jam in place rather than adding another", () => {
  const first = applyJamEvent([], jamStart(AGGRESSOR, AGGRESSOR_MODULE, "warpScrambler", 1_000)!);
  const second = applyJamEvent(
    first,
    jamStart(AGGRESSOR, AGGRESSOR_MODULE, "warpScrambler", 6_000)!,
  );
  assert.equal(second.length, 1);
  assert.equal(second[0]?.receivedAtMs, 6_000);
});

// ⚠ ONE SHIP MAY HOLD ANOTHER WITH TWO MODULES. The identity is the pair, so a
// second module is a second jam — and ending one must not end the other.
test("two modules on one aggressor are two jams, and one end leaves the other", () => {
  let jams = applyJamEvent([], jamStart(AGGRESSOR, AGGRESSOR_MODULE, "warpScrambler", 1_000)!);
  jams = applyJamEvent(jams, jamStart(AGGRESSOR, OTHER_MODULE, "warpScramblerMWD", 1_000)!);
  assert.equal(jams.length, 2);

  jams = applyJamEvent(jams, {
    active: false,
    sourceBallID: AGGRESSOR,
    moduleID: AGGRESSOR_MODULE,
    targetBallID: MY_SHIP,
    jammingType: "warpScrambler",
    receivedAtMs: 2_000,
    durationMs: null,
  });
  assert.equal(jams.length, 1);
  assert.equal(jams[0]?.moduleID, OTHER_MODULE);
});

test("an end for a jam that was never started changes nothing, by reference", () => {
  const jams = applyJamEvent([], jamStart(AGGRESSOR, AGGRESSOR_MODULE, "warpScrambler", 1_000)!);
  const after = applyJamEvent(jams, {
    active: false,
    sourceBallID: SECOND_AGGRESSOR,
    moduleID: AGGRESSOR_MODULE,
    targetBallID: MY_SHIP,
    jammingType: "warpScrambler",
    receivedAtMs: 2_000,
    durationMs: null,
  });
  assert.equal(after, jams);
});

const live: ActiveJam = {
  sourceBallID: AGGRESSOR,
  moduleID: AGGRESSOR_MODULE,
  jammingType: "warpScrambler",
  receivedAtMs: 1_000,
  durationMs: 5_000,
};

test("a jam is believed until its own cycle ends plus the refresh grace", () => {
  assert.equal(isJamLive(live, 1_000), true);
  assert.equal(isJamLive(live, 1_000 + 5_000 + JAM_REFRESH_GRACE_MS - 1), true);
  assert.equal(isJamLive(live, 1_000 + 5_000 + JAM_REFRESH_GRACE_MS), false);
});

test("a jam with no readable duration falls back to the assumed one", () => {
  const noDuration: ActiveJam = { ...live, durationMs: null };
  assert.equal(isJamLive(noDuration, 1_000 + JAM_ASSUMED_DURATION_MS), true);
  assert.equal(
    isJamLive(noDuration, 1_000 + JAM_ASSUMED_DURATION_MS + JAM_REFRESH_GRACE_MS),
    false,
  );
});

// ⚠ DEDUPLICATED. A ship holding us with both a scrambler and a disruptor is two
// jams and ONE tagging candidate; a caller counting jams would letter it twice.
test("tacklersHolding names each tackling ship once, and skips non-tackle jams", () => {
  const jams: readonly ActiveJam[] = [
    { ...live, jammingType: "webify" },
    { ...live, moduleID: OTHER_MODULE, jammingType: "warpScrambler" },
    { ...live, moduleID: OTHER_MODULE + 1, jammingType: "warpScramblerMWD" },
    { ...live, sourceBallID: SECOND_AGGRESSOR, jammingType: "warpScramblerMWD" },
  ];
  assert.deepEqual([...tacklersHolding(jams, 1_000)], [AGGRESSOR, SECOND_AGGRESSOR]);
});

test("tacklersHolding drops a tackler whose jam has lapsed", () => {
  const jams: readonly ActiveJam[] = [live];
  assert.deepEqual([...tacklersHolding(jams, 1_000)], [AGGRESSOR]);
  assert.deepEqual([...tacklersHolding(jams, 1_000 + 5_000 + JAM_REFRESH_GRACE_MS)], []);
});
