// ⚠ THE DOCKED NET — the mirror of `dockPanelStates.test.ts`.
//
// That suite exists because the right-hand dock panel is one frame showing two
// different things, and it stops a change made for the DOCKED panel reaching a
// pilot in space. This one runs the other way, for the in-space workspace
// redesign, and it has more to hold: that redesign changes the shape of the
// whole work area, and three of the things it touches are SHARED with the
// docked workspace rather than merely adjacent to it.
//
//   • `.desktop`, `Desktop.svelte`, `DesktopWindow.svelte` and `desktop.ts` —
//     the floating-window surface. Docked, it is the only surface there is.
//   • `.dock-panel*` — the frame, holding the Station panel docked and the
//     overview in space.
//   • the global `@theme` tokens.
//
// So this suite pins what the DOCKED workspace renders, what must never appear
// in it, and the window model's contract. A failure here is the question "did
// you mean to change the docked workspace as well?" — and if the answer is no,
// the fix is to scope the change to the in-space branch, not to re-bless it.
//
// It deliberately does NOT re-pin the dock frame's CSS or the design tokens:
// `dockPanelStates.test.ts` already hashes both, and one hash with two homes is
// a hash nobody updates correctly.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { isWindowTab, openWindow, focusWindow, resizeWindow, MIN_W, MIN_H } = await import(
  "./desktop.ts"
);
const Workspace = (await import("./Workspace.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(path.join(UI_DIR, file), "utf8");

/** No panel may call the flow during a server render — every read no-ops. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

const STATION_ID = 60003760;
const SYSTEM_ID = 30000142;

/** A live pilot, docked at a station or out in space. */
function onlineStore(docked: boolean): unknown {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" } as never);
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Farmer",
      stationID: docked ? STATION_ID : null,
      structureID: null,
      solarSystemID: SYSTEM_ID,
      corporationID: 1000001,
    },
    station: null,
  } as never);
  return store;
}

function workspace(docked: boolean): string {
  return render(Workspace as never, {
    props: { store: onlineStore(docked), flow: fakeFlow() },
  } as never).body;
}

// --- 1. what the docked workspace is made of --------------------------------

test("docked, the workspace is the rail, the desktop and the station panel", () => {
  const body = workspace(true);
  assert.match(body, /class="workspace"/);
  assert.match(body, /class="desktop"/, "the window surface is the docked workspace too");
  assert.match(body, /class="stn-panel"/, "the dock frame holds the station panel");
});

test("⚠ none of the in-space chrome reaches a docked pilot", () => {
  const body = workspace(true);
  // Each of these is mounted behind `!isDocked` today, and the redesign moves
  // every one of them. Moving one out from behind that guard is the failure
  // this test exists for.
  assert.doesNotMatch(body, /class="tactical"/, "the radar leaked into the station");
  assert.doesNotMatch(body, /class="hud-bar"/, "the ship HUD leaked into the station");
  assert.doesNotMatch(body, /class="targets-panel"/, "the target panel leaked into the station");
  assert.doesNotMatch(body, /class="spc-panel"/, "the overview leaked into the station");
  assert.doesNotMatch(body, /in-space/, "the in-space workspace modifier leaked");
});

test("in space the same workspace is the radar, the HUD and the overview", () => {
  // The other half of the branch — without it the test above could pass on a
  // workspace that renders nothing at all.
  const body = workspace(false);
  assert.match(body, /class="desktop has-view"/);
  assert.match(body, /class="tactical"/);
  assert.match(body, /class="hud-bar"/);
  assert.match(body, /class="spc-panel"/);
  assert.doesNotMatch(body, /class="stn-panel"/, "the station panel leaked into space");
});

/**
 * The condition of the `{#if}` a component is drawn inside, or null.
 *
 * ⚠ The nearest ENCLOSING conditional, not "a mention within N characters".
 * The first version of this looked back a fixed 400 chars and reported a false
 * failure the moment a comment was written between the guard and the component
 * — which is exactly the kind of test that gets weakened until it proves
 * nothing.
 */
function enclosingCondition(markup: string, tag: string): string | null {
  const at = markup.indexOf(`<${tag}`);
  if (at === -1) return null;
  const opened = markup.lastIndexOf("{#if ", at);
  if (opened === -1) return null;
  return markup.slice(opened, markup.indexOf("}", opened) + 1);
}

