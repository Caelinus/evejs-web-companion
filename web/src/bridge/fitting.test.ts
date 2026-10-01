// Goal R12: decoding the fitting reads into slots and resource bars.
//
// Covers the shapes that actually come off the wire: ListByFlags packedrows,
// the python-set-wrapped empty list, the ShipGetInfo attribute dict, and the
// docked-ship capacitor quirk (base capacity null, effective value in charge).

import test from "node:test";
import assert from "node:assert/strict";

import {
  SLOT_FAMILY_LABELS,
  SLOT_FAMILY_ORDER,
  buildSlots,
  chargeLooksCompatible,
  decodeChargeFits,
  isChargeRow,
  decodeOnlineModuleIDs,
  decodeResources,
  decodeShipAttributes,
  isFittableRow,
  slotsOfFamily,
} from "./fitting.ts";
import type { JsonValue } from "./wire.ts";

// --- fixtures ---------------------------------------------------------------

function packedRow(fields: Record<string, JsonValue>): JsonValue {
  return { type: "packedrow", fields } as unknown as JsonValue;
}

function slotList(rows: readonly JsonValue[]): JsonValue {
  return { type: "list", items: rows } as unknown as JsonValue;
}

/** The empty flag-scoped List shape: a python set wrapping an empty list. */
function emptySet(): JsonValue {
  return {
    type: "objectex1",
    header: [
      { type: "token", value: "__builtin__.set" },
      [{ type: "list", items: [] }],
    ],
  } as unknown as JsonValue;
}

/** A dogmaIM.ShipGetInfo result carrying the given attributeID -> value map. */
function shipInfo(attributes: Record<number, number | null>): JsonValue {
  return {
    type: "dict",
    entries: [
      [
        9001,
        {
          type: "object",
          name: "util.KeyVal",
          args: {
            type: "dict",
            entries: [
              ["itemID", 9001],
              [
                "attributes",
                {
                  type: "dict",
                  entries: Object.entries(attributes).map(([id, value]) => [
                    Number(id),
                    value,
                  ]),
                },
              ],
            ],
          },
        },
      ],
    ],
  } as unknown as JsonValue;
}

/** A Punisher-shaped ship: 4 high, 2 mid, 5 low, 3 rig slots. */
const PUNISHER_ATTRIBUTES: Record<number, number | null> = {
  48: 168, // CPU output
  49: 3.6, // CPU load
  11: 88.44, // powergrid output
  15: 6, // powergrid load
  482: null, // capacitor capacity — null while DOCKED
  18: 460, // charge — the effective capacitor a docked ship reports
  1132: 400, // calibration capacity
  1152: 100, // calibration used
  14: 4, // high slots
  13: 2, // mid slots
  12: 5, // low slots
  1137: 3, // rig slots
};

// --- attribute + online reads ----------------------------------------------

test("decodeShipAttributes pulls the ship's attribute map out of ShipGetInfo", () => {
  const attributes = decodeShipAttributes(shipInfo(PUNISHER_ATTRIBUTES));
  assert.equal(attributes.get(48), 168);
  assert.equal(attributes.get(11), 88.44);
  assert.equal(attributes.get(482), null);
});

test("decodeShipAttributes tolerates a malformed or missing result", () => {
  for (const value of [null, 7, "nope", { type: "dict", entries: [] }] as JsonValue[]) {
    assert.equal(decodeShipAttributes(value).size, 0);
  }
});

test("decodeOnlineModuleIDs reads the flat list of online module IDs", () => {
  const online = decodeOnlineModuleIDs({ type: "list", items: [11, 22, 33] } as unknown as JsonValue);
  assert.equal(online.has(22), true);
  assert.equal(online.has(44), false);
  assert.equal(decodeOnlineModuleIDs(null as unknown as JsonValue).size, 0);
});

// --- resource readings ------------------------------------------------------

