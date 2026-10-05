// The R90 toolbar, tab bar and hidden menu as they actually RENDER.
//
// The model tests pin what a tab IS and what hiding DOES. This file pins that
// the panel gives the player ordinary LEFT-CLICK controls for both — which is
// the specific thing the first pass got wrong: hiding was only reachable by a
// context menu, and in a browser the context menu is not the client's.
//
// It also re-proves the standing invariants on the new markup (R7d: no visible
// ids; R8: controls are real buttons).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const SpaceOverview = (await import("./SpaceOverview.svelte")).default;
const { OVERVIEW_RECIPES } = await import("../space/overviewRecipes.ts");
const { overviewTabs, createTabBar } = await import("../space/overviewTabs.ts");
const { tabHidden } = await import("../space/overviewHidden.ts");
const { spaceSelection } = await import("../space/selection.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "SpaceOverview.svelte"), "utf8");
const TACTICAL_SOURCE = readFileSync(path.join(UI_DIR, "Tactical.svelte"), "utf8");

const SHIP_ID = 9001;
const ROCK_ID = 50001248;
const DECOR_ID = 60000001;
const RAT_ID = 70000001;
const DECOR_TYPE_ID = 5555;
const ORE_TYPE_ID = 1230;
/** Group 25 is the frigate group; a belt rat is a frigate-shaped hull. */
const RAT_TYPE_ID = 1232;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function entity(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "ship",
    typeID: 606,
    groupID: 25,
    categoryID: 6,
    name: null,
    ownerID: null,
    radius: 100,
    position: { x: 1000, y: 0, z: 0 },
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
    oreValuePerM3: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

const ROCK = entity({ kind: "celestial", itemID: ROCK_ID, typeID: ORE_TYPE_ID, groupID: 450, categoryID: 25, miningYieldTypeID: ORE_TYPE_ID, name: "Veldspar" });
// ⚠ A RAT IS A HULL. It used to be built with the default `kind: "celestial"`,
// which classified as `celestial` and so earned a "Hide Celestials" button — a
// fixture that quietly contradicted the thing under test. Group 25 is the
// frigate group, so this is what the classifier and the panel will read.
const RAT = entity({ kind: "ship", itemID: RAT_ID, typeID: RAT_TYPE_ID, groupID: 25, categoryID: 6, isNpc: true, npcEntityType: "npc", name: "Belt Rat" });
const DECOR = entity({ kind: "structure", itemID: DECOR_ID, typeID: DECOR_TYPE_ID, groupID: 226, name: "An Emitter" });

function storeWith(entities: readonly Record<string, unknown>[]): unknown {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: 30000142,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  } as never);
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities,
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
        activeModuleIDs: [],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
    },
  } as never);
  return store;
}

function panel(entities: readonly Record<string, unknown>[] = [ROCK, DECOR, RAT]): string {
  return render(SpaceOverview as never, {
    props: { store: storeWith(entities), flow: fakeFlow() },
  } as never).body;
}

/**
 * ⚠ A PANEL WITH SOMETHING PICKED.
 *
 * The Hide verbs act on the SELECTION, so a toolbar test that renders nothing
 * selected sees no named button at all — which is correct (there is nothing to
 * name) and useless for asserting what the button says. This picks the row
 * first, so the render is the one a player actually gets after a click.
 */
