// The selection bar's verb set (goal R30 slice D), as DATA.
//
// This is the file the Overview suites' markup regexes were re-pointed at. The
// claim "the flight verbs are generic, and Dock is offered on a station and not
// on a rock" used to be checked by grepping `Overview.svelte` for `class=
// "row-actions"` and for the exact call text `flow.dockAt(row.itemID)`. Neither
// of those checked the decision — they checked that some characters were still
// present in a template. Here the decision is a returned array, so the test can
// read it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  actionsForRow,
  isDockableKind,
  isLootableKind,
  isMiningGroup,
  MINING_GROUP_NAMES,
  SELECTION_GONE,
  shipActions,
  type RowActionContext,
} from "./rowActions.ts";
import type { GateLink } from "./gateLinks.ts";

const A_ROCK: RowActionContext = {
  kind: "asteroid",
  locked: false,
  acquiring: false,
  gateLink: null,
  minerCount: 2,
};

function ids(ctx: RowActionContext): string[] {
  return actionsForRow(ctx).map((action) => action.id);
}

// --- The generic core --------------------------------------------------------

test("every thing in space gets the same five flight verbs — there is no branch on what it is", () => {
  // THE GENERICITY CLAIM, as data. A rock, a station, another player's ship and
  // a wreck are all just balls with a position as far as movement is concerned,
  // and the server treats them identically. If a later goal ever grows an
  // "if this is a rock…" here, this fails.
  const flight = ["warp", "approach", "orbit", "keepAtRange", "align"];
  for (const kind of ["asteroid", "station", "ship", "wreck", "structure", "cargo", null]) {
    const got = ids({ ...A_ROCK, kind });
    for (const verb of flight) {
      assert.ok(got.includes(verb), `a ${kind ?? "kind-less"} row must offer ${verb}`);
    }
  }
});

test("every action carries a label a player can read, and never an id", () => {
  for (const action of actionsForRow(A_ROCK)) {
    assert.ok(action.label.length > 0, `${action.id} must have a label`);
    // R7d — no bare numbers anywhere in the words on a control.
    assert.doesNotMatch(action.label, /\d{4,}/, `${action.id} must not name an id`);
  }
});

test("every action declares the concern it is busy on — never a shared flag", () => {
  // The per-concern busy set is what keeps Stop enabled while a lock is in
  // flight. An action with no concern would have to fall back to a global flag.
  const allowed = new Set(["move", "lock", "module", "drone", "hold", "route"]);
  for (const action of actionsForRow({ ...A_ROCK, locked: true })) {
    assert.ok(allowed.has(action.concern), `${action.id} has an unknown concern`);
  }
});

// --- Dock: decided from the server's own kind --------------------------------

test("R24: a station offers Dock and a rock does not — from the ball's KIND", () => {
  assert.ok(ids({ ...A_ROCK, kind: "station" }).includes("dock"));
  assert.ok(ids({ ...A_ROCK, kind: "structure" }).includes("dock"));
  assert.equal(ids({ ...A_ROCK, kind: "asteroid" }).includes("dock"), false);
  assert.equal(ids({ ...A_ROCK, kind: "ship" }).includes("dock"), false);
  // And the predicate itself, which is the only thing that decides it. Not the
  // name, not the distance, not the category number.
  assert.equal(isDockableKind("station"), true);
  assert.equal(isDockableKind("structure"), true);
  assert.equal(isDockableKind("asteroid"), false);
  assert.equal(isDockableKind(null), false);
});

// --- Lock: the three honest states -------------------------------------------

test("lock, release and the middle state are three different offers", () => {
  assert.deepEqual(
    actionsForRow(A_ROCK).filter((a) => a.concern === "lock").map((a) => [a.id, a.label]),
    [["lock", "Lock"]],
  );
  assert.deepEqual(
    actionsForRow({ ...A_ROCK, locked: true }).filter((a) => a.concern === "lock").map((a) => [a.id, a.label]),
    [["unlock", "Release lock"]],
  );
  // Still acquiring: the lock has NOT landed, and the control says so rather
  // than reading "Release lock" as though it had.
  assert.deepEqual(
    actionsForRow({ ...A_ROCK, acquiring: true }).filter((a) => a.concern === "lock").map((a) => [a.id, a.label]),
    [["unlock", "Locking… stop"]],
  );
});

