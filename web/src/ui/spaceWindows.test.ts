// The two windows the in-space cockpit became — and the one control that had to
// be carried back into the overview panel so the cockpit could go.
//
// ⚠ WHAT THIS FILE IS FOR. `Overview.svelte` is being taken apart section by
// section, and the failure mode of that kind of work is not a broken test — it
// is a capability that simply stops existing, with every remaining test green.
// So the claims here are deliberately about WHAT A PILOT CAN STILL DO:
//
//   1. Both new windows are reachable — a `TabID`, a rail entry, a route in the
//      panel host, and a Neocom glyph. A window nothing can open is not a
//      window.
//   2. "Send drones" is back on a hostile row. It was the fastest path in the
//      whole client from "something is shooting me" to "my drones are on it" —
//      no lock, no window — and the drones window is not a replacement for it.
//   3. The shots window says what its totals are over, in the markup, not only
//      in `shotsLog.ts`.
//
// The drones window's own behaviour is not re-tested here: `dronePanel.test.ts`
// makes those claims and was re-pointed at the new component, which is the
// stronger proof — the old suite passing against the new home.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { TABS, launchableTabsFor } = await import("./tabs.ts");
const { NEOCOM_GLYPHS } = await import("./neocomIcons.ts");
const ShotsPanel = (await import("./ShotsPanel.svelte")).default;
const SpaceOverview = (await import("./SpaceOverview.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HOST = readFileSync(path.join(UI_DIR, "PanelHost.svelte"), "utf8");

const SHIP_ID = 9001;
const SHIP_TYPE_ID = 622;
const SYSTEM_ID = 30000142;
const PIRATE_ID = 7700001;
const DRONE_ID = 9500001;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- reachable ---------------------------------------------------------------

test("the drones and shots windows are reachable in space, and only in space", () => {
  for (const id of ["drones", "shots"] as const) {
    const tab = TABS.find((entry) => entry.id === id);
    assert.ok(tab, `there is no '${id}' tab at all`);
    assert.equal(tab.where, "in-space", `'${id}' must not appear docked`);
    // Launchable: "where are my drones" and "what just hit me" are questions a
    // pilot asks without anything having been clicked first.
    assert.ok(
      launchableTabsFor(false).some((entry) => entry.id === id),
      `'${id}' is not offered in the in-space rail`,
    );
    assert.equal(
      launchableTabsFor(true).some((entry) => entry.id === id),
      false,
      `'${id}' leaked into the docked rail`,
    );
    // A glyph, or the rail draws an empty box.
    assert.ok(NEOCOM_GLYPHS[id], `no Neocom glyph for '${id}'`);
    // And a route, or the rail opens onto nothing.
    assert.match(
      PANEL_HOST,
      new RegExp(`tab === "${id}"`),
      `the panel host has no route for '${id}'`,
    );
  }
});

// --- Send drones came back ---------------------------------------------------

function grid(options: { drones?: boolean } = {}): unknown {
  const store = createClientStore();
  const entities: unknown[] = [
    {
      kind: "ship",
      itemID: PIRATE_ID,
      typeID: 587,
      groupID: null,
      categoryID: null,
      name: "Guristas Wight",
      ownerID: null,
      radius: 30,
      position: { x: 2000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isSelf: false,
      shieldRatio: 1,
      armorRatio: 1,
      hullRatio: 1,
      characterID: null,
      corporationID: null,
      allianceID: null,
      securityStatus: null,
      maxVelocity: null,
      mode: null,
      capacitorRatio: null,
      remainingQuantity: null,
      miningYieldTypeID: null,
      beltID: null,
      oreGrade: null,
      isNpc: true,
      npcEntityType: "pirate",
      controllerID: null,
      droneActivity: null,
      targetEntityID: null,
    },
  ];
  if (options.drones) {
    entities.push({
      ...(entities[0] as Record<string, unknown>),
      kind: "drone",
      itemID: DRONE_ID,
      typeID: 2456,
      name: "Hobgoblin I",
      isNpc: false,
      npcEntityType: null,
      controllerID: SHIP_ID,
      droneActivity: "idle",
    });
  }
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities,
      ship: {
        itemID: SHIP_ID,
        typeID: SHIP_TYPE_ID,
        name: null,
        mode: "STOP",
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 400,
        armorCapacity: 300,
        hullCapacity: 600,
        radius: 100,
        maxVelocity: 300,
        activeModuleIDs: [],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
    },
  } as never);
  if (options.drones) {
    store.apply({
      type: "drones/loaded",
      bay: [],
      inSpace: [
        {
          itemID: DRONE_ID,
          typeID: 2456,
          name: "Hobgoblin I",
          activity: "idle",
          targetID: null,
          shieldRatio: 1,
          armorRatio: 1,
          hullRatio: 1,
          controlled: true,
        },
      ],
      limits: { maxActiveDrones: 5, droneBandwidth: 25 },
    } as never);
  }
  return store;
}

function renderOverview(store: unknown): string {
  return render(SpaceOverview as never, { props: { store, flow: fakeFlow() } } as never).body;
}

test("⚠ a hostile row can still send the drones — the cockpit's fastest path", () => {
  // It was on every threat row in `Overview.svelte`: no lock, no window, one
  // press from "something is shooting me" to "my drones are on it". Deleting
  // that file without this would have left only the drones window, which is two
  // clicks and a lock.
  const body = renderOverview(grid({ drones: true }));
  assert.match(visibleText(body), /Guristas Wight/, "no threat row was rendered at all");
  assert.match(body, /class="spc-threat-send"/, "the threat row cannot command drones");
  assert.match(visibleText(body), /Send drones/);
});

test("⚠ with no drones out the control is ABSENT, not a button that can only refuse", () => {
  const body = renderOverview(grid({ drones: false }));
  assert.match(visibleText(body), /Guristas Wight/, "the threat itself is still listed");
  assert.equal(
    /class="spc-threat-send"/.test(body),
    false,
    "a hull with nothing to send drew a control that could only decline",
  );
});

test("the drone gate is SHARED between the two panels, not copied", () => {
  // The branch a second copy gets wrong is the `null` one — a drone the
  // snapshot does not carry, which neither panel can judge and both must keep.
  for (const file of ["SpaceOverview.svelte", "DronesPanel.svelte"]) {
    const source = readFileSync(path.join(UI_DIR, file), "utf8");
    assert.match(
      source,
      /orderableDroneIDs/,
      `${file} does not use the shared gate`,
    );
    assert.equal(
      /canMyShipOrderDrone\([^)]*\)\s*!==\s*false/.test(source),
      false,
      `${file} re-implements the gate instead of calling it`,
    );
  }
});

// --- the shots window --------------------------------------------------------

function renderShots(shots: readonly unknown[]): string {
  const store = createClientStore();
  for (const shot of shots) {
    store.apply({ type: "combat/damage", ...(shot as object) } as never);
  }
  return render(ShotsPanel as never, { props: { store, flow: fakeFlow() } } as never).body;
}

test("⚠ the shots window never prints a total without saying what it is over", () => {
  const text = visibleText(renderShots([]));
  assert.match(text, /Damage dealt/);
  assert.match(text, /Damage taken/);
  // The caption is not optional dressing: two bare numbers read as a scoreboard
  // for the whole engagement, which is a claim this log cannot make.
  assert.match(text, /Nothing to add up yet/);
});

test("an empty log says so in words, and shows no fabricated zero rows", () => {
  const text = visibleText(renderShots([]));
  assert.match(text, /Nothing has been shot at, or by, your ship/);
});

test("R7d: no bare numeric ID reaches the shots window", () => {
  const text = visibleText(renderShots([]));
  for (const id of [SHIP_ID, SHIP_TYPE_ID, SYSTEM_ID]) {
    assert.equal(new RegExp(`\\b${id}\\b`).test(text), false, `${id} is visible`);
  }
});
