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

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "SpaceOverview.svelte"), "utf8");
const TACTICAL_SOURCE = readFileSync(path.join(UI_DIR, "Tactical.svelte"), "utf8");

const SHIP_ID = 9001;
const ROCK_ID = 50001248;
const DECOR_ID = 60000001;
const RAT_ID = 70000001;
const DECOR_TYPE_ID = 5555;
const ORE_TYPE_ID = 1230;

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

const ROCK = entity({ kind: "asteroid", itemID: ROCK_ID, typeID: ORE_TYPE_ID, groupID: 450, categoryID: 25, name: "Veldspar" });
const DECOR = entity({ kind: "structure", itemID: DECOR_ID, typeID: DECOR_TYPE_ID, groupID: 1250, name: "An Emitter" });
const RAT = entity({ itemID: RAT_ID, isNpc: true, npcEntityType: "npc", name: "Belt Rat" });

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
  const body = panel([ROCK]);
  assert.match(body, /class="spc-tool"/, "no overview verb is offered");
  assert.ok(visibleText(body).includes("Hide"), "there is no Hide control");
  // ⚠ A REAL `<button>`, NOT A CLICKABLE `<div>` OR `<span>`. The whole point of
  // this pass is that every control is an ordinary left click on a button the
  // browser owns, so keyboard reach and focus come for free.
  assert.match(body, /<button[^>]*class="spc-tool"/, "Hide is not a real button element");
  // The wiring itself is not in the SSR output (handlers are not rendered), so
  // it is pinned from the source — see the toolbar-wiring test below.
  assert.match(SOURCE, /onclick=\{hideSelected\}/, "Hide is not wired to the selection");
});

test("Hide is disabled with a REASON when nothing is picked", () => {
  // ⚠ A greyed-out button that says nothing is the silent decline this project
  // already rejected elsewhere; the reason is carried in the tooltip.
  resetShared();
  assert.match(panel([ROCK]), /Pick something first/, "a disabled Hide offers no reason");
});

test("⚠ the per-row Hide control is GONE", () => {
  // ⚠ 200 extra controls in a scrolling list, and the one a player wants is the
  // one for whatever they just clicked — which is what the toolbar acts on.
  assert.doesNotMatch(SOURCE, /spc-row-hide/, "the per-row hide control came back");
  assert.doesNotMatch(panel([ROCK]), /spc-row-hide/);
});

// --- the tab bar -------------------------------------------------------------

