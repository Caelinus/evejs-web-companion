// ⚠ THE IN-SPACE NET. This suite exists for exactly one reason: the right-hand
// dock panel is ONE frame showing TWO different things, and only one of them is
// being redesigned.
//
//   docked   -> the hangars, the ship bays, the station's services
//   in space -> the compact Overview, which is what is around your ship
//
// The station-panel redesign touches the docked half. Nothing it does may reach
// the in-space half — and "nothing" has to be checked, not asserted, because the
// two halves share a frame (`.dock-panel*`), a stylesheet, a set of global
// design tokens and, until the redesign, a component.
//
// So this suite pins the SHARED surfaces rather than the docked content:
//
//   1. what the in-space branch actually renders (and what it must not);
//   2. the dock frame's CSS, by content — if you changed `.dock-panel-body`'s
//      padding to suit the new panel, you changed the Overview's padding too;
//   3. the global `@theme` tokens, by content — repainting those repaints the
//      whole client, in space included;
//   4. the frame's width limits, which the handoff wanted raised.
//
// A failure here is not necessarily a bug. It is the question "did you mean to
// change the IN-SPACE panel as well?" — and if the answer is no, the fix is to
// scope the change to the station panel instead of re-blessing the hash.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const DockPanel = (await import("./DockPanel.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
const DOCK_PANEL_SOURCE = readFileSync(path.join(UI_DIR, "DockPanel.svelte"), "utf8");

/** No panel may call the flow during a server render — every read no-ops. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

const STATION_ID = 60003760;

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
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: null,
  } as never);
  return store;
}

function dockPanel(options: {
  readonly isDocked: boolean;
  readonly collapsed?: boolean;
  readonly expanded?: boolean;
}): string {
  return render(DockPanel as never, {
    props: {
      store: onlineStore(options.isDocked),
      flow: fakeFlow(),
      isDocked: options.isDocked,
      collapsed: options.collapsed ?? false,
      expanded: options.expanded ?? false,
      width: 340,
      onToggle: () => {},
      onToggleExpand: () => {},
      onResize: () => {},
    },
  } as never).body;
}

// --- 1. what the in-space branch renders ------------------------------------

test("in space the dock panel is the Overview, and says so", () => {
  const body = dockPanel({ isDocked: false });
  assert.match(body, /class="dock-overview"/, "the in-space body must be the Overview");
  assert.match(body, /Around Your Ship/, "the in-space panel keeps its descriptive name");
  assert.doesNotMatch(body, /class="dock-inventory"/, "the docked body leaked into space");
});

test("⚠ no part of the docked station panel reaches the in-space render", () => {
  const body = dockPanel({ isDocked: false });
  // The redesign's markup and its scoped palette. Neither may appear out here,
  // however the docked half is built.
  assert.doesNotMatch(body, /\bstn-/, "station-panel markup leaked into space");
  assert.doesNotMatch(body, /--stn-/, "the station panel's scoped tokens leaked into space");
  assert.doesNotMatch(body, /Station Services/, "the docked services tab leaked into space");
  assert.doesNotMatch(body, /Board your corvette/, "a docked-only action leaked into space");
});

test("collapsed in space, the strip still names the Overview", () => {
  const body = dockPanel({ isDocked: false, collapsed: true });
  assert.match(body, /Around Your Ship/);
  assert.doesNotMatch(body, /\bstn-/);
});

test("docked, the same frame shows the station panel instead", () => {
  // The other half of the branch — without this the tests above could pass on a
  // panel that renders nothing at all.
  const body = dockPanel({ isDocked: true });
  assert.match(body, /class="stn-host"/);
  assert.match(body, /class="stn-panel"/);
  assert.doesNotMatch(body, /class="dock-overview"/);
});

test("⚠ the two arms are deliberately not symmetrical", () => {
  // The station panel carries its OWN header (title, station hint, refresh,
  // collapse) and its own pinned action bar, so it takes the whole frame. The
  // Overview keeps `.dock-panel-head` and the padded, scrolling
  // `.dock-panel-body` it has always had. This asymmetry is the thing that
  // stops a change made for the docked panel from being made by editing them.
  const docked = dockPanel({ isDocked: true });
  assert.doesNotMatch(docked, /class="dock-panel-head"/, "the docked arm must not repeat a header");
  assert.doesNotMatch(docked, /class="dock-panel-body"/, "the docked arm must not be padded/scrolled");
  assert.match(docked, /aria-label="Collapse"/, "the collapse control must survive the swap");

  const inSpace = dockPanel({ isDocked: false });
  assert.match(inSpace, /class="dock-panel-head"/);
  assert.match(inSpace, /class="dock-panel-body"/);
});

test("the resize handle is on the frame, so it survives in both states", () => {
  for (const isDocked of [true, false]) {
    assert.match(dockPanel({ isDocked }), /class="dock-resize"/, `no handle (isDocked=${isDocked})`);
  }
});

test("the in-space branch of DockPanel.svelte does not mention the station panel", () => {
  // A source guard, because a render only proves what the INITIAL store
  // reaches. Slice from the `{:else}` that closes the `{#if isDocked}` arm.
  const dockedArm = DOCK_PANEL_SOURCE.indexOf("{#if isDocked}");
  assert.notEqual(dockedArm, -1, "expected an isDocked branch");
  const elseAt = DOCK_PANEL_SOURCE.indexOf("{:else}", dockedArm);
  assert.notEqual(elseAt, -1, "expected an in-space branch");
  const inSpaceArm = DOCK_PANEL_SOURCE.slice(elseAt);
  assert.doesNotMatch(inSpaceArm, /StationPanel/, "the station panel is mounted in space");
  assert.match(inSpaceArm, /Overview/, "the in-space branch must still be the Overview");
});

// --- 2. the shared frame CSS ------------------------------------------------

/**
 * Every rule in the stylesheet that can apply to the dock frame IN SPACE, as
 * `selector{body}`, whitespace-normalised and sorted. Comments are stripped
 * first so re-wording a note is never a "change".
 *
 * ⚠ Selectors that also require `.expanded` / `.station-expanded` are left out,
 * and that is not a loophole. Those classes are bound to Workspace's DERIVED
 * `isDocked && preference` flag, so nothing written under them can be reached
 * by a pilot in space — which is the property this whole suite is about, and
 * which is pinned separately below rather than assumed here.
 */