// --- Jump: only on a gate, and an unusable one says why ----------------------

const GOOD_GATE: GateLink = {
  gateID: 5001,
  toSystemID: 30000142,
  toSystemName: "Jita",
  destinationGateID: 5002,
};

test("R30 slice A: Jump appears only on a gate, and names the system", () => {
  assert.equal(ids(A_ROCK).includes("jump"), false, "a rock is not a gate");
  const jump = actionsForRow({ ...A_ROCK, gateLink: GOOD_GATE }).find((a) => a.id === "jump");
  assert.ok(jump, "a gate row offers Jump");
  assert.equal(jump.label, "Jump to Jita");
  assert.equal(jump.unavailable, null);
});

test("a gate with no far side is still OFFERED, carrying the reason it cannot be used", () => {
  // ⚠ The rule the whole module turns on: an unavailable action states its
  // reason. It is never dropped from the list and never silently greyed out.
  const jump = actionsForRow({
    ...A_ROCK,
    gateLink: { ...GOOD_GATE, destinationGateID: 0 },
  }).find((a) => a.id === "jump");
  assert.ok(jump, "the action is still returned");
  assert.equal(typeof jump.unavailable, "string");
  assert.ok((jump.unavailable ?? "").length > 10, "and the reason is a sentence, not a flag");
});

test("no action is ever returned with an empty-string reason — null means usable", () => {
  // A "" reason would render as a disabled control with no explanation, which
  // is exactly the silent grey rectangle this module exists to prevent.
  for (const ctx of [A_ROCK, { ...A_ROCK, kind: "station" }, { ...A_ROCK, gateLink: GOOD_GATE }]) {
    for (const action of actionsForRow(ctx)) {
      assert.notEqual(action.unavailable, "", `${action.id} must use null, not ""`);
    }
  }
});

// --- R30 slice E: Mine this --------------------------------------------------

test("Mine this is offered on ANYTHING — what can be mined is the server's call", () => {
  // A browser that pre-filtered on `kind === "asteroid"` would refuse ice and
  // gas it has never been told about. The server owns that answer.
  for (const kind of ["asteroid", "ship", "station", "cargo", null]) {
    assert.ok(
      ids({ ...A_ROCK, kind, locked: true }).includes("mine"),
      `a ${kind ?? "kind-less"} row must still offer Mine this`,
    );
  }
});

test("Mine this states WHICH rule is stopping it, and they are the server's own", () => {
  const reason = (ctx: Partial<RowActionContext>) =>
    actionsForRow({ ...A_ROCK, ...ctx }).find((a) => a.id === "mine")?.unavailable ?? null;

  // Nothing powered up: there is nothing to run.
  assert.match(reason({ minerCount: 0, locked: true }) ?? "", /switched on/i);
  // Powered up but no lock: a module needs a fix on the target before it runs.
  assert.match(reason({ minerCount: 1, locked: false }) ?? "", /lock/i);
  // Both satisfied.
  assert.equal(reason({ minerCount: 1, locked: true }), null);
  // And the two are DIFFERENT sentences — a player fixes them differently.
  assert.notEqual(reason({ minerCount: 0, locked: true }), reason({ minerCount: 1, locked: false }));
});

