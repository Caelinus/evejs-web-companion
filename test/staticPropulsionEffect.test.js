"use strict";

// getPropulsionEffectName: the typeID -> propulsion-effect-name resolver behind
// the deactivate route's AB/MWD handling.
//
// WHY IT EXISTS (the marked server-side asymmetry): eve.js's Handle_Deactivate
// routes a module to deactivatePropulsionModule only when the effect argument
// NAMES a propulsion effect; an empty effect takes the generic path, which
// answers success while the prop mod keeps cycling. Activation infers the
// module's default effect from its type — deactivation does not. Observed live
// (2026-07-30): Deactivate(ab, "") -> 200, stopped:false, burner still running;
// Deactivate(ab, "moduleBonusAfterburner") stops it.
//
// The table is a FIXTURE shaped exactly like the gameStore's typeDogma
// (typesByTypeID -> {effects: [effectID...]}) so the test does not depend on an
// EveJS checkout being present.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-propfx-"));
fs.mkdirSync(path.join(dataDir, "typeDogma"));
fs.writeFileSync(
  path.join(dataDir, "typeDogma", "data.json"),
  JSON.stringify({
    typesByTypeID: {
      // 1MN Afterburner I — real shape: effects carry ids, 6731 is the AB bonus.
      439: { typeID: 439, effects: [13, 16, 3175, 6731] },
      // 5MN Microwarpdrive II — 6730 is the MWD bonus.
      440: { typeID: 440, effects: [13, 16, 58, 3175, 6730] },
      // A turret: effects, none of them propulsion.
      3634: { typeID: 3634, effects: [13, 16] },
      // A type with no effects array at all.
      999: { typeID: 999 },
    },
  }),
);
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
// Point the SDE dir somewhere empty so nothing else resolves accidentally.
process.env.EVEJS_SDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-nosde-"));

const staticData = require("../src/staticData");

test("an afterburner type resolves to moduleBonusAfterburner", () => {
  assert.equal(staticData.getPropulsionEffectName(439), "moduleBonusAfterburner");
});

test("a microwarpdrive type resolves to moduleBonusMicrowarpdrive", () => {
  assert.equal(staticData.getPropulsionEffectName(440), "moduleBonusMicrowarpdrive");
});

test("everything that is not a prop mod resolves to null — the generic path is correct for it", () => {
  assert.equal(staticData.getPropulsionEffectName(3634), null);
  assert.equal(staticData.getPropulsionEffectName(999), null);
  assert.equal(staticData.getPropulsionEffectName(0), null);
  assert.equal(staticData.getPropulsionEffectName(123456789), null);
});

// --- the same answer through the batch names resolver ------------------------
//
// ⚠ THE BROWSER NEEDS THIS TOO, NOT JUST THE DEACTIVATE ROUTE. A client that
// classifies a fitted module off SDE group 46 "Propulsion Module" learns only
// that it IS a prop mod: that group holds every afterburner AND every MWD, so no
// group name can separate them. The split matters because a warp scrambler
// (`warpScramblerMWD`, the jam carrying `blocksMicrowarpdrive`) turns an MWD off
// and does nothing at all to an afterburner.
//
// It rides `/api/names` rather than a route of its own because it is the same
// question in the same shape — one typeID against the static tables, batched and
// cached per key — and it is the ONE kind there that does not answer a display
// name, which is why it says so out loud.

test("the names resolver answers propulsionEffect, so a browser can tell an AB from an MWD", () => {
  const { names } = staticData.resolveNames({
    items: [
      { kind: "propulsionEffect", id: 439 },
      { kind: "propulsionEffect", id: 440 },
    ],
  });
  assert.equal(names["propulsionEffect:439"], "moduleBonusAfterburner");
  assert.equal(names["propulsionEffect:440"], "moduleBonusMicrowarpdrive");
});

test("a non-propulsion type is a definitive null, which a caller caches rather than refetches", () => {
  const { names } = staticData.resolveNames({
    items: [
      { kind: "propulsionEffect", id: 3634 },
      { kind: "propulsionEffect", id: 999 },
    ],
  });
  // Every requested item is echoed into `names` — present, and null.
  assert.ok("propulsionEffect:3634" in names);
  assert.equal(names["propulsionEffect:3634"], null);
  assert.equal(names["propulsionEffect:999"], null);
});

// It must not disturb the kinds that were already there.
test("propulsionEffect is keyed apart from every other kind for the same typeID", () => {
  const { names } = staticData.resolveNames({
    items: [
      { kind: "propulsionEffect", id: 439 },
      { kind: "type", id: 439 },
    ],
  });
  assert.equal(names["propulsionEffect:439"], "moduleBonusAfterburner");
  assert.notEqual(names["type:439"], "moduleBonusAfterburner");
});