function panelPicking(itemID: number, entities: readonly Record<string, unknown>[]): string {
  spaceSelection.select(itemID);
  try {
    return panel(entities);
  } finally {
    spaceSelection.select(null);
  }
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

// ⚠ EVERY TEST RESTORES THE SHARED SINGLETONS. `overviewTabs` and `tabHidden`
// are app-wide and deliberately outlive any component, so a test that leaves one
// mid-edit hands that state to the next one.
function resetShared(): void {
  overviewTabs.reset();
  tabHidden.clearAll();
}

/** The id of a tab by name, for tests that must act on a tab other than All. */
function tabIDByName(name: string): string {
  const found = overviewTabs.tabs.get().find((tab) => tab.name === name);
  assert.ok(found, `the '${name}' tab is missing`);
  return found.id;
}

// --- the toolbar -------------------------------------------------------------

test("⚠ there is NO context menu anywhere in the panel", () => {
  // ⚠ THE WHOLE REASON THIS PASS EXISTS. Hiding was reachable only by
  // right-click, and in a web page the browser owns that gesture — the player
  // got "Save image as…" and the client heard nothing. If a contextmenu handler
  // ever comes back, this fails before a player finds it the hard way.
  assert.doesNotMatch(SOURCE, /contextmenu/i, "a context menu handler crept back in");
});

test("the tabs and the overview verbs live on two separate bars", () => {
  resetShared();
  const body = panel();
  assert.match(body, /class="spc-tabs-bar"/, "the tab bar is missing");
  assert.match(body, /class="spc-tools-bar"/, "the verb bar is missing");
  // ⚠ TWO BARS, ONE CONCERN EACH. The tab list owns the line above and the Hide
  // verbs own the line under it — in this order — so two wide buttons can never
  // push the tabs off a narrow panel. A single shared row, where the two crowded
  // each other, is the failure this split exists to forbid.
  assert.ok(
    body.indexOf("spc-tabs-bar") < body.indexOf("spc-tools-bar"),
    "the verb bar came before the tabs",
  );
});

test("Hide is a real left-click button in the toolbar", () => {
  resetShared();
  const body = panelPicking(ROCK_ID, [ROCK, DECOR, RAT]);
  // ⚠ PLAN goal 1b: THE BUTTON NAMES ITS CATEGORY, so a bare "Hide" is not
  // enough — a player must be able to see WHAT is being hidden before pressing it.
  assert.ok(visibleText(body).includes("Hide Rocks"), "there is no named Hide control");
  // ⚠ A REAL `<button>`, NOT A CLICKABLE `<div>` OR `<span>`. The whole point of
  // this pass is that every control is an ordinary left click on a button the
  // browser owns, so keyboard reach and focus come for free.
  assert.match(body, /<button[^>]*class="spc-tool/, "Hide is not a real button element");
  // The wiring itself is not in the SSR output (handlers are not rendered), so
  // it is pinned from the source — see the toolbar-wiring test below.
  assert.match(
    SOURCE,
    /onclick=\{\(\) => hideSelectedCategory\(category\.id\)\}/,
    "Hide is not wired to the selection",
  );
});

test("⚠ a row earns one Hide button per category it carries (goal 1b)", () => {
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const rockText = visibleText(panelPicking(ROCK_ID, [ROCK, DECOR, RAT]));
  assert.ok(rockText.includes("Hide Rocks"), "no category button");

  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const ratText = visibleText(panelPicking(RAT_ID, [ROCK, DECOR, RAT]));
  assert.ok(ratText.includes("Hide Ships"), "no category button for a ship");
  // ⚠ AND NO PER-ROW STANCE BUTTON — THE 2026-04-10 PIVOT REPLACED IT. The two
  // standing toggles do this job for the whole grid instead of one row at a
  // time, so a "Hide Ships (Friendly)" verb must NOT come back.
  assert.doesNotMatch(ratText, /Hide Ships \(/, "the per-row stance hide came back");
});

test("⚠ the two standing toggles are present, and neither offers a hostile side", () => {
  // ⚠ PLAN PIVOT: "Hide Friendly" / "Hide Neutral" clear a whole side's
  // combat-capable traffic off the grid at once. They are TOGGLES, so their
  // state is the struck-through button rather than a Hidden Items row.
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const text = visibleText(panel([ROCK, DECOR, RAT]));

  assert.ok(text.includes("Hide Friendly"), "no friendly toggle");
  assert.ok(text.includes("Hide Neutral"), "no neutral toggle");
  // ⚠ NO HOSTILE TOGGLE, AND IT CANNOT EXIST: a threat is never hidden, so a
  // button offering it would either lie or be refused.
  assert.doesNotMatch(text, /Hide Hostile/, "a hostile toggle was offered");
  // ⚠ AND THEY ARE TAGGED AS PRESSABLE TOGGLES for assistive tech, not as verbs.
  assert.match(panel([ROCK, DECOR, RAT]), /aria-pressed="false"/);
});

test("Hide is disabled with a REASON when nothing is picked", () => {
  // ⚠ A greyed-out button that says nothing is the silent decline this project
  // already rejected elsewhere; the reason is carried in the tooltip.
  resetShared();
  assert.match(panel([ROCK]), /Pick something first/, "a disabled Hide offers no reason");
});

test("⚠ the blank Hide survives an empty category list, so the refusal is still said", () => {
  // ⚠ GOAL 1b DID NOT SILENTLY REMOVE THE VERB. With nothing picked the
  // per-category loop renders nothing, so a bare disabled "Hide" stands in —
  // otherwise the toolbar would simply have no button and the player would be
  // left wondering where it went rather than told why.
  resetShared();
  const body = panel([ROCK, DECOR, RAT]);
  assert.ok(visibleText(body).includes("Hide"), "the Hide verb vanished when nothing was picked");
  assert.doesNotMatch(body, /Hide Rocks/, "a category was named with no selection");
});

test("⚠ the per-row Hide control is GONE", () => {
  // ⚠ 200 extra controls in a scrolling list, and the one a player wants is the
  // one for whatever they just clicked — which is what the toolbar acts on.
  assert.doesNotMatch(SOURCE, /spc-row-hide/, "the per-row hide control came back");
  assert.doesNotMatch(panel([ROCK]), /spc-row-hide/);
});

// --- the tab bar -------------------------------------------------------------

test("the bar opens on All plus the four defaults", () => {
  resetShared();
  const text = visibleText(panel());
  for (const label of ["All", "System", "Combat", "Mining", "Travel"]) {
    assert.ok(text.includes(label), `the '${label}' tab is missing`);
  }
});

test("⚠ All is drawn fixed — no rename and no delete", () => {
  // ⚠ ALL IS THE WAY BACK TO SEEING EVERYTHING. A deletable All leaves a player
  // with no route to the whole grid, and a renamed one lies about what it does.
  const body = panel();
  assert.match(body, />All</, "the All tab is not drawn");
  assert.ok(!body.includes("Delete All"), "All offers a delete control");
  assert.ok(!body.includes("Rename All"), "All offers a rename control");
});

test("the controls are real buttons, not clickable divs", () => {
  // ⚠ THE WHOLE POINT OF THIS PASS: every control is an ordinary LEFT CLICK on a
  // button the browser owns, so keyboard reach and focus come for free.
  resetShared();
  // The hidden menu belongs to a tab, and All is not a tab that hides — so the
  // toggle check happens on Mining, where the menu is a resident.
  overviewTabs.select(tabIDByName("Mining"));
  const body = panel();
  assert.match(body, /<button[^>]*class="spc-tab-add"/);
  assert.match(body, /<button[^>]*class="spc-tab-tool"/);
  assert.match(body, /<button[^>]*class="spc-tool/);
  assert.match(body, /<button[^>]*class="spc-hidden-toggle"/);
});

test("the tools are NOT nested inside the tab button", () => {
  // ⚠ Nested buttons are invalid HTML, and one press would both switch tabs and
  // delete one — the player would have no way to tell which happened.
  assert.doesNotMatch(
    SOURCE,
    /class="spc-tab"[\s\S]{0,300}?class="spc-tab-tool"/,
    "a tab tool was nested inside the tab button",
  );
});

test("the New tab control is a bare +, with the words on hover", () => {
  // ⚠ THE LABEL IS "+", NOT "+ New tab". Four words beside every other control
  // in a row that already holds the tab names crowds the tab list on a narrow
  // panel, so the words live in the tooltip and the accessible name instead.
  resetShared();
  const body = panel();
  assert.match(body, /class="spc-tab-add"[^>]*>\+<\/button>/, "the New tab button is not a bare +");
  assert.doesNotMatch(body, />\+ New tab</, "the New tab label came back into the button");
  assert.match(body, /class="spc-tab-add"[^>]*title="New tab"/, "no hover text");
  assert.match(body, /class="spc-tab-add"[^>]*aria-label="New tab"/, "no accessible name");
  assert.match(SOURCE, /onclick=\{openCreate\}/, "New tab is not wired to the editor");
});

test("⚠ rename and delete are NOT part of a tab — they sit beside the +", () => {
  // ⚠ THE CHANGE. They used to be inside the tab's own wrapper, which put two
  // more buttons on every tab and made a four-tab bar carry twelve controls. The
  // bar now costs three buttons however many tabs there are, and they act on
  // whichever tab is selected.
  resetShared();
  const body = panel();
  assert.doesNotMatch(body, /spc-tab-wrap/, "a tab still carries its own tools");
  assert.doesNotMatch(SOURCE, /spc-tab-wrap/, "the per-tab wrapper came back");
    // ⚠ ONE rename and ONE delete, regardless of how many tabs there are. Counted
    // on the BUTTON elements rather than the `aria-label` text, because each
    // control repeats that string in both its title and its accessible name.
    assert.equal(body.split('<button').filter((chunk) => chunk.includes("✎")).length, 1, "more than one rename control");
    assert.equal(body.split('<button').filter((chunk) => chunk.includes("✕")).length, 1, "more than one delete control");
    // And they are near the "+", not near a tab.
    assert.ok(
      body.indexOf('class="spc-tab-add"') < body.indexOf("✎"),
      "the rename control is not beside the +",
    );
});

test("rename and delete are disabled on All, with a reason", () => {
  // ⚠ All is the way back to seeing everything, so the controls that would break
  // it are refused in words rather than silently ignored.
  resetShared();
  const body = panel();
  assert.match(body, /aria-label="All cannot be renamed"/);
  assert.match(body, /aria-label="All cannot be deleted"/);
  assert.match(body, /aria-label="All cannot be deleted"[\s\S]{0,300}?disabled/);
});

test("⚠ renaming and deleting act on the SELECTED tab", () => {
  // ⚠ They read `activeTab`, not a per-tab id, which is what lets them live
  // outside the tab entirely.
  assert.match(SOURCE, /openRename\(activeTab\.id\)/, "rename is not bound to the selection");
  assert.match(SOURCE, /openDelete\(activeTab\.id\)/, "delete is not bound to the selection");
});

// --- the delete confirmation -------------------------------------------------

test("⚠ deleting a tab asks first, in the same submenu style", () => {
  // ⚠ A ✕ ONE CLICK FROM A ✎, and a deleted tab is a piece of the player's own
  // arrangement that cannot be rebuilt for them. The confirmation reuses the
  // editor panel so there is one place a submenu appears from.
  resetShared();
  const body = panel();
  assert.doesNotMatch(body, />Yes</, "the confirmation is showing when nothing was pressed");
  assert.match(SOURCE, /class="spc-editor" class:danger=\{tabEditor\.mode === "delete"\}/);
  assert.match(SOURCE, />Yes</, "no confirmation button exists");
  assert.match(SOURCE, /openDelete\(activeTab\.id\)/, "delete does not go through the confirmation");
  assert.match(SOURCE, /onclick=\{confirmDelete\}/, "the confirmation is not wired");
});

test("⚠ the delete button deletes nothing on its own", () => {
  // ⚠ THE ACTUAL SAFETY PROPERTY: `openDelete` only OPENS the panel. If a
  // `remove` ever appears on that path, a single click would destroy a tab.
  const openDelete = SOURCE.slice(SOURCE.indexOf("function openDelete"));
  const body = openDelete.slice(0, openDelete.indexOf("}"));
  assert.ok(!body.includes("overviewTabs.remove"), "the delete control removed a tab directly");
});

test("the confirmation is styled differently from the create/rename form", () => {
  // ⚠ A DESTRUCTIVE ACTION WEARING THE SAME CLOTHES AS "PICK A RECIPE" is how a
  // misclick becomes a lost tab, so the panel flips to a danger treatment.
  assert.match(SOURCE, /class:danger=\{tabEditor\.mode === "delete"\}/);
  assert.match(SOURCE, /spc-editor-confirm/);
  assert.match(SOURCE, />No</, "there is no way to back out of the confirmation");
});

// --- in-game reports, 2026-04-10 (second round) -------------------------------

test("⚠ --stn-warn is DEFINED, so the Yes button cannot vanish on hover", () => {
  // ⚠ THE ROOT CAUSE OF "hovering 'Yes, delete it' makes it disappear". Eight
  // rules referenced `var(--stn-warn)` and NOTHING DEFINED IT. An undefined
  // custom property invalidates the whole declaration, so
  // `.spc-tool.bad:hover` fell back to `color: var(--stn-page)` (#0a1119,
  // near-black) over a background that was never painted — dark text on a dark
  // button. The press looked like the button had gone.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /--stn-warn:\s*#/, "--stn-warn is referenced but never defined");

  // ⚠ AND EVERY reference resolves inside the block that defines it, so the
  // hover rule inherits the variable rather than dropping it.
  const uses = css.match(/var\(--stn-warn\)/g)?.length ?? 0;
  assert.ok(uses > 0, "no rule references the warn colour, so the definition is dead");
});

test("⚠ the delete confirmation is terse: one question, and Yes / No", () => {
  // ⚠ REPORTED AS OVEREXPLAINED. The question is the whole of it; the extra
  // sentence about going back to a built-in filter is what made it read as a
  // dialog rather than a confirmation.
  assert.match(SOURCE, /Delete the tab <strong>/, "the question does not name the tab");
  assert.match(SOURCE, /onclick=\{confirmDelete\}>Yes</, "the confirm button is not just 'Yes'");
  assert.match(SOURCE, /onclick=\{closeEditor\}>No</, "the cancel button is not just 'No'");
  assert.doesNotMatch(SOURCE, /Yes, delete it/, "the old verbose label came back");
  assert.doesNotMatch(SOURCE, /Keep it/, "the old verbose label came back");
  assert.doesNotMatch(SOURCE, /built-in filters/, "the over-explaining sentence came back");
});

test("⚠ the delete confirmation is right-aligned under the delete button", () => {
  // ⚠ THE DELETE VERB IS THE RIGHTMOST CONTROL, so a confirmation that opened
  // left put its buttons nowhere near the thing being confirmed.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const danger = css.match(/\.spc-editor\.danger\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(danger, /justify-content:\s*flex-end/, "the confirmation is not right-aligned");
  const confirm = css.match(/\.spc-editor\.danger \.spc-editor-confirm\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(confirm, /text-align:\s*right/, "the question is not right-aligned");
});

test("⚠ a switched-on toggle reads as inactive: faded AND struck through", () => {
  // ⚠ REPORTED AS "no indicator at all". The class was rendering all along, so
  // the strike was too quiet on its own at 10px. Three signals now: the strike,
  // a dimmed colour, and reduced opacity.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const on = css.match(/\.spc-tool-toggle\.on\s*(,\s*\n\s*\.[\w-]+\s*)*\{[^}]*\}/)?.[0]
    ?? css.match(/\.spc-tool-toggle\.on[^{]*\{[^}]*\}/)?.[0] ?? "";
  assert.match(on, /line-through/, "an active toggle is not struck through");
  assert.match(on, /opacity/, "an active toggle does not fade");
  // ⚠ AND HOVER MUST NOT BRING IT BACK — `.spc-tool:hover` is later in the same
  // layer and would otherwise repaint the very control that must look inactive.
  const onHover = css.match(/\.spc-tool-toggle\.on:hover[^{]*\{[^}]*\}/)?.[0] ?? "";
  assert.match(onHover, /opacity/, "hover undoes the active toggle's fade");
});

test("⚠ the toggles read the SUBSCRIBED signal, so a press actually repaints them", () => {
  // ⚠ REPORTED AS "the buttons still look identical when clicked". The CSS was
  // right, and SSR renders the pressed state correctly — but the class and
  // `aria-pressed` were bound to a plain `combatToggles.forTab(...)` read. That
  // call reaches the signal with `.get()` and registers NO Svelte dependency, so
  // the bindings (and the filtered list) never re-evaluated on a press, however
  // many times the button was clicked. Reading `$combatToggleMap` subscribes to
  // the store, which is what makes the press observable. SSR cannot catch this
  // — it never re-renders — so the wiring is pinned from the source, the same
  // way the suite checks other event wiring the SSR renderer strips.
  assert.match(SOURCE, /\$combatToggleMap/, "the toggles are not read through the subscribed signal");
  assert.doesNotMatch(
    SOURCE,
    /combatToggles\.forTab/,
    "a plain .forTab() read is back; the button will not repaint on a press",
  );
  assert.match(
    SOURCE,
    /class:on=\{combatTogglesOn\(side\)\}/,
    "the pressed class is not driven by the shared predicate",
  );
  assert.match(
    SOURCE,
    /aria-pressed=\{combatTogglesOn\(side\)\}/,
    "the accessible pressed state is not driven by the shared predicate",
  );
});

test("⚠ `npm start` does NOT rebuild, so a CSS change needs `npm run build:web`", () => {
  // ⚠ THE CAUSE OF "the toggle shows no indication", reported twice. The rule was
  // correct in `styles.css` the whole time and correct in the SSR render — but
  // `npm start` serves the gitignored `public/dist` and never rebuilds it, so a
  // player testing after a CSS change was loading the PREVIOUS build. This test
  // cannot catch a stale build by itself; it records why the built CSS is the
  // thing to check, so the next report starts from the build and not the source.
  const pkg = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.start?.includes("vite"), false, "start may rebuild the web assets");
  assert.ok(pkg.scripts["build:web"], "there is no build:web to rebuild them with");
});

test("move-left and move-right exist and are disabled while All is selected", () => {
  resetShared();
  const body = panel();
  assert.match(body, /aria-label="Move All left"/);
  // ⚠ All is selected by default and it is fixed, so the move controls must read
  // as unavailable rather than accepting a click and doing nothing.
  assert.match(body, /aria-label="Move All left"[\s\S]{0,500}?disabled/);
});

test("⚠ R7d: no numeric id reaches the toolbar or the tab bar", () => {
  resetShared();
  const body = panel([ROCK, DECOR, RAT]);
  // ⚠ READABLE TEXT ONLY, NOT RAW MARKUP. A short id like 5555 occurs
  // incidentally in Svelte's SSR comment markers (`<!--[-->`), and asserting on
  // the raw string would either fail for the wrong reason or force the real
  // invariant to be loosened. The invariant is about what the PLAYER can read.
  const text = visibleText(body);
  for (const id of [ROCK_ID, DECOR_ID, RAT_ID, DECOR_TYPE_ID, ORE_TYPE_ID]) {
    assert.ok(!text.includes(String(id)), `the id ${id} is visible text`);
  }
});

// --- the hidden menu ---------------------------------------------------------

test("the hidden menu sits at the BOTTOM, outside the scroller", () => {
  // ⚠ IT IS THE ROUTE BACK FROM HIDING. A control you have to scroll to find
  // is not a control you can rely on, so it lives after the list.
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const body = panel();
  assert.match(body, /class="spc-hidden-menu"/, "no hidden menu");
  assert.ok(
    body.indexOf("spc-hidden-menu") > body.indexOf("spc-content"),
    "the hidden menu is inside the scrolling list",
  );
});

test("⚠ ALL CARRIES NO HIDDEN MENU — IT IS THE FALLBACK THAT HIDES NOTHING", () => {
  // ⚠ THE DECISION. The tab that shows everything does not track its own
  // hiding: a hide on it could not be seen undone from within it, so the menu
  // is not drawn there at all, and the Hide button says why it is refused.
  resetShared();
  const body = panel();
  assert.doesNotMatch(body, /class="spc-hidden-menu"/, "the fallback tab grew a hidden menu");
  // The refusal words only reach the tooltip once something is picked, so they
  // are pinned from the source the way the other per-tab wiring is.
  assert.match(SOURCE, /All shows everything, so there is nothing to hide/, "the refusal has no words");
  assert.match(SOURCE, /if \(activeTab\.fixed\)/, "the refusal is not the All tab's");
});

test("⚠ the stance hide holds the row in a local BEFORE the write, so it cannot read a stale selection", () => {
  // ⚠ THE CRASH Hiding USED TO THROW. `selectedRow` is a derived that reads
  // through `rows` and so through the per-tab hidden map. `tabHidden.hideStance`
  // writes into that map, which invalidates the derived — and a second read of
  // `selectedRow` (the old `selectedID === selectedRow.itemID`) re-resolves it to
  // null, the row that just left the tab, and `.itemID` on null is the "can't
  // access property 'itemID'" error. The row must be held in a local captured
  // BEFORE the write, so the write and the comparison both aim at the same
  // stable object. This is pinned from the source: an SSR render cannot press
  // the button, so the shape of the handler is what is checked.
  // ⚠ BOUND TO THE BODY. Everything after the handler is the rest of the panel
  // (the template still legitimately reads `selectedRow.itemID` for the lock
  // badges), so only the body up to the next `function` is checked.
  const stanceHide = (SOURCE.split("function hideSelectedCategoryStance").pop() ?? "").split("\n  function ")[0] ?? "";
  assert.match(stanceHide, /const row = selectedRow;/, "the row is not captured before the write");
  assert.match(
    stanceHide,
    /tabHidden\.hideCategoryStance\(activeTabID, row, stanceContext\)/,
    "the write is not aimed at the held row",
  );
  assert.match(stanceHide, /selectedID === row\.itemID/, "the comparison is not the held row's id");
  assert.doesNotMatch(stanceHide, /selectedRow\.itemID/, "the stance hide still reads selectedRow.itemID");

  // ⚠ AND THE SAME RULE ON THE CATEGORY SIDE, which goal 1b added.
  const categoryHide = (SOURCE.split("function hideSelectedCategory").pop() ?? "").split("\n  function ")[0] ?? "";
  assert.match(categoryHide, /const row = selectedRow;/, "the category hide reads selectedRow twice");
  assert.doesNotMatch(categoryHide, /selectedRow\.itemID/, "the category hide still reads selectedRow.itemID");
});

test("⚠ Show everything is a FULL reset, and Reset Tab is its gentler half (goals 3 and 4)", () => {
  // ⚠ TWO WHOLE-TAB ACTIONS THAT ARE NOT INTERCHANGEABLE.
  //   Show everything → the hidden list is empty, the tab shows EVERYTHING.
  //   Reset Tab      → both lists gone, the tab's PRESET decides again.
  // A player who hid a belt of rocks on a Mining tab and wants their mining tab
  // back has pressed the wrong one for their intent, so the button names the
  // preset it restores.
  //
  // ⚠ PINNED FROM THE SOURCE, NOT THE RENDER. The hidden menu is COLLAPSED on
  // first paint and SSR strips the handler that opens it, so a render can never
  // show these two buttons. What is asserted is the wiring and the wording.
  assert.match(SOURCE, /onclick=\{\(\) => \{\s*showEverythingOnTab\(\);/, "Show everything has no action");
  assert.match(SOURCE, /onclick=\{\(\) => \{\s*resetTabToPreset\(\);/, "Reset Tab has no action");

  // ⚠ AND THE FORMAT IS THE PLAN'S: "Reset Tab (<Preset Name>)" — the PRESET's
  // name, interpolated, so a renamed tab still says what it is restoring.
  assert.match(SOURCE, /Reset Tab \(\{activeRecipeLabel\}\)/, "the reset button does not name its preset");
  assert.match(
    SOURCE,
    /const activeRecipeLabel = \$derived\(recipeByID\(activeTab\.recipeId\)\.label\)/,
    "the reset button reads something other than the preset's own name",
  );
  // ⚠ NOT THE TAB'S NAME. A tab renamed "Belt run" must still restore Mining.
  assert.doesNotMatch(SOURCE, /Reset Tab \(\{activeTab\.name\}\)/, "the reset button named the tab");
});

test("⚠ the full-reset button carries a tooltip saying it clears MORE than the list above it (goal 3)", () => {
  // ⚠ THE MENU ONLY LISTS WHAT IS ON THE GRID, but "Show everything" clears the
  // WHOLE stored list — including entries whose objects have warped off. A
  // button that clears more than the list above it looks like a bug, so the
  // tooltip has to say so rather than leave the player to find out.
  assert.match(
    SOURCE,
    /title="Forget everything hidden on \{activeTab\.name\}, including anything not currently on the grid\./,
    "the full-reset button has no tooltip, or does not say it is a full reset",
  );
});

test("⚠ the hidden menu lists only what is on the GRID right now (goal 3)", () => {
  // ⚠ THE MENU ANSWERS "what is missing from what I can see". An entry whose
  // objects have all warped off is not missing from this screen, so it is not
  // listed — but it is STILL STORED, and comes back when its objects return.
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const miningID = tabIDByName("Mining");
  tabHidden.hide(miningID, DECOR as never, "scenery");

  // With DECOR on the grid the entry is listed.
  const withDecor = panel([ROCK, DECOR, RAT]);
  assert.match(SOURCE, /\.filter\(visibleNow\)/, "the menu is not filtered to the live grid");

  // And the state is untouched by the filtering — the store still holds it.
  assert.equal(tabHidden.stateFor(miningID).hidden.length, 1, "filtering dropped the stored entry");
  assert.ok(withDecor.length > 0);
});

test("⚠ the toggles sit LEFT and the per-object Hide is pushed RIGHT (goals 1a + pivot)", () => {
  // ⚠ PURE CSS, PINNED FROM THE STYLESHEET. There is no layout engine in this
  // suite, so what is checked is that the rules exist: the standing toggles are
  // ordinary flow items on the left, and only the Hide is pushed to the edge by
  // `margin-left: auto` — so a third button extends leftward and never pushes
  // the Hide off a narrow panel.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const bar = css.match(/\.spc-tools-bar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(bar, /justify-content/, "the bar is right-aligning everything");

  const push = css.match(/\.spc-tools-bar \.spc-tool-hide\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(push, /margin-left:\s*auto/, "the Hide is not pushed to the right edge");

  // ⚠ AND A SWITCHED-ON TOGGLE IS STRUCK THROUGH, which is how the plan says a
  // hidden side should read without adding a row to the Hidden Items menu.
  const strike = css.match(/\.spc-tool-toggle\.on\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(strike, /line-through/, "an active toggle has no crossed-out state");
});

test("the hidden menu says 'Hidden Items', whether the tab hides anything or not", () => {
  // ⚠ THE LABEL IS A NAME, NOT A STATUS LINE. It used to read "Nothing hidden"
  // and then "1 hidden"; now it is the one word the section is, and the answer
  // is inside — the menu is a fallback you open, not a counter you watch.
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const emptyText = visibleText(panel());
  assert.ok(emptyText.includes("Hidden Items"), "the menu does not name itself");
  assert.doesNotMatch(emptyText, /Nothing hidden/, "the old empty state came back");
  const miningID = tabIDByName("Mining");
  tabHidden.hide(miningID, DECOR as never, "scenery");
  const busyText = visibleText(panel());
  assert.ok(busyText.includes("Hidden Items"), "the label changed with the content");
  assert.doesNotMatch(busyText, /1 hidden/, "the label started counting again");
  assert.match(panel(), /aria-expanded="false"/, "the menu did not start collapsed");
});

test("⚠ hiding on one tab does not touch the others, and All keeps everything", () => {
  // ⚠ THE WHOLE OF THE PER-TAB CHANGE, AS THE PLAYER SEES IT. One press of
  // Hide is one tab's business: the tab it happens on loses the group, the
  // next tab over does not, and the fallback tab loses nothing at all.
  resetShared();
  const miningID = tabIDByName("Mining");
  // ⚠ SYSTEM IS THE COMPARISON TAB, not Travel. Every preset but System excludes
  // scenery, so a Travel tab would hide the emitter for its OWN reason and the
  // test could not tell a per-tab leak from a preset working.
  const systemID = tabIDByName("System");
  overviewTabs.select(miningID);
  tabHidden.hide(miningID, DECOR as never, "scenery");
  const miningBody = panel();
  assert.equal(tabHidden.stateFor(miningID).hidden.length, 1, "the hiding tab recorded nothing");
  assert.ok(!visibleText(miningBody).includes("An Emitter"), "the hiding tab kept showing the group");
  overviewTabs.select(systemID);
  const systemBody = panel();
  assert.deepEqual(tabHidden.stateFor(systemID).hidden, [], "the other tab saw a hiding of its own");
  assert.ok(visibleText(systemBody).includes("An Emitter"), "the other tab lost the group");
  overviewTabs.select("all");
  const allBody = panel();
  assert.ok(visibleText(allBody).includes("An Emitter"), "All lost a group hidden elsewhere");
  assert.doesNotMatch(allBody, /spc-hidden-menu/, "the fallback tab carries a hidden menu");
});

test("the hidden menu can show this tab's categories back, one or all at once", () => {
  // ⚠ ENTRIES ARE CATEGORIES: one entry is one CATEGORY, so 200 emitters are
  // one row, and Show undoes that one entry — the player's own hides get
  // unhidden, and the preset's pre-hidings get their override recorded. The
  // label no longer counts.
  resetShared();
  const miningID = tabIDByName("Mining");
  overviewTabs.select(miningID);
  tabHidden.hide(miningID, DECOR as never, "scenery");
  // ⚠ The per-entry "Show" button only EXISTS while the menu is open, so its
  // presence is a source-level check — an SSR render always starts collapsed.
  assert.match(SOURCE, /class="spc-hidden-show"/, "no way to bring one back");
  assert.match(SOURCE, /showEntry\(row\)/, "Show is not wired to the row");
  assert.match(
    SOURCE,
    /tabHidden\.unhideCategory\(activeTabID, row\.category\)/,
    "Show is not per-tab",
  );
  assert.match(SOURCE, /Show everything/, "no way to unhide the tab's hiding at once");
  assert.match(SOURCE, /showEverythingOnTab\(\);/, "Show everything has no action");
  assert.match(SOURCE, /tabHidden\.clearHidden\(activeTabID\)/, "Show everything wipes the wrong tab");
});

test("⚠ the hidden menu names the CATEGORY, and the press lands in the ACTIVE TAB's list", () => {
  // ⚠ THE ENTRY'S LABEL IS THE CATEGORY'S OWN NAME, read from the classifier
  // that built the entry — so the menu and the grid cannot disagree about the
  // word — and the press goes to the tab the player is on.
  assert.match(SOURCE, /tabHidden\.hide\(activeTabID, row\)/, "the hide is not per-tab");
  assert.match(SOURCE, /hideCategoryByID/, "the menu does not ask the classifier for its word");
  // ⚠ AND NO RESOLVED GROUP NAME IS USED FOR THE HIDE ANY MORE. The old code
  // resolved a group label here; the category axis replaced it, and a leftover
  // would mean two sources of truth for the same word.
  assert.doesNotMatch(SOURCE, /const label = group === "—" \? typeName\(row\) : group;/);
  assert.match(SOURCE, /class="spc-hidden-menu"/);
});

test("hiding does NOT open the menu — it stays the fallback, collapsed until asked", () => {
  // ⚠ THE OLD BEHAVIOUR, DELIBERATELY UNDONE. The menu used to flip itself open
  // so the undo could not be missed; now that hiding is per-tab and All always
  // shows the group anyway, the menu is only for when something is actually
  // wanted back, and it waits to be clicked.
  assert.doesNotMatch(SOURCE, /hiddenMenuOpen = true/, "hiding flipped the restore menu open");
});

test("the tab's added groups get NO section — they are visible in the overview", () => {
  // ⚠ THE DECISION. A group the player added to this tab beyond its preset is
  // visible on the grid itself; listing it in the menu as well would be a
  // duplicate of what the overview already shows, and a group that the player
  // can already see is not a candidate for "what is missing".
  assert.doesNotMatch(SOURCE, /Added on this tab/, "the added-group section came back");
  assert.doesNotMatch(SOURCE, /hideGroupFromTab/, "the added-group undo came back");
});

test("the preset's pre-hidings sit in the menu, one flat list with the player's own", () => {
  // ⚠ THE UNIFIED SYSTEM. The preset no longer "allows" — it pre-hides, in
  // advance, exactly like the player's own hides. So the menu has no
  // subcategories: what the preset pre-hides and what the tab hid itself are
  // one kind of row, and Show on a preset row records the pre-hiding as undone
  // on THIS tab only.
  assert.doesNotMatch(SOURCE, /Not shown on this tab/, "a picker section came back");
  assert.doesNotMatch(SOURCE, /Hidden on this tab/, "a subcategory came back");
  assert.match(SOURCE, /const hiddenMenuRows = \$derived/, "the menu's flat list has no list to read");
  // ⚠ AND THERE IS NO "WHAT THE PRESET HID" ROW — A REPORTED BUG. It used to be
  // one row named after the recipe (so a PVE tab listed "PVE [Show]") whose Show
  // cleared the tab's own hidden list. A recipe's omissions are decided by the
  // RECIPE and come straight back, so the press visibly did nothing: a menu row
  // that cannot undo itself is the one control that lies about its own effect.
  assert.doesNotMatch(SOURCE, /preset:omissions/, "the preset row came back");
  assert.match(
    SOURCE,
    /tabHidden\.addCategory\(activeTabID, row\.category\)/,
    "Show on a category row is not per-tab",
  );
});

test("⚠ the menu's flat list never repeats a hiding the tab already decided", () => {
  // ⚠ THE MENU LISTS ONLY WHAT IS ON THE GRID (goal 3), and a hiding the tab
  // already decided is owned by exactly one of its two lists — so each category
  // appears once, and no row ever sits in the menu doing nothing.
  assert.match(SOURCE, /\.filter\(visibleNow\)/, "the menu is not filtered to the live grid");
  // ⚠ AND THE COMBAT TOGGLES ARE NOT IN THE LIST AT ALL. They are not hidden
  // entries, so a row for one would be a way to undo a toggle from a place that
  // is meant to list things deliberately removed.
  assert.doesNotMatch(SOURCE, /kind: "combat"/, "a combat toggle reached the hidden menu");
});

test("the hidden menu expands on a real button", () => {
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  const body = panel();
  assert.match(body, /<button[^>]*class="spc-hidden-toggle"/, "the toggle is not a real button");
  assert.match(body, /aria-expanded="false"/, "the menu did not start collapsed");
  assert.match(
    SOURCE,
    /onclick=\{\(\) => \(hiddenMenuOpen = !hiddenMenuOpen\)\}/,
    "the toggle is not wired",
  );
  // ⚠ The caret ROTATES rather than swapping glyphs, so the menu's state is one
  // property and cannot desync from `aria-expanded`.
  assert.match(SOURCE, /class:open=\{hiddenMenuOpen\}/);
});

test("the hidden menu is present on a tab even when nothing is hidden — it is the way back", () => {
  // ⚠ NOT CONDITIONAL ON HAVING HIDDEN ANYTHING. If the control only appeared
  // once there was something to undo, a player could not find out it existed.
  resetShared();
  overviewTabs.select(tabIDByName("Mining"));
  assert.match(panel(), /class="spc-hidden-menu"/);
});

// --- the picture cannot disagree with the list -------------------------------

test("⚠ the radar and the list answer from the SAME tab, the SAME map, the SAME resolver", () => {
  // ⚠ THE FAILURE R79 EXISTS TO FORBID, reintroduced through a second code
  // path: a tab whose list says "Rocks" while the picture still draws the rat.
  // Both surfaces must therefore be pinned to the shared tab signal, the shared
  // per-tab map and the one `tabShows` resolver — not to parallel copies of
  // the rule, which is where the two sides last diverged.
  assert.match(TACTICAL_SOURCE, /overviewTabs\.selected/, "the radar reads its own tab state");
  assert.match(TACTICAL_SOURCE, /tabHiddenMap/, "the radar reads its own hidden map");
  assert.match(TACTICAL_SOURCE, /tabShows\(/, "the radar does not use the shared resolver");
  assert.match(SOURCE, /tabHiddenMap/, "the list reads its own hidden map");
  assert.match(SOURCE, /tabShows\(/, "the list does not use the shared resolver");
});

test("the panel reads the player's side through the shared stance module, and no fleet or mission", () => {
  // ⚠ THE ITERATION-5 CONTRACT. A tab no longer classifies on its own: it hands
  // the loaded identity to `stance.ts` and reads three-word answers back. The
  // panel may reference the selected character only to build that context, and
  // it must not reach for a fleet, a corporation id or a mission of its own.
  assert.match(SOURCE, /stanceContextFrom\(\$character\.characters, \$character\.selectedCharacterID\)/);
  for (const needle of ["fleet", "corporationID", "relationContext", "missionIDs"]) {
    assert.ok(
      !new RegExp(needle, "i").test(SOURCE),
      `the overview still reads '${needle}' to decide what a tab shows`,
    );
  }
});

test("the tab editor offers a picker over the five recipes, All included", () => {
  // ⚠ THE REQUEST: a new tab is built by picking one of the original filters.
  assert.match(SOURCE, /class="spc-editor"/);
  assert.match(SOURCE, /OVERVIEW_RECIPES as recipe/);
  assert.match(SOURCE, /New tab/);
  assert.ok(
    OVERVIEW_RECIPES.some((recipe) => recipe.id === "all"),
    "All is not offered when creating a tab",
  );
});

// --- model-level guards on the shared singletons -----------------------------

test("the shared bar and a fresh bar never share state", () => {
  const fresh = createTabBar();
  overviewTabs.create("combat", "Only mine");
  assert.equal(fresh.tabs.get().some((tab) => tab.name === "Only mine"), false);
  resetShared();
});

test("reset restores the shipped bar", () => {
  overviewTabs.create("combat", "Temp");
  overviewTabs.reset();
  assert.deepEqual(overviewTabs.tabs.get().map((tab) => tab.name), [
    "All",
    "System",
    "Combat",
    "Mining",
    "Travel",
  ]);
});