test("R47 — a miner is decided by the GAME'S GROUP, not by guessing at the name", () => {
  // The groups the SDE files real mining modules under, resolved live through
  // /api/names (typeGroup). Strip Miner I -> "Strip Miner", Miner I ->
  // "Mining Laser", etc.
  assert.equal(isMiningGroup("Strip Miner"), true, "Strip Miner I / Ice Harvester I/II");
  assert.equal(isMiningGroup("Mining Laser"), true, "Miner I/II, Deep Core Mining Laser I");
  assert.equal(isMiningGroup("Frequency Mining Laser"), true, "Modulated Strip/Deep Core Miner II");
  assert.equal(isMiningGroup("Gas Cloud Harvesters"), true);
  assert.equal(isMiningGroup("Gas Cloud Scoops"), true);
  assert.equal(isMiningGroup("Citizen Mining Laser"), true);

  // ⚠ The names the OLD guess got wrong, now answered by the group instead of a
  // regex over English. "Mining Upgrade" is the low-slot passive; "Rig Resource
  // Processing" is the Ice Harvester rig; "Command Burst" / "Gang Coordinator"
  // are mining FLEET modules that are not lasers at all.
  assert.equal(isMiningGroup("Mining Upgrade"), false, "Ice Harvester Upgrade II lives here");
  assert.equal(isMiningGroup("Rig Resource Processing"), false, "the Ice Harvester Accelerator rig");
  assert.equal(isMiningGroup("Command Burst"), false, "Mining Foreman Burst is not a laser");
  assert.equal(isMiningGroup("Gang Coordinator"), false, "a Mining Foreman Link is not a laser");
  assert.equal(isMiningGroup("Data Miners"), false, "a Data Analyzer is not a mining laser");
  assert.equal(isMiningGroup("Salvager"), false);

  // The set is exactly those six — no more, so a new group cannot slip in
  // unnoticed, and no fewer, so a real family cannot silently drop out.
  assert.equal(MINING_GROUP_NAMES.size, 6);
});

// --- R30 slice E: Haul now ---------------------------------------------------

test("Haul now is ALWAYS offered — every blocked case says why, in its own words", () => {
  const haul = (ctx: Parameters<typeof shipActions>[0]) => {
    const actions = shipActions(ctx);
    assert.equal(actions.length, 1, "there is exactly one haul verb, in every case");
    return actions[0]!;
  };

  // ⚠ The acceptance case from the goal: no station on this grid.
  const nowhere = haul({ nearestStationName: null, docked: false, hasCargo: true });
  assert.equal(nowhere.id, "haul", "the action is still returned, not dropped");
  assert.match(nowhere.unavailable ?? "", /no station on this grid/i);

  // Empty holds is a DIFFERENT fact and reads differently.
  const empty = haul({ nearestStationName: "Jita IV", docked: false, hasCargo: false });
  assert.match(empty.unavailable ?? "", /nothing in your holds/i);
  assert.notEqual(empty.unavailable, nowhere.unavailable);

  // Usable in space: it NAMES where it would fly, so pressing it is not a
  // surprise — and it names it, never an id (R7d).
  const flying = haul({ nearestStationName: "Jita IV", docked: false, hasCargo: true });
  assert.equal(flying.unavailable, null);
  assert.match(flying.label, /Jita IV/);
  assert.doesNotMatch(flying.label, /\d{4,}/);

  // Already docked: there is nowhere to fly, so it does not pretend there is.
  const docked = haul({ nearestStationName: null, docked: true, hasCargo: true });
  assert.equal(docked.unavailable, null, "docked with cargo, hauling is just the unload");
  assert.match(docked.label, /Unload/i);
});

test("Haul now belongs to the hold concern, so it cannot grey out Stop or a lock", () => {
  assert.equal(shipActions({ nearestStationName: "X", docked: false, hasCargo: true })[0]?.concern, "hold");
});

// --- The selection rule ------------------------------------------------------

test("the lost-selection sentence is plain player language, and names no id", () => {
  assert.match(SELECTION_GONE, /no longer/i);
  assert.doesNotMatch(SELECTION_GONE, /\d/, "R7d: it never quotes what it lost by number");
});

// --- R49: depletion is the server's, not the client's -----------------------
//
// Until R49 the "Mine this" verb carried a "no ore left" reason whenever the
// client thought a rock was empty, from a merged ore count. It no longer does:
// the server owns depletion and REMOVES a mined-out rock from the grid, so a
// rock the client can still see is a rock to mine. The verb is gated only by the
// server's own rules — equipment switched on, and the rock locked first. (The
// "Ore left" column still shows the survey scan; that is a readout, not a gate.)

