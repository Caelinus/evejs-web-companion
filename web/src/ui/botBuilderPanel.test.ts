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
