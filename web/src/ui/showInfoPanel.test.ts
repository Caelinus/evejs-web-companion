// The Show Info window as it RENDERS (goal R76).
//
// The window's whole value is that every figure in it is real. So this checks the
// negative cases hardest: a subject that has left the grid must lose its numbers
// rather than keep stale ones, a module with no dogma read must draw no attribute
// table, and nothing may print a raw game ID (R7d).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const ShowInfo = (await import("./ShowInfo.svelte")).default;
const { createShowInfoTarget, showInfoTarget } = await import("./showInfo.ts");

const ROCK_ID = 50001248;
const ORE_TYPE_ID = 1230;
const SHIP_ID = 9001;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => () => {} });
}

/** A snapshot with one rock 12 km out, half its shield gone. */
function spaceStore(): unknown {
  const store = createClientStore();
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      ship: {
        itemID: SHIP_ID,
        typeID: 622,
        name: null,
        mode: null,
        maxVelocity: 300,
        radius: 50,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 400,
        armorCapacity: 400,
        hullCapacity: 400,
        activeModuleIDs: [],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
      entities: [
        {
          kind: "celestial",
          itemID: ROCK_ID,
          typeID: ORE_TYPE_ID,
          groupID: 462,
          categoryID: 25,
          name: "Dense Veldspar",
          ownerID: null,
          radius: 300,
          position: { x: 12_000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          isSelf: false,
          shieldRatio: 0.5,
          armorRatio: null,
          hullRatio: null,
          characterID: null,
          corporationID: null,
          allianceID: null,
          securityStatus: null,
          maxVelocity: null,
          mode: null,
          capacitorRatio: null,
          remainingQuantity: 4200,
          miningYieldTypeID: ORE_TYPE_ID,
          beltID: 1,
          oreGrade: null,
          isNpc: false,
          npcEntityType: null,
          controllerID: null,
          droneActivity: null,
          targetEntityID: null,
        },
      ],
    },
  } as never);
  return store;
}

function renderInfo(store: unknown): string {
  return render(ShowInfo as never, {
    props: { store: store as never, flow: fakeFlow() as never },
  } as never).body;
}

test("with nothing selected the window says so rather than rendering blank", () => {
  showInfoTarget.clear();
  const body = renderInfo(createClientStore());
  assert.match(body, /Nothing selected/);
});

test("a thing on the grid shows its distance, condition and what is left of it", () => {
  showInfoTarget.show({ kind: "spaceObject", itemID: ROCK_ID, typeID: ORE_TYPE_ID });
  const body = renderInfo(spaceStore());
  assert.match(body, /Dense Veldspar/, "its own name beats its type name");
  assert.match(body, /12\.0 km/, "distance, computed from the ship");
  assert.match(body, /Shield/);
  assert.match(body, /50%/, "condition from the snapshot's own ratios");
  assert.match(body, /Ore left/);
  assert.match(body, /4,200/);
});

test("a layer with NO reading is absent, not rendered as zero", () => {
  // The rock reports a shield ratio and nothing for armor or hull. A window that
  // filled those in with 0% would say a rock is about to break up.
  showInfoTarget.show({ kind: "spaceObject", itemID: ROCK_ID, typeID: ORE_TYPE_ID });
  const body = renderInfo(spaceStore());
  assert.equal(body.includes("Armor"), false, "armor has no reading and must not appear");
  assert.equal(body.includes("Hull"), false, "hull has no reading and must not appear");
});

test("a thing that has LEFT the grid keeps its identity and loses its numbers", () => {
  // ⚠ The important one. Stale numbers are worse than none: a distance that
  // stopped updating reads as a thing sitting still.
  showInfoTarget.show({ kind: "spaceObject", itemID: 999_999, typeID: ORE_TYPE_ID });
  const body = renderInfo(spaceStore());
  assert.match(body, /no longer on your grid/);
  assert.equal(body.includes("12.0 km"), false, "no distance may survive the object");
  assert.equal(body.includes("Ore left"), false);
});

test("a module with no dogma read draws no attribute table", () => {
  // An empty table would imply a module with no attributes, rather than a
  // reading we do not have.
  showInfoTarget.show({ kind: "module", itemID: 7_700_001, typeID: 483 });
  const body = renderInfo(createClientStore());
  assert.match(body, /No attribute reading for this module yet/);
  assert.equal(body.includes("Attributes"), false);
});

test("a pilot with no recorded standing says so instead of showing 0.00", () => {
  // 0.00 is a REAL standing — neutral. It must never stand in for "we do not
  // know", which is a different fact a player would act on differently.
  showInfoTarget.show({ kind: "character", characterID: 140000005 });
  const body = renderInfo(createClientStore());
  assert.match(body, /no recorded standing/);
  assert.equal(body.includes("0.00"), false);
});

/**
 * Everything a player can actually READ, markup and images stripped.
 *
 * ⚠ THE `<img>` STRIP IS NOT A LOOPHOLE. R7d is about a game ID reaching a
 * player as DATA. A typeID inside `/icon-cache/types/64/icon/1230.png` is a
 * cache path — the mechanism every panel in this app already uses to fetch an
 * item picture (see TypeIcon) — and it is no more visible to a player than the
 * itemID in an onclick handler. `shellRender.test.ts` strips images for the same
 * reason; this matches it deliberately rather than inventing a stricter rule
 * that only this one panel would have to meet.
 */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("R7d: no raw game ID is ever rendered as text", () => {
  showInfoTarget.show({ kind: "spaceObject", itemID: ROCK_ID, typeID: ORE_TYPE_ID });
  const text = visibleText(renderInfo(spaceStore()));
  assert.equal(text.includes(String(ROCK_ID)), false, "the itemID must never show");
  assert.equal(text.includes(String(ORE_TYPE_ID)), false, "the typeID must never show");
  // And the window did render something, so this is not passing on an empty page.
  assert.match(text, /Dense Veldspar/);
});

test("an unresolved name degrades to words, never to an id", () => {
  showInfoTarget.show({ kind: "type", typeID: 34 });
  const body = renderInfo(createClientStore());
  assert.match(body, /Unknown object/);
  assert.equal(/>34</.test(body), false);
});

test("the shared target and a private one are independent", () => {
  // Guards the module-singleton: a test that set the shared target must not be
  // able to leak into an unrelated one that built its own.
  const own = createShowInfoTarget();
  showInfoTarget.show({ kind: "type", typeID: 34 });
  assert.equal(own.subject.get(), null);
});
