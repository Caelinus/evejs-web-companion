// THE ROUND-TRIP NOBODY HAD CHECKED.
//
// Opening a saved bot in the Bot Builder and pressing Save without touching
// anything must produce the SAME document. Until this file existed there was
// nothing asserting that, in either the old editor or the rebuilt one, because
// the two functions that decide it lived inside a Svelte component — and this
// project neither type-checks components nor can drive one outside a
// single-shot SSR render.
//
// Why it matters more than it sounds: the library is platform-wide and
// `rev`-checked. A lossy round trip does not annoy one player privately, it
// rewrites a bot other accounts are running, on a save that looked like a
// no-op, and bumps the revision so their next save conflicts.
//
// It found two real losses on the day it was written, both older than the
// redesign — see the loop-id and loop-until tests below.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newEditorState, toEditorState, toScript, DEFAULT_LOOP_ID } from "./editorDoc.ts";
import { decodeScriptValue, encodeScriptDoc } from "./scriptCodec.ts";
import { validateScript } from "./validateScript.ts";
import { EXAMPLE_BOTS } from "./exampleBots.ts";

const SEED_PATH = fileURLToPath(new URL("../../../src/starterBots.json", import.meta.url));
const seeds = (
  JSON.parse(readFileSync(SEED_PATH, "utf8")) as { bots?: readonly { id?: string; doc?: unknown }[] }
).bots ?? [];

/** Every document the app ships: the bundled examples and the BFF's seeds. */
const SHIPPED: readonly { label: string; doc: unknown }[] = [
  ...EXAMPLE_BOTS.map((example) => ({ label: `example: ${example.label}`, doc: example.doc })),
  ...seeds.map((seed, i) => ({ label: `seed: ${seed.id ?? i}`, doc: seed.doc })),
];

test("there are documents to check, so the sweep below is not vacuous", () => {
  assert.ok(SHIPPED.length >= 10, `expected the shipped bots, found ${SHIPPED.length}`);
});

for (const { label, doc } of SHIPPED) {
  test(`${label} — opening it and saving it changes nothing`, () => {
    const decoded = decodeScriptValue(doc);
    assert.ok(decoded.ok, `${label} does not decode: ${decoded.ok ? "" : decoded.refusal}`);
    // The baseline is the document AS THE CODEC READS IT, not the raw file:
    // the codec is allowed to tidy on the way in (that is what its warnings
    // are for), and the editor is not being asked to reproduce a file's
    // whitespace — only to add nothing and drop nothing of its own.
    const opened = encodeScriptDoc(decoded.doc);
    const resaved = encodeScriptDoc(toScript(toEditorState(decoded.doc)));
    assert.equal(resaved, opened, `${label} was rewritten by a no-op save`);
  });
}

test("a loop keeps its own id across a round trip", () => {
  // The editor used to rebuild every loop as `{ id: "main-loop" }`, so opening
  // a bot whose loop was named anything else and saving it renamed the loop —
  // and a loop id is what a running bot's step path is reported against.
  const doc = {
    format: "evejs-bot-script",
    version: 1,
    name: "Loop with a name of its own",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      {
        id: "outer",
        kind: "loop",
        repeat: { kind: "times", count: 4 },
        body: [{ id: "s1", kind: "macro", macro: "undock", args: {} }],
      },
    ],
  };
  const decoded = decodeScriptValue(doc);
  assert.ok(decoded.ok);
  const rebuilt = toScript(toEditorState(decoded.doc));
  const loop = rebuilt.program[0];
  assert.ok(loop !== undefined && loop.kind === "loop");
  assert.equal(loop.id, "outer", "the loop was renamed on save");
});

