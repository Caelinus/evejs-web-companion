// The module-rack model (moduleRack.ts): grouping into high/mid/low, the
// activation overlay from the snapshot, the empty-fit signal — and the click
// decision that makes the rack an F-row rather than a picture.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModuleRack,
  cycleProgressPercent,
  rackClickAction,
  rackDamageBand,
  rackDamageText,
  rackDamageWedge,
  rackHeatBand,
  rackHeatText,
  rackHoldAction,
  rackIsEmpty,
  rackModuleBurntOut,
  rackSlotTitle,
  OVERLOAD_HOLD_MS,
} from "./moduleRack.ts";
import type { RackModule } from "./moduleRack.ts";
import type { FittingSlot } from "../store/types.ts";

function slot(family: FittingSlot["family"], index: number, mod: { itemID: number; typeID: number; online?: boolean } | null): FittingSlot {
  return {
    family,
    index,
    module: mod ? { itemID: mod.itemID, typeID: mod.typeID, groupID: null, online: mod.online ?? true, charge: null } : null,
  };
}

test("groups slots into high/mid/low in order, skipping rigs/subsystems", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 1, typeID: 3634 }),
    slot("mid", 0, { itemID: 2, typeID: 5001 }),
    slot("low", 0, null),
    slot("rig", 0, { itemID: 9, typeID: 31358 }),
    slot("subsystem", 0, { itemID: 10, typeID: 30000 }),
  ];
  const rows = buildModuleRack(slots, null);
  assert.deepEqual(rows.map((r) => r.family), ["high", "mid", "low"]);
  assert.equal(rows[0]!.slots.length, 1);
  assert.equal(rows[1]!.slots.length, 1);
  assert.equal(rows[2]!.slots.length, 1);
  // The low slot is present but empty.
  assert.equal(rows[2]!.slots[0]!.module, null);
});

test("marks a module active when the snapshot lists its itemID", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 1, typeID: 3634 }),
    slot("high", 1, { itemID: 2, typeID: 3634 }),
  ];
  const rows = buildModuleRack(slots, [1]);
  assert.equal(rows[0]!.slots[0]!.module?.active, true, "module 1 should be active");
  assert.equal(rows[0]!.slots[1]!.module?.active, false, "module 2 should be idle");
});

test("no snapshot means nothing glows", () => {
  const slots: FittingSlot[] = [slot("high", 0, { itemID: 1, typeID: 3634 })];
  assert.equal(buildModuleRack(slots, null)[0]!.slots[0]!.module?.active, false);
});

test("an offline module carries its offline flag through", () => {
  const slots: FittingSlot[] = [slot("mid", 0, { itemID: 7, typeID: 5001, online: false })];
  assert.equal(buildModuleRack(slots, [])[1]!.slots[0]!.module?.online, false);
});

test("rackIsEmpty is true only when no slots exist at all", () => {
  assert.equal(rackIsEmpty(buildModuleRack([], null)), true);
  assert.equal(rackIsEmpty(buildModuleRack([slot("high", 0, null)], null)), false);
});

test("the rack carries each module's itemID — what activation addresses", () => {
  const rows = buildModuleRack([slot("high", 0, { itemID: 42, typeID: 3634 })], []);
  assert.equal(rows[0]!.slots[0]!.module?.itemID, 42);
});

// --- the click decision -------------------------------------------------------

function rackModule(overrides: Partial<RackModule> = {}): RackModule {
  return { itemID: 42, typeID: 3634, online: true, active: false, charge: null, overloaded: false, damage: 0, bankMasterID: null, bankMaster: false, bankSize: 1, ...overrides };
}

test("a click on an idle online module ACTIVATES it", () => {
  assert.equal(rackClickAction(rackModule()), "activate");
});

test("a click on a cycling module DEACTIVATES it", () => {
  assert.equal(rackClickAction(rackModule({ active: true })), "deactivate");
});

test("⚠ an OFFLINE module is inert — onlining is a Fitting decision, not a rack misclick", () => {
  assert.equal(rackClickAction(rackModule({ online: false })), null);
  // Even an offline module the snapshot somehow calls active stays inert: the
  // fit's offline flag wins, because activating an offline module cannot work.
  assert.equal(rackClickAction(rackModule({ online: false, active: true })), null);
});

