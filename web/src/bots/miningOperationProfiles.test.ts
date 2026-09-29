import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { decodeScriptValue } from "./scriptCodec.ts";
import { analyzeBotRunPolicy } from "./runPolicy.ts";

const require = createRequire(import.meta.url);
const { buildStandardProfile, standardProfileFor, BELT_MINER_ID, BELT_HAULER_ID } = require("../../../src/miningOperationProfiles.js");
const definition = {
  area: { targetClasses: ["BELT"] }, unloadPolicy: "HAULER_SERVICE",
  unloadDestination: { stationID: 60003760, stationName: "Jita IV - Moon 4", systemName: "Jita", corporationDivision: 1 },
};
const miner = { role: "MINER", routineMode: "STANDARD", automationID: "" };
const hauler = { role: "HAULER", routineMode: "STANDARD", automationID: "" };

test("versioned standard BELT profiles are valid runner docs, independent of saved bots", () => {
  const mining = buildStandardProfile(definition, miner);
  const hauling = buildStandardProfile(definition, hauler);
  assert.equal(mining.scriptID, BELT_MINER_ID);
  assert.equal(hauling.scriptID, BELT_HAULER_ID);
  assert.equal(mining.rev, 2);
  assert.equal(hauling.rev, 1);
  for (const profile of [mining, hauling]) {
    const decoded = decodeScriptValue(profile.doc);
    assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.refusal);
    if (decoded.ok) assert.ok(analyzeBotRunPolicy(decoded.doc).riskClasses.includes("inventory"));
    assert.equal(profile.doc.home.id, 60003760);
    assert.notEqual(profile.doc.home.starting, true);
  }
  assert.equal(standardProfileFor({ ...definition, area: { targetClasses: ["GAS"] } }, miner), null);
  assert.equal(standardProfileFor({ ...definition, unloadPolicy: "SELF_UNLOAD" }, hauler), null);
  assert.equal(standardProfileFor(definition, { ...miner, routineMode: "CUSTOM", automationID: "saved-script" }), null);
});

test("standard miner and hauler use only operation-overlay resource targets and bounded hauler idle cadence", () => {
  const mining = buildStandardProfile(definition, miner).doc.program[0].body;
  assert.deepEqual(mining.map((node: { macro: string }) => node.macro), ["undock", "mine-at-belt", "jettison-ore"]);
  assert.equal(mining[1].args.belt.belt.mode, "nearest");
  assert.equal(mining[1].args.drones, undefined, "Farmer/Batch 6 drone capability is inferred from the ship");
  assert.equal(mining[1].until.fraction, 0.9);
  const hauling = buildStandardProfile(definition, hauler).doc.program[0].body;
  assert.equal(hauling[0].kind, "branch");
  assert.equal(hauling[0].when.fraction, 0.9);
  assert.deepEqual(hauling[0].else.map((node: { macro: string }) => node.macro), ["undock", "travel-to-belt", "loot-containers"]);
  assert.equal(hauling[0].else[1].args.belt.belt.mode, "nearest");
  assert.equal(hauling[0].then[0].args.station.ref.id, 60003760);
  assert.equal(hauling[0].then[0].args.into.division, 1);
  assert.equal(hauling[1].macro, "wait");
  assert.equal(hauling[1].args.seconds.value, 3);
});

test("missing explicit unload destination never produces a standard runnable doc", () => {
  assert.equal(buildStandardProfile({ ...definition, unloadDestination: null }, hauler), null);
  assert.equal(buildStandardProfile({ ...definition, unloadDestination: { ...definition.unloadDestination, corporationDivision: 8 } }, hauler), null);
});

test("personal Standard delivery omits the strict corporation-division argument", () => {
  const personal = { ...definition, unloadPolicy: "SELF_UNLOAD", unloadDestination: { ...definition.unloadDestination, corporationDivision: null, corporationID: null } };
  for (const member of [miner]) {
    const profile = buildStandardProfile(personal, member);
    const body = profile.doc.program[0].body;
    const delivery = body[2];
    assert.equal(delivery.macro, "deliver-ore");
    assert.equal(delivery.args.into, undefined);
    assert.ok(decodeScriptValue(profile.doc).ok);
  }
  const haulerProfile = buildStandardProfile({ ...personal, unloadPolicy: "HAULER_SERVICE" }, hauler);
  const haulerDelivery = haulerProfile.doc.program[0].body[0].then[0];
  assert.equal(haulerDelivery.macro, "deliver-ore");
  assert.equal(haulerDelivery.args.into, undefined);
});

for (const [family, id] of [["BELT", "belt"], ["ORE_ANOMALY", "ore-anomaly"], ["ICE", "ice"]]) {
  test(`${family} Standard Self-Unload v1 uses explicit delivery, no jettison or hauler`, () => {
    const def = { ...definition, area: { targetClasses: [family] }, unloadPolicy: "SELF_UNLOAD" };
    const profile = buildStandardProfile(def, miner);
    assert.equal(profile.scriptID, `mcc.${id}.self-unload.miner`);
    assert.equal(profile.rev, 1);
    const decoded = decodeScriptValue(profile.doc); assert.ok(decoded.ok);
    assert.ok(analyzeBotRunPolicy(decoded.doc), "profile is analyzed by the current Farmer policy; operation recovery separately requires fresh target authority");
    assert.deepEqual(profile.doc.program[0].body.map((node: { macro: string }) => node.macro), ["undock", "mine-at-belt", "deliver-ore"]);
    assert.equal(profile.doc.program[0].body[2].args.station.ref.id, definition.unloadDestination.stationID);
    assert.equal(buildStandardProfile({ ...def, unloadDestination: null }, miner), null);
    assert.equal(buildStandardProfile({ ...def, unloadDestination: { ...def.unloadDestination, stationID: 0 } }, miner), null);
    assert.equal(standardProfileFor(def, hauler), null);
    assert.equal(standardProfileFor({ ...def, area: { targetClasses: ["GAS"] } }, miner), null);
  });
}

test("site families resolve distinct v1 runner documents, never a cross-family profile", () => {
  for (const [family, id, mode] of [["ORE_ANOMALY", "ore-anomaly", "site"], ["ICE", "ice", "ice-site"]]) {
    const def = { ...definition, area: { targetClasses: [family] } };
    for (const member of [miner, hauler]) {
      const profile = buildStandardProfile(def, member);
      assert.equal(profile.scriptID, `mcc.${id}.hauler-service.${member.role.toLowerCase()}`);
      assert.equal(profile.rev, 1);
      const decoded = decodeScriptValue(profile.doc);
      assert.ok(decoded.ok, JSON.stringify(decoded));
      const body = profile.doc.program[0].body;
      const targetStep = member.role === "MINER" ? body[1] : body[0].else[1];
      assert.equal(targetStep.args.belt.belt.mode, mode);
      assert.equal(profile.doc.home.id, definition.unloadDestination.stationID);
      if (member.role === "HAULER") assert.equal(body[1].args.seconds.value, 3);
      assert.equal(buildStandardProfile({ ...def, area: { targetClasses: [family, "BELT"] } }, member), null);
    }
  }
});
