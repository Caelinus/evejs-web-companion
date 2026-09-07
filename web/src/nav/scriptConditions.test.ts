// A4a — the tri-state reads and interrupt resolution. These pin the two things
// the critiques hammered on: cannot-tell never passes, and a pirate with an
// unreadable ship never gets worked past.

import test from "node:test";
import assert from "node:assert/strict";

import { conditionAllowedAt, type Condition, type InterruptRow } from "../bots/botScript.ts";
import {
  MAX_CANNOT_TELL_STREAK,
  bumpCannotTellStreak,
  cannotTellStreakExhausted,
  evaluateCondition,
  releaseSpentAlerts,
  resolveInterrupt,
  type ScriptObservation,
} from "./scriptConditions.ts";

// A fully-readable, calm observation; tests override one field at a time.
function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true,
    docked: false,
    inWarp: false,
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    health: 1,
    oreHoldFraction: 0,
    holdEmpty: true,
    hostileOnGrid: false,
    dronesOut: false,
    ...over,
  };
}

const floor: InterruptRow = {
  id: "i0",
  builtIn: "safety-floor",
  when: { kind: "health-below", fraction: 0.5 },
  respond: "dock-and-pause",
};

test("a below-threshold read is met, above is not-met, unreadable is cannot-tell", () => {
  const c: Condition = { kind: "shield-below", fraction: 0.3 };
  assert.equal(evaluateCondition(c, obs({ shieldRatio: 0.2 })), "met");
  assert.equal(evaluateCondition(c, obs({ shieldRatio: 0.5 })), "not-met");
  assert.equal(evaluateCondition(c, obs({ shieldRatio: null })), "cannot-tell");
});

test("ore-hold-at-least reads the fill fraction the other way round", () => {
  const c: Condition = { kind: "ore-hold-at-least", fraction: 0.9 };
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: 0.95 })), "met");
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: 0.5 })), "not-met");
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: null })), "cannot-tell");
});

test("wallet thresholds read an absolute ISK balance, unread never fires", () => {
  const below: Condition = { kind: "wallet-below", isk: 100_000_000 };
  assert.equal(evaluateCondition(below, obs({ walletBalance: 50_000_000 })), "met");
  assert.equal(evaluateCondition(below, obs({ walletBalance: 150_000_000 })), "not-met");
  assert.equal(evaluateCondition(below, obs({ walletBalance: null })), "cannot-tell");
  // Absent entirely (a bot that does not read the wallet) is unreadable, not zero.
  assert.equal(evaluateCondition(below, obs()), "cannot-tell");

  const above: Condition = { kind: "wallet-above", isk: 100_000_000 };
  assert.equal(evaluateCondition(above, obs({ walletBalance: 150_000_000 })), "met");
  assert.equal(evaluateCondition(above, obs({ walletBalance: 100_000_000 })), "not-met"); // strict >
  assert.equal(evaluateCondition(above, obs({ walletBalance: null })), "cannot-tell");
});

test("boolean conditions are tri-state too", () => {
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: true })), "met");
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: false })), "not-met");
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: null })), "cannot-tell");
  assert.equal(evaluateCondition({ kind: "hostile-on-grid" }, obs({ hostileOnGrid: true })), "met");
  assert.equal(evaluateCondition({ kind: "hostile-on-grid" }, obs({ hostileOnGrid: null })), "cannot-tell");
});

test("health-below watches the lowest layer, shield-below watches the shield", () => {
  // Shield full, hull low: shield-below is not-met, health-below (lowest) is met.
  const worn = obs({ shieldRatio: 1, armorRatio: 1, hullRatio: 0.1, health: 0.1 });
  assert.equal(evaluateCondition({ kind: "shield-below", fraction: 0.5 }, worn), "not-met");
  assert.equal(evaluateCondition({ kind: "health-below", fraction: 0.5 }, worn), "met");
});

