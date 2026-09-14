// Drones by role — that ONE function still answers what TWO used to.
//
// `nav/droneLaunch.ts` was extracted from two knowing copies: `droneRoster` and
// `launchRoleDrones`, private to `nav/scriptMacros.ts` and written for the gun
// ladders, and `combatRoster`/`launchCombatDrones`, copied into
// `nav/droneBoatLadder.ts` because that file cannot import from `scriptMacros.ts`
// (the dependency runs the other way). The two had DIFFERENT SHAPES — one took a
// role and computed its own roster, the other was combat-only and took a roster
// the caller already held, and only the drone boat's carried `roleRows` — so the
// extraction had to unify them rather than delete one. That is the thing worth
// guarding: not that the leaf is correct in the abstract, but that it gives both
// old callers exactly the answer they used to get.
//
// ─── THE REFERENCE COPIES BELOW ARE A FROZEN SNAPSHOT ────────────────────────
//
// `refRoster`/`refLaunchCombat` and `refRosterMacros`/`refLaunchRole` reproduce
// the four deleted functions VERBATIM as they stood at the extraction. They are
// not a second implementation to keep in step with new features.
//
// ⚠ SO A DELIBERATE CHANGE TO THE LEAF IS SUPPOSED TO BREAK THIS FILE. When it
// does, that is the test doing its job: update the reference in the same commit
// and say in the message what behaviour moved and why. Editing the reference to
// match without reading it is the one thing that turns this file into noise —
// it is the only remaining record of what the blocks shipped with.
//
// The differential is an exhaustive cross-product rather than a sample: every
// snapshot shape crossed with every role-list, bay, per-drone fold and memory
// shape, both roles, ~13k cases, deterministic. The count is asserted at the end
// so a builder quietly dropping a dimension cannot shrink the sweep unnoticed.

import test from "node:test";
import assert from "node:assert/strict";

import { canMyShipOrderDrone } from "../space/overview.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, MacroTick } from "./scriptDecide.ts";
import {
  LAUNCH_MAX_TRIES,
  RECALL_MAX_WAIT_TICKS,
  droneRoster,
  launchRoleDrones,
  launchStalled,
  type DroneRole,
} from "./droneLaunch.ts";

// ─── The frozen pre-extraction copies ────────────────────────────────────────

const ACTING = { kind: "acting" } as const;

