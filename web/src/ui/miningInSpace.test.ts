// The Mining panel's IN-SPACE half: Compress and Jettison.
//
// ⚠ WHAT WAS WRONG BEFORE. Both of this panel's actions needed a station, so a
// flying miner with a full hold had a panel whose only answer was "dock". The
// two things the game actually offers out there — compressing at a support ship
// on grid, and dumping the ore into space — existed in the BFF and in the bot
// macros, and were unreachable from any panel: neither was an `AppFlow` method
// at all.
//
// The claims that matter here are the honest-refusal ones:
//
//   1. Nothing on grid to compress against is a SENTENCE, not a hidden button.
//   2. Jettison is armed in two steps, and the arming dies with the selection —
//      the ore is not destroyed, it is on the grid for anyone to take.
//   3. The docked actions stay docked-only, and these stay in-space-only.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Mining = (await import("./Mining.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Mining.svelte"), "utf8");

const SHIP_ID = 9001;
const SYSTEM_ID = 30000142;
const STATION_ID = 60000358;
const ORE_TYPE_ID = 1230;
const ORE_ITEM_ID = 7700001;
const MATE_ID = 8800001;

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

function shipRow(over: Record<string, unknown>): unknown {
  return {
    kind: "ship",
    itemID: MATE_ID,
    typeID: 28606,
    groupID: null,
    categoryID: null,
    name: "Orca on station",
    ownerID: null,
    radius: 100,
    position: { x: 2000, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
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
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

interface SceneOptions {
  readonly docked?: boolean;
  /** A support ship on grid, and whether its gear is running. */
  readonly facility?: "running" | "off" | "absent" | "far" | "npc";
  readonly ore?: boolean;
}

function scene(options: SceneOptions = {}) {
  const docked = options.docked === true;
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: !docked,
      docked,
      solarSystemID: SYSTEM_ID,
      stationID: docked ? STATION_ID : null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: docked ? null : "STOP",
      shipSpeedFraction: docked ? null : 0,
    },
  } as never);

  const entities: unknown[] = [];
  const facility = options.facility ?? "absent";
  if (facility !== "absent") {
    entities.push(
      shipRow({
        isNpc: facility === "npc",
        position: facility === "far" ? { x: 500_000, y: 0, z: 0 } : { x: 2000, y: 0, z: 0 },
        compressionFacility:
          facility === "off" ? null : { rangeMeters: 10_000, typeListIDs: [] },
      }),
    );
  }
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: !docked,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities,
      ship: {
        itemID: SHIP_ID,
        typeID: 622,
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

  store.apply({
    type: "mining/holds",
    holds: [
      {
        key: "ore",
        label: "Ore hold",
        items:
          options.ore === false
            ? []
            : [
                {
                  itemID: ORE_ITEM_ID,
                  typeID: ORE_TYPE_ID,
                  groupID: 462,
                  categoryID: 25,
                  quantity: 1250,
                },
              ],
        capacity: { capacity: 5000, used: 1250 },
        present: true,
        error: null,
      },
    ],
  } as never);
  store.apply({
    type: "names/resolved",
    entries: { [`type:${ORE_TYPE_ID}`]: "Veldspar" },
  } as never);
  return store;
}

function renderMining(options: SceneOptions = {}): string {
  return render(Mining as never, { props: { store: scene(options), flow: fakeFlow() } } as never)
    .body;
}

// --- compress ----------------------------------------------------------------

test("a support ship running its gear is offered, by name and range", () => {
  const text = visibleText(renderMining({ facility: "running" }));
  assert.match(text, /Compress it/);
  assert.match(text, /Orca on station/);
  assert.match(text, /Veldspar/, "the stack it would compress is named");
});

test("⚠ NOTHING ON GRID IS A SENTENCE, NOT A HIDDEN BUTTON", () => {
  // R30's rule. The player is told what would have to be true, rather than
  // shown a section that silently has no controls in it.
  const text = visibleText(renderMining({ facility: "absent" }));
  assert.match(text, /No mining support ship on this grid is running its compression gear/);
  assert.match(text, /Bring one, or switch yours on/);
});

test("⚠ A SUPPORT SHIP WITH ITS GEAR OFF IS NOT A CANDIDATE", () => {
  // An explicit null means the hull is there and the modules are not running.
  const text = visibleText(renderMining({ facility: "off" }));
  assert.match(text, /No mining support ship on this grid/);
  assert.equal(/Orca on station/.test(text), false, "an idle hull was offered");
});

test("⚠ AN NPC HULL IS NEVER OFFERED", () => {
  const text = visibleText(renderMining({ facility: "npc" }));
  assert.match(text, /No mining support ship on this grid/);
});

test("a support ship outside its own reach is DRAWN, wearing its reason", () => {
  const body = renderMining({ facility: "far" });
  const text = visibleText(body);
  assert.match(text, /Orca on station/, "the ship is still listed");
  assert.match(text, /Too far from that support ship/);
  // And the control that cannot work carries the reason rather than being
  // greyed out in silence.
  assert.match(body, /title="Too far from that support ship[^"]*"/);
});

test("with an empty hold there is nothing to compress, and it says so", () => {
  const text = visibleText(renderMining({ facility: "running", ore: false }));
  assert.match(text, /Nothing in your holds to compress/);
});

// --- jettison ----------------------------------------------------------------

test("⚠ JETTISON SAYS WHAT IT ACTUALLY DOES — the ore is not destroyed", () => {
  // Calling it "drop" or "delete" would both be wrong: it goes into a container
  // on the grid that anyone passing can take.
  const text = visibleText(renderMining({ facility: "running" }));
  assert.match(text, /Dump it into space/);
  assert.match(text, /Pick what you want to dump/);
});

test("⚠ JETTISON IS TWO STEPS, AND THE ARMING DIES WITH THE SELECTION", () => {
  // Same treatment reprocessing has, for the same reason: a confirmation must
  // never outlive the thing it was shown for.
  assert.match(SOURCE, /jettisonArmedFor = \$state<string \| null>\(null\)/);
  assert.match(SOURCE, /jettisonArmedFor === selectionKey\(selected\)/);
  assert.match(SOURCE, /jettisonArmedFor = null/, "the arming is cleared after the act");
});

// --- the two states stay apart -----------------------------------------------

test("⚠ THE IN-SPACE ACTIONS ARE NOT DRAWN DOCKED", () => {
  const text = visibleText(renderMining({ docked: true, facility: "running" }));
  assert.equal(/Compress it/.test(text), false, "compression needs a ship on grid");
  assert.equal(/Dump it into space/.test(text), false, "there is no space to dump into");
  // ...and the docked ones are.
  assert.match(text, /Move it to your hangar/);
  assert.match(text, /Refine it into minerals/);
});

test("the docked actions still say to dock, rather than pretending", () => {
  const text = visibleText(renderMining({ facility: "running" }));
  assert.match(text, /Dock at a station to unload/);
  assert.match(text, /Dock at a station to use its refinery/);
});

// --- the standing invariants -------------------------------------------------

test("R7d: no itemID, typeID or stationID reaches the screen", () => {
  const text = visibleText(renderMining({ facility: "running" }));
  for (const id of [SHIP_ID, SYSTEM_ID, STATION_ID, ORE_TYPE_ID, ORE_ITEM_ID, MATE_ID]) {
    assert.equal(new RegExp(`\\b${id}\\b`).test(text), false, `${id} is visible`);
  }
});

test("R8: every offered action is a real button", () => {
  const body = renderMining({ facility: "running" });
  const section = body.slice(body.indexOf("Compress it"), body.indexOf("Move it to your hangar"));
  assert.match(section, /<button[^>]*>[\s\S]{0,40}Compress/);
  assert.equal(/<a\s+href="#/.test(section), false, "an anchor was used as a control");
});

test("the facility rule is SHARED with the bot macro, not copied", () => {
  // The branch two copies get wrong is the absent reading, which must mean "not
  // a facility" and never "an unknown worth firing at".
  assert.match(SOURCE, /from "\.\.\/space\/compression\.ts"/);
  const macro = readFileSync(path.join(UI_DIR, "..", "nav", "scriptMacros.ts"), "utf8");
  assert.match(macro, /from "\.\.\/space\/compression\.ts"/);
  assert.equal(
    /function compressionFacilities/.test(macro),
    false,
    "the macro kept its own copy of the rule",
  );
});