test("an empty slot has no click", () => {
  assert.equal(rackClickAction(null), null);
});

// --- the readout line ---------------------------------------------------------

test("the slot title names the module and what a click would do", () => {
  assert.equal(
    rackSlotTitle("Small Shield Booster I", rackModule()),
    "Small Shield Booster I — click to switch on. Hold to overload.",
  );
  assert.equal(
    rackSlotTitle("Small Shield Booster I", rackModule({ active: true })),
    "Small Shield Booster I — active. Click to switch off. Hold to overload.",
  );
  assert.equal(
    rackSlotTitle("Small Shield Booster I", rackModule({ online: false })),
    "Small Shield Booster I — offline (bring it online from the Fitting window)",
  );
  assert.equal(rackSlotTitle("", null), "Empty slot");
});

// --- What is loaded ----------------------------------------------------------
//
// The rack tile is a PICTURE of the module, so a gun that is out of ammunition
// looks exactly like a loaded one. The title is the only place that can say.

test("the rack carries the loaded charge through from the fit", () => {
  const slots: FittingSlot[] = [
    {
      family: "high",
      index: 0,
      module: {
        itemID: 42,
        typeID: 485,
        groupID: 55,
        online: true,
        charge: { itemID: 99, typeID: 184, quantity: 160 },
      },
    },
  ];
  assert.deepEqual(buildModuleRack(slots, [])[0]!.slots[0]!.module?.charge, {
    typeID: 184,
    quantity: 160,
  });
});

test("the slot title says what is loaded, by NAME and count", () => {
  const loaded = rackModule({ charge: { typeID: 184, quantity: 160 } });
  assert.equal(
    rackSlotTitle("150mm Light AutoCannon I", loaded, "Phased Plasma S"),
    "150mm Light AutoCannon I — click to switch on. Loaded: 160 Phased Plasma S. Hold to overload.",
  );
  // Cycling, and offline, keep their own wording and gain the same suffix.
  assert.match(
    rackSlotTitle("150mm Light AutoCannon I", rackModule({ charge: { typeID: 184, quantity: 160 }, active: true }), "Phased Plasma S"),
    /Click to switch off\. Loaded: 160 Phased Plasma S\. Hold to overload\.$/,
  );
});

test("a charge whose name has not resolved yet is left unsaid, never numbered", () => {
  // R7d — the id must not stand in for the name while it is in flight.
  const loaded = rackModule({ charge: { typeID: 184, quantity: 160 } });
  const title = rackSlotTitle("150mm Light AutoCannon I", loaded, null);
  assert.doesNotMatch(title, /184|Loaded/);
});

test("a module with no charge says nothing about ammunition", () => {
  assert.doesNotMatch(rackSlotTitle("Miner I", rackModule(), "Phased Plasma S"), /Loaded/);
});

// --- Overloading --------------------------------------------------------------
//
// ⚠ IT DAMAGES THE MODULE, which is why it lives behind a modifier rather than
// sharing the plain click that fires the gun. The tile is a picture, so the
// title is where the state and the modifier are both said in words.

test("the rack carries the overloaded flag from the snapshot", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 1, typeID: 485 }),
    slot("high", 1, { itemID: 2, typeID: 485 }),
  ];
  const rows = buildModuleRack(slots, [], [1]);
  assert.equal(rows[0]!.slots[0]!.module?.overloaded, true);
  assert.equal(rows[0]!.slots[1]!.module?.overloaded, false);
});

test("⚠ an ABSENT overload list is unknown, NOT 'nothing is hot'", () => {
  // A rack that reported "cool" for a reading it never got would hide a module
  // burning itself out.
  const slots: FittingSlot[] = [slot("high", 0, { itemID: 1, typeID: 485 })];
  assert.equal(buildModuleRack(slots, [], null)[0]!.slots[0]!.module?.overloaded, null);
  assert.equal(buildModuleRack(slots, [])[0]!.slots[0]!.module?.overloaded, null);
  // An EMPTY list is a real answer: nothing is overloaded.
  assert.equal(buildModuleRack(slots, [], [])[0]!.slots[0]!.module?.overloaded, false);
});