test("⚠ every in-space-only piece is mounted behind an isDocked guard", () => {
  // A grep rather than an argument, the same way the station panel's own suite
  // proves it cannot be reached from space. A render only proves what the
  // initial store reaches; this covers the branches it does not.
  const ws = source("Workspace.svelte");
  for (const piece of ["HudBar", "TargetsPanel"]) {
    const condition = enclosingCondition(ws, piece);
    assert.notEqual(condition, null, `${piece} is no longer mounted by Workspace`);
    assert.match(condition ?? "", /!isDocked/, `${piece} is mounted without an isDocked guard`);
  }
  // The radar is mounted by Desktop, which takes isDocked as a prop.
  const radar = enclosingCondition(source("Desktop.svelte"), "Tactical");
  assert.notEqual(radar, null, "Desktop no longer mounts the radar");
  assert.match(radar ?? "", /!isDocked/, "the radar is drawn without an isDocked guard");
});

test("the guard check above is not vacuous — it catches an unguarded mount", () => {
  assert.equal(enclosingCondition("{#if !isDocked}<HudBar />", "HudBar"), "{#if !isDocked}");
  assert.equal(enclosingCondition("{#if anything}<HudBar />", "HudBar"), "{#if anything}");
  assert.equal(enclosingCondition("<HudBar />", "HudBar"), null, "no guard at all is null");
});

// --- 2. the window model is shared, so its contract is pinned here -----------

test("⚠ the floating-window model belongs to BOTH workspaces", () => {
  // Desktop/DesktopWindow/desktop.ts are not in-space components. Docked, they
  // are the only surface there is — so `minimized`, the window strip and the
  // clamp-to-radar change all land on the docked workspace too.
  const workspaceSource = source("Workspace.svelte");
  const desktopAt = workspaceSource.indexOf("<Desktop");
  assert.notEqual(desktopAt, -1);
  const before = workspaceSource.slice(Math.max(0, desktopAt - 600), desktopAt);
  assert.doesNotMatch(
    before,
    /\{#if\s+!isDocked\}[^{]*$/,
    "the desktop must not become in-space only",
  );
  assert.match(workspace(true), /class="desktop"/);
});

test("one window per tab, and opening an open one focuses it", () => {
  const once = openWindow([], "market");
  const twice = openWindow(once, "market");
  assert.deepEqual(twice.map((w) => w.id), ["market"]);
  assert.ok((twice[0]?.z ?? 0) > (once[0]?.z ?? 0), "re-opening raises it");
});

test("focusing raises a window without moving or resizing it", () => {
  const wins = openWindow(openWindow([], "market"), "wallet");
  const raised = focusWindow(wins, "market");
  const before = wins.find((w) => w.id === "market");
  const after = raised.find((w) => w.id === "market");
  assert.equal(after?.x, before?.x);
  assert.equal(after?.y, before?.y);
  assert.equal(after?.w, before?.w);
  assert.equal(after?.h, before?.h);
});

test("a window can never be resized below the floor", () => {
  const wins = resizeWindow(openWindow([], "market"), "market", 10, 10);
  assert.equal(wins[0]?.w, MIN_W);
  assert.equal(wins[0]?.h, MIN_H);
});

test("⚠ the OVERVIEW half of the dock frame has no TabID at all", () => {
  // ⚠ THIS USED TO COVER BOTH HALVES, AND NOW COVERS ONE. The claim was that
  // neither `StationPanel` nor `SpaceOverview` could be opened as a floating
  // window, so a docked surface could never appear over a pilot in space.
  //
  // `StationPanel` IS a window now, on purpose: it is the "Inventory & Ship"
  // panel in both states, and it replaced `InventoryShip.svelte`, which drew
  // three station-only locations while flying. The guarantee moved with it —
  // the panel is told `isDocked` by every mount, and `stationPanelActions.test`
  // holds that in space it offers the ship's own bays and nothing else. That is
  // a stronger promise than "cannot be opened at all", because it is about what
  // the pilot can actually reach rather than which frame is on screen.
  //
  // The overview half is unchanged: it is the dock panel, always there, and
  // opening a second copy of it in a window would be two of the same thing.
  const ws = source("Workspace.svelte");
  assert.match(ws, /<DockPanel/, "the frame is mounted by Workspace, not opened as a window");
  const dockPanelSource = source("DockPanel.svelte");
  for (const panel of ["StationPanel", "SpaceOverview"]) {
    assert.match(dockPanelSource, new RegExp(`<${panel}`), `${panel} is not in the frame`);
  }
  assert.doesNotMatch(
    source("PanelHost.svelte"),
    /<SpaceOverview/,
    "the overview can be opened as a second, floating copy of the dock panel",
  );
  assert.equal(isWindowTab("market"), true);
});

// --- 3. the shape of the work area ------------------------------------------

test("⚠ the work area's layout is one rule, and the docked side shares it", () => {
  // The redesign turns `.work-main` from a flex row into a grid with a radar
  // area, a HUD area and the overview column. Docked there is no radar and no
  // HUD, so whatever it becomes has to still give the desktop and the dock
  // panel the whole box. This pins that both states render the same container.
  for (const docked of [true, false]) {
    assert.match(workspace(docked), /class="work-main/, `no work area (docked=${docked})`);
  }
});

test("the expanded station panel still hides the desktop, and only while docked", () => {
  // Carried from the station work: the one existing rule that hides `.desktop`.
  // The in-space redesign must not add a second one — see dockPanelStates.
  const css = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const hiders = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, selector, body]) => /\.desktop\b/.test(selector ?? "") && /display:\s*none/.test(body ?? ""),
  );
  assert.equal(hiders.length, 1, "something else has learned to hide the desktop");
  assert.match(hiders[0]?.[1] ?? "", /\.station-expanded\b/);
});