test("decodeResources reads CPU, powergrid and calibration as used vs total", () => {
  const resources = decodeResources(shipInfo(PUNISHER_ATTRIBUTES));
  assert.deepEqual(
    { used: resources.cpu.used, total: resources.cpu.total, known: resources.cpu.known },
    { used: 3.6, total: 168, known: true },
  );
  assert.deepEqual(
    { used: resources.powergrid.used, total: resources.powergrid.total, known: true },
    { used: 6, total: 88.44, known: true },
  );
  assert.deepEqual(
    { used: resources.calibration.used, total: resources.calibration.total },
    { used: 100, total: 400 },
  );
});

test("a DOCKED ship's capacitor reads from charge when the capacity attribute is null", () => {
  const resources = decodeResources(shipInfo(PUNISHER_ATTRIBUTES));
  assert.equal(resources.capacitor.known, true);
  assert.equal(resources.capacitor.total, 460, "falls back to the charge attribute");
});

test("capacitor prefers the real capacity attribute when the ship reports one", () => {
  const resources = decodeResources(
    shipInfo({ ...PUNISHER_ATTRIBUTES, 482: 375, 18: 200 }),
  );
  assert.equal(resources.capacitor.total, 375);
});

test("a missing reading is 'unknown', never a misleading 0 / 0", () => {
  const resources = decodeResources(shipInfo({}));
  for (const reading of [
    resources.cpu,
    resources.powergrid,
    resources.capacitor,
    resources.calibration,
  ]) {
    assert.equal(reading.known, false);
  }
});

// --- slot building ----------------------------------------------------------

test("buildSlots draws one slot per slot the ship HAS, empty slots included", () => {
  const slots = buildSlots(emptySet(), shipInfo(PUNISHER_ATTRIBUTES), null as unknown as JsonValue);
  assert.equal(slotsOfFamily(slots, "high").length, 4);
  assert.equal(slotsOfFamily(slots, "mid").length, 2);
  assert.equal(slotsOfFamily(slots, "low").length, 5);
  assert.equal(slotsOfFamily(slots, "rig").length, 3);
  assert.equal(slotsOfFamily(slots, "subsystem").length, 0, "a frigate has no subsystems");
  // Every one of them is visibly EMPTY rather than absent.
  assert.equal(slots.every((slot) => slot.module === null), true);
});

test("buildSlots places each fitted module in its own slot, by family and index", () => {
  const slots = buildSlots(
    slotList([
      packedRow({ itemID: 5001, typeID: 3634, groupID: 53, flagID: 27 }), // high slot 1
      packedRow({ itemID: 5002, typeID: 3634, groupID: 53, flagID: 29 }), // high slot 3
      packedRow({ itemID: 5003, typeID: 2048, groupID: 60, flagID: 11 }), // low slot 1
      packedRow({ itemID: 5004, typeID: 31358, groupID: 781, flagID: 92 }), // rig 1
    ]),
    shipInfo(PUNISHER_ATTRIBUTES),
    { type: "list", items: [5001] } as unknown as JsonValue,
  );

  const high = slotsOfFamily(slots, "high");
  assert.equal(high[0]!.module?.itemID, 5001);
  assert.equal(high[1]!.module, null, "the second high slot is empty");
  assert.equal(high[2]!.module?.itemID, 5002);
  assert.equal(high[3]!.module, null);

  assert.equal(slotsOfFamily(slots, "low")[0]!.module?.typeID, 2048);
  assert.equal(slotsOfFamily(slots, "rig")[0]!.module?.typeID, 31358);

  // Online state comes from ShipOnlineModules, per module.
  assert.equal(high[0]!.module?.online, true);
  assert.equal(high[2]!.module?.online, false);
});