test("an overloaded module says so, and says how to stop", () => {
  const title = rackSlotTitle("150mm Light AutoCannon I", rackModule({ overloaded: true }));
  assert.match(title, /Overloaded — running hot and taking damage\./);
  assert.match(title, /Hold to stop\.$/);
});

test("an UNKNOWN overload state says nothing about heat either way", () => {
  const title = rackSlotTitle("150mm Light AutoCannon I", rackModule({ overloaded: null }));
  assert.doesNotMatch(title, /overload/i);
  assert.doesNotMatch(title, /hot/i);
});

// --- Module damage and repair -------------------------------------------------
//
// ⚠ THE COMPLEMENT TO OVERLOADING. Heat damages modules, so shipping overload
// without any way to see or undo the damage left a one-way door: burn a module
// out and it is dead for the session. Damage is 0..1 with 1 meaning burnt out
// (runtime.js isModuleIncapacitated).

test("the rack carries per-module damage, and absent-from-the-map means intact", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 1, typeID: 485 }),
    slot("high", 1, { itemID: 2, typeID: 485 }),
  ];
  const rows = buildModuleRack(slots, [], [], { 1: 0.4 });
  assert.equal(rows[0]!.slots[0]!.module?.damage, 0.4);
  assert.equal(rows[0]!.slots[1]!.module?.damage, 0, "listed nowhere = undamaged");
});

test("⚠ an ABSENT damage map is unknown, NOT 'everything is intact'", () => {
  const slots: FittingSlot[] = [slot("high", 0, { itemID: 1, typeID: 485 })];
  assert.equal(buildModuleRack(slots, [], [], null)[0]!.slots[0]!.module?.damage, null);
  assert.equal(buildModuleRack(slots, [], [])[0]!.slots[0]!.module?.damage, null);
  // An EMPTY map is a real answer.
  assert.equal(buildModuleRack(slots, [], [], {})[0]!.slots[0]!.module?.damage, 0);
});

test("burnt out is a definite 1 — unknown damage is never reported as burnt out", () => {
  assert.equal(rackModuleBurntOut(rackModule({ damage: 1 })), true);
  assert.equal(rackModuleBurntOut(rackModule({ damage: 0.99 })), false);
  assert.equal(rackModuleBurntOut(rackModule({ damage: 0 })), false);
  assert.equal(rackModuleBurntOut(rackModule({ damage: null })), false, "unknown is not burnt out");
  assert.equal(rackModuleBurntOut(null), false);
});

test("damage renders as whole percent, and says nothing when there is none", () => {
  assert.equal(rackDamageText(rackModule({ damage: 0.4 })), "40%");
  assert.equal(rackDamageText(rackModule({ damage: 0.055 })), "6%");
  assert.equal(rackDamageText(rackModule({ damage: 0 })), null);
  assert.equal(rackDamageText(rackModule({ damage: null })), null);
});

test("⚠ a burnt-out module's title leads with WHY it will not run", () => {
  // "click to switch on" on a module the server refuses outright is an
  // invitation to fail, so the damage comes first and names the remedy.
  const title = rackSlotTitle("150mm Light AutoCannon I", rackModule({ damage: 1 }));
  assert.match(title, /^150mm Light AutoCannon I — BURNT OUT\./);
  assert.match(title, /nanite paste/i);
  assert.doesNotMatch(title, /click to switch on/i);
});

test("a partly damaged module still works, and says how worn it is", () => {
  const title = rackSlotTitle("150mm Light AutoCannon I", rackModule({ damage: 0.25 }));
  assert.match(title, /click to switch on\./);
  assert.match(title, /Damaged: 25%\./);
});

// --- Weapon banking -----------------------------------------------------------
//
// ⚠ THE BUG THIS FIXES. dogmaService's Handle_Activate silently redirects a
// banked weapon to its bank MASTER, and the snapshot's activeModuleIDs then
// names only the master. A rack that read each slave's own id showed a tile that
// stayed dark however many times it was clicked, while the whole group fired.