function dockFrameRules(): string {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = (selector ?? "").trim().replace(/\s+/g, " ");
    if (/\bexpanded\b/.test(s)) continue;
    if (/\.dock-(panel|overview|resize|collapse|expand)/.test(s)) {
      rules.push(`${s}{${(body ?? "").trim().replace(/\s+/g, " ")}}`);
    }
  }
  return rules.sort().join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("the extractor is not vacuous: it finds the frame's rules", () => {
  const rules = dockFrameRules();
  assert.equal(rules.split("\n").length, 17, "the dock frame's rule count changed");
  assert.match(rules, /\.dock-panel-body\{[^}]*overflow: auto/);
  assert.match(rules, /\.dock-overview\{/);
});

test("⚠ the dock frame's CSS is shared with the in-space Overview and is unchanged", () => {
  // If this fails because you restyled the frame for the docked station panel:
  // DON'T re-bless it. Scope the change — put it on the station panel's own
  // root (`.stn-panel`), the way `.hangar` carries the Pilot Hangar's palette.
  // Re-bless it only for a change that is genuinely meant for BOTH states.
  //
  // ⚠ RE-BLESSED ONCE, for the in-space redesign's Phase 1. The work area became
  // a GRID — the window surface is the radar's cell, the ship HUD is a cell
  // beneath it, and the dock column spans both rows — so the frame lost
  // `flex: 0 0 auto`, which means nothing to a grid item, and gained
  // `min-height: 0`, which is what lets its own scroller work inside a grid row.
  // Both apply identically to the Station panel and to the Overview, which is
  // exactly the test the paragraph above sets.
  assert.equal(
    sha256(dockFrameRules()),
    "173d818cabec27d48b7cc88b028d699545623719236a04a10d238e969ce0bf57",
  );
});

// --- 2b. the expanded panel, which hides the desktop ------------------------

test("⚠ expanding is gated on being DOCKED by derivation, not by a reset", () => {
  // Expanding HIDES the desktop. A pilot who undocked into a hidden desktop
  // would also have no HUD and no locked-target panel, and no control left to
  // bring any of them back. So the flag Workspace renders with is computed as
  // `isDocked && preference`: there is no stored state that could go stale and
  // no effect whose ordering could be wrong.
  const workspace = readFileSync(path.join(UI_DIR, "Workspace.svelte"), "utf8");
  assert.match(
    workspace,
    /const stationExpanded = \$derived\(isDocked && expandPreferred\);/,
    "the expanded flag must be derived from isDocked, not reset after the fact",
  );
  assert.match(workspace, /class:station-expanded=\{stationExpanded\}/);
  assert.doesNotMatch(
    workspace,
    /class:station-expanded=\{expandPreferred\}/,
    "the remembered preference must never drive the class directly",
  );
});

test("⚠ every rule that hides the desktop requires a docked-only class", () => {
  // The counterpart to the extractor's exclusion above: whatever is written
  // under those class names, it cannot apply without them.
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  let found = 0;
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.desktop\b/.test(selector ?? "")) continue;
    if (!/display:\s*none/.test(body ?? "")) continue;
    found += 1;
    assert.match(
      selector ?? "",
      /\.station-expanded\b/,
      `a rule hides the desktop without the docked-only class: ${selector}`,
    );
  }
  assert.equal(found, 1, "expected exactly one rule to hide the desktop");
});

