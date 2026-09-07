// The module rack as it actually RENDERS now that it is clickable (the retail
// F-row). The load-bearing claims, proven on real rendered markup:
//
//   1. R8 — a module you can click is a real <button>, not a styled span, and
//      an EMPTY slot is not a button (there is nothing to press).
//   2. The button SAYS what a click does — activate, deactivate, or why nothing
//      will happen (offline) — in its title/aria-label, because the tile itself
//      is a picture.
//   3. An OFFLINE module renders disabled: onlining is a Fitting-window
//      decision and the rack must not bury it under a misclick.
//   4. A rack with NO flow (read-only mount) renders every module disabled —
//      markup that looks pressable but goes nowhere is a lie.
//   5. R7d — no raw itemID/typeID in anything the player can read.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { deriveShipStats } = await import("../bridge/shipStats.ts");
const ModuleRack = (await import("./ModuleRack.svelte")).default;

const SHIP_ID = 9001;
const BOOSTER_ID = 7100001;
const BOOSTER_TYPE = 10850;
const MINER_ID = 7100002;
const MINER_TYPE = 483;
const HARDENER_ID = 7100003;
const HARDENER_TYPE = 11642;

function loadedStore(options: { activeModuleIDs?: number[] } = {}) {
  const store = createClientStore();
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: [],
      ship: {
        itemID: SHIP_ID,
        typeID: 606,
        name: "Ibis",
        mode: "STOP",
        maxVelocity: 300,
        radius: 30,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 300,
        armorCapacity: 300,
        hullCapacity: 300,
        activeModuleIDs: options.activeModuleIDs ?? [MINER_ID],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
    },
  });
  store.apply({
    type: "fitting/loaded",
    activeShipID: SHIP_ID,
    slots: [
      {
        family: "high",
        index: 0,
        module: { itemID: MINER_ID, typeID: MINER_TYPE, groupID: 54, online: true, charge: null },
      },
      {
        family: "mid",
        index: 0,
        module: { itemID: BOOSTER_ID, typeID: BOOSTER_TYPE, groupID: 40, online: true, charge: null },
      },
      {
        family: "mid",
        index: 1,
        module: null,
      },
      {
        family: "low",
        index: 0,
        module: { itemID: HARDENER_ID, typeID: HARDENER_TYPE, groupID: 328, online: false, charge: null },
      },
    ],
    resources: {
      cpu: { used: 0, total: 0, known: false },
      powergrid: { used: 0, total: 0, known: false },
      capacitor: { used: 0, total: 0, known: false },
      calibration: { used: 0, total: 0, known: false },
    },
    stats: deriveShipStats(new Map()),
    slotsError: null,
    resourcesError: null,
  });
  store.apply({
    type: "names/resolved",
    entries: {
      [`type:${MINER_TYPE}`]: "Miner I",
      [`type:${BOOSTER_TYPE}`]: "Small Shield Booster I",
      [`type:${HARDENER_TYPE}`]: "Armor EM Hardener I",
    },
  });
  return store;
}

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function renderRack(options: { flow?: unknown | null; activeModuleIDs?: number[] } = {}): string {
  return render(ModuleRack, {
    props: {
      store: loadedStore(options),
      flow: options.flow === undefined ? fakeFlow() : options.flow,
    },
  }).body;
}