test("a module fitted beyond the reported slot count is still shown", () => {
  // The server is authoritative about what is FITTED; the slot count only
  // decides how many empty slots to draw, so it must never hide a module.
  const slots = buildSlots(
    slotList([packedRow({ itemID: 5010, typeID: 3634, groupID: 53, flagID: 32 })]),
    shipInfo({ ...PUNISHER_ATTRIBUTES, 14: 2 }),
    null as unknown as JsonValue,
  );
  const high = slotsOfFamily(slots, "high");
  assert.equal(high.length, 6, "grown to reach the occupied slot");
  assert.equal(high[5]!.module?.itemID, 5010);
});

test("a row whose itemID is an ARRAY cannot fill a slot", () => {
  // ⚠ THIS IS NOT THE CHARGE CASE, though it was once written as one. The
  // belief was that a loaded charge arrives with an array itemID and is
  // therefore dropped by the number coercion; it is not — a charge is an
  // ordinary row sharing its module's flag, and the tests at the end of this
  // file cover it against real captured bytes.
  //
  // What this still pins is the coercion itself: a row with a non-numeric
  // itemID is not a fitted item, whatever produced it.
  const slots = buildSlots(
    slotList([
      packedRow({ itemID: [9001, 27, 200] as unknown as JsonValue, typeID: 200, flagID: 27 }),
      packedRow({ itemID: 5001, typeID: 3634, flagID: 28 }),
    ]),
    shipInfo(PUNISHER_ATTRIBUTES),
    null as unknown as JsonValue,
  );
  const high = slotsOfFamily(slots, "high");
  assert.equal(high[0]!.module, null, "an unusable itemID did not fill the slot");
  assert.equal(high[1]!.module?.itemID, 5001);
});

test("slots come back in fitting-window order, and every family is labelled", () => {
  const slots = buildSlots(emptySet(), shipInfo(PUNISHER_ATTRIBUTES), null as unknown as JsonValue);
  const families = [...new Set(slots.map((slot) => slot.family))];
  assert.deepEqual(families, ["high", "mid", "low", "rig"]);
  for (const family of SLOT_FAMILY_ORDER) {
    assert.equal(typeof SLOT_FAMILY_LABELS[family], "string");
    assert.ok(SLOT_FAMILY_LABELS[family].length > 0);
  }
});

// --- what can be fitted -----------------------------------------------------

test("only modules and subsystems are offered as fittable", () => {
  assert.equal(isFittableRow(7), true, "a module");
  assert.equal(isFittableRow(32), true, "a subsystem");
  assert.equal(isFittableRow(8), false, "a charge");
  assert.equal(isFittableRow(6), false, "a ship");
  assert.equal(isFittableRow(18), false, "a drone");
  assert.equal(isFittableRow(null), false);
});

// --- Loaded charges ----------------------------------------------------------
//
// ⚠ THE BUG THIS PINS, and it was live. A loaded charge is an ORDINARY row that
// shares its MODULE'S slot flag — not, as was previously believed and written in
// a comment here, a tuple itemID that the number coercion would drop. Indexing
// the rows by flag alone therefore let the charge OVERWRITE the module, and
// every panel drew the ammunition where the gun should be: the Fitting window,
// the Overview equipment list, and the module rack, which offered to "activate"
// a round of Phased Plasma.
//
// The rows below are the exact bytes captured from a Rifter at Perimeter VI on
// 2026-07-31 after fitting a 150mm Light AutoCannon I (485) and loading Phased
// Plasma S (184) into it — module first, charge second, both on flagID 27.
const RIFTER_ATTRIBUTES: Record<number, number> = {
  14: 4, // hiSlots
  13: 3, // medSlots
  12: 3, // lowSlots
  1137: 3, // rigSlots
};

function loadedTurretRows(): JsonValue {
  return slotList([
    packedRow({ itemID: 9988400094759, typeID: 485, groupID: 55, categoryID: 7, flagID: 27, quantity: -1 }),
    packedRow({ itemID: 9988400094760, typeID: 184, groupID: 83, categoryID: 8, flagID: 27, quantity: 160 }),
  ]);
}