test("a loop keeps its own stop condition across a round trip", () => {
  // `until` on a LOOP is legal (scriptCodec reads one) and the editor has no
  // control for it, so it was simply dropped on the next save — the bot
  // quietly lost the only thing that could stop it early.
  const doc = {
    format: "evejs-bot-script",
    version: 1,
    name: "Loop that can stop early",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      {
        id: "outer",
        kind: "loop",
        repeat: { kind: "forever" },
        until: { kind: "cargo-full", fraction: 0.9 },
        body: [{ id: "s1", kind: "macro", macro: "undock", args: {} }],
      },
    ],
  };
  const decoded = decodeScriptValue(doc);
  assert.ok(decoded.ok);
  const rebuilt = toScript(toEditorState(decoded.doc));
  const loop = rebuilt.program[0];
  assert.ok(loop !== undefined && loop.kind === "loop");
  assert.deepEqual(loop.until, { kind: "cargo-full", fraction: 0.9 }, "the loop's stop condition was dropped");
  assert.equal(encodeScriptDoc(rebuilt), encodeScriptDoc(decoded.doc));
});

test("a program the flat list cannot hold is preserved verbatim, not flattened", () => {
  // Two loops: not a shape one list can show. It must still export unchanged.
  const doc = {
    format: "evejs-bot-script",
    version: 1,
    name: "Two loops",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      { id: "l1", kind: "loop", repeat: { kind: "times", count: 2 }, body: [{ id: "a", kind: "macro", macro: "undock", args: {} }] },
      { id: "l2", kind: "loop", repeat: { kind: "times", count: 3 }, body: [{ id: "b", kind: "macro", macro: "unload-cargo", args: {} }] },
    ],
  };
  const decoded = decodeScriptValue(doc);
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.refusal);
  const state = toEditorState(decoded.doc);
  assert.notEqual(state.advancedProgram, null, "a two-loop program must be preserved, not flattened");
  assert.equal(encodeScriptDoc(toScript(state)), encodeScriptDoc(decoded.doc));
  // ...and the read-only view still has the steps to show.
  assert.deepEqual(state.steps.map((n) => n.id), ["a", "b"]);
});

test("a run-once bot does not grow a loop it never had", () => {
  const doc = {
    format: "evejs-bot-script",
    version: 1,
    name: "Straight through",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [{ id: "a", kind: "macro", macro: "undock", args: {} }],
  };
  const decoded = decodeScriptValue(doc);
  assert.ok(decoded.ok);
  const state = toEditorState(decoded.doc);
  assert.equal(state.repeatMode, "once");
  assert.equal(encodeScriptDoc(toScript(state)), encodeScriptDoc(decoded.doc));
});

test("a brand-new bot is valid the moment it opens, and needs nothing picked", () => {
  const doc = toScript(newEditorState());
  const blocking = validateScript(doc).filter((p) => p.severity === "blocking");
  assert.deepEqual(blocking, [], "a new bot opens with something already broken");
  // And it survives its own codec, which is what Save will put it through.
  const decoded = decodeScriptValue(JSON.parse(encodeScriptDoc(doc)));
  assert.ok(decoded.ok, decoded.ok ? "" : decoded.refusal);
  const loop = decoded.doc.program[0];
  assert.ok(loop !== undefined && loop.kind === "loop");
  assert.equal(loop.id, DEFAULT_LOOP_ID, "a bot that never held a loop should get the historic default id");
});

test("an empty plan builds an empty program rather than an empty loop", () => {
  // An empty loop is refused by the codec, so the editor must not build one.
  const state = { ...newEditorState(), steps: [] };
  assert.deepEqual(toScript(state).program, []);
});

test("a sub-bot forces a run-once program however the repeat control is set", () => {
  const state = {
    ...newEditorState(),
    repeatMode: "forever" as const,
    steps: [{ id: "sb", kind: "sub-bot" as const, scriptID: "other", name: "Another bot" }],
  };
  const program = toScript(state).program;
  assert.equal(program.length, 1);
  assert.equal(program[0]?.kind, "sub-bot", "a sub-bot must stay at the top level, never inside a loop");
});

test("notes are carried, not discarded, and are bounded", () => {
  const state = { ...newEditorState(), notes: "why this bot exists" };
  assert.equal(toScript(state).notes, "why this bot exists");
  const long = { ...newEditorState(), notes: "x".repeat(9000) };
  assert.ok(toScript(long).notes.length <= 2000, "notes must be clipped to what the codec accepts");
});
