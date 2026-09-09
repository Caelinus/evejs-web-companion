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

// A refusal is the only thing the rack itself says now. The winding-down note
// went to the centre flash — see the reversal at the bottom of this file.
test("a refusal is an alert, on the control that refused (R30)", () => {
  const source = readFileSync(path.join(UI_DIR, "ModuleRack.svelte"), "utf8");
  assert.match(source, /class="rack-error" role="alert"/, "a refusal is an alert");
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
  // ⚠ BOUNDED BY THE RULE'S OWN BRACE. It used to run to
  // `button.module-slot:hover`, which was the next rule until hover moved onto
  // the ring — after which this slice swept up half the rack's styling and the
  // claim stopped being about the tile at all.
  const at = CSS_SOURCE.indexOf("  .module-slot {");
  const slotRule = CSS_SOURCE.slice(at, CSS_SOURCE.indexOf("\n  }", at));
  assert.ok(slotRule.length > 0, "the .module-slot rule is not where this test looks");
  assert.equal(
    /border-radius/.test(slotRule),
    false,
    "the tile was rounded — draw the circle, do not round the box",
  );
  // ⚠ AND THE TILE IS NOT PAINTED AT ALL. The square box came off: it drew a
  // filled bordered rectangle around the circle, both in the same line colour,
  // and the square won. The 42px box stays as layout and touch target; the ring
  // is the only thing drawn.
  assert.match(slotRule, /border: none;/, "the tile got its box back");
  assert.match(slotRule, /background: none;/, "the tile got its fill back");
});

test("⚠ AN ACTIVE MODULE LIGHTS THE RING, NOT THE WHOLE SQUARE", () => {
  // FOUND BY EYE, on a rack with three guns up: every cycling module was a
  // filled accent-blue SQUARE with its ring lost inside it.
  //
  // The tile is a real <button> and it carries `class:active`, which is also
  // this app's GLOBAL nav-tab selected state — an accent gradient across the
  // whole box. `button.active` (0,1,1) beats `.module-slot`'s own
  // `background: none` (0,1,0), so the square the rack deliberately took off
  // came back on the one state where the circle is the instrument.
  //
  // The cancellation has to name the button, or it loses the same way.
  const at = CSS_SOURCE.indexOf("  button.module-slot.active {");
  assert.ok(at > 0, "the active tile no longer cancels the global button chrome");
  const rule = CSS_SOURCE.slice(at, CSS_SOURCE.indexOf("\n  }", at));
  assert.match(rule, /background: none;/, "an active slot paints its box again");
  assert.match(rule, /border: none;/, "an active slot got its border back");
  // `button.active` sets colour and weight too, and the fallback abbreviation
  // renders in them — cancelling only the fill leaves the ink wrong.
  assert.match(rule, /color: var\(--color-muted\);/);
  assert.match(rule, /font-weight: 700;/);
  // And it must still come AFTER the global rule, or specificity is moot.
  assert.ok(
    at > CSS_SOURCE.indexOf("  button.active {"),
    "the cancellation is above the rule it cancels",
  );
});