// --- 4. nothing new may reach for an image host -----------------------------

test("⚠ no in-space component links to an external image or font host", () => {
  // The space handoff asks for `images.evetech.net` icons, as the station one
  // did. Icons are local only — the browser never touches an external host, so
  // the client keeps working offline and leaks nothing about what is flown.
  const offences: string[] = [];
  for (const file of readdirSync(UI_DIR)) {
    if (!file.endsWith(".svelte") && !file.endsWith(".ts")) continue;
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(path.join(UI_DIR, file), "utf8");
    for (const host of ["images.evetech.net", "fonts.googleapis.com", "fonts.gstatic.com"]) {
      // typeIcons.ts NAMES the banned host in the comment that bans it.
      const at = text.indexOf(host);
      if (at === -1) continue;
      if (/getRemoteTypeIconUrl|must not be wired/.test(text.slice(Math.max(0, at - 400), at + 200))) {
        continue;
      }
      offences.push(`${file} links to ${host}`);
    }
  }
  assert.deepEqual(offences, []);
});

test("the host sweep above is not vacuous — it catches a real link", () => {
  // The sweep skips `typeIcons.ts`, which NAMES the banned host in the comment
  // that bans it. Without this, widening that skip would silently turn the
  // sweep off.
  const banned = "images.evetech.net";
  const leak = `const src = "https://${banned}/types/34/icon?size=64";`;
  const excused = `// getRemoteTypeIconUrl points at ${banned} and is not wired to the browser.`;
  const isExcused = (text: string): boolean => {
    const at = text.indexOf(banned);
    return /getRemoteTypeIconUrl|must not be wired/.test(
      text.slice(Math.max(0, at - 400), at + 200),
    );
  };
  assert.equal(isExcused(leak), false, "a real link must not be excused");
  assert.equal(isExcused(excused), true, "the ban's own comment must be");
});