/** Everything a player can see, with markup and comments stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<!--.*?-->/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

test("R8 — fitted modules render as real buttons; the empty slot does not", () => {
  const body = renderRack();
  const buttons = body.match(/<button[^>]*class="[^"]*module-slot/g) ?? [];
  assert.equal(buttons.length, 3, "three fitted modules, three buttons");
  // The empty mid slot is a span, because there is nothing to press.
  assert.match(body, /<span[^>]*class="[^"]*module-slot[^"]*empty/);
});

test("the button says what a click does, by NAME", () => {
  const body = renderRack();
  assert.match(body, /Small Shield Booster I — click to switch on\./);
  assert.match(body, /Miner I — active\. Click to switch off\./);
  assert.match(body, /Armor EM Hardener I — offline \(bring it online from the Fitting window\)/);
});

test("the cycling module carries aria-pressed and the glow class", () => {
  const body = renderRack();
  const miner = body.match(/<button[^>]*Miner I[^>]*>/)?.[0] ?? "";
  assert.match(miner, /aria-pressed="true"/);
  assert.match(miner, /class="[^"]*active/);
  const booster = body.match(/<button[^>]*Small Shield Booster I[^>]*>/)?.[0] ?? "";
  assert.match(booster, /aria-pressed="false"/);
});

test("⚠ the offline module renders DISABLED — the rack refuses the misclick", () => {
  const body = renderRack();
  const hardener = body.match(/<button[^>]*Armor EM Hardener I[^>]*>/)?.[0] ?? "";
  assert.match(hardener, /disabled/);
  assert.match(hardener, /class="[^"]*offline/);
});

test("a rack with no flow renders every module disabled (read-only mount)", () => {
  const body = renderRack({ flow: null });
  const buttons = body.match(/<button[^>]*class="[^"]*module-slot[^>]*>/g) ?? [];
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.match(button, /disabled/, "a rack nothing can drive must not look pressable");
  }
});

// A module winding down must not wear the danger styling or role="alert": the
// click worked, the cycle is simply finishing. The markup carries two distinct
// elements so a note can never be mistaken for a failure.
test("the rack has separate markup for a refusal and for a winding-down note", () => {
  const source = readFileSync(path.join(UI_DIR, "ModuleRack.svelte"), "utf8");
  assert.match(source, /class="rack-error" role="alert"/, "a refusal is an alert");
  assert.match(source, /class="rack-note" aria-live="polite"/, "a note is not");
  // And the note is the ELSE branch, so the two can never render together.
  assert.match(source, /\{#if error\}[\s\S]*\{:else if windingDown\}/);
});

test("R7d — no raw ids reach the player's eyes", () => {
  const text = visibleText(renderRack());
  for (const id of [SHIP_ID, MINER_ID, BOOSTER_ID, HARDENER_ID, MINER_TYPE, BOOSTER_TYPE, HARDENER_TYPE]) {
    assert.equal(
      text.includes(String(id)),
      false,
      `the visible rack must not contain the number ${id}`,
    );
  }
});

// --- press-and-hold to overload ----------------------------------------------
//
// The gesture that guards overloading changed from shift-click to a hold. These
// are source claims rather than render claims because SSR runs no handlers at
// all: what can be proven here is that the wiring exists and that the OLD
// wiring is gone, which is exactly the pair that rots when someone "restores"
// the familiar modifier.

const RACK_SOURCE = readFileSync(path.join(UI_DIR, "ModuleRack.svelte"), "utf8");
const CSS_SOURCE = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");

test("⚠ SHIFT-CLICK IS GONE — it does not exist on a touch screen", () => {
  assert.equal(
    /shiftKey/.test(RACK_SOURCE),
    false,
    "shift-click came back; on the touch tier this panel now has, it is unreachable",
  );
  assert.equal(
    /Shift-click/.test(RACK_SOURCE),
    false,
    "the tooltip still names a modifier the player may not be able to press",
  );
});

test("the hold is wired for a pointer AND for a keyboard", () => {
  for (const handler of ["onpointerdown", "onpointerup", "onpointerleave", "onkeydown", "onkeyup"]) {
    assert.match(RACK_SOURCE, new RegExp(handler), `no ${handler} — the press is incomplete`);
  }
  // ⚠ The keyboard path must suppress the browser's own click for the key, or a
  // tap fires the module twice. Trading one inaccessible gesture for another is
  // not a fix.
  assert.match(RACK_SOURCE, /event\.preventDefault\(\)/);
});

test("a press that slides off the button does nothing at all", () => {
  // Not the overload, and not the activation either: dragging off a control is
  // how a player takes a press back.
  assert.match(RACK_SOURCE, /function pressCancel\(\)/);
  assert.match(RACK_SOURCE, /onpointerleave=\{pressCancel\}/);
});

test("the slot ring is a drawn CIRCLE, not a rounded corner (R53)", () => {
  // R53 squared this app's corners and squareCorners.test.ts holds them squared.
  // The round slot face is an SVG circle INSIDE the square tile — the same
  // exception `.fit-ring-guide` already is.
  assert.match(RACK_SOURCE, /<circle class="slot-ring-track"/);
  const slotRule = CSS_SOURCE.slice(
    CSS_SOURCE.indexOf("  .module-slot {"),
    CSS_SOURCE.indexOf("button.module-slot:hover"),
  );
  assert.ok(slotRule.length > 0, "the .module-slot rule is not where this test looks");
  assert.equal(
    /border-radius/.test(slotRule),
    false,
    "the tile was rounded — draw the circle, do not round the box",
  );
});

// --- rack heat: a stub that admits it ----------------------------------------

test("⚠ the heat bar says NOT KNOWN, and is never filled from damage", () => {
  const body = renderRack();
  assert.match(body, /class="rack-heat/, "the heat bar is missing entirely");
  assert.match(visibleText(body), /not known/, "the heat bar invented a reading");
  // The trap — damage is the SCAR heat leaves behind, not the heat in the rack
  // now — is proven on damaged modules in `moduleRack.test.ts`. What is proven
  // HERE is the rendering half: no fill element is drawn at all, so there is
  // nothing for a later "just show something" change to quietly start filling.
  assert.equal(
    /rack-heat-fill/.test(body),
    false,
    "a heat fill was drawn from a reading this client does not have",
  );
  assert.equal(/Heat 0/.test(visibleText(body)), false, "not known must never render as 0");
});

test("⚠ THE HEAT READING IS A COLUMN, not something that lands after the slots", () => {
  // FOUND BY EYE, ON THE PHONE. The first build pushed the heat to the end of
  // the row with `margin-left: auto`, so each rack's reading landed wherever
  // that rack's slots happened to stop wrapping — three rows, three different
  // positions, and nothing you could read down.
  //
  // The handoff's row is `44px minmax(0,1fr)`: a fixed label cell holding the
  // rack name, the bar and the reading, then the slots. A fixed first column is
  // what makes the three readings a column at all.
  const rule = CSS_SOURCE.slice(CSS_SOURCE.indexOf("  .rack-row {"), CSS_SOURCE.indexOf("  .rack-name"));
  assert.ok(rule.length > 0, "the .rack-row rule is not where this test looks");
  assert.match(rule, /display: grid/);
  assert.match(rule, /grid-template-columns: \d+px minmax\(0, 1fr\)/);
  assert.equal(/margin-left: auto/.test(CSS_SOURCE.slice(
    CSS_SOURCE.indexOf("  .rack-row-label {"),
    CSS_SOURCE.indexOf("  .rack-slots"),
  )), false, "the heat drifted to the end of the row again");
  // And in the markup, the label cell holds all three pieces — before the slots.
  const label = RACK_SOURCE.slice(
    RACK_SOURCE.indexOf('class="rack-row-label"'),
    RACK_SOURCE.indexOf('class="rack-slots"'),
  );
  assert.ok(label.length > 0, "the label cell no longer precedes the slots");
  assert.match(label, /rack-name/);
  assert.match(label, /rack-heat-track/);
  assert.match(label, /rack-heat-value/);
});