test("the first met interrupt fires, in order", () => {
  const shields: InterruptRow = { id: "i1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([floor, shields], obs({ shieldRatio: 0.2 }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.id, "i1");
});

test("a cannot-tell condition does not fire, and the scan continues past it", () => {
  // floor's health is unreadable (cannot-tell, does not fire); the shields row
  // after it IS met and fires.
  const shields: InterruptRow = { id: "i1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([floor, shields], obs({ health: null, shieldRatio: 0.2 }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.id, "i1");
});

test("an unreadable safety floor flags safetyBlind but does not fire", () => {
  const res = resolveInterrupt([floor], obs({ health: null }));
  assert.equal(res.kind, "none");
  assert.ok(res.kind === "none");
  assert.equal(res.safetyBlind, true);
});

test("nothing wrong: no interrupt fires and the ship is not blind", () => {
  const res = resolveInterrupt([floor], obs());
  assert.equal(res.kind, "none");
  assert.ok(res.kind === "none");
  assert.equal(res.safetyBlind, false);
});

test("a pirate with unreadable health pauses immediately when nothing else handles it", () => {
  const res = resolveInterrupt([floor], obs({ hostileOnGrid: true, health: null }));
  assert.equal(res.kind, "safety-override");
  assert.ok(res.kind === "safety-override");
  assert.match(res.reason, /pirate/i);
});

test("a player's drone response fires before the acute pause can", () => {
  // The player chose to launch drones on a pirate; even with health unreadable,
  // that fires first and defends the ship rather than pausing helpless.
  const drones: InterruptRow = { id: "i2", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const res = resolveInterrupt([floor, drones], obs({ hostileOnGrid: true, health: null }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.respond, "launch-drones");
});

test("a pirate present with READABLE health does not trigger the acute pause", () => {
  const res = resolveInterrupt([floor], obs({ hostileOnGrid: true, health: 1 }));
  assert.equal(res.kind, "none");
});

test("the cannot-tell streak counts up while blind and resets when it reads again", () => {
  let streak = 0;
  for (let i = 0; i < MAX_CANNOT_TELL_STREAK; i += 1) {
    streak = bumpCannotTellStreak(streak, true);
  }
  assert.equal(streak, MAX_CANNOT_TELL_STREAK);
  assert.ok(cannotTellStreakExhausted(streak));

  streak = bumpCannotTellStreak(streak, false);
  assert.equal(streak, 0);
  assert.equal(cannotTellStreakExhausted(streak), false);
});

// ── The four awareness conditions (2026-07-25) ───────────────────────────────

test("cargo-full: the ORDINARY hold, tri-state, and unreadable never fires", () => {
  const full = { kind: "cargo-full", fraction: 0.9 } as const;
  assert.equal(evaluateCondition(full, obs({ cargoFraction: 0.95 })), "met");
  assert.equal(evaluateCondition(full, obs({ cargoFraction: 0.5 })), "not-met");
  assert.equal(evaluateCondition(full, obs({ cargoFraction: null })), "cannot-tell");
  // It is NOT the ore hold: a full ore hold says nothing about the cargo hold.
  assert.equal(evaluateCondition(full, obs({ oreHoldFraction: 1, cargoFraction: 0 })), "not-met");
});

test("targeted-by-player: tri-state over the lock reading", () => {
  const locked = { kind: "targeted-by-player" } as const;
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: true })), "met");
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: false })), "not-met");
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: null })), "cannot-tell");
});

test("drone-health-below: no drones out reads cannot-tell, never healthy", () => {
  const hurt = { kind: "drone-health-below", fraction: 0.5 } as const;
  assert.equal(evaluateCondition(hurt, obs({ lowestDroneHealth: 0.2 })), "met");
  assert.equal(evaluateCondition(hurt, obs({ lowestDroneHealth: 0.9 })), "not-met");
  assert.equal(
    evaluateCondition(hurt, obs({ lowestDroneHealth: null })),
    "cannot-tell",
    "nothing to judge is not a verdict",
  );
});

test("the new grid/awareness conditions are interrupt-only (the belt-empty guard)", () => {
  for (const kind of ["targeted-by-player", "drone-health-below"] as const) {
    assert.equal(conditionAllowedAt(kind, "until"), false, `${kind} must not be a stop-when`);
    assert.equal(conditionAllowedAt(kind, "interrupt"), true, `${kind} must be usable as a watch`);
  }
  // cargo-full is an OWN-SHIP reading, so it is legal in both places.
  assert.equal(conditionAllowedAt("cargo-full", "until"), true);
  assert.equal(conditionAllowedAt("cargo-full", "interrupt"), true);
});

// ── The alert ladder's two helpers (spent rows) ──────────────────────────────

test("resolveInterrupt: a SPENT alert row is skipped so the row under it can fire", () => {
  const alertRow: InterruptRow = { id: "a", when: { kind: "shield-below", fraction: 0.6 }, respond: "alert" };
  const dockRow: InterruptRow = { id: "d", when: { kind: "shield-below", fraction: 0.6 }, respond: "dock-and-pause" };
  const hurt = obs({ shieldRatio: 0.3 });
  const fresh = resolveInterrupt([alertRow, dockRow], hurt, []);
  assert.equal(fresh.kind === "fire" && fresh.row.id, "a");
  const spent = resolveInterrupt([alertRow, dockRow], hurt, ["a"]);
  assert.equal(spent.kind === "fire" && spent.row.id, "d", "the spent alert must step aside");
});

test("resolveInterrupt: only ALERT rows are ever skipped — a real response keeps winning", () => {
  const dockRow: InterruptRow = { id: "d", when: { kind: "shield-below", fraction: 0.6 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([dockRow], obs({ shieldRatio: 0.3 }), ["d"]);
  assert.equal(res.kind === "fire" && res.row.id, "d");
});

test("releaseSpentAlerts: released when the check passes, kept while it holds or is blind", () => {
  const alertRow: InterruptRow = { id: "a", when: { kind: "shield-below", fraction: 0.6 }, respond: "alert" };
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: 1 }), ["a"]), [], "recovered - re-arm");
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: 0.3 }), ["a"]), ["a"], "still hurt - stay spent");
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: null }), ["a"]), ["a"], "blind - stay spent");
  assert.deepEqual(releaseSpentAlerts([], obs({}), ["gone"]), [], "a deleted row is forgotten");
});