test("⚠ a banked SLAVE reads active when its master is cycling", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 100, typeID: 485 }), // master
    slot("high", 1, { itemID: 101, typeID: 485 }), // slave
  ];
  // Only the MASTER is in the server's cycling list — that is the whole point.
  const rows = buildModuleRack(slots, [100], [], {}, { 100: [101] });
  assert.equal(rows[0]!.slots[0]!.module?.active, true, "the master lights");
  assert.equal(rows[0]!.slots[1]!.module?.active, true, "and so does its slave");
});

test("an unbanked module is unaffected by other ships' banks", () => {
  const slots: FittingSlot[] = [slot("high", 0, { itemID: 200, typeID: 485 })];
  const rows = buildModuleRack(slots, [100], [], {}, { 100: [101] });
  assert.equal(rows[0]!.slots[0]!.module?.active, false);
  assert.equal(rows[0]!.slots[0]!.module?.bankSize, 1);
  assert.equal(rows[0]!.slots[0]!.module?.bankMasterID, null);
});

test("bank membership is carried through, master and slave alike", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, { itemID: 100, typeID: 485 }),
    slot("high", 1, { itemID: 101, typeID: 485 }),
    slot("high", 2, { itemID: 102, typeID: 485 }),
  ];
  const rows = buildModuleRack(slots, [], [], {}, { 100: [101, 102] });
  const modules = rows[0]!.slots.map((s) => s.module!);
  const master = modules[0]!;
  const slaveA = modules[1]!;
  const slaveB = modules[2]!;
  assert.equal(master.bankMaster, true);
  assert.equal(master.bankMasterID, null, "a master fires through itself");
  assert.equal(master.bankSize, 3);
  assert.equal(slaveA.bankMasterID, 100);
  assert.equal(slaveA.bankSize, 3);
  assert.equal(slaveB.bankMasterID, 100);
});

test("⚠ an ABSENT bank map means unbanked, and never invents a group", () => {
  const slots: FittingSlot[] = [slot("high", 0, { itemID: 100, typeID: 485 })];
  for (const banks of [null, undefined]) {
    const module = buildModuleRack(slots, [], [], {}, banks)[0]!.slots[0]!.module!;
    assert.equal(module.bankSize, 1);
    assert.equal(module.bankMasterID, null);
    assert.equal(module.bankMaster, false);
  }
});

test("a banked gun's title says it fires with the others", () => {
  assert.match(
    rackSlotTitle("150mm Light AutoCannon I", rackModule({ bankSize: 3 })),
    /Banked: fires with 2 others\./,
  );
  // Singular reads correctly for a pair.
  assert.match(
    rackSlotTitle("150mm Light AutoCannon I", rackModule({ bankSize: 2 })),
    /Banked: fires with 1 other\./,
  );
  // And an unbanked gun says nothing about banks.
  assert.doesNotMatch(rackSlotTitle("Miner I", rackModule()), /Banked/);
});

// --- The cycle sweep ----------------------------------------------------------
//
// ⚠ NULL IS NOT ZERO. A module with no cycle stamp draws NO bar; an empty bar
// would read as "just started", which is a claim the client does not have. This
// is the same helper the Overview's equipment list uses — one implementation.

test("progress is measured from the SERVER's own cycle stamp", () => {
  const cycle = { durationMs: 10000, source: "server" as const, startedAtMs: 1000, repeating: false };
  assert.equal(cycleProgressPercent(cycle, 1000), 0, "the instant it started");
  assert.equal(cycleProgressPercent(cycle, 6000), 50);
  assert.equal(cycleProgressPercent(cycle, 11000), 100);
  // A non-repeating cycle stops at full rather than wrapping.
  assert.equal(cycleProgressPercent(cycle, 30000), 100);
});

