// The equipment list's model (equipmentRows.ts). Pure, no DOM.
//
// Three rules carry this file, and all three are the kind that a later
// "simplification" collapses without any test going red unless one is written:
//
//   1. POWERED UP and RUNNING are different questions.
//   2. `null` running is NOT KNOWN, never Idle.
//   3. An OFFLINE module is LISTED — that listing is the only way to power one
//      up in space, because the Fitting window is docked-only.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_TARGET,
  NO_TARGET,
  cycleIsBaseFigure,
  cycleLengthLabel,
  equipmentRows,
  runningText,
  slotLabelFor,
  targetChoice,
} from "./equipmentRows.ts";
import type { FittingSlot, ModuleCycle } from "../store/types.ts";

function slot(
  family: FittingSlot["family"],
  index: number,
  mod: { itemID: number; typeID: number; online?: boolean } | null,
): FittingSlot {
  return {
    family,
    index,
    module: mod
      ? {
          itemID: mod.itemID,
          typeID: mod.typeID,
          groupID: null,
          online: mod.online ?? true,
          charge: null,
        }
      : null,
  } as FittingSlot;
}

/** Names resolve to something obvious; the group is the second element. */
const namer = (typeID: number) => [`Module ${typeID}`, "Mining Laser"] as const;
const NO_CYCLES: Record<number, ModuleCycle> = {};

test("rigs and subsystems are left out — there is no control to put on their row", () => {
  const rows = equipmentRows(
    [
      slot("high", 0, { itemID: 1, typeID: 483 }),
      slot("rig", 0, { itemID: 2, typeID: 31358 }),
      slot("subsystem", 0, { itemID: 3, typeID: 30000 }),
      slot("low", 0, { itemID: 4, typeID: 1319 }),
    ],
    null,
    namer,
    NO_CYCLES,
  );
  assert.deepEqual(rows.map((row) => row.itemID), [1, 4]);
});

test("an empty slot yields no row", () => {
  assert.equal(equipmentRows([slot("mid", 0, null)], null, namer, NO_CYCLES).length, 0);
});

test("⚠ AN OFFLINE MODULE IS LISTED — that row is the only way to power it up in space", () => {
  // It used to be skipped, and the panel told the player to go to the Fitting
  // window for the one click that powers it up. Fitting is DOCKED-ONLY.
  const rows = equipmentRows(
    [slot("high", 0, { itemID: 1, typeID: 483, online: false })],
    [],
    namer,
    NO_CYCLES,
  );
  assert.equal(rows.length, 1, "the offline module vanished from the list");
  assert.equal(rows[0]!.online, false);
});

test("⚠ POWERED UP AND RUNNING ARE DIFFERENT QUESTIONS", () => {
  const [offline] = equipmentRows(
    [slot("high", 0, { itemID: 1, typeID: 483, online: false })],
    [1],
    namer,
    NO_CYCLES,
  );
  // Even with the server listing it as active, a module that is not powered up
  // cannot be running — that is a FACT, not a guess, so it does not go through
  // the unknown branch.
  assert.equal(offline!.online, false);
  assert.equal(offline!.running, false);
  assert.equal(runningText(offline!), "Not powered up");

  const [idle] = equipmentRows([slot("high", 0, { itemID: 1, typeID: 483 })], [], namer, NO_CYCLES);
  assert.equal(runningText(idle!), "Idle", "online but not cycling is Idle, not 'off'");

  const [live] = equipmentRows([slot("high", 0, { itemID: 1, typeID: 483 })], [1], namer, NO_CYCLES);
  assert.equal(runningText(live!), "Running");
});

test("⚠ A NULL ACTIVE LIST IS 'NOT KNOWN', NEVER IDLE", () => {
  // `activeModuleIDs === null` means the server did not tell us what is
  // cycling. Rendering that as Idle invites a second activation on a module
  // that is already running.
  const [row] = equipmentRows([slot("high", 0, { itemID: 1, typeID: 483 })], null, namer, NO_CYCLES);
  assert.equal(row!.running, null);
  assert.equal(runningText(row!), "Not known");
});

test("the group name is carried through, and an unresolved one stays null", () => {
  const [resolved] = equipmentRows(
    [slot("high", 0, { itemID: 1, typeID: 483 })],
    null,
    namer,
    NO_CYCLES,
  );
  assert.equal(resolved!.group, "Mining Laser");
  // "cannot tell" must not become a definitive "not a miner".
  const [unknown] = equipmentRows(
    [slot("high", 0, { itemID: 1, typeID: 483 })],
    null,
    () => ["Module 483", null],
    NO_CYCLES,
  );
  assert.equal(unknown!.group, null);
});

test("slots are named in player words, never by flag", () => {
  assert.equal(slotLabelFor("high"), "High slot");
  assert.equal(slotLabelFor("mid"), "Mid slot");
  assert.equal(slotLabelFor("low"), "Low slot");
});

// --- cycle figures -----------------------------------------------------------

test("⚠ no cycle figure yields NO label — never a fabricated time", () => {
  assert.equal(cycleLengthLabel(null), "");
  assert.equal(cycleLengthLabel({ durationMs: 0, startedAtMs: null, source: "base" } as ModuleCycle), "");
});

test("a short cycle keeps a decimal; a long one is rounded", () => {
  // Rounding a 2.4s laser to "2s" is a number a player would plan around.
  assert.equal(cycleLengthLabel({ durationMs: 2400, startedAtMs: null, source: "server" } as ModuleCycle), "2.4s");
  assert.equal(cycleLengthLabel({ durationMs: 60000, startedAtMs: null, source: "server" } as ModuleCycle), "60s");
});

test("a BASE figure is flagged so it is not passed off as this pilot's", () => {
  assert.equal(cycleIsBaseFigure({ durationMs: 5000, startedAtMs: null, source: "base" } as ModuleCycle), true);
  assert.equal(cycleIsBaseFigure({ durationMs: 5000, startedAtMs: null, source: "server" } as ModuleCycle), false);
  assert.equal(cycleIsBaseFigure(null), false);
});

// --- what a module is switched on against ------------------------------------

test("⚠ THE DEFAULT IS AUTO — locking something makes it what your gear acts on", () => {
  // Defaulting to "no target" meant a player could lock a rock, press Switch
  // on, and be refused "You need an active target" while staring at the rock
  // they had just locked.
  assert.equal(targetChoice(AUTO_TARGET, [555, 666]), 555);
  assert.equal(targetChoice(AUTO_TARGET, []), 0, "auto with nothing locked is no target");
});

test("an explicit pick is honoured while it is still locked", () => {
  assert.equal(targetChoice("666", [555, 666]), 666);
});

test("⚠ A STALE PICK FALLS BACK TO AUTO rather than being sent to be refused", () => {
  // The picked target is no longer locked. Sending it would earn a refusal the
  // panel could see coming, with the player's own live lock sitting right there.
  assert.equal(targetChoice("999", [555]), 555);
});

test("'nothing' is an explicit opt-out, for gear that acts on the ship itself", () => {
  assert.equal(targetChoice(NO_TARGET, [555]), 0);
});