test("⚠ a loaded charge does NOT displace the module it sits in", () => {
  const slots = buildSlots(
    loadedTurretRows(),
    shipInfo(RIFTER_ATTRIBUTES),
    { type: "list", items: [9988400094759] } as unknown as JsonValue,
  );
  const high = slotsOfFamily(slots, "high");

  // The GUN, not the ammunition.
  assert.equal(high[0]!.module?.typeID, 485);
  assert.equal(high[0]!.module?.itemID, 9988400094759);
  assert.equal(high[0]!.module?.groupID, 55);
  // And it is still recognised as online, which is keyed off the MODULE's id.
  assert.equal(high[0]!.module?.online, true);
});

test("the charge belongs to the module, with what is loaded and how much", () => {
  const slots = buildSlots(
    loadedTurretRows(),
    shipInfo(RIFTER_ATTRIBUTES),
    { type: "list", items: [] } as unknown as JsonValue,
  );

  assert.deepEqual(slotsOfFamily(slots, "high")[0]!.module?.charge, {
    itemID: 9988400094760,
    typeID: 184,
    quantity: 160,
  });
});

test("active-ship sublocation charge keeps its tuple identity and never replaces the module", () => {
  const module = packedRow({ itemID: 301, typeID: 43551, categoryID: 7, groupID: 1770, locationID: 101, flagID: 27 });
  const charge = (itemID: JsonValue, extra: Record<string, JsonValue> = {}) => packedRow({ itemID, typeID: 42830,
    categoryID: 8, groupID: 1771, locationID: 101, flagID: 27, quantity: 300, ...extra });
  const decode = (row: JsonValue) => buildSlots(slotList([module, row]), shipInfo({ 14: 1 }), { type: "list", items: [301] })[0]!.module;
  assert.deepEqual(decode(charge([101, 27, 42830]))?.charge, { itemID: [101, 27, 42830], typeID: 42830, quantity: 300 });
  assert.equal(decode(charge([101, 27, 42830]))?.itemID, 301);
  for (const row of [charge([102, 27, 42830]), charge([101, 28, 42830]), charge([101, 27, 42831]),
    charge([101, 27]), charge([101, 27, 42830], { categoryID: 7 }), charge([102, 27, 42830], { locationID: 102 })]) {
    assert.equal(decode(row)?.charge, null);
    assert.equal(decode(row)?.itemID, 301);
  }
});

test("a charge never becomes a slot of its own", () => {
  const slots = buildSlots(
    loadedTurretRows(),
    shipInfo(RIFTER_ATTRIBUTES),
    { type: "list", items: [] } as unknown as JsonValue,
  );
  const occupied = slots.filter((slot) => slot.module !== null);

  assert.equal(occupied.length, 1, "one turret, one occupied slot");
  assert.equal(
    slots.some((slot) => slot.module?.typeID === 184),
    false,
    "the ammunition must never appear as a fitted item",
  );
});

test("an empty module reads charge null — not an absent field", () => {
  const slots = buildSlots(
    slotList([packedRow({ itemID: 5001, typeID: 3634, groupID: 53, categoryID: 7, flagID: 27 })]),
    shipInfo(RIFTER_ATTRIBUTES),
    { type: "list", items: [] } as unknown as JsonValue,
  );

  assert.equal(slotsOfFamily(slots, "high")[0]!.module?.charge, null);
});

test("a charge whose module is not there is dropped, not drawn as a phantom", () => {
  // The server would not produce this, but a partial read might: a lone charge
  // row must not become a fitted item.
  const slots = buildSlots(
    slotList([
      packedRow({ itemID: 9988400094760, typeID: 184, groupID: 83, categoryID: 8, flagID: 27, quantity: 160 }),
    ]),
    shipInfo(RIFTER_ATTRIBUTES),
    { type: "list", items: [] } as unknown as JsonValue,
  );

  assert.equal(slots.every((slot) => slot.module === null), true);
});

