// The Bot Builder as it RENDERS, after the redesign to a numbered plan plus an
// inspector (docs/bot-builder-interface.md §2).
//
// WHAT THIS FILE CAN AND CANNOT SEE. The SSR harness renders once and cannot
// click, so everything here is FIRST-MOUNT state: the three regions, the plan
// as sentences, the row menus closed, the pickers closed, and the inspector
// absent because nothing is selected yet. That is deliberate — the inspector is
// the part with the most template in it, so it lives in `BotInspector.svelte`
// and `botInspector.test.ts` renders it DIRECTLY with props, the same split
// that `BotManagerPilotRow.svelte` needed for the same reason. Nothing here
// takes a test-only prop to make a hidden state reachable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const BotBuilder = (await import("./BotBuilder.svelte")).default;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function renderPanel(): string {
  const store = createClientStore();
  return render(BotBuilder as never, { props: { store, flow: fakeFlow() } } as never).body;
}

test("the three regions are there, in order: the bot, its watches, its plan", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Bot builder/);
  const watches = text.indexOf("Always watching");
  const plan = text.indexOf("The plan");
  assert.ok(watches > 0, "the watches region is missing");
  assert.ok(plan > watches, "the plan must come after the watches region");
});

test("watches are their own region with the cap visible, never step zero of the plan", () => {
  const text = visibleText(renderPanel());
  // The design's one structural rule for region 1 (Home Assistant / Kodu):
  // always-on rules are separate from the sequence, and the cap is shown.
  assert.match(text, /Always watching/);
  assert.match(text, /1 of 8/, "the watch count against the cap is not shown");
  assert.match(text, /If shields drop below 30%, dock at home and stop/, "the default watch is not a sentence");
});

test("the plan is numbered plain-English sentences, not rows of widgets", () => {
  const body = renderPanel();
  const text = visibleText(body);
  assert.match(text, /Leave the station/);
  assert.match(text, /Mine at the nearest belt until the ore hold is 90% full/);
  assert.match(text, /Haul the ore/);
  // The row IS the summary: no inline argument widget rides along with it.
  // (The step's own select elements live in the inspector, which is absent
  // until something is selected.)
  assert.doesNotMatch(text, /stop when/i, "an inline until-editor is back inside a row");
  assert.doesNotMatch(body, /<select[^>]*>[\s\S]*?the ore hold is nearly full/, "an inline until dropdown is back");
});

test("the top-level repeat sits in the plan's header, because it wraps everything", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /The plan/);
  assert.match(text, /Repeat/);
  assert.match(text, /a set number of times/);
});

test("every row offers an actions menu, and it starts closed", () => {
  const body = renderPanel();
  assert.match(body, /aria-label="Actions for Leave the station"/, "a plan row has no actions menu");
  // Closed on first render: the menu's items must not be in the document yet.
  assert.doesNotMatch(visibleText(body), /Move to bottom/, "a row menu renders open");
});

test("the step picker is a closed disclosure, not a permanent palette", () => {
  const body = renderPanel();
  const text = visibleText(body);
  assert.match(text, /\+ Step/);
  assert.match(text, /\+ Branch/);
  assert.match(text, /\+ Saved bot/);
  assert.match(body, /aria-expanded="false"/, "the picker is not reported as collapsed");
  // The 49-macro catalogue used to be a permanent grid below the plan.
  assert.doesNotMatch(text, /Fight off rats with drones/, "the whole palette still renders unprompted");
});

test("the inspector region collapses entirely when nothing is selected", () => {
  const body = renderPanel();
  assert.doesNotMatch(body, /builder-inspector/, "an empty inspector frame renders anyway");
  assert.doesNotMatch(visibleText(body), /More options/, "the inspector's disclosure renders with nothing selected");
});

test("the header carries the aggregate badge and Save, and the example is Ready", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Ready/, "the starter plan should need nothing picked");
  assert.match(text, /Save/);
  assert.match(text, /starting station/i, "home and the haul default to the starting station");
});

test("no world id reaches the screen (R7d)", () => {
  const text = visibleText(renderPanel());
  assert.doesNotMatch(text, /\d{5,}/, "a raw world id rendered");
});

test("still has a name field and a notes field, so documentation is not discarded", () => {
  const body = renderPanel();
  assert.ok(body.includes('id="bot-name"'), "no name field rendered");
  assert.ok(body.includes('id="bot-notes"'), "no notes field rendered");
});

test("keeps the examples, the shared library, the by-value insert and the import box", () => {
  const text = visibleText(renderPanel());
  for (const label of ["Mining day", "Fleet medic", "Anomaly expedition", "Operations closeout"]) {
    assert.ok(text.includes(label), `${label} example is missing`);
  }
  assert.match(text, /Insert steps from a saved bot/);
  assert.match(text, /copies them once/i, "the by-value insert no longer says it copies rather than links");
  assert.match(text, /Saved bots/);
  assert.match(text, /Import or export/);
  // onMount does not run under SSR, so both library lists start empty and say so.
  assert.match(text, /No saved bots yet/);
});

test("renders against an empty store without throwing (R18)", () => {
  assert.doesNotThrow(() => renderPanel());
});

// The inspector is rendered by whichever region owns the selection — a watch's
// settings under the WATCHES, a step's under the PLAN — rather than in one
// fixed spot after the plan, where a watch's settings appeared two panels away
// from the row that opened them and read as belonging to the plan.
//
// SSR cannot click, so what is pinned here is the STRUCTURE that makes it
// possible: exactly one render point per region, each guarded on the selection
// kind. `botInspector.test.ts` proves what those render points draw.
test("the inspector has a render point under each region, guarded by kind", () => {
  const source = readFileSync(new URL("./BotBuilder.svelte", import.meta.url), "utf8");
  const watchPoint = source.indexOf('inspectorTarget.kind === "watch"');
  const stepPoint = source.indexOf('inspectorTarget.kind !== "watch"');
  assert.ok(watchPoint > 0, "no render point for a selected watch");
  assert.ok(stepPoint > 0, "no render point for a selected step");

  const watchesRegion = source.indexOf('class="panel builder-watches"');
  const planRegion = source.indexOf('class="panel builder-plan"');
  assert.ok(watchesRegion > 0 && planRegion > watchesRegion);
  assert.ok(
    watchPoint > watchesRegion && watchPoint < planRegion,
    "a selected watch's settings must render between the watches and the plan, not after both",
  );
  assert.ok(stepPoint > planRegion, "a selected step's settings must render after the plan");

  // One component, two guarded call sites — not two copies of the prop list.
  const renders = source.split("{@render inspector(").length - 1;
  assert.equal(renders, 2, `expected exactly 2 inspector render points, found ${renders}`);
  assert.equal(source.split("<BotInspector").length - 1, 1, "the inspector is instantiated more than once");
});
