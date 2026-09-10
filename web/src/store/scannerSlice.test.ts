import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "./clientStore.ts";

const emptyScan = {
  anomalies: [],
  signatures: [],
  staticSites: [],
  structures: [],
} as const;
const SYSTEM_A = 30000142;
const SYSTEM_B = 30000144;
const unavailableOperations = {
  status: "unavailable" as const,
  reason: "not needed by this reducer test",
};

test("Scanner starts unloaded without claiming the current system is empty", () => {
  const scanner = createClientStore().get().scanner;
  assert.equal(scanner.loaded, false);
  assert.equal(scanner.loading, false);
  assert.equal(scanner.solarSystemID, null);
  assert.equal(scanner.scan.status, "loading");
  assert.equal(scanner.formations.status, "loading");
});

test("scanner/loading preserves the last authoritative result", () => {
  const store = createClientStore();
  store.apply({
    type: "scanner/loaded",
    solarSystemID: SYSTEM_A,
    scan: { status: "ready", value: emptyScan },
    formations: {
      status: "ready",
      value: { formations: [], cacheReference: null },
    },
    operations: unavailableOperations,
    refreshedAtMs: 100,
  });
  store.apply({ type: "scanner/loading" });

  const scanner = store.get().scanner;
  assert.equal(scanner.loaded, true);
  assert.equal(scanner.loading, true);
  assert.equal(scanner.solarSystemID, SYSTEM_A);
  assert.equal(scanner.scan.status, "ready");
  assert.equal(scanner.refreshedAtMs, 100);
});

test("Scanner stores partial availability without collapsing failure into empty", () => {
  const store = createClientStore();
  store.apply({
    type: "scanner/loaded",
    solarSystemID: SYSTEM_A,
    scan: { status: "unavailable", reason: "Scanner data could not be read." },
    formations: {
      status: "ready",
      value: { formations: [], cacheReference: null },
    },
    operations: unavailableOperations,
    refreshedAtMs: 200,
  });
  const scanner = store.get().scanner;
  assert.equal(scanner.scan.status, "unavailable");
  assert.equal(scanner.formations.status, "ready");
});

test("offline, logout and explicit clear discard character-specific Scanner state", () => {
  for (const event of [
    { type: "scanner/cleared" } as const,
    { type: "character/offline" } as const,
    { type: "session/logged-out" } as const,
  ]) {
    const store = createClientStore();
    store.apply({
      type: "scanner/loaded",
      solarSystemID: SYSTEM_A,
      scan: { status: "ready", value: emptyScan },
      formations: {
        status: "ready",
        value: { formations: [], cacheReference: null },
      },
      operations: unavailableOperations,
      refreshedAtMs: 300,
    });
    store.apply(event);
    assert.equal(store.get().scanner.loaded, false);
    assert.equal(store.get().scanner.solarSystemID, null);
    assert.equal(store.get().scanner.scan.status, "loading");
  }
});

test("a confirmed solar-system change clears old scanner rows synchronously", () => {
  const store = createClientStore();
  store.apply({
    type: "scanner/loaded",
    solarSystemID: SYSTEM_A,
    scan: { status: "ready", value: emptyScan },
    formations: { status: "ready", value: { formations: [], cacheReference: null } },
    operations: unavailableOperations,
    refreshedAtMs: 400,
  });
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: SYSTEM_B,
      stationID: null,
      structureID: null,
      shipID: 9001,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  });

  const scanner = store.get().scanner;
  assert.equal(scanner.loaded, false);
  assert.equal(scanner.solarSystemID, null);
  assert.equal(scanner.scan.status, "loading");
});
