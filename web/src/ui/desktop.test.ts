// The desktop window model's ONE-WINDOW-PER-TAB invariant, at the seam where it
// is easiest to lose: storage.
//
// The reducers all keep the invariant (openWindow focuses an open tab instead of
// adding a second). loadLayout is the one entry point that does not go through
// them — it parses whatever is in localStorage, which may have been written by
// any past build. A duplicate that survives that read reaches Desktop.svelte's
// keyed `{#each shown as win (win.id)}`, which throws instead of rendering; the
// throw aborts the render flush, and since the bad layout is saved straight back
// it happens again on every reload. That is a frozen page that survives a
// refresh, so this read must be the thing that cleans it.

import test from "node:test";
import assert from "node:assert/strict";

import { loadLayout, saveLayout, openWindow, moveWindow, type WinState } from "./desktop.ts";
import { DEFAULT_GLOBAL_POS, DEFAULT_GLOBAL_W } from "./globalWindow.ts";

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

const win = (id: string, z: number): WinState =>
  ({ id, x: 10, y: 10, w: 400, h: 300, z }) as WinState;

test("a saved layout holding the same tab twice comes back holding it once", () => {
  installStorage();
  // Structurally valid, invariant-breaking — exactly what a stale layout from a
  // build that once allowed it looks like on the way back in.
  saveLayout(140000005, {
    wins: [win("market", 1), win("wallet", 2), win("market", 3)],
    dockCollapsed: false,
    dockWidth: 340,
    targetsX: 20,
    targetsY: 12,
    stationExpanded: false,
  });
  const loaded = loadLayout(140000005);
  assert.deepEqual((loaded?.wins ?? []).map((w) => w.id), ["market", "wallet"]);
  // First one wins: its own position/size come back, not the later copy's.
  assert.equal(loaded?.wins[0]?.z, 1);
});

test("opening a tab that is already open still never adds a second window", () => {
  const once = openWindow([], "market");
  const twice = openWindow(once, "market");
  assert.deepEqual(twice.map((w) => w.id), ["market"]);
});

test("a layout saved before the expand toggle existed comes back un-expanded", () => {
  // ⚠ Not merely tidiness. `stationExpanded` HIDES the desktop, so an absent
  // field that read as anything but false would hide it for every player whose
  // layout predates the toggle.
  installStorage();
  localStorage.setItem(
    "evejs-web-desktop:v1:140000006",
    JSON.stringify({ wins: [], dockCollapsed: false, dockWidth: 340, targetsX: 20, targetsY: 12 }),
  );
  assert.equal(loadLayout(140000006)?.stationExpanded, false);
});

test("the expand preference itself round-trips, so a dock comes back expanded", () => {
  installStorage();
  const layout = {
    wins: [],
    dockCollapsed: false,
    dockWidth: 340,
    targetsX: 20,
    targetsY: 12,
    stationExpanded: true,
  };
  saveLayout(140000007, layout);
  assert.equal(loadLayout(140000007)?.stationExpanded, true);
});

test("a nonsense expand field is not truthy — only a real true expands", () => {
  installStorage();
  localStorage.setItem(
    "evejs-web-desktop:v1:140000008",
    JSON.stringify({ wins: [], dockWidth: 340, stationExpanded: "yes" }),
  );
  assert.equal(loadLayout(140000008)?.stationExpanded, false);
});

test("⚠ A LAYOUT SAVED WHILE THE SHADE EXISTED IS STILL LOADED", () => {
  // The window shade is gone: two ways to get a window out of the way was one
  // too many, and it was the weaker of the two — it went on occupying the
  // desktop and left a stub the player had to find again.
  //
  // But layouts written while it existed still carry `collapsed`, and REJECTING
  // a layout throws away the windows a player had open. An unknown field must
  // simply be ignored — which is what makes dropping a field safe in a way that
  // adding a required one never is.
  const saved = {
    wins: [{ id: "market", x: 10, y: 10, w: 400, h: 300, z: 1, collapsed: true }],
    dockCollapsed: false,
    dockWidth: 340,
    targetsX: 20,
    targetsY: 12,
  };
  saveLayout(90000001, saved as never);
  const back = loadLayout(90000001);
  assert.ok(back, "a layout with an extra field was thrown away");
  assert.equal(back.wins.length, 1, "the window was dropped");
  assert.equal(back.wins[0]!.id, "market");
  // ...and the stale field does not come back as state.
  assert.equal("collapsed" in (back.wins[0] as object), false, "the shade came back with it");
});

test("the Bot Builder does not open underneath the global window that opens it", () => {
  // ⚠ FOUND BY DRIVING IT, NOT BY READING IT. The builder has no launcher entry:
  // the only way in is the Bot Manager's Edit / New bot, and the Manager is a
  // GLOBAL window painted over this desktop. At the default sizes the cascade's
  // first spot (16,16) is entirely inside the global window's default rectangle,
  // so pressing Edit opened a panel that could not be seen — indistinguishable
  // from the button doing nothing.
  const builder = openWindow([], "botBuilder")[0] as WinState;
  const globalRight = DEFAULT_GLOBAL_POS.x + DEFAULT_GLOBAL_W;
  assert.ok(
    builder.x >= globalRight,
    `the builder opens at x=${builder.x}, inside the global window's rectangle (ends at ${globalRight})`,
  );
  // Only this one is special; everything else still cascades from the corner.
  const market = openWindow([], "market")[0] as WinState;
  assert.equal(market.x, 16);
  assert.equal(market.y, 16);
});

test("a builder already open keeps where the player put it", () => {
  // The clear-of-global spot is a FIRST position, not a home it snaps back to:
  // pressing Edit again on a window that has been dragged somewhere must raise
  // it where it stands, or it could not be kept anywhere.
  const opened = openWindow([], "botBuilder");
  const moved = moveWindow(opened, "botBuilder", 40, 300);
  const again = openWindow(moved, "botBuilder");
  const win = again.find((w) => w.id === "botBuilder");
  assert.equal(win?.x, 40);
  assert.equal(win?.y, 300);
});
