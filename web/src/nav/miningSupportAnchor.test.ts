import test from "node:test";
import assert from "node:assert/strict";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import { decodeMiningSupportAnchorRead } from "../bridge/miningSupportAnchor.ts";
import { observedSupportAnchorServices, resolveSupportAnchor, supportEnvelope, evaluateSupportEnvelope,
  type MiningSupportAnchor, type SupportFleetRoster, type SupportRequirements, type SupportAnchorServices } from "./miningSupportAnchor.ts";

function fixture(centre = 60_300) {
  const support = decodeSpaceSnapshot({ inSpace: true, shipID: 1001, sampledAtMs: 400, solarSystemID: 30000142,
    ship: { itemID: 1001, characterID: 1, miningBurstServices: { activeModuleIDs: [42], bursts: [{ moduleID: 42, rangeMeters: 90_000 }] },
      compressionService: { state: "active", typeListRanges: [{ typeListID: 10, rangeMeters: 60_000 }, { typeListID: 11, rangeMeters: 30_000 }], compressors: [] } }, entities: [] });
  let publication: MiningSupportAnchor = { characterID: 1, shipID: 1001, fleetID: "9007199254740993123", solarSystemID: 30000142,
    sessionEpoch: "opaque-epoch", sampledAtMs: 400, observedAtMs: 100_000, publishedAtMs: 100_000, expiresAtMs: 110_000,
    ageMs: 0, freshness: "fresh", reason: null, services: observedSupportAnchorServices(support) };
  const snapshot = decodeSpaceSnapshot({ inSpace: true, shipID: 1002, solarSystemID: 30000142, sampledAtMs: 450,
    ship: { itemID: 1002, characterID: 2, radius: 100, position: { x: 0, y: 0, z: 0 } },
    entities: [{ kind: "ship", itemID: 1001, characterID: 1, radius: 200, position: { x: centre, y: 0, z: 0 }, corporationID: 55, allianceID: 66 }] });
  const scene = { snapshot, receivedAtMs: 100_000 };
  const fleet: SupportFleetRoster = { fleetID: publication.fleetID, readerCharacterID: 2,
    members: [{ characterID: 1, solarSystemID: 30000142 }, { characterID: 2, solarSystemID: 30000142 }], observedAtMs: 100_000, expiresAtMs: 110_000 };
  const resolve = () => resolveSupportAnchor(publication, scene, fleet, 100_500);
  return { get publication() { return publication; }, scene, fleet, resolve,
    setServices(change: Partial<SupportAnchorServices>) { publication = { ...publication, services: { ...publication.services, ...change } }; } };
}
const burst: SupportRequirements = { requireMiningBurst: true };
const both: SupportRequirements = { requireMiningBurst: true, requireCompressionTypeListID: 10 };

