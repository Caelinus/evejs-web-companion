// REPRO: the live freeze. Operator ran a custom bot; it undocked, warped to a
// belt, launched drones on a pirate — and the whole web UI froze at the undock
// message and never moved again (overview stuck, Pause/Stop dead). That is the
// signature of a RENDER-TIME THROW on the first in-space paint: the runner keeps
// pushing store updates (ship keeps moving) but Svelte's scheduler is wedged, so
// the DOM never flushes past the last good render.
//
// This renders the workspace against the exact state at that moment — in space,
// a custom bot running, a snapshot carrying the ship, a controlled drone, a
// locked rock, and a hostile NPC — and asserts it does not throw. (R107 moved
// the in-space paint out of App, now the multibox roster, into Workspace.)

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

const SHIP = {
  itemID: 9001, typeID: 17476, name: "Procurer", mode: "orbit", maxVelocity: 100, radius: 100,
  position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
  shieldRatio: 0.9, armorRatio: 1, hullRatio: 1, capacitorRatio: 0.7,
  shieldCapacity: 3000, armorCapacity: 2000, hullCapacity: 1500, activeModuleIDs: [700],
};

function ent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: null, ownerID: null,
    radius: 10, position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  };
}

const SNAPSHOT = {
  inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1,
  ship: SHIP,
  entities: [
    ent({ itemID: 9001, kind: "ship", name: "Procurer", isSelf: true, position: { x: 0, y: 0, z: 0 } }),
    ent({ itemID: 50001, kind: "asteroid", name: "Veldspar", miningYieldTypeID: 1230, beltID: 40001, remainingQuantity: 1500, position: { x: 4000, y: 0, z: 0 } }),
    ent({ itemID: 40001, kind: "celestial", name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } }),
    ent({ itemID: 111, kind: "drone", name: "Hobgoblin II", controllerID: 9001, ownerID: 90000001, characterID: 90000001, position: { x: 500, y: 0, z: 0 } }),
    ent({ itemID: 6660, kind: "npc", name: "Serpentis Scout", isNpc: true, npcEntityType: "hostile", securityStatus: -5, shieldRatio: 0.3, armorRatio: 0.2, hullRatio: 1, position: { x: 8000, y: 0, z: 0 } }),
  ],
};

function inSpaceBotStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" });
  store.apply({
    type: "character/online",
    character: { characterID: 90000001, characterName: "Farmer", stationID: 60003760, structureID: null, solarSystemID: 30000142, corporationID: 1000001 },
    station: null,
  });
  store.apply({
    type: "flight/status",
    status: { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipMode: "orbit", shipSpeedFraction: 0.5 },
  });
  store.apply({ type: "space/snapshot", snapshot: SNAPSHOT as never, gateLinks: [] });
  store.apply({ type: "targeting/targets", targetIDs: [50001, 6660] });
  store.apply({ type: "custom-bot/started", name: "Mine & haul" });
  store.apply({
    type: "custom-bot/progress",
    status: "running", phase: "Fighting", why: "Sending the drones onto the pirate.",
    stepPath: "d", interruptID: null, pauseReason: null,
  });
  return store;
}

test("the workspace survives the first in-space paint with a running custom bot, drones, a lock, and a pirate", async () => {
  const store = inSpaceBotStore();
  const Workspace = (await import("./Workspace.svelte")).default;
  const body = render(Workspace as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.equal(typeof body, "string");
  assert.match(body, /In Space/);
});

test("the panels that render drones survive that same snapshot (drones, pirate, rock)", async () => {
  // ⚠ THE CRASH THIS REPRO WAS WRITTEN FOR WAS IN THE DRONE RENDER, and the
  // cockpit that held it has been taken apart. The claim moved to the two
  // components that render those rows now — the drones window and the overview
  // panel — because a whole-workspace render (the test above) can go green
  // while one panel inside an ErrorBoundary is quietly showing its fallback.
  const store = inSpaceBotStore();
  const DronesPanel = (await import("./DronesPanel.svelte")).default;
  const SpaceOverview = (await import("./SpaceOverview.svelte")).default;
  for (const Panel of [DronesPanel, SpaceOverview]) {
    const body = render(Panel as never, { props: { store, flow: fakeFlow() } } as never).body;
    assert.equal(typeof body, "string");
  }
});
