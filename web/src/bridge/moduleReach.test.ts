import test from "node:test";
import assert from "node:assert/strict";
import { decodeModuleReach, readObservedModuleReach } from "./moduleReach.ts";
import type { SpaceSnapshot } from "../store/types.ts";
const raw = { shipID: 101, sampledAtSimTimeMs: 200, availability: "available", reason: null,
  modules: [{ moduleID: 301, typeID: 401, family: "mining", resourceFamily: "ore", availability: "available", maxRangeMeters: 23000, settlementSurfaceDistanceMeters: null, reason: null }] } as const;
test("module reach preserves exact item range and requires the same own scene sample", () => {
  const moduleReach = decodeModuleReach(raw)!;
  const scene = { inSpace: true, shipID: 101, sampledAtMs: 200, ship: { itemID: 101, moduleReach } } as SpaceSnapshot;
  assert.equal(readObservedModuleReach(scene, 301, 401)?.maxRangeMeters, 23000);
  assert.equal(readObservedModuleReach(scene, 301, 402), null);
  assert.equal(readObservedModuleReach({ ...scene, shipID: 102 }, 301, 401), null);
  assert.equal(readObservedModuleReach({ ...scene, sampledAtMs: 201 }, 301, 401), null);
  assert.equal(readObservedModuleReach({ ...scene, inSpace: false }, 301, 401), null);
});
test("missing, malformed and duplicate ranges remain unknown; zero is a measured range", () => {
  assert.equal(decodeModuleReach(undefined), null);
  assert.equal(decodeModuleReach({ ...raw, modules: null })?.availability, "unknown");
  assert.equal(decodeModuleReach({ ...raw, modules: [raw.modules[0], raw.modules[0]] })?.availability, "unknown");
  for (const maxRangeMeters of [null, -1, "23000"]) {
    assert.equal(decodeModuleReach({ ...raw, modules: [{ ...raw.modules[0], maxRangeMeters }] })?.modules?.[0]?.availability, "unknown");
  }
  assert.equal(decodeModuleReach({ ...raw, modules: [{ ...raw.modules[0], maxRangeMeters: 0 }] })?.modules?.[0]?.maxRangeMeters, 0);
  assert.equal(decodeModuleReach({ ...raw, modules: [{ ...raw.modules[0], family: "tractor" }] })?.modules?.[0]?.availability, "unknown");
});
