import test from "node:test";
import assert from "node:assert/strict";
import { createTravelAssist, fittedTravelPropulsion, travelPropulsionActivation, type TravelAssistInput } from "./travelAssist.ts";
import { readFileSync } from "node:fs";
import type { SpaceSnapshot } from "../store/types.ts";
import type { PropulsionModule } from "./propulsion.ts";

const ab: PropulsionModule = { itemID: 2, typeID: 439, kind: "afterburner" };
const mwd: PropulsionModule = { itemID: 1, typeID: 440, kind: "microwarpdrive" };
function world(over: Partial<TravelAssistInput> = {}, x = 50_000, active: number[] = []): TravelAssistInput {
  return { enabled: true, scope: "op:target:step", action: { kind: "approach", targetID: 10 }, inWarp: false, docked: false, modules: [ab], scrammed: false,
    snapshot: { inSpace: true, shipID: 9, solarSystemID: 30000142, sampledAtMs: 1, ship: { position: { x: 0, y: 0, z: 0 }, radius: 100, activeModuleIDs: active, capacitorRatio: 1 },
      entities: [{ itemID: 10, position: { x, y: 0, z: 0 }, radius: 100 }, { itemID: 11, position: { x, y: 0, z: 0 }, radius: 100 }] } as unknown as SpaceSnapshot, ...over };
}
function harness(refuseOn = false, refuseOff = false) {
  const changes: { module: PropulsionModule; on: boolean }[] = [], logs: string[] = [];
  const assist = createTravelAssist({ change: async (module, on) => { changes.push({ module, on }); if (on ? refuseOn : refuseOff) throw new Error("refused"); return true; }, log: line => logs.push(line) });
  return { assist, changes, logs };
}

test("fitted propulsion comes from online SDE effect metadata, not display names", () => {
  assert.deepEqual(fittedTravelPropulsion([
    { itemID: 2, typeID: 439, online: true, effect: "moduleBonusAfterburner" },
    { itemID: 1, typeID: 440, online: true, effect: "moduleBonusMicrowarpdrive" },
    { itemID: 3, typeID: 439, online: false, effect: "moduleBonusAfterburner" },
    { itemID: 4, typeID: 439, online: true, effect: "Afterburner" },
  ]), [ab, mwd]);
});

for (const [name, over, distance] of [
  ["no module", { modules: [] }, 50_000], ["disabled", { enabled: false }, 50_000],
  ["warp", { inWarp: true }, 50_000], ["docked", { docked: true }, 50_000],
  ["waiting without approach", { action: { kind: "wait" } }, 50_000],
  ["near interaction", {}, 2_000], ["unreadable scene", { snapshot: null }, 50_000],
] as const) test(`${name}: ordinary movement unchanged, no assist activation`, async () => {
  const h = harness(); assert.equal(await h.assist.beforeAction(world(over, distance)), false); assert.deepEqual(h.changes, []);
});

test("AB first then itemID; MWD works alone and scram/capacitor policy is shared", async () => {
  const h = harness(); await h.assist.beforeAction(world({ modules: [mwd, { ...ab, itemID: 3 }, ab] }));
  assert.deepEqual(h.changes[0], { module: ab, on: true });
  const m = harness(); await m.assist.beforeAction(world({ modules: [mwd] })); assert.equal(m.changes[0]!.module.kind, "microwarpdrive");
  const scram = harness(); await scram.assist.beforeAction(world({ modules: [mwd], scrammed: true })); assert.equal(scram.changes.length, 0);
  const low = world(); const lowCap = { ...low, snapshot: { ...low.snapshot!, ship: { ...low.snapshot!.ship!, capacitorRatio: 0.1 } } };
  const c = harness(); await c.assist.beforeAction(lowCap); assert.equal(c.changes.length, 0);
});

test("long approach continues between commands, then owned prop turns off near target", async () => {
  const h = harness(); assert.equal(await h.assist.beforeAction(world()), true);
  assert.equal(await h.assist.beforeAction(world({ action: { kind: "wait" } }, 30_000, [2])), false);
  assert.equal(await h.assist.beforeAction(world({ action: { kind: "wait" } }, 3_000, [2])), true);
  assert.deepEqual(h.changes.map(row => row.on), [true, false]);
  await h.assist.requestStop(); assert.equal(h.changes.length, 2, "Stop is idempotent after confirmed off");
});