test("⚠ THE CYCLE SWEEP CANNOT OUTLIVE THE CYCLE — it follows the snapshot", () => {
  // FOUND LIVE: a module that had finished stayed marked as running.
  //
  // The sweep is drawn from `targeting.moduleCycles`, and that record only ends
  // on an `OnGodmaShipEffect` frame with isStart=0. Miss one — a feed reconnect,
  // a cycle the server ends without saying — and `startedAtMs` stays set; a
  // non-repeating cycle then CLAMPS at 100% (moduleRack.test.ts pins that, and
  // it is right: the question "where in the cycle" has no other answer). So the
  // tile kept a full accent disc over its icon on an idle module.
  //
  // The fix is not to make the arithmetic lie — it is to ask the same authority
  // the glow asks. `active` is the snapshot's own activeModuleIDs.
  assert.match(
    RACK_SOURCE,
    /\{#if slot\.module\.active && cycleOf\(slot\.module\.itemID\) !== null\}/,
    "the sweep is drawn from the cycle record alone again",
  );
});

test("⚠ the 10Hz redraw is for modules that are RUNNING, not ones we have a duration for", () => {
  // `moduleCycles` also holds BASE durations (attribute 73), learnt from the fit
  // and never removed. Keyed off that, the rack re-rendered ten times a second
  // for the rest of the session — docked, drifting, everything off — which is
  // exactly the idle cost its own comment warns about.
  assert.match(RACK_SOURCE, /const anyCycling = \$derived\(/);
  assert.match(RACK_SOURCE, /slot\.module\?\.active === true/, "the tick lost the snapshot");
  assert.doesNotMatch(
    RACK_SOURCE,
    /const anyCycling = \$derived\(Object\.keys/,
    "the tick is keyed off the cycle record again",
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

test("⚠ THE HEAT READING IS PART OF THE ROW HEADER, on one line with the name", () => {
  // It used to be stacked under the rack's name, which made every rack row two
  // lines tall beside a 42px slot and left "heat not known" reading as a second
  // label hanging under HIGH. Inline it is one statement about one rack.
  assert.match(CSS_SOURCE, /\.rack-row-label \{[\s\S]{0,700}flex-direction: row;/);
  // ⚠ AND THE NAME IS A FIXED WIDTH. At `auto` each name sized to its own word
  // — HIGH 22px, LOW 20, MID 17 — and the bar took up the slack, so the three
  // heat bars started at three different x and could not be read down against
  // each other. Measured live after the fix: all three start at the same x and
  // are the same width.
  assert.match(CSS_SOURCE, /\.rack-name \{[\s\S]{0,500}flex: 0 0 22px;/);
  // The label cell still comes second (after the gutter) and is still fixed —
  // the claim above. The columns moved from `.rack-row` to the shared grid on
  // `.module-rack-rows`; see the `display: contents` test in mobileStack.
  const at = CSS_SOURCE.indexOf("  .module-rack-rows {");
  assert.match(
    CSS_SOURCE.slice(at, CSS_SOURCE.indexOf("\n  }", at)),
    /grid-template-columns: auto \d+px minmax\(0, 1fr\)/,
  );
});

test("⚠ THE GUTTER ICON IS ON THE RACK'S CENTRE LINE — FOUND BY EYE", () => {
  // At 26px square, top-aligned against a 42px row, the glyph rode 8px above
  // the line the rack's name, its heat bar and every module tile share. That is
  // the one line this instrument has, and the only thing that was off it was
  // the control that had just been added to it.
  //
  // ⚠ THE SLOT BOX IS WRITTEN DOWN ONCE, and that is the actual fix. The tile
  // and the gutter both read `--rack-slot`, so a rack row and the icon beside
  // it cannot disagree about how tall a row is. Two literals is how they came
  // to disagree in the first place.
  assert.match(CSS_SOURCE, /\.module-rack-rows \{[\s\S]{0,400}--rack-slot: 42px;/);
  assert.match(CSS_SOURCE, /width: var\(--rack-slot, 42px\);/);
  assert.match(CSS_SOURCE, /\.rack-bank \{[\s\S]{0,900}height: var\(--rack-slot, 42px\);/);
  // The extra height is hit area, not ink — the glyph itself stays 16px.
  assert.match(CSS_SOURCE, /\.rack-bank svg \{[\s\S]{0,120}width: 16px;/);
});

test("⚠ WEAPON BANKING IS AN ICON IN THE RACK'S GUTTER, and still says what it is", () => {
  // It was a strip under the racks: a sentence of state and a button spelling
  // out the action, two lines from the guns it acts on. It is an icon beside
  // the HIGH rack now — the only rack whose modules banking can affect.
  //
  // ⚠ THE WORDS DID NOT GO WITH THE LABEL. `title` and the accessible name both
  // carry the action AND what is true right now, and `aria-pressed` says the
  // state again in a way a screen reader reads as state. The two glyphs differ
  // in SHAPE — a joined chain against a broken one — so nothing rests on colour.
  assert.match(RACK_SOURCE, /class="rack-bank"/);
  assert.match(RACK_SOURCE, /aria-pressed=\{linked\}/);
  assert.match(RACK_SOURCE, /"Link weapons — weapons fire one at a time"/);
  assert.match(RACK_SOURCE, /`Unlink weapons — \$\{bankedCount\} weapon/);
  assert.match(RACK_SOURCE, /aria-label=\{linked$/m);
  // Drawn, not an emoji — the reason the overload dot is drawn.
  assert.match(RACK_SOURCE, /<svg viewBox="0 0 24 24" aria-hidden="true">/);
  assert.equal(/rack-banks/.test(RACK_SOURCE), false, "the old strip came back");
  assert.equal(/rack-banks/.test(CSS_SOURCE), false, "the old strip's styling came back");
  // It sits in a GUTTER CELL of the high row, so the row's own centring puts it
  // on the same line as the name, the bar and the tiles — whatever height the
  // row takes when its slots wrap. It was a column beside the whole stack, and
  // on a phone, where the high rack wraps, that left it 23px high.
  assert.match(RACK_SOURCE, /<span class="rack-gutter">/);
  assert.match(RACK_SOURCE, /\{#if row\.family === "high" && weaponsCount > 1 && flow\}/);
  assert.equal(/rack-stack/.test(CSS_SOURCE), false, "the old gutter column came back");
  assert.match(CSS_SOURCE, /\.module-rack-rows \{[\s\S]{0,1200}align-items: center;/);
  assert.match(CSS_SOURCE, /\.rack-bank \{[\s\S]{0,400}width: 26px;/);
  // Under a coarse pointer only the WIDTH grows — the height is already a
  // slot, and a slot clears R8's minimum on its own.
  assert.match(CSS_SOURCE, /@media \(pointer: coarse\) \{[\s\S]{0,200}\.rack-bank \{ width: var\(--rack-slot, 42px\);/);
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
  // The columns live on `.module-rack-rows` now, shared by all three rows —
  // see the `display: contents` test in mobileStack.test.ts.
  const at = CSS_SOURCE.indexOf("  .module-rack-rows {");
  const rule = CSS_SOURCE.slice(at, CSS_SOURCE.indexOf("\n  }", at));
  assert.ok(rule.length > 0, "the shared grid is not where this test looks");
  assert.match(rule, /display: grid/);
  assert.match(rule, /grid-template-columns: auto \d+px minmax\(0, 1fr\)/);
  assert.equal(/margin-left: auto/.test(CSS_SOURCE.slice(
    CSS_SOURCE.indexOf("  .rack-row-label {"),
    CSS_SOURCE.indexOf("  .rack-slots {"),
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

// --- the winding-down note, and where it went --------------------------------
//
// ⚠ REVERSED, BY THE OPERATOR, WITH THE SCREENSHOT TO PROVE IT. Three tests
// used to live here pinning a `windingDownID` state, a `windingDown` derived
// and a `.rack-note` paragraph under the rack — including one earned the hard
// way, that the note must clear itself when it stops being true.
//
// That fix was right about WHEN and wrong about WHERE. The rack sits in the
// HUD, which is on screen for the entire session, so a sentence about the next
// few seconds rendered as a paragraph bolted to the bottom of it reads as a
// standing condition no matter how correctly it is derived. It was reported a
// second time, still on screen, still looking permanent.
//
// So it is a notice now: raised once at the click, retired by the flash's own
// clock, and kept in the log for anyone who looks away. All three of those
// tests describe machinery that no longer exists, which is why they are gone
// rather than adjusted — but the claim they were protecting has to survive the
// move, so it is restated below against the new home.

test("⚠ THE WINDING-DOWN NOTE IS A NOTICE, NOT A LINE UNDER THE RACK", () => {
  assert.match(RACK_SOURCE, /import \{ notify \} from "\.\/notices\.ts";/);
  assert.match(RACK_SOURCE, /detail: "Stops when its current cycle ends\.",/);
  assert.match(RACK_SOURCE, /kind: "info",/, "the module did as it was told; that is not a warning");
  // And nothing of the paragraph is left to come back.
  assert.equal(/rack-note/.test(RACK_SOURCE), false, "the paragraph survived");
  assert.equal(/windingDown/.test(RACK_SOURCE), false, "the state survived");
  const css = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
  assert.equal(/\.rack-note/.test(css), false, "the style survived the markup");
});

test("it is still raised only for a module that is actually still running", () => {
  // The whole reason to say anything: the tile stays LIT after the click. A
  // module that stopped immediately needs no explanation, and an unknown
  // `activeModuleIDs` is not a reason to assert one either — `?? []` stays
  // silent rather than claiming a cycle that may not be running.
  assert.match(
    RACK_SOURCE,
    /action === "deactivate" &&\s+\(\$space\.snapshot\?\.ship\?\.activeModuleIDs \?\? \[\]\)\.includes\(module\.itemID\)/,
  );
});

test("the notice is keyed per module, so two modules are two notices", () => {
  // Keyed on the title alone, switching off a second module inside the 30s
  // dedupe window would say nothing at all — and the player would be back to a
  // lit tile with no explanation, which is the bug this note exists for.
  assert.match(RACK_SOURCE, /key: `module-winding-down:\$\{module\.itemID\}`,/);
});