test("visible matching pilot/ship resolves using miner scene position/radius and surface distance", () => {
  const f = fixture();
  const result = f.resolve();
  assert.equal(result.availability, "available");
  assert.equal(result.anchor?.radius, 200);
  assert.equal(result.anchor?.surfaceDistanceMeters, 60_000);
  assert.equal(result.anchor?.sameFleet, true);
  assert.equal(result.anchor?.onGrid, true);
});
test("off-grid ship is not invented from a board position", () => {
  const f = fixture();
  const spoof = { ...f.publication, position: { x: 0, y: 0, z: 0 }, radius: 500 };
  assert.equal(resolveSupportAnchor(spoof, { ...f.scene, snapshot: { ...f.scene.snapshot, entities: [] } }, f.fleet, 100_500).reason, "off-grid");
});
test("fleet roster mismatch and different fleet fail closed regardless of corp/alliance", () => {
  const f = fixture();
  assert.equal(resolveSupportAnchor(f.publication, f.scene, { ...f.fleet, members: f.fleet.members.filter(row => row.characterID === 2) }, 100_500).reason, "fleet-mismatch");
  assert.equal(resolveSupportAnchor(f.publication, f.scene, { ...f.fleet, fleetID: "2" }, 100_500).reason, "fleet-mismatch");
  assert.equal(resolveSupportAnchor(f.publication, f.scene, { ...f.fleet, readerCharacterID: 3 }, 100_500).reason, "fleet-mismatch");
});
test("changed visible ship, foreign pilot, other system, and unknown system fail closed", () => {
  const f = fixture();
  const visible = f.scene.snapshot.entities[0]!;
  for (const changed of [{ ...visible, itemID: 2001 }, { ...visible, characterID: 3 }, { ...visible, isNpc: true }]) {
    assert.equal(resolveSupportAnchor(f.publication, { ...f.scene, snapshot: { ...f.scene.snapshot, entities: [changed] } }, f.fleet, 100_500).reason, "ship-mismatch");
  }
  assert.equal(resolveSupportAnchor({ ...f.publication, solarSystemID: 30000143 }, f.scene, f.fleet, 100_500).reason, "system-mismatch");
  assert.equal(resolveSupportAnchor({ ...f.publication, solarSystemID: null }, f.scene, f.fleet, 100_500).reason, "system-unknown");
});
test("freshness is checked again at use; stale publication/scene/roster cannot satisfy services", () => {
  const f = fixture();
  assert.equal(resolveSupportAnchor(f.publication, f.scene, f.fleet, 110_000).reason, "publication-stale");
  assert.equal(resolveSupportAnchor({ ...f.publication, freshness: "invalid" }, f.scene, f.fleet, 100_500).availability, "unknown");
  assert.equal(resolveSupportAnchor(f.publication, { ...f.scene, receivedAtMs: 90_000 }, f.fleet, 100_500).reason, "scene-stale");
  assert.equal(resolveSupportAnchor(f.publication, f.scene, { ...f.fleet, expiresAtMs: 100_500 }, 100_500).reason, "fleet-unknown");
  assert.equal(supportEnvelope(resolveSupportAnchor(f.publication, f.scene, null, 100_500), burst).status, "unknown");
});
test("decoder geometry fallbacks cannot fabricate usable measurements; explicit origin/zero radius is valid", () => {
  const f = fixture();
  const snapshot = decodeSpaceSnapshot({ inSpace: true, shipID: 1002, solarSystemID: 30000142,
    ship: { itemID: 1002, characterID: 2, position: { x: 0, y: 0, z: 0 }, radius: 0 },
    entities: [{ itemID: 1001, kind: "ship", characterID: 1 }] });
  assert.equal(snapshot.entities[0]?.geometryAvailable, false);
  assert.equal(snapshot.ship?.geometryAvailable, true);
  assert.equal(resolveSupportAnchor(f.publication, { ...f.scene, snapshot }, f.fleet, 100_500).reason, "geometry-unknown");
});
test("burst-only envelope is 90km and burst plus matching compression is min=60km", () => {
  const f = fixture();
  assert.equal(supportEnvelope(f.resolve(), burst).maxSurfaceDistanceMeters, 90_000);
  assert.equal(supportEnvelope(f.resolve(), both).maxSurfaceDistanceMeters, 60_000);
  assert.equal(supportEnvelope(f.resolve(), { requireMiningBurst: false, requireCompressionTypeListID: 11 }).maxSurfaceDistanceMeters, 30_000);
});
test("wrong/missing or inactive compression typelist is unsatisfied", () => {
  const f = fixture();
  assert.equal(supportEnvelope(f.resolve(), { ...both, requireCompressionTypeListID: 12 }).status, "unsatisfied");
  f.setServices({ compression: { state: "inactive", typeListRanges: [], compressors: [] } });
  assert.equal(supportEnvelope(f.resolve(), both).status, "unsatisfied");
});
test("unknown required range/service is unknown, never satisfied; inactive burst is unavailable", () => {
  const f = fixture();
  f.setServices({ bursts: { activeModuleIDs: [42], bursts: [{ ...f.publication.services.bursts!.bursts[0]!, rangeMeters: null }] } });
  assert.equal(evaluateSupportEnvelope(f.resolve(), burst).status, "unknown");
  f.setServices({ bursts: null });
  assert.equal(supportEnvelope(f.resolve(), burst).status, "unknown");
  f.setServices({ compression: { state: "unknown", typeListRanges: null, compressors: null } });
  assert.equal(supportEnvelope(f.resolve(), { requireMiningBurst: false, requireCompressionTypeListID: 10 }).status, "unknown");
  f.setServices({ bursts: { activeModuleIDs: [], bursts: [] } });
  assert.equal(supportEnvelope(f.resolve(), burst).status, "unsatisfied");
});
test("all active required burst ranges are intersected; unknown range cannot be hidden by a wider burst", () => {
  const f = fixture();
  const first = f.publication.services.bursts!.bursts[0]!;
  f.setServices({ bursts: { activeModuleIDs: [42, 43], bursts: [first, { ...first, moduleID: 43, rangeMeters: 50_000 }] } });
  assert.equal(supportEnvelope(f.resolve(), burst).maxSurfaceDistanceMeters, 50_000);
  f.setServices({ bursts: { ...f.publication.services.bursts!, bursts: [first, { ...first, moduleID: 43, rangeMeters: null }] } });
  assert.equal(supportEnvelope(f.resolve(), burst).status, "unknown");
});
test("inside and outside evaluation includes the exact surface boundary and clamps overlapping hulls", () => {
  for (const [centre, expected] of [[60_299, "inside"], [60_300, "inside"], [60_301, "outside"], [100, "inside"]] as const) {
    const f = fixture(centre);
    const result = evaluateSupportEnvelope(f.resolve(), both);
    assert.equal(result.status, expected);
    assert.equal(result.surfaceDistanceMeters, Math.max(0, centre - 300));
  }
});
test("no required ranged services is explicit unbounded/not-applicable even with unknown anchor", () => {
  const f = fixture();
  const unknown = resolveSupportAnchor(f.publication, f.scene, null, 100_500);
  assert.equal(supportEnvelope(unknown, { requireMiningBurst: false }).status, "unbounded");
  assert.equal(evaluateSupportEnvelope(unknown, { requireMiningBurst: false }).status, "not-applicable");
});
test("read decoder distinguishes none/unknown/stale and rejects cross-fleet or malformed records", () => {
  const f = fixture();
  const wire = (anchors: unknown[]) => JSON.parse(JSON.stringify({ availability: "available", readAtMs: 100_000, fleet: f.fleet, anchors }));
  assert.deepEqual(decodeMiningSupportAnchorRead(wire([])).anchors, []);
  assert.equal(decodeMiningSupportAnchorRead({ availability: "unknown", reason: "READ_FAILED" }).availability, "unknown");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...f.publication, freshness: "stale", ageMs: 10_000 }])).anchors[0]?.freshness, "stale");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...f.publication, fleetID: "2" }])).availability, "unknown");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...f.publication, shipID: null }])).availability, "unknown");
});
