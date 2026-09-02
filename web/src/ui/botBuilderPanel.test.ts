// The Bot Builder editor as it RENDERS. It pins what a player first sees: the
// watch buttons (no built-in floor anymore — watches are the player's), the top
// repeat control, the example program in plain sentences, the palette (including
// the new rats block), and — R7d — no world id on screen.

import test from "node:test";
import assert from "node:assert/strict";
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

test("renders the sections and the watch buttons (shields/armor/hull/rats)", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Bot Builder/);
  assert.match(text, /Always watching/);
  assert.match(text, /Watch Shields/);
  assert.match(text, /Watch Armor/);
  assert.match(text, /Watch Hull/);
  assert.match(text, /Watch for Rats/);
});

test("the steps section has a top-level repeat control", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Steps/);
  assert.match(text, /Repeat/);
});

test("the palette lists every block, including the rats block", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Leave the station/);
  assert.match(text, /Mine at a belt/);
  assert.match(text, /Haul the ore home/);
  assert.match(text, /Fight off rats with drones/);
});

test("the example program reads as plain sentences", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Mine at the nearest belt/);
  assert.match(text, /the ore hold is 90% full/);
});

test("the default shields watch shows, and the example is valid out of the box", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Shields drop below/);
  // Starting station (home + haul), nearest belt, auto equipment => nothing to
  // pick, so the example reads Ready with no picking required.
  assert.match(text, /Ready/);
  assert.match(text, /starting station/i, "home + haul default to the starting station");
});

test("no built-in health floor, and no world id on screen (R7d)", () => {
  const text = visibleText(renderPanel());
  assert.doesNotMatch(text, /built in/i, "the safety floor is no longer built in");
  assert.doesNotMatch(text, /\d{5,}/, "no world id renders (example uses unbound slots)");
});

test("has a Save button and a saved-bots section", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Save/);
  assert.match(text, /Saved bots/);
  // onMount does not run under SSR, so the list starts empty.
  assert.match(text, /No saved bots yet/);
});

test("offers to insert steps from a saved bot, and explains it copies rather than links", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Insert steps from a saved bot/);
  assert.match(text, /end of the blocks you already have/i, "the insert explicitly appends instead of replacing");
  assert.match(text, /copies them once/i, "the copy says plainly that it copies, not links, the source bot");
  assert.match(text, /later changes to that saved bot will not change this one/i);
  // onMount does not run under SSR, so the library starts empty and the panel
  // says so instead of showing an empty grid.
  assert.match(text, /No saved bots yet\. Save one below/i);
});

test("offers the new fleet, exploration, and operations examples", () => {
  const text = visibleText(renderPanel());
  for (const label of ["Fleet medic", "Fleet anchor", "Anomaly expedition", "Operations closeout"]) {
    assert.ok(text.includes(label), `${label} example is missing`);
  }
});

test("renders against an empty store without throwing (R18)", () => {
  assert.doesNotThrow(() => renderPanel());
});

// The editor used to hand-write a `{#if step.macro === "..."}` chain per
// macro, which left `equipment` (mine-at-belt), `corporation`
// (find-distribution-agent) and `agent` (request-mission) with NO widget at
// all — `request-mission` had no editor branch whatsoever. These are now
// GENERATED from `MACRO_ARG_DESCRIPTORS`, behind "More options" since all
// three are optional args.
test("an optional arg with no bespoke editor is GENERATED from the macro's spec", () => {
  // `equipment` on mine-at-belt is one of the three kinds that used to have no
  // widget at all. It is provable here because mine-at-belt is in the starter
  // plan a new bot opens with. The other two — `corporation` and `agent` — sit
  // on macros a player adds later, and the SSR harness cannot add a step, so
  // they are pinned where they can be: editorOptions.test.ts asserts each maps
  // to a real widget kind, and this test proves the generic renderer that
  // consumes that mapping actually works. Putting those macros into the
  // starter plan to make them renderable here would change what EVERY new bot
  // begins as, to suit a test — the plan would read "mine, haul, then go find a
  // courier agent", which is not a bot anyone would want.
  const text = visibleText(renderPanel());
  assert.match(text, /Equipment:/, "no equipment editor rendered for mine-at-belt");
  assert.match(text, /use everything fitted/, "the equipment picker's default option is missing");
  assert.match(text, /More options/, "the optional-arg disclosure never renders");
});

// The watch-add row used to be a hardcoded list of 11 of the 14 legal
// `conditionAllowedAt(kind, "interrupt")` kinds — health-below, ore-hold-at-least
// and hold-empty had no button. It is now generated from `WATCH_CONDITION_KINDS`.
test("a watch can be added for health-below, ore-hold-at-least, and hold-empty", () => {
  const body = renderPanel();
  for (const label of ["Watch Ship Health", "Watch Ore Hold", "Watch for an Empty Hold"]) {
    const found = body.match(new RegExp(`<button([^>]*)>${label}</button>`));
    assert.ok(found, `${label} watch-add button is missing`);
    assert.doesNotMatch(found![1]!, /disabled/, `${label}'s button is disabled by default`);
  }
});

// `untilKinds` used to be a hardcoded array of 7, while `conditionAllowedAt`
// admits 10 — wallet-below, wallet-above and cargo-full were unreachable as a
// step's or branch's "stop when". Now derived from `UNTIL_CONDITION_KINDS`.
test("the until dropdown offers cargo-full, wallet-below, and wallet-above", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /the cargo hold is nearly full/, "cargo-full is missing from the until dropdown");
  assert.match(text, /the wallet drops below/, "wallet-below is missing from the until dropdown");
  assert.match(text, /the wallet rises above/, "wallet-above is missing from the until dropdown");
});

// `notes` used to be hardcoded to "" in buildScript, the only mention of it in
// the file — so importing a documented bot and saving it silently discarded
// its documentation. There is now a real field for it.
test("has a notes field, so a bot's documentation is not silently discarded on save", () => {
  const body = renderPanel();
  assert.ok(body.includes('id="bot-notes"'), "no notes field rendered");
});

// Validation now carries severities; the header badge must count only the
// blocking ones (an advisory note is worth reading, never worth stopping a
// save over). The default bot has no advisory issues, so this just pins that
// the badge still reads "Ready" once blockingCount, not problems.length, is
// what it counts.
test("the header badge counts only blocking problems", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Ready/);
});