test("⚠ a window is always reconciled back inside its surface", () => {
  // A source guard, because the clamp is pointer maths that SSR cannot run.
  //
  // It matters more than it looks: a window placed for a roomier screen can end
  // up with its title bar AND its own resize handles past the visible edge,
  // with nothing left on screen to pull it back — the handles that would do it
  // are exactly what is cut off. The redesign re-bounds windows to the radar
  // rect, which docked does not have, so this must keep measuring the surface
  // the windows are actually in.
  const desktop = source("Desktop.svelte");
  assert.match(desktop, /new ResizeObserver/, "nothing watches the surface's size");
  assert.match(desktop, /Math\.min\(/, "nothing clamps a window's size");
  assert.match(desktop, /Math\.max\(0/, "nothing clamps a window's position");
});

// --- 5. the in-space panel, and what it may not lose ------------------------

test("⚠ the overview claims the space feed", () => {
  // Found by driving it: the panel it replaced was what asked for a snapshot,
  // and for a few minutes nothing did — the radar read NOTHING ON GRID and
  // every gauge read a dash, on a ship sitting in a belt. Nothing was broken;
  // nobody had asked.
  const panel = source("SpaceOverview.svelte");
  assert.match(panel, /flow\.startSpacePolling\(\)/, "the panel must claim the feed");
  assert.match(panel, /return \(\) => flow\.stopSpacePolling\(\)/, "and hand it back");
  assert.match(panel, /flow\.loadSpaceSnapshot\(\)/, "and ask for one immediately");
  assert.match(panel, /flow\.loadTargets\(\)/, "the locks decide a row's ⌖ and Release lock");
});

test("⚠ every verb the model returns is drawn, including the blocked ones", () => {
  // `actionsForRow` returns an action that cannot be used right now WITH the
  // sentence that says why, and the bar renders it disabled wearing that
  // sentence. Dropping one silently leaves a player wondering where a button
  // went; leaving it enabled promises something the ship cannot do.
  const panel = source("SpaceOverview.svelte");
  assert.match(panel, /\{#each selectedActions as action/, "the bar must iterate the model");
  assert.match(panel, /action\.unavailable \?\? action\.label/, "a blocked verb wears its reason");
  assert.match(panel, /disabled=\{busy\.has\(action\.concern\) \|\| action\.unavailable !== null\}/);
  assert.doesNotMatch(panel, /action\.unavailable === null \?[\s\S]{0,40}\{#each/, "no filtering");
});

test("⚠ busy is a SET, so one pending call cannot grey out every verb", () => {
  const panel = source("SpaceOverview.svelte");
  assert.match(panel, /busy = \$state<ReadonlySet<ActionConcern>>/);
  assert.match(panel, /busy\.has\(action\.concern\)/, "a verb is disabled by its OWN concern");
});

test("⚠ the threat strip reads the whole snapshot, not the filtered rows", () => {
  // No preset, no search and no row cap may hide something that is shooting at
  // you. `hostileRows` takes the snapshot; `presetSnapshot` is the filtered one.
  const panel = source("SpaceOverview.svelte");
  assert.match(panel, /hostileRows\(snapshot, origin\)/);
  assert.doesNotMatch(panel, /hostileRows\(presetSnapshot/, "a preset must not hide a hostile");
});

test("the panel names the distances it flies at, and stores them in one place", () => {
  // The ▾ writes through to `flyingDistances`, so Settings, the radial menu and
  // the radar cannot disagree with the button the player just pressed.
  const panel = source("SpaceOverview.svelte");
  assert.match(panel, /setDistance\(rangeStorageKey\(kind\)/);
  assert.doesNotMatch(panel, /localStorage/, "the panel keeps no range store of its own");
});

// --- the window chrome ------------------------------------------------------

test("⚠ A WINDOW HAS TWO CHROME BUTTONS, NOT THREE — and no shade", () => {
  // ⚠ THE SHADE IS GONE AT THE OPERATOR'S CALL. `collapsed` shaded a window to
  // its title bar; `minimized` puts it away into the strip. Both shipped for a
  // while because they are genuinely different acts — but two ways to get a
  // window out of the way is one too many, and the shade is the weaker: it goes
  // on occupying the desktop, goes on overlapping what is under it, and leaves
  // a stub the player has to find again. A chip in the strip is a better handle.
  const win = source("DesktopWindow.svelte");
  assert.equal(/collapsed/.test(win), false, "the shade came back");
  assert.equal(/onToggleCollapse/.test(win), false, "the shade's handler came back");
  // `—` is the put-away now: the glyph a player already reads as "minimize".
  assert.match(win, /aria-label="Put away"[\s\S]{0,200}>—<\/button>/);
  assert.match(win, /aria-label="Close"/);
  // And the model has one hide, not two.
  const model = source("desktop.ts");
  assert.equal(/export function toggleCollapse/.test(model), false);
  assert.match(model, /export function toggleMinimize/);
});

test("⚠ DOUBLE-CLICKING THE TITLE BAR DOES THE SURVIVING THING", () => {
  // The gesture used to shade. It is the same gesture on the same target, so
  // leaving it wired to a handler that no longer exists would have been a dead
  // double-click — and silently, because nothing renders a gesture.
  const win = source("DesktopWindow.svelte");
  assert.match(win, /ondblclick=\{onToggleMinimize\}/);
});
