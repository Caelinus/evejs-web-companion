// THE GLOBAL WINDOW IS MOUNTED ABOVE THE PILOT-SWITCH REMOUNT — a source sweep.
//
// ⚠ WHY THIS IS A TEXT SWEEP AND NOT A RENDER TEST. The whole feature is a
// question about WHERE a component is mounted, and the failure is silent. App
// renders the active pilot's Workspace inside `{#key active.id}`, which
// destroys and rebuilds everything under it on every character switch. The Bot
// Manager works perfectly well from inside there — it just quietly loses its
// roster, its search box and its poll every time you switch, which is the exact
// behaviour the hoist removed and the exact behaviour nothing else would fail
// on. Moving the layer a few lines down, into the key, would pass every other
// test in this repo.
//
// A render test cannot see it either: `svelte/server` runs no effects and never
// switches a pilot, so both placements render identically. The placement itself
// is the thing to assert, so this reads the source and checks it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = readFileSync(fileURLToPath(new URL("./App.svelte", import.meta.url)), "utf8");
const WORKSPACE = readFileSync(fileURLToPath(new URL("./Workspace.svelte", import.meta.url)), "utf8");

/** Blank out HTML comments, so the sweep reads MARKUP and not prose about it. */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

const MARKUP = withoutComments(APP);

test("the sweep is actually reading App's markup", () => {
  // A path or stripping bug would make every assertion below vacuous.
  assert.match(MARKUP, /<Workspace/);
  assert.match(MARKUP, /\{#key active\.id\}/);
  assert.match(MARKUP, /global-layer/);
});

test("the global window layer sits OUTSIDE the {#key active.id} that remounts on a pilot switch", () => {
  const keyStart = MARKUP.indexOf("{#key active.id}");
  const keyEnd = MARKUP.indexOf("{/key}", keyStart);
  const layer = MARKUP.indexOf("global-layer");
  assert.ok(keyStart >= 0 && keyEnd > keyStart, "the pilot-switch key block moved or was renamed");
  assert.ok(layer >= 0, "the global window layer is gone");
  assert.ok(
    layer > keyEnd,
    "the global window layer is inside {#key active.id} — it will be torn down on every character switch, " +
      "which is the one thing it exists not to do",
  );
});

test("the Workspace is still inside that key — the hoist is for one window, not a general escape", () => {
  // Every other panel is a view of ONE pilot's store, so being remounted with
  // that pilot is correctness, not a limitation. If this ever fails, a stale
  // pilot's panels can outlive the switch away from them.
  const keyStart = MARKUP.indexOf("{#key active.id}");
  const keyEnd = MARKUP.indexOf("{/key}", keyStart);
  const workspace = MARKUP.indexOf("<Workspace");
  assert.ok(workspace > keyStart && workspace < keyEnd, "<Workspace> must stay inside the key");
});

test("the layer is given the ACTIVE pilot's store and flow, rather than capturing one", () => {
  // It survives the switch, so what it is handed has to FOLLOW the switch —
  // otherwise it keeps querying with a pilot the player has moved on from, and
  // its own token, which is worse than being remounted.
  const layerAt = MARKUP.indexOf("global-layer");
  const layer = MARKUP.slice(layerAt);
  assert.match(layer, /store=\{active\.store\}/);
  assert.match(layer, /flow=\{active\.flow\}/);
});

// ─── the open-request counter ────────────────────────────────────────────────

test("an open request is ADDRESSED to a pilot, not merely timed", () => {
  // ⚠ TWO BUGS, OPPOSITE DIRECTIONS, BOTH FOUND BY CLICKING. App's request lives
  // above the `{#key active.id}` that remounts a workspace per pilot, so a bare
  // counter cannot tell "asked for before I existed" from "asked for AS I was
  // being created" — and both happen here:
  //
  //  • Serving any unseen number replayed old requests: opening the Bot Builder
  //    and then switching pilots opened it again on the pilot switched TO, and
  //    on every pilot after that, each saving it into their own layout.
  //  • Seeding the mark from the counter at mount fixed that and broke the
  //    other: "Set up this built-in on that pilot" switches pilots and asks for
  //    the panel in ONE tick, so the new workspace saw a counter that already
  //    included its own request and ignored it. The pilot switched, no panel.
  //
  // Neither is a timing problem, so neither has a timing fix. The request names
  // the pilot; the matching workspace serves it and says so; App drops it.
  const effect = WORKSPACE.slice(WORKSPACE.indexOf("servedOpenRequest"));
  assert.match(
    effect,
    /request\.sessionID !== sessionID/,
    "a workspace must ignore a request addressed to a different pilot",
  );
  assert.match(
    effect,
    /onOpenRequestServed\?\.\(\)/,
    "a served request must be reported, so App can drop it before a remount finds it",
  );
  assert.match(APP, /onOpenRequestServed=\{\(\) => \(openRequest = null\)\}/);
  assert.match(APP, /sessionID=\{active\.id\}/);
});

test("a request for a pilot who is not active switches to them first", () => {
  // The panels reached this way read the MOUNTED pilot's store. Opening one for
  // a pilot who is not on screen would show the wrong ship under the right name.
  const opener = APP.slice(APP.indexOf("const requestOpenInWorkspace"));
  const switchAt = opener.indexOf("switchTo(target)");
  const setAt = opener.indexOf("openRequest = {");
  assert.ok(switchAt >= 0, "the opener no longer switches pilots");
  assert.ok(setAt > switchAt, "the pilot must be switched before the request is made");
});
test("the request is passed down as a prop, not pulled from a shared singleton", () => {
  // Data flows down. A registered callback or module-level store would let a
  // workspace be driven by something it cannot see in its own props, which is
  // what makes the staleness above hard to reason about in the first place.
  assert.match(withoutComments(WORKSPACE), /openRequest,/);
  assert.match(MARKUP, /\{openRequest\}/);
});