test("the expansion is offered only where there is something to expand into", () => {
  // The mobile home has no work area to take, so it passes no handler and the
  // panel draws no control — the button cannot exist where it would do nothing.
  const mobile = readFileSync(path.join(UI_DIR, "MobileWorkspace.svelte"), "utf8");
  assert.doesNotMatch(mobile, /onToggleExpand/);
  const stationPanel = readFileSync(path.join(UI_DIR, "StationPanel.svelte"), "utf8");
  assert.match(stationPanel, /\{#if onToggleExpand\}/, "the control must be conditional on the handler");
});

test("expanded, the frame drops its pixel width so the column can stretch it", () => {
  // An inline `width` outranks any rule that would stretch the panel, so an
  // expanded frame must not emit one at all.
  const body = dockPanel({ isDocked: true, expanded: true });
  const frame = /<aside[^>]*>/.exec(body)?.[0] ?? "";
  assert.match(frame, /class="dock-panel expanded"/);
  assert.doesNotMatch(frame, /style="width:/, "an expanded panel must carry no fixed width");
  // Non-vacuous: an ordinary docked panel DOES carry one.
  const ordinary = /<aside[^>]*>/.exec(dockPanel({ isDocked: true }))?.[0] ?? "";
  assert.match(ordinary, /style="width:340px"/);
  assert.match(body, /class="stn-host"/, "and it is still the station panel inside");
  assert.doesNotMatch(body, /class="dock-resize"/, "there is nothing to drag against");
});

test("in space the frame is never expanded, whatever it is handed", () => {
  // DockPanel renders the flag it is given; Workspace is what guarantees the
  // value. This pins the other half: handed `true`, the in-space arm is still
  // the Overview and the control is nowhere on screen.
  const body = dockPanel({ isDocked: false, expanded: true });
  assert.match(body, /class="dock-overview"/);
  assert.doesNotMatch(body, /Take the whole work area/, "the control leaked into space");
});

// --- 3. the global design tokens --------------------------------------------

/** The whole `@theme { … }` block, whitespace-normalised, comments stripped. */
function themeBlock(): string {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf("@theme {");
  assert.notEqual(start, -1, "the @theme token block has gone");
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1).replace(/\s+/g, " ").trim();
    }
  }
  throw new Error("the @theme block is unterminated");
}

test("the theme extractor is not vacuous", () => {
  const block = themeBlock();
  assert.match(block, /--color-bg: #05080d;/);
  assert.match(block, /--radius-frame: 0;/);
});

test("⚠ the global design tokens are unchanged", () => {
  // These paint EVERY panel — the Overview, the HUD, the tactical view, the
  // fitting window. The station panel's palette belongs in its own scoped
  // `--stn-*` block on `.stn-panel`, never here.
  assert.equal(
    sha256(themeBlock()),
    "152435fe34e1d12b76c1e71dca9c10843f2e1e990ca1fd19e2aa85f8ce59b1b0",
  );
});

// --- 4. the frame's width limits --------------------------------------------

test("⚠ the frame's width limits are the ones the Overview was built against", () => {
  // The handoff assumes a 320px floor. Raising MIN_W here to suit it would stop
  // the player narrowing the Overview in space, which is not this change's to
  // decide — the station panel gets a narrower tier instead.
  assert.match(DOCK_PANEL_SOURCE, /const MIN_W = 240;/);
  assert.match(DOCK_PANEL_SOURCE, /const MAX_W = 900;/);
});

test("opening a window gives the work area back", () => {
  // The expanded panel HIDES the desktop, so a window opened while it is
  // expanded would land somewhere invisible and the launcher rail would look
  // broken. Asking for a panel is asking for the canvas it lives on.
  const workspace = readFileSync(path.join(UI_DIR, "Workspace.svelte"), "utf8");
  const opener = workspace.slice(workspace.indexOf("const open = (id: TabID)"));
  const body = opener.slice(0, opener.indexOf("};") + 2);
  assert.match(body, /expandPreferred = false;/, "opening a window must un-expand");
  assert.match(body, /openWindow\(wins, id\)/);
  // ...but the docked Neocom pick that folds INTO the dock panel must not, or
  // choosing "Inventory & Ship" would throw the expansion away.
  const neocom = workspace.slice(workspace.indexOf("const openFromNeocom"));
  const neocomBody = neocom.slice(0, neocom.indexOf("\n  };"));
  assert.doesNotMatch(neocomBody, /expandPreferred/);
});