/** `nav/droneBoatLadder.ts`'s reader: non-finite was already null there. */
function refNumStrict(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** `nav/scriptMacros.ts`'s reader: looser, and the one difference between them. */
function refNumLoose(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" ? value : null;
}
function refFlag(mem: MacroMemory, key: string): boolean {
  return mem[key] === true;
}
function refTick(
  action: MacroTick["action"],
  why: string,
  phase: string,
  outcome: MacroTick["outcome"],
  armed = true,
  nextMem: MacroMemory = {},
): MacroTick {
  return { action, why, phase, armed, outcome, nextMem };
}

/** Was `combatRoster` in `nav/droneBoatLadder.ts`. */
function refRoster(obs: ScriptObservation, snapshot: SpaceSnapshot | null) {
  const shipID = snapshot?.ship?.itemID ?? null;
  const out = (snapshot?.entities ?? [])
    .filter((entity) => canMyShipOrderDrone(entity, shipID) === true)
    .map((entity) => entity.itemID);
  const combat = obs.combatDroneIDs ?? null;
  const combatSet = new Set(combat ?? []);
  const mine = obs.myDrones ?? null;
  return {
    out,
    roleOut: out.filter((id) => combatSet.has(id)),
    roleBay: obs.combatDroneBayItemIDs ?? [],
    othersOut: out.filter((id) => !combatSet.has(id)),
    roleRows:
      mine === undefined || mine === null || combat === null
        ? null
        : mine.filter((row) => combatSet.has(row.itemID)),
  };
}

/** Was `launchCombatDrones` in `nav/droneBoatLadder.ts`. */
function refLaunchCombat(
  _obs: ScriptObservation,
  mem: MacroMemory,
  roster: ReturnType<typeof refRoster>,
  phase: string,
): { readonly tick: MacroTick | null; readonly mem: MacroMemory } {
  if (roster.roleOut.length > 0 || roster.roleBay.length === 0) {
    return { tick: null, mem };
  }
  if (roster.othersOut.length > 0) {
    if (!refFlag(mem, "othersRecalled")) {
      return {
        tick: refTick(
          { kind: "recallDrones", droneIDs: roster.othersOut },
          "Calling the other drones in to make room for the combat drones.",
          phase,
          ACTING,
          true,
          { ...mem, othersRecalled: true, recallWaited: 0 },
        ),
        mem,
      };
    }
    const waited = (refNumStrict(mem, "recallWaited") ?? 0) + 1;
    if (waited <= RECALL_MAX_WAIT_TICKS) {
      return { tick: null, mem: { ...mem, recallWaited: waited } };
    }
  }
  const tries = refNumStrict(mem, "launchTries") ?? 0;
  if (tries >= LAUNCH_MAX_TRIES) {
    return { tick: null, mem };
  }
  return {
    tick: refTick(
      { kind: "launchDrones", droneItemIDs: roster.roleBay },
      "Launching the combat drones.",
      phase,
      ACTING,
      true,
      { ...mem, launchTries: tries + 1 },
    ),
    mem,
  };
}

/** Was `myDroneIDs` in `nav/scriptMacros.ts` (it still is — the recall half stayed). */
function refMyDroneIDs(snapshot: SpaceSnapshot | null): readonly number[] {
  if (snapshot === null) {
    return [];
  }
  const shipID = snapshot.ship?.itemID ?? null;
  return snapshot.entities.filter((e) => canMyShipOrderDrone(e, shipID) === true).map((e) => e.itemID);
}

/** Was `droneRoster` in `nav/scriptMacros.ts` — four fields, no `roleRows`. */
function refRosterMacros(obs: ScriptObservation, role: DroneRole) {
  const out = refMyDroneIDs(obs.snapshot ?? null);
  const roleSet = new Set((role === "combat" ? obs.combatDroneIDs : obs.salvageDroneIDs) ?? []);
  return {
    out,
    roleOut: out.filter((id) => roleSet.has(id)),
    roleBay: (role === "combat" ? obs.combatDroneBayItemIDs : obs.salvageDroneBayItemIDs) ?? [],
    othersOut: out.filter((id) => !roleSet.has(id)),
  };
}

/** Was `launchRoleDrones` in `nav/scriptMacros.ts` — computed its own roster. */
function refLaunchRole(
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  role: DroneRole,
  why: string,
): { readonly tick: MacroTick | null; readonly mem: MacroMemory } {
  const roster = refRosterMacros(obs, role);
  if (roster.roleOut.length > 0 || roster.roleBay.length === 0) {
    return { tick: null, mem };
  }
  if (roster.othersOut.length > 0) {
    if (!refFlag(mem, "othersRecalled")) {
      return {
        tick: refTick(
          { kind: "recallDrones", droneIDs: roster.othersOut },
          `Calling the other drones in to make room for the ${role} drones.`,
          phase,
          ACTING,
          true,
          { ...mem, othersRecalled: true, recallWaited: 0 },
        ),
        mem,
      };
    }
    const waited = (refNumLoose(mem, "recallWaited") ?? 0) + 1;
    if (waited <= RECALL_MAX_WAIT_TICKS) {
      return { tick: null, mem: { ...mem, recallWaited: waited } };
    }
  }
  const tries = refNumLoose(mem, "launchTries") ?? 0;
  if (tries >= LAUNCH_MAX_TRIES) {
    return { tick: null, mem };
  }
  return {
    tick: refTick({ kind: "launchDrones", droneItemIDs: roster.roleBay }, why, phase, ACTING, true, {
      ...mem,
      launchTries: tries + 1,
    }),
    mem,
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────

const MY_SHIP = 100;
const OTHER_SHIP = 200;

function drone(itemID: number, controllerID: number | null): unknown {
  return { itemID, kind: "drone", controllerID };
}

function snap(ship: number | null, entities: readonly unknown[]): SpaceSnapshot {
  return { ship: ship === null ? null : { itemID: ship }, entities } as unknown as SpaceSnapshot;
}

/** The observation shapes, with only the fields these two functions read. */
function obsOf(over: Record<string, unknown>): ScriptObservation {
  return over as unknown as ScriptObservation;
}

// Every drone-ownership shape that changes `out`: ours, another ship's, a
// non-drone entity, and the two unreadable halves (no hull id, no snapshot).
const SNAPSHOTS: readonly (SpaceSnapshot | null)[] = [
  null,
  snap(MY_SHIP, []),
  snap(MY_SHIP, [drone(1000, MY_SHIP), drone(1001, MY_SHIP)]),
  snap(MY_SHIP, [drone(1000, MY_SHIP), drone(1001, OTHER_SHIP), { itemID: 1002, kind: "ship", controllerID: MY_SHIP }]),
  snap(null, [drone(1000, MY_SHIP)]),
];

// Null is "the split did not read" and [] is "none of them are this role" — a
// distinction `roleRows` turns into null-versus-empty, so both are swept.
const ROLE_IDS: readonly (readonly number[] | null)[] = [
  null,
  [],
  [1000],
  [1000, 1001],
  [9999],
];

const BAYS: readonly (readonly number[] | null)[] = [null, [], [2001], [2001, 2002]];

const FOLDS: readonly (readonly { itemID: number; shieldRatio: number | null; armorRatio: number | null; hullRatio: number | null }[] | null | undefined)[] = [
  null,
  undefined,
  [],
  [
    { itemID: 1000, shieldRatio: 0.4, armorRatio: null, hullRatio: null },
    { itemID: 1001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
  ],
];

// Memory shapes around every bound the launch carries. Finite only — see the
// non-finite test at the bottom, which is where the two copies parted company.
const MEMS: readonly MacroMemory[] = [
  {},
  { othersRecalled: true },
  { othersRecalled: false },
  { othersRecalled: true, recallWaited: 0 },
  { othersRecalled: true, recallWaited: RECALL_MAX_WAIT_TICKS - 1 },
  { othersRecalled: true, recallWaited: RECALL_MAX_WAIT_TICKS },
  { othersRecalled: true, recallWaited: RECALL_MAX_WAIT_TICKS + 1 },
  { launchTries: LAUNCH_MAX_TRIES - 1 },
  { launchTries: LAUNCH_MAX_TRIES },
  { launchTries: LAUNCH_MAX_TRIES + 1, othersRecalled: true, recallWaited: 99 },
];

const ROLES: readonly DroneRole[] = ["combat", "salvage"];

// ─── The differential ────────────────────────────────────────────────────────

test("the leaf gives the drone boat exactly what its own copy gave it", () => {
  let cases = 0;
  for (const snapshot of SNAPSHOTS) {
    for (const combatDroneIDs of ROLE_IDS) {
      for (const combatDroneBayItemIDs of BAYS) {
        for (const myDrones of FOLDS) {
          const obs = obsOf({
            snapshot,
            combatDroneIDs,
            combatDroneBayItemIDs,
            myDrones,
            salvageDroneIDs: [1001],
            salvageDroneBayItemIDs: [3001],
          });
          const where = JSON.stringify({ combatDroneIDs, combatDroneBayItemIDs, myDrones: myDrones ?? String(myDrones) });

          // The roster, all five fields — `roleRows` included, which is the
          // field only this caller reads and the one with the three-state null.
          const now = droneRoster(obs, "combat");
          assert.deepEqual(now, refRoster(obs, snapshot), `roster for ${where}`);

          for (const mem of MEMS) {
            // The drone boat passed a roster it already held; the leaf takes it
            // as the optional last argument, and that path must not diverge.
            assert.deepEqual(
              launchRoleDrones(obs, mem, "Fighting", "combat", "Launching the combat drones.", now),
              refLaunchCombat(obs, mem, refRoster(obs, snapshot), "Fighting"),
              `launch for ${where} with ${JSON.stringify(mem)}`,
            );
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, SNAPSHOTS.length * ROLE_IDS.length * BAYS.length * FOLDS.length * MEMS.length);
});

test("the leaf gives the gun ladders exactly what their copy gave them", () => {
  let cases = 0;
  for (const snapshot of SNAPSHOTS) {
    for (const roleIDs of ROLE_IDS) {
      for (const bay of BAYS) {
        for (const role of ROLES) {
          const obs = obsOf({
            snapshot,
            combatDroneIDs: role === "combat" ? roleIDs : [1001],
            salvageDroneIDs: role === "salvage" ? roleIDs : [1001],
            combatDroneBayItemIDs: role === "combat" ? bay : [2001],
            salvageDroneBayItemIDs: role === "salvage" ? bay : [3001],
            myDrones: undefined,
          });
          const where = JSON.stringify({ role, roleIDs, bay });

          // Four fields only: `roleRows` is new and additive, and no caller on
          // this side has ever read it.
          const now = droneRoster(obs, role);
          const ref = refRosterMacros(obs, role);
          assert.deepEqual(
            { out: now.out, roleOut: now.roleOut, roleBay: now.roleBay, othersOut: now.othersOut },
            ref,
            `roster for ${where}`,
          );

          for (const mem of MEMS) {
            const why = `Launching the ${role} drones.`;
            // No roster argument: the leaf reads its own, the way this caller did.
            assert.deepEqual(
              launchRoleDrones(obs, mem, "Fighting", role, why),
              refLaunchRole(obs, mem, "Fighting", role, why),
              `launch for ${where} with ${JSON.stringify(mem)}`,
            );
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, SNAPSHOTS.length * ROLE_IDS.length * BAYS.length * ROLES.length * MEMS.length);
});

test("a roster the caller already holds is the same roster the leaf would read", () => {
  // The optional `roster` argument exists only to save the drone boat a second
  // walk of the snapshot. If it were ever passed a roster for a DIFFERENT role
  // the launch would recall the wrong drones, so the two paths are pinned equal.
  for (const snapshot of SNAPSHOTS) {
    for (const role of ROLES) {
      const obs = obsOf({
        snapshot,
        combatDroneIDs: [1000],
        salvageDroneIDs: [1001],
        combatDroneBayItemIDs: [2001],
        salvageDroneBayItemIDs: [3001],
        myDrones: undefined,
      });
      assert.deepEqual(
        launchRoleDrones(obs, {}, "Fighting", role, "why", droneRoster(obs, role)),
        launchRoleDrones(obs, {}, "Fighting", role, "why"),
      );
    }
  }
});

// ─── The one place the copies disagreed ──────────────────────────────────────

test("⚠ a non-finite counter reads as absent, which neither abandons nor spins", () => {
  // The two copies did NOT agree here: `fight-the-rats` read any `typeof number`
  // and the drone boat's copy already required a finite one. The leaf takes the
  // finite test, so this is the one input where it does not reproduce
  // `fight-the-rats` — and it is unreachable, because `launchTries` has exactly
  // one writer (the launch itself, seeding 0 and adding 1) and every writer of
  // `recallWaited` does the same.
  //
  // It is pinned because of WHICH WAY the loose reader failed. `Infinity >= 3`
  // is true, so a drone boat would stop launching for the rest of the run and
  // sit on the grid with a full bay; `NaN >= 3` is false, so it would relaunch
  // every tick and book a refusal each time, and enough refusals on one key end
  // the run. The finite reader produces neither: a junk counter reads as 0 and
  // the launch simply starts over.
  const obs = obsOf({
    snapshot: snap(MY_SHIP, []),
    combatDroneIDs: [],
    combatDroneBayItemIDs: [2001],
    salvageDroneIDs: [],
    salvageDroneBayItemIDs: [],
    myDrones: undefined,
  });
  for (const junk of [NaN, Infinity, -Infinity, "3", null, undefined, {}]) {
    const out = launchRoleDrones(obs, { launchTries: junk }, "Fighting", "combat", "why");
    assert.notEqual(out.tick, null, `a junk counter must not abandon the launch: ${String(junk)}`);
    assert.equal(out.tick?.nextMem["launchTries"], 1, `and it must count from 1: ${String(junk)}`);
    assert.equal(launchStalled({ launchTries: junk }), false, `nor read as stalled: ${String(junk)}`);
  }
  // A real budget still stops it.
  assert.equal(launchStalled({ launchTries: LAUNCH_MAX_TRIES }), true);
  assert.equal(launchRoleDrones(obs, { launchTries: LAUNCH_MAX_TRIES }, "Fighting", "combat", "why").tick, null);
});

// ─── The behaviours the leaf is FOR ──────────────────────────────────────────
//
// The differential above proves the move; these say what the module is for, so
// a future reader has the rules in prose and not only as a diff against a copy.

test("the wrong role's drones are called in ONCE, then the launch waits for them", () => {
  const obs = obsOf({
    snapshot: snap(MY_SHIP, [drone(1000, MY_SHIP)]),
    combatDroneIDs: [],
    combatDroneBayItemIDs: [2001],
    salvageDroneIDs: [1000],
    salvageDroneBayItemIDs: [],
    myDrones: undefined,
  });
  const first = launchRoleDrones(obs, {}, "Fighting", "combat", "why");
  assert.deepEqual(first.tick?.action, { kind: "recallDrones", droneIDs: [1000] });
  // The flag is what makes it ONCE: a recall re-issued every tick is a rung that
  // starves every rung below it, and the fight never starts.
  const second = launchRoleDrones(obs, first.tick?.nextMem ?? {}, "Fighting", "combat", "why");
  assert.equal(second.tick, null);
  assert.equal(second.mem["recallWaited"], 1);
});

test("a drone that never comes home does not end the fight", () => {
  // Unbounded, the wait above is a bot that sits for ever behind one drone that
  // will not answer. Past the bound the launch goes ahead anyway.
  const obs = obsOf({
    snapshot: snap(MY_SHIP, [drone(1000, MY_SHIP)]),
    combatDroneIDs: [],
    combatDroneBayItemIDs: [2001],
    salvageDroneIDs: [1000],
    salvageDroneBayItemIDs: [],
    myDrones: undefined,
  });
  const mem = { othersRecalled: true, recallWaited: RECALL_MAX_WAIT_TICKS };
  const out = launchRoleDrones(obs, mem, "Fighting", "combat", "why");
  assert.deepEqual(out.tick?.action, { kind: "launchDrones", droneItemIDs: [2001] });
});

test("nothing to do when the role is already out, or when its bay is empty", () => {
  // Either way this rung must fall through: a rung that returns an action every
  // tick starves every rung below it, and the ship never fires.
  const alreadyOut = obsOf({
    snapshot: snap(MY_SHIP, [drone(1000, MY_SHIP)]),
    combatDroneIDs: [1000],
    combatDroneBayItemIDs: [2001],
    salvageDroneIDs: [],
    salvageDroneBayItemIDs: [],
    myDrones: undefined,
  });
  assert.equal(launchRoleDrones(alreadyOut, {}, "Fighting", "combat", "why").tick, null);

  const emptyBay = obsOf({
    snapshot: snap(MY_SHIP, []),
    combatDroneIDs: [],
    combatDroneBayItemIDs: [],
    salvageDroneIDs: [],
    salvageDroneBayItemIDs: [],
    myDrones: undefined,
  });
  assert.equal(launchRoleDrones(emptyBay, {}, "Fighting", "combat", "why").tick, null);
});

test("⚠ roleRows is null when NOBODY LOOKED and empty when the flight is in the bay", () => {
  // The rotation machine reads this distinction and would otherwise write a live
  // drone off as dead. BOTH halves have to be readable: without the role split a
  // salvage drone losing shield would be rotated by the COMBAT block, which is a
  // recall of something that block never launched.
  const entities = [drone(1000, MY_SHIP)];
  const fold = [{ itemID: 1000, shieldRatio: 0.4, armorRatio: null, hullRatio: null }];

  const noFold = obsOf({ snapshot: snap(MY_SHIP, entities), combatDroneIDs: [1000], myDrones: undefined });
  assert.equal(droneRoster(noFold, "combat").roleRows, null, "no per-drone fold");

  const noSplit = obsOf({ snapshot: snap(MY_SHIP, entities), combatDroneIDs: null, myDrones: fold });
  assert.equal(droneRoster(noSplit, "combat").roleRows, null, "no role split");

  const inBay = obsOf({ snapshot: snap(MY_SHIP, entities), combatDroneIDs: [], myDrones: fold });
  assert.deepEqual(droneRoster(inBay, "combat").roleRows, [], "readable, and none of them are combat");

  const out = obsOf({ snapshot: snap(MY_SHIP, entities), combatDroneIDs: [1000], myDrones: fold });
  assert.deepEqual(droneRoster(out, "combat").roleRows, fold, "readable, and one of them is");
});

test("a drone under another ship's control is nobody's to order", () => {
  // `out` is what a RECALL takes, and a recall of a drone we do not control is
  // answered with a 200 that moves nothing — a rung waiting on it waits for ever.
  const obs = obsOf({
    snapshot: snap(MY_SHIP, [drone(1000, MY_SHIP), drone(1001, OTHER_SHIP), drone(1002, null)]),
    combatDroneIDs: [1000, 1001, 1002],
    combatDroneBayItemIDs: [],
    myDrones: undefined,
  });
  assert.deepEqual(droneRoster(obs, "combat").out, [1000]);
});