for (const change of [{ action: { kind: "lootContainer" } }, { action: { kind: "activate" } }, { action: { kind: "approach", targetID: 11 } }, { scope: "new-target" }, { enabled: false, scope: null }, { inWarp: true }]) {
  test(`interaction/change/loss deactivates owned propulsion: ${JSON.stringify(change)}`, async () => {
    const h = harness(); await h.assist.beforeAction(world()); await h.assist.beforeAction(world(change, 50_000, [2]));
    assert.deepEqual(h.changes.map(row => row.on), [true, false]);
  });
}

test("external active module is neither activated nor stopped by assist", async () => {
  const h = harness(); await h.assist.beforeAction(world({}, 50_000, [2])); await h.assist.requestStop(); assert.deepEqual(h.changes, []);
});

test("already-active refusal during activation race never acquires another controller's propulsion", async () => {
  const writes: boolean[] = [];
  const assist = createTravelAssist({ change: async (_module, on) => { writes.push(on); throw new Error("MODULE_ALREADY_ACTIVE"); }, log: () => {} });
  await assist.beforeAction(world());
  await assist.requestStop();
  assert.equal(assist.pending(), false);
  assert.deepEqual(writes, [true]);
});
test("activation refusal is soft and not retried blindly", async () => {
  const h = harness(true); await h.assist.beforeAction(world());
  for (let i = 0; i < 10; i++) assert.equal(await h.assist.beforeAction(world()), false);
  assert.equal(h.changes.length, 1); assert.ok(h.logs.some(row => row.includes("ordinary movement continues")));
});
test("graceful Stop/Parking stops only assist-owned module and verifies its existing action result", async () => {
  const h = harness(); await h.assist.beforeAction(world()); await h.assist.requestStop(); await h.assist.requestStop();
  assert.deepEqual(h.changes.map(row => row.on), [true, false]);
  const blocked = harness(false, true); await blocked.assist.beforeAction(world());
  await blocked.assist.requestStop();
  assert.equal(blocked.assist.pending(), true, "a false off result cannot authorize handing control away");
});
test("continuous approach does not flap or restart an externally stopped/expired propulsion cycle", async () => {
  const h = harness(); await h.assist.beforeAction(world());
  for (let i = 0; i < 40; i++) await h.assist.beforeAction(world({ action: { kind: "wait" } }, 40_000, [2]));
  await h.assist.beforeAction(world({ action: { kind: "wait" } }, 30_000));
  assert.deepEqual(h.changes.map(row => row.on), [true]);
});

test("AB/MWD explicitly select the physical dogma path and repeat until owned shutdown", () => {
  assert.deepEqual(travelPropulsionActivation(ab), { effect: "moduleBonusAfterburner", repeat: -1 });
  assert.deepEqual(travelPropulsionActivation(mwd), { effect: "moduleBonusMicrowarpdrive", repeat: -1 });
  const flow = readFileSync(new URL("../app/flow.ts", import.meta.url), "utf8");
  assert.match(flow, /activateModule\(module.itemID, travelPropulsionActivation\(module\), callOptions\)/);
});

test("cycling acceptance is distinct from physical max-speed and acceleration observations", async () => {
  const h = harness();
  const scene = (maxVelocity: number, speed: number, active: number[]) => {
    const input = world({}, 50_000, active);
    return { ...input, snapshot: { ...input.snapshot!, ship: { ...input.snapshot!.ship!, maxVelocity, velocity: { x: speed, y: 0, z: 0 } } } };
  };
  await h.assist.beforeAction(scene(187, 187, []));
  assert.match(h.logs[0]!, /awaiting physical effect observation/);
  for (let i = 0; i < 4; i++) await h.assist.beforeAction(scene(187, 187, [2]));
  assert.equal(h.logs.filter(row => row.includes("not confirmed")).length, 1);
  await h.assist.beforeAction(scene(340, 210, [2]));
  for (let i = 0; i < 8; i++) await h.assist.beforeAction(scene(340, 250, [2]));
  assert.equal(h.logs.filter(row => row.includes("effect observed")).length, 1);
  assert.equal(h.logs.filter(row => row.includes("acceleration observed")).length, 1);
  assert.equal(h.changes.length, 1);
});
