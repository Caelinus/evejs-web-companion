"use strict";

// What a rock is WORTH per cubic metre — the arithmetic behind the Mining
// Surveyor's "Ore Value" gradient, and behind the mining bot's "most valuable
// ore first" pick.
//
// The retail client computes this itself, in `mining_util.get_volume_est_price`:
// the reprocessed value of one unit (materials × price × 0.66 ÷ portion size),
// divided by the unit volume. `staticData.getOreValuePerM3` is that same
// arithmetic over the same inputs, done once in the BFF instead of per rock per
// tick in the browser.
//
// ⚠ WHAT THIS FILE IS REALLY PINNING is where it refuses to answer. Every input
// can be missing — an ore with no volume, a portion size of zero, a mineral with
// no price — and every one of those has to come back NULL. A zero would rank the
// rock as worthless, which is a claim nobody computed, and would send a bot past
// the best ore in the belt.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ORE = 1230;            // priced through its materials
const ORE_UNPRICEABLE = 1228; // one of its materials has no price
const ORE_NO_VOLUME = 1227;   // volume missing
const ORE_NO_MATERIALS = 1226; // falls back to its own average price
const TRITANIUM = 34;
const MEXALLON = 36;
const UNPRICED_MINERAL = 35;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-orevalue-data-"));
const sdeDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-orevalue-sde-"));
fs.mkdirSync(path.join(dataDir, "itemTypes"), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "itemTypes", "data.json"),
  JSON.stringify({
    types: [
      { typeID: ORE, name: "Testite", volume: 0.1, portionSize: 100, basePrice: 2000 },
      { typeID: ORE_UNPRICEABLE, name: "Murkite", volume: 0.1, portionSize: 100, basePrice: 2000 },
      { typeID: ORE_NO_VOLUME, name: "Voidite", portionSize: 100, basePrice: 2000 },
      { typeID: ORE_NO_MATERIALS, name: "Plainite", volume: 2, basePrice: 50 },
      { typeID: TRITANIUM, name: "Tritanium", volume: 0.01, portionSize: 1, basePrice: 2 },
      { typeID: MEXALLON, name: "Mexallon", volume: 0.01, portionSize: 1, basePrice: 32 },
      // A mineral with NO basePrice: the reason a whole ore can be unpriceable.
      { typeID: UNPRICED_MINERAL, name: "Pyerite", volume: 0.01, portionSize: 1 },
    ],
  }),
);
fs.writeFileSync(
  path.join(sdeDir, "typeMaterials.jsonl"),
  [
    JSON.stringify({
      _key: ORE,
      materials: [
        { materialTypeID: TRITANIUM, quantity: 175 },
        { materialTypeID: MEXALLON, quantity: 70 },
      ],
    }),
    JSON.stringify({
      _key: ORE_UNPRICEABLE,
      materials: [
        { materialTypeID: TRITANIUM, quantity: 175 },
        { materialTypeID: UNPRICED_MINERAL, quantity: 70 },
      ],
    }),
    JSON.stringify({
      _key: ORE_NO_VOLUME,
      materials: [{ materialTypeID: TRITANIUM, quantity: 175 }],
    }),
  ].join("\n") + "\n",
);

process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
process.env.EVEJS_SDE_DIR = sdeDir;
process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "evejs-web-orevalue-app-"),
);

const staticData = require("../src/staticData");

test("an ore is worth its reprocessed materials, per cubic metre", () => {
  // 175 × 2 + 70 × 32 = 2590 ISK per portion of 100 units, at 0.66 efficiency
  // → 17.094 ISK per unit → 170.94 ISK per m³ at 0.1 m³ per unit.
  const value = staticData.getOreValuePerM3(ORE);
  assert.ok(Math.abs(value - 170.94) < 1e-9, `expected ~170.94, got ${value}`);
});

test("a type with no materials falls back to its own average price", () => {
  // 50 ISK a unit at 2 m³ a unit — the client's `get_unit_est_price` does the
  // same for anything the reprocessor has nothing to say about.
  assert.equal(staticData.getOreValuePerM3(ORE_NO_MATERIALS), 25);
});

test("one unpriced mineral makes the whole ore UNKNOWN, not cheap", () => {
  assert.equal(
    staticData.getOreValuePerM3(ORE_UNPRICEABLE),
    null,
    "a partial sum would rank this ore below ore it might well beat",
  );
});

test("no volume, no answer — ISK per m³ needs the m³", () => {
  assert.equal(staticData.getOreValuePerM3(ORE_NO_VOLUME), null);
});

test("a type nobody has ever heard of reads null, and does not throw", () => {
  assert.equal(staticData.getOreValuePerM3(999999), null);
  assert.equal(staticData.getOreValuePerM3(0), null);
});