test("a repeating module wraps, cycle after cycle, off its one start event", () => {
  const cycle = { durationMs: 10000, source: "server" as const, startedAtMs: 0, repeating: true };
  assert.equal(cycleProgressPercent(cycle, 5000), 50);
  assert.equal(cycleProgressPercent(cycle, 15000), 50, "second cycle, same place");
  assert.equal(cycleProgressPercent(cycle, 25000), 50, "third");
});

test("⚠ no stamp, no cycle and no duration all read as NULL — never 0", () => {
  assert.equal(cycleProgressPercent(null, 5000), null);
  assert.equal(cycleProgressPercent(undefined, 5000), null);
  assert.equal(
    cycleProgressPercent({ durationMs: 10000, source: "base", startedAtMs: null, repeating: false }, 5000),
    null,
    "a base duration with no start stamp cannot place us in the cycle",
  );
  assert.equal(
    cycleProgressPercent({ durationMs: 0, source: "server", startedAtMs: 0, repeating: false }, 5000),
    null,
  );
});

test("a clock reading BEFORE the start stamp is null, not a negative bar", () => {
  const cycle = { durationMs: 10000, source: "server" as const, startedAtMs: 9000, repeating: false };
  assert.equal(cycleProgressPercent(cycle, 1000), null);
});

// --- the hold: what a press-and-hold on a slot would do ----------------------
//
// Overloading has always been behind a second, deliberate gesture because it
// damages the module. The gesture changed (shift-click could not be performed
// on a touch screen); the guard did not.

/** A module as the rack sees it, with only the fields a test cares about set. */
function mod(over: Partial<RackModule>): RackModule {
  return {
    itemID: 1,
    typeID: 3634,
    online: true,
    active: false,
    charge: null,
    overloaded: false,
    damage: null,
    bankMasterID: null,
    bankMaster: false,
    bankSize: 1,
    ...over,
  } as RackModule;
}

test("a hold overloads a cool module, and stops an overloaded one", () => {
  assert.equal(rackHoldAction(mod({ overloaded: false })), "overload");
  assert.equal(rackHoldAction(mod({ overloaded: true })), "stopOverload");
});

test("⚠ an UNKNOWN overload state is not 'cool' — the hold does nothing", () => {
  // `null` means the server did not tell us, so there is no honest toggle to
  // offer. Guessing "it must be off, so overload it" damages a module on the
  // strength of an assumption.
  assert.equal(rackHoldAction(mod({ overloaded: null })), null);
});

test("an OFFLINE module is inert to the hold, as it is to a click", () => {
  assert.equal(rackHoldAction(mod({ online: false, overloaded: false })), null);
  assert.equal(rackClickAction(mod({ online: false })), null, "and the click too");
});

test("no module at all holds towards nothing", () => {
  assert.equal(rackHoldAction(null), null);
});

test("the hold is long enough to be deliberate, and short enough to be a gesture", () => {
  // Not a magic number worth pinning to the millisecond, but the ORDER matters:
  // under ~300ms a normal click starts triggering it, over ~1s it stops feeling
  // like a control and starts feeling broken.
  assert.ok(OVERLOAD_HOLD_MS >= 300, "a hold this short is reachable by an ordinary click");
  assert.ok(OVERLOAD_HOLD_MS <= 1000, "a hold this long reads as an unresponsive button");
});

// --- the heat-damage wedge ---------------------------------------------------

test("⚠ UNKNOWN damage draws no wedge — which is not the same as an empty one", () => {
  assert.equal(rackDamageWedge(mod({ damage: null })), 0);
  assert.equal(rackDamageBand(mod({ damage: null })), null);
  assert.equal(rackDamageWedge(null), 0);
});

test("an intact module draws no wedge either", () => {
  assert.equal(rackDamageWedge(mod({ damage: 0 })), 0);
  assert.equal(rackDamageBand(mod({ damage: 0 })), null);
});

test("the wedge grows with the damage, and never past the burnt-out size", () => {
  const light = rackDamageWedge(mod({ damage: 0.1 }));
  const heavy = rackDamageWedge(mod({ damage: 0.9 }));
  const dead = rackDamageWedge(mod({ damage: 1 }));
  assert.ok(light > 0, "a damaged module draws something");
  assert.ok(heavy > light, "more damage is a longer arc");
  assert.ok(dead >= heavy);
  // Clamped: a server that reported more than total damage does not draw a
  // wedge longer than the ring it sits on.
  assert.equal(rackDamageWedge(mod({ damage: 4 })), dead);
});

