// The global window model — the one window that outlives a pilot switch.
//
// What is worth pinning here is not the arithmetic but the two rules that make
// the window "global" at all: that its position is NOT stored per character
// (the bug being fixed is the same window jumping around as you switch pilots),
// and that a tab which is global can never also be a per-pilot desktop window
// (which would put a second, character-scoped copy of the roster on screen).
// The second rule is enforced in desktop.ts and asserted from here, because it
// is this module's decision that desktop.ts is obeying.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GLOBAL_POS,
  GLOBAL_TABS,
  isGlobalTab,
  loadGlobalWindow,
  openGlobal,
  saveGlobalWindow,
} from "./globalWindow.ts";
import { isWindowTab, loadLayout, openWindow, saveLayout, type WinState } from "./desktop.ts";
import { launchableTabsFor } from "./tabs.ts";

/** A minimal localStorage, since Node has none by default. */
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
  };
}

const win = (id: string, over: Partial<WinState> = {}): WinState =>
  ({ id, x: 10, y: 10, w: 400, h: 300, z: 1, minimized: false, ...over }) as WinState;

// ─── which tabs are global ───────────────────────────────────────────────────

test("the Bot Manager is the global tab, and an ordinary panel is not", () => {
  assert.equal(isGlobalTab("botManager"), true);
  assert.equal(isGlobalTab("market"), false);
});

test("every global tab is still offered by the launcher rail", () => {
  // Being global changes WHERE a panel opens, never whether it can be opened.
  // If this ever fails the panel has become unreachable, which is a worse bug
  // than the crowding the hoist was part of fixing.
  for (const docked of [true, false]) {
    const offered = new Set(launchableTabsFor(docked).map((tab) => tab.id));
    for (const id of GLOBAL_TABS) {
      assert.equal(offered.has(id), true, `${id} must stay in the rail`);
    }
  }
});

// ─── it is never ALSO a per-pilot window ─────────────────────────────────────

test("a workspace desktop refuses to open a global tab as its own window", () => {
  // Two copies of the roster, one per pilot, is exactly what the hoist removes.
  const wins = openWindow([], "botManager");
  assert.deepEqual(wins, []);
});

test("a layout saved before the hoist does not resurrect a per-pilot copy", () => {
  installStorage();
  saveLayout(140000005, {
    wins: [win("botManager"), win("market")],
    dockCollapsed: false,
    dockWidth: 340,
    targetsX: 20,
    targetsY: 12,
    stationExpanded: false,
  });
  assert.deepEqual((loadLayout(140000005)?.wins ?? []).map((w) => w.id), ["market"]);
});

test("a global tab is still a WINDOW — the rail filters on that and must keep it", () => {
  // ⚠ The guard deliberately lives in openWindow/isWinState and NOT in
  // isWindowTab, because Neocom and MobileWorkspace filter their entries with
  // isWindowTab: excluding it there would delete the launcher entry instead of
  // just the desktop window. This pins that distinction.
  assert.equal(isWindowTab("botManager"), true);
});

// ─── opening ────────────────────────────────────────────────────────────────

test("opening it the first time places it at the default spot", () => {
  const opened = openGlobal(null, "botManager");
  assert.equal(opened.id, "botManager");
  assert.equal(opened.x, DEFAULT_GLOBAL_POS.x);
  assert.equal(opened.y, DEFAULT_GLOBAL_POS.y);
  assert.equal(opened.minimized, false);
});

test("re-opening the window already open keeps where the player put it", () => {
  // The rail entry is a toggle onto a window that may just be put away — it
  // must not snap a window the player dragged and resized back to the default.
  const moved = { ...openGlobal(null, "botManager"), x: 300, y: 200, w: 900, h: 600 };
  const again = openGlobal(moved, "botManager");
  assert.equal(again.x, 300);
  assert.equal(again.y, 200);
  assert.equal(again.w, 900);
  assert.equal(again.h, 600);
});

test("re-opening a put-away window brings it back rather than doing nothing", () => {
  const away = { ...openGlobal(null, "botManager"), minimized: true };
  assert.equal(openGlobal(away, "botManager").minimized, false);
});

// ─── persistence ────────────────────────────────────────────────────────────

test("the saved position round-trips", () => {
  installStorage();
  saveGlobalWindow(win("botManager", { x: 120, y: 90, w: 800, h: 560 }));
  const loaded = loadGlobalWindow();
  assert.equal(loaded?.x, 120);
  assert.equal(loaded?.y, 90);
  assert.equal(loaded?.w, 800);
  assert.equal(loaded?.h, 560);
});

test("the window is stored ONCE, not once per character", () => {
  // The whole point: desktop.ts keys its layout by characterID because a
  // desktop belongs to a pilot. This one does not, so two pilots must not be
  // able to hold two different positions for it — the "same window jumping
  // around as you switch" behaviour the hoist exists to remove.
  installStorage();
  saveGlobalWindow(win("botManager", { x: 120, y: 90 }));
  saveGlobalWindow(win("botManager", { x: 300, y: 200 }));
  // One record, and it is the latest write rather than a per-pilot fork.
  assert.equal(loadGlobalWindow()?.x, 300);

  // And no per-character layout carries a copy of it, whichever pilot saved.
  for (const characterID of [140000005, 140000006]) {
    saveLayout(characterID, {
      wins: [win("botManager"), win("market")],
      dockCollapsed: false,
      dockWidth: 340,
      targetsX: 20,
      targetsY: 12,
      stationExpanded: false,
    });
    assert.deepEqual((loadLayout(characterID)?.wins ?? []).map((w) => w.id), ["market"]);
  }
});
test("a stored id that is no longer global is dropped rather than drawn", () => {
  // The migration path if a tab ever leaves GLOBAL_TABS: a leftover record must
  // not open a window on a layer that no longer claims that panel.
  installStorage();
  localStorage.setItem(
    "evejs-web-global-window:v1",
    JSON.stringify({ id: "market", x: 10, y: 10, w: 400, h: 300, z: 1, minimized: false }),
  );
  assert.equal(loadGlobalWindow(), null);
});

test("a corrupt record reads as 'no window', never as a throw", () => {
  installStorage();
  localStorage.setItem("evejs-web-global-window:v1", "{not json");
  assert.equal(loadGlobalWindow(), null);
  localStorage.setItem(
    "evejs-web-global-window:v1",
    JSON.stringify({ id: "botManager", x: "left", y: 10, w: 400, h: 300 }),
  );
  assert.equal(loadGlobalWindow(), null);
});

test("saving null clears the record", () => {
  installStorage();
  saveGlobalWindow(win("botManager"));
  saveGlobalWindow(null);
  assert.equal(loadGlobalWindow(), null);
});

test("a put-away window comes back put away, not on screen", () => {
  installStorage();
  saveGlobalWindow(win("botManager", { minimized: true }));
  assert.equal(loadGlobalWindow()?.minimized, true);
});
