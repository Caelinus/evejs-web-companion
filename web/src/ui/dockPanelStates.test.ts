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
}): string {
  return render(DockPanel as never, {
    props: {
      store: onlineStore(options.isDocked),
      flow: fakeFlow(),
      isDocked: options.isDocked,
      collapsed: options.collapsed ?? false,
      width: 340,
      onToggle: () => {},
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

test("docked, the same frame shows the docked body instead", () => {
  // The other half of the branch — without this the tests above could pass on a
  // panel that renders nothing at all.
  const body = dockPanel({ isDocked: true });
  assert.match(body, /class="dock-inventory"/);
  assert.doesNotMatch(body, /class="dock-overview"/);
});

test("the frame keeps its own head, body and resize handle in both states", () => {
  for (const isDocked of [true, false]) {
    const body = dockPanel({ isDocked });
    assert.match(body, /class="dock-resize"/, `no resize handle (isDocked=${isDocked})`);
    assert.match(body, /class="dock-panel-head"/, `no head (isDocked=${isDocked})`);
  }
});

test("the in-space branch of DockPanel.svelte does not mention the station panel", () => {
  // A source guard, because a render only proves what the initial store reaches.
  const elseArm = DOCK_PANEL_SOURCE.slice(DOCK_PANEL_SOURCE.indexOf("{:else}"));
  assert.ok(elseArm.length > 0, "expected an in-space branch");
  assert.doesNotMatch(elseArm, /StationPanel/, "the station panel is mounted in space");
  assert.match(elseArm, /Overview/, "the in-space branch must still be the Overview");
});

// --- 2. the shared frame CSS ------------------------------------------------

/**
 * Every rule in the stylesheet whose selector touches the dock frame, as
 * `selector{body}`, whitespace-normalised and sorted. Comments are stripped
 * first so re-wording a note is never a "change".
 */
function dockFrameRules(): string {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = (selector ?? "").trim().replace(/\s+/g, " ");
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
  assert.equal(rules.split("\n").length, 16, "the dock frame's rule count changed");
  assert.match(rules, /\.dock-panel-body\{[^}]*overflow: auto/);
  assert.match(rules, /\.dock-overview\{/);
});

test("⚠ the dock frame's CSS is shared with the in-space Overview and is unchanged", () => {
  // If this fails because you restyled the frame for the docked station panel:
  // DON'T re-bless it. Scope the change — put it on the station panel's own
  // root (`.stn-panel`), the way `.hangar` carries the Pilot Hangar's palette.
  // Re-bless it only for a change that is genuinely meant for BOTH states.
  assert.equal(
    sha256(dockFrameRules()),
    "37687642292c11e023978bfe4e9f69b445aea07cac635a5894954e785b558314",
  );
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