test("⚠ the three bands differ by LENGTH as well as colour", () => {
  // Nothing in this app may be conveyed by colour alone. The band names pick the
  // stroke; the wedge SIZE is what carries the reading for anyone who cannot
  // tell the three apart.
  assert.equal(rackDamageBand(mod({ damage: 0.1 })), "warm");
  assert.equal(rackDamageBand(mod({ damage: 0.45 })), "hot");
  assert.equal(rackDamageBand(mod({ damage: 0.8 })), "burning");
  assert.ok(
    rackDamageWedge(mod({ damage: 0.8 })) > rackDamageWedge(mod({ damage: 0.1 })),
    "the bands are not distinguishable without colour",
  );
});

// --- rack heat: a stub that admits it ---------------------------------------

test("⚠ rack heat is NULL for every row today, and never a fabricated 0", () => {
  const rows = buildModuleRack(
    [slot("high", 0, { itemID: 1, typeID: 3634 }), slot("mid", 0, { itemID: 2, typeID: 5001 })],
    [1],
    [1],
    { 1: 0.8 },
  );
  for (const row of rows) {
    assert.equal(
      row.heat,
      null,
      `${row.family} rack reported a heat reading nothing in this client can produce`,
    );
  }
});

test("⚠ rack heat is NOT derived from module damage", () => {
  // The trap this exists to catch: damage is the SCAR heat leaves behind, not
  // the heat in the rack now. A rack full of burnt modules is not a hot rack,
  // and a cool-looking bar is what gets the next module burnt out.
  const rows = buildModuleRack(
    [slot("high", 0, { itemID: 1, typeID: 3634 })],
    null,
    null,
    { 1: 1 },
  );
  assert.equal(rows[0]!.slots[0]!.module?.damage, 1, "the module damage IS read");
  assert.equal(rows[0]!.heat, null, "but it must not become a heat reading");
});

test("a supplied heat reading is carried through untouched, for the day there is one", () => {
  const rows = buildModuleRack(
    [slot("high", 0, { itemID: 1, typeID: 3634 })],
    null,
    null,
    null,
    null,
    // Absent IS the way "not known" is spelled in this map — a rack with no
    // entry gets null, not 0. That is the same distinction the row type makes.
    { high: 0.25 },
  );
  assert.equal(rows[0]!.heat, 0.25);
  assert.equal(rows[1]!.heat, null, "an unlisted rack must not read as cold");
});

// --- the rack heat bar's own bands ------------------------------------------

test("⚠ AN UNKNOWN HEAT HAS NO BAND — it must not fall through to 'cool'", () => {
  // The whole failure this stub exists to avoid: a bar that draws in the cool
  // colour because nobody told it anything.
  assert.equal(rackHeatBand(null), null);
  assert.equal(rackHeatText(null), "heat not known");
});

test("the bands are the handoff's, and are NOT the damage bands", () => {
  // Damage is the scar heat leaves behind; this is the heat in the rack now. A
  // module can be badly scarred in a cold rack, and an undamaged one can be
  // about to burn — so the two thresholds must not be merged.
  assert.equal(rackHeatBand(0.1), "cool");
  assert.equal(rackHeatBand(0.29), "cool");
  assert.equal(rackHeatBand(0.3), "warm");
  assert.equal(rackHeatBand(0.59), "warm");
  assert.equal(rackHeatBand(0.6), "hot");
  assert.equal(rackHeatBand(1), "hot");
});

test("⚠ THE WORDS ALWAYS CONTAIN 'heat' — the bar has no other label", () => {
  // In the design the rack's NAME is above the bar and the reading is below it;
  // nothing else says what the bar measures. A bare dash would leave a nameless
  // empty bar.
  assert.match(rackHeatText(null), /heat/);
  assert.match(rackHeatText(0.22), /heat/);
  assert.equal(rackHeatText(0.22), "22% heat");
});