test("R49: Mine this never carries a depletion reason — a rock still on the grid is mineable", () => {
  const reason = (ctx: Partial<RowActionContext>) =>
    actionsForRow({ ...A_ROCK, ...ctx }).find((a) => a.id === "mine")?.unavailable ?? null;
  // Locked, equipment on: usable, full stop. There is no ore-count gate left —
  // and no way to pass one, since the context no longer carries an ore count.
  assert.equal(reason({ minerCount: 1, locked: true }), null);
});

test("R49: the verb is still offered, and its only reasons are the server's own rules in order", () => {
  const mine = actionsForRow({ ...A_ROCK, minerCount: 0, locked: false }).find((a) => a.id === "mine");
  assert.ok(mine, "the verb is always offered");
  // Equipment-off comes first, then the lock — the two rules the SERVER enforces.
  assert.match(mine.unavailable ?? "", /No mining equipment/i);
  const reason = (ctx: Partial<RowActionContext>) =>
    actionsForRow({ ...A_ROCK, ...ctx }).find((a) => a.id === "mine")?.unavailable ?? null;
  assert.match(reason({ minerCount: 1, locked: false }) ?? "", /Lock it first/i);
});

test("R49: neither remaining reason mentions ore being gone", () => {
  const reason = (ctx: Partial<RowActionContext>) =>
    actionsForRow({ ...A_ROCK, ...ctx }).find((a) => a.id === "mine")?.unavailable ?? "";
  assert.doesNotMatch(reason({ minerCount: 0, locked: false }), /no ore|empty|mined out/i);
  assert.doesNotMatch(reason({ minerCount: 1, locked: false }), /no ore|empty|mined out/i);
});

// --- Taking what is inside ---------------------------------------------------
//
// The gap this closed: a wreck could be warped to, approached, locked and
// salvaged from this bar, and there was no verb anywhere in space for taking
// what was INSIDE it. The only route to a wreck's contents was a custom bot with
// a loot-wrecks block; the Station panel's "open this crate" is docked-only.

test("Take everything is offered on the two things that HOLD something, and on nothing else", () => {
  for (const kind of ["wreck", "container"]) {
    assert.ok(ids({ ...A_ROCK, kind }).includes("loot"), `a ${kind} can be emptied`);
  }
  // A rock, a station, a gate and another ship have no inventory to reach into.
  for (const kind of ["asteroid", "station", "structure", "ship", "celestial", null]) {
    assert.ok(
      !ids({ ...A_ROCK, kind }).includes("loot"),
      `a ${kind ?? "kind-less"} row must not offer it`,
    );
  }
});

test("what can be emptied is the SERVER'S runtime kind, never a guess at a name", () => {
  // The same two strings the loot blocks filter on (nav/scriptMacros.ts), so the
  // verb a player presses and the bot that does it unattended cannot disagree.
  assert.equal(isLootableKind("wreck"), true);
  assert.equal(isLootableKind("container"), true);
  assert.equal(isLootableKind("asteroid"), false);
  assert.equal(isLootableKind(null), false);
});

test("Take everything is never blocked by a distance this side worked out", () => {
  // Retail will not open a can past 2,500 m — and that is the GATEWAY'S rule,
  // which it states itself. A reason invented here would put a guessed rule on
  // screen beside the real one, so the verb goes out at any range and the server
  // answers. (The context carries no distance at all, which is the structural
  // half of the same guarantee.)
  const loot = actionsForRow({ ...A_ROCK, kind: "wreck" }).find((a) => a.id === "loot");
  assert.ok(loot);
  assert.equal(loot.unavailable, null);
  assert.doesNotMatch(loot.label, /\d/, "R7d: no id, and no range number either");
});

test("Take everything belongs to the hold concern, so it cannot grey out a lock or Stop", () => {
  // The same rule "Haul now" is held to: one busy channel per CONCERN, so a
  // transfer in flight can never disable the lock button in the middle of a
  // fight.
  const loot = actionsForRow({ ...A_ROCK, kind: "wreck" }).find((a) => a.id === "loot");
  assert.equal(loot?.concern, "hold");
});
