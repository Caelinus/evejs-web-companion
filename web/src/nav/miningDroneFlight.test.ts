import test from "node:test";
import assert from "node:assert/strict";
import { decideMiningDroneFlight, freshDroneMemory, type MiningDroneState } from "./miningDroneFlight.ts";

const bay = (itemID: number, typeID: number, quantity = 5) => ({ itemID, typeID, quantity });
const out = (itemID: number, typeID: number, activity: string, targetID: number | null = null) => ({
  itemID, typeID, name: null, activity, targetID, controlled: true,
  shieldRatio: 1, armorRatio: 1, hullRatio: 1,
});
const state = (bayRows: MiningDroneState["bay"], outRows: MiningDroneState["out"], maxActive = 5): MiningDroneState => ({
  bay: bayRows, out: outRows, maxActive, roles: { 101: "mining", 102: "combat", 103: null },
});

test("capability flight: mine, recall, fight, three clears, recall, resume mining", () => {
  let mem = freshDroneMemory();
  const step = (s: MiningDroneState, hostile: number | null, rock = 900, leaving = false) => {
    const decision = decideMiningDroneFlight(s, mem, hostile, rock, leaving);
    mem = decision.memory;
    return decision.action;
  };
  assert.deepEqual(step(state([bay(11, 101), bay(12, 102)], []), null), { kind: "launch", droneItemIDs: [11] });
  assert.deepEqual(step(state([bay(12, 102)], [out(21, 101, "idle")]), null),
    { kind: "mineDrones", droneIDs: [21], targetID: 900 });
  assert.deepEqual(step(state([bay(12, 102)], [out(21, 101, "mining", 900)]), 500)?.kind, "recallDrones");
  assert.equal(step(state([bay(12, 102)], [out(21, 101, "returning")]), 500)?.kind, "wait");
  assert.deepEqual(step(state([bay(11, 101), bay(12, 102)], []), 500), { kind: "launch", droneItemIDs: [12] });
  assert.deepEqual(step(state([bay(11, 101)], [out(22, 102, "idle")]), 500),
    { kind: "engageDrones", droneIDs: [22], targetID: 500 });
  assert.equal(step(state([bay(11, 101)], [out(22, 102, "fighting", 500)]), null), null);
  assert.equal(step(state([bay(11, 101)], [out(22, 102, "fighting", 500)]), null), null);
  assert.equal(step(state([bay(11, 101)], [out(22, 102, "fighting", 500)]), null)?.kind, "recallDrones");
  assert.equal(step(state([bay(11, 101)], [out(22, 102, "returning")]), null)?.kind, "wait");
  assert.deepEqual(step(state([bay(11, 101)], []), null), { kind: "launch", droneItemIDs: [11] });
});

test("unreadable flight or limit never launches; moving recalls and waits for return", () => {
  const fresh = freshDroneMemory();
  assert.equal(decideMiningDroneFlight(null, fresh, null, 900, false).action?.kind, "wait");
  assert.equal(decideMiningDroneFlight(state([bay(11, 101)], null), fresh, null, 900, false).action?.kind, "wait");
  assert.equal(decideMiningDroneFlight(state([bay(11, 101)], [], 0), fresh, null, 900, false).action, null);
  assert.equal(decideMiningDroneFlight({ ...state([bay(11, 101)], []), maxActive: null }, fresh, null, 900, false).action, null);
  assert.equal(decideMiningDroneFlight(state([bay(13, 103)], []), fresh, null, 900, false).action, null);
  const recall = decideMiningDroneFlight(state([], [out(21, 101, "mining", 900)]), fresh, null, 900, true);
  assert.equal(recall.action?.kind, "recallDrones");
  assert.equal(decideMiningDroneFlight(state([], [out(21, 101, "returning")]), recall.memory, null, 900, true).action?.kind, "wait");
  assert.equal(decideMiningDroneFlight(state([], []), recall.memory, null, 900, true).action, null);
});

test("a known non-mining flight is not commandeered and still occupies active slots", () => {
  const salvage = out(301, 104, "salvaging", 700);
  const s = { ...state([bay(11, 101)], [salvage], 1), roles: { 101: "mining" as const, 104: "salvage" as const } };
  assert.equal(decideMiningDroneFlight(s, freshDroneMemory(), null, 900, false).action, null);
  assert.equal(decideMiningDroneFlight(s, freshDroneMemory(), null, 900, true).action, null);
});

test("returned EveJS singleton drones remain launchable for mining and defensive flight", () => {
  const singletonBay = [bay(11, 101, -1), bay(12, 102, -1)];
  const calm = decideMiningDroneFlight(state(singletonBay, []), freshDroneMemory(), null, 900, false);
  assert.deepEqual(calm.action, { kind: "launch", droneItemIDs: [11] });
  const hostile = decideMiningDroneFlight(state(singletonBay, []), freshDroneMemory(), 500, 900, false);
  assert.deepEqual(hostile.action, { kind: "launch", droneItemIDs: [12] });
  assert.equal(decideMiningDroneFlight(state([bay(13, 101, -2)], []), freshDroneMemory(), null, 900, false).action,
    null, "an unknown negative quantity is not treated as an EveJS singleton");
});