test("the bar opens on All plus the five defaults", () => {
  resetShared();
  const text = visibleText(panel());
  for (const label of ["All", "System", "PVE", "PVP", "Mining", "Travel"]) {
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
  assert.match(body, /<button[^>]*class="spc-tool"/);
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
  assert.doesNotMatch(body, /Yes, delete it/, "the confirmation is showing when nothing was pressed");
  assert.match(SOURCE, /class="spc-editor" class:danger=\{tabEditor\.mode === "delete"\}/);
  assert.match(SOURCE, /Yes, delete it/, "no confirmation button exists");
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
  assert.match(SOURCE, /Keep it/, "there is no way to back out of the confirmation");
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
  const stanceHide = (SOURCE.split("function hideSelectedStance").pop() ?? "").split("\n  function ")[0] ?? "";
  assert.match(stanceHide, /const row = selectedRow;/, "the row is not captured before the write");
  assert.match(stanceHide, /tabHidden\.hideStance\(activeTabID, row, stanceContext\)/, "the write is not aimed at the held row");
  assert.match(stanceHide, /selectedID === row\.itemID/, "the comparison is not the held row's id");
  assert.doesNotMatch(stanceHide, /selectedRow\.itemID/, "the stance hide still reads selectedRow.itemID");
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
  tabHidden.hide(miningID, DECOR as never, "Emitter");
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
  const travelID = tabIDByName("Travel");
  overviewTabs.select(miningID);
  tabHidden.hide(miningID, DECOR as never, "Emitter");
  const miningBody = panel();
  assert.equal(tabHidden.stateFor(miningID).hidden.length, 1, "the hiding tab recorded nothing");
  assert.ok(!visibleText(miningBody).includes("An Emitter"), "the hiding tab kept showing the group");
  overviewTabs.select(travelID);
  const travelBody = panel();
  assert.deepEqual(tabHidden.stateFor(travelID).hidden, [], "the other tab saw a hiding of its own");
  assert.ok(visibleText(travelBody).includes("An Emitter"), "the other tab lost the group");
  overviewTabs.select("all");
  const allBody = panel();
  assert.ok(visibleText(allBody).includes("An Emitter"), "All lost a group hidden elsewhere");
  assert.doesNotMatch(allBody, /spc-hidden-menu/, "the fallback tab carries a hidden menu");
});

test("the hidden menu can show this tab's groups back, one or all at once", () => {
  // ⚠ ENTRIES ARE GROUPS: one entry is one GROUP, so 200 emitters are one row,
  // and Show undoes that one entry — the player's own hides get unhidden, and
  // the preset's pre-hidings get their override recorded. The label no longer
  // counts.
  resetShared();
  const miningID = tabIDByName("Mining");
  overviewTabs.select(miningID);
  tabHidden.hide(miningID, DECOR as never, "Emitter");
  // ⚠ The per-entry "Show" button only EXISTS while the menu is open, so its
  // presence is a source-level check — an SSR render always starts collapsed.
  assert.match(SOURCE, /class="spc-hidden-show"/, "no way to bring one back");
  assert.match(SOURCE, /showEntry\(row\)/, "Show is not wired to the row");
  assert.match(SOURCE, /tabHidden\.unhideGroup\(activeTabID, row\.groupID\)/, "Show is not per-tab");
  assert.match(SOURCE, /Show everything/, "no way to unhide the tab's hiding at once");
  assert.match(SOURCE, /showEverythingOnTab\(\);/, "Show everything has no action");
  assert.match(SOURCE, /tabHidden\.clearHidden\(activeTabID\)/, "Show everything wipes the wrong tab");
});

test("⚠ the hidden menu names the GROUP, and the press lands in the ACTIVE TAB's list", () => {
  // ⚠ THE ENTRY'S LABEL IS THE GROUP'S OWN NAME. The menu says "Planet" rather
  // than whichever rock was under the cursor when Hide was pressed, and the
  // press goes to the tab the player is on — the same lookup the list's Group
  // column uses, so the menu and the grid agree on the word.
  assert.match(SOURCE, /const label = group === "—" \? typeName\(row\) : group;/);
  assert.match(SOURCE, /tabHidden\.hide\(activeTabID, row, label\)/, "the hide is not per-tab");
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
  assert.match(SOURCE, /const presetGroupRows = \$derived/, "the group pre-hidings have no list to read");
  assert.match(SOURCE, /const presetStanceRows = \$derived/, "the stance pre-hidings have no list to read");
  assert.match(SOURCE, /const hiddenMenuRows = \$derived/, "the menu's flat list has no list to read");
  assert.match(
    SOURCE,
    /presetGroupHides\(activeTab, entity, activeTabState, stanceContext\)/,
    "the preset rows are not derived from the shared rule",
  );
  assert.match(SOURCE, /tabHidden\.addGroup\(activeTabID, row\.groupID, row\.label\)/, "Show is not per-tab");
});

test("the menu's flat list never repeats a group the tab already decided", () => {
  // ⚠ THE "IT STAYS" BUG, FORBIDDEN. A group the tab hid itself is owned by
  // the tab's hidden list, and one the player already showed is owned by its
  // `shown` list — `presetHides` says no to both, so each group appears once,
  // under the list that owns it, and no row ever sits in the menu doing
  // nothing.
  assert.match(
    SOURCE,
    /if \(!presetGroupHides\(activeTab, entity, activeTabState, stanceContext\)\) continue;/,
    "the preset rows ignore the shared undecided-only rule",
  );
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
  overviewTabs.create("pve", "Only mine");
  assert.equal(fresh.tabs.get().some((tab) => tab.name === "Only mine"), false);
  resetShared();
});

test("reset restores the shipped bar", () => {
  overviewTabs.create("pve", "Temp");
  overviewTabs.reset();
  assert.deepEqual(overviewTabs.tabs.get().map((tab) => tab.name), [
    "All",
    "System",
    "PVE",
    "PVP",
    "Mining",
    "Travel",
  ]);
});