test("isChargeRow picks out ammunition, and nothing else in the hold", () => {
  assert.equal(isChargeRow(8), true, "category 8 is Charge");
  assert.equal(isChargeRow(7), false, "a module is not ammunition");
  assert.equal(isChargeRow(18), false, "a drone is not ammunition");
  assert.equal(isChargeRow(6), false, "a ship is not ammunition");
  assert.equal(isChargeRow(null), false, "unknown is not a yes");
});

test("⚠ isChargeRow is a CATEGORY test, never a compatibility test", () => {
  // Which charges a module accepts lives in dogma attributes the browser has no
  // allowlisted read for. Narrowing the offered list by a guess would hide
  // ammunition that would have loaded fine, so every charge is offered and the
  // SERVER refuses the wrong ones in its own words. Two charges for completely
  // different weapon systems both answer true, and that is correct.
  assert.equal(isChargeRow(8), true); // Phased Plasma S — projectile
  assert.equal(isChargeRow(8), true); // Multifrequency S — laser
});

// --- Charge fitment (advisory sorting only) -----------------------------------
//
// ⚠ THIS NEVER HIDES A CHARGE. The server decides what loads and refuses
// silently, so the picker offers everything and only puts the likely ones first.
// The attributes are 128 (charge size) and 604/605/606/609 (accepted groups),
// both read from the same static dogma the volume lookup uses.

test("a charge of the right group AND size looks compatible", () => {
  const fits = decodeChargeFits({ 485: { size: 1, groups: [83] } } as unknown as JsonValue);
  // Phased Plasma S: group 83, size 1, into a 150mm Light AutoCannon I.
  assert.equal(chargeLooksCompatible(fits[485], 83, 1), true);
});

test("⚠ same family, wrong calibre — the case that failed live", () => {
  const fits = decodeChargeFits({ 485: { size: 1, groups: [83] } } as unknown as JsonValue);
  // Arch Angel Phased Plasma XL is group 83 too, and the server refused it.
  assert.equal(chargeLooksCompatible(fits[485], 83, 4), false);
});

test("a charge from another weapon system does not look compatible", () => {
  const fits = decodeChargeFits({ 485: { size: 1, groups: [83] } } as unknown as JsonValue);
  assert.equal(chargeLooksCompatible(fits[485], 85, 1), false, "hybrid charge, projectile gun");
});

test("a module accepting several groups accepts any of them", () => {
  // 800mm Repeating Cannon II: size 3, groups 83 and 372.
  const fits = decodeChargeFits({ 2929: { size: 3, groups: [83, 372] } } as unknown as JsonValue);
  assert.equal(chargeLooksCompatible(fits[2929], 83, 3), true);
  assert.equal(chargeLooksCompatible(fits[2929], 372, 3), true);
  assert.equal(chargeLooksCompatible(fits[2929], 86, 3), false);
});

test("⚠ 'cannot say' is NULL, and is never a no", () => {
  const fits = decodeChargeFits({ 485: { size: 1, groups: [83] } } as unknown as JsonValue);
  // No fitment for the module at all (an afterburner, say).
  assert.equal(chargeLooksCompatible(fits[12058], 83, 1), null);
  assert.equal(chargeLooksCompatible(undefined, 83, 1), null);
  // A charge whose group we do not know.
  assert.equal(chargeLooksCompatible(fits[485], null, 1), null);
  // Right group, but a size we cannot read on one side.
  assert.equal(chargeLooksCompatible(fits[485], 83, null), null);
});

test("a malformed or absent map decodes to {} — 'we cannot sort', not 'nothing fits'", () => {
  assert.deepEqual(decodeChargeFits(undefined), {});
  assert.deepEqual(decodeChargeFits(null as unknown as JsonValue), {});
  assert.deepEqual(decodeChargeFits([] as unknown as JsonValue), {});
});
