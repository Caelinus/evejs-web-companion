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

import {
  newBranch,
  newEditorState,
  newStepFor,
  newSubBot,
  toEditorState,
  toScript,
  DEFAULT_LOOP_ID,
} from "./editorDoc.ts";
import { DEFAULT_HUNT_MAX_JUMPS, DEFAULT_HUNT_RANGE_AU, MACRO_IDS } from "./botScript.ts";
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

// ─── What a newly added node is born as ──────────────────────────────────────
//
// This is the durable form of a comparison that had only ever been run by hand:
// the JSON a fresh step carries, for every macro the format has. It exists
// because `hunt-player` silently lost its leash and scanner reach in a rewrite
// and nothing noticed — the step's own SENTENCE went on claiming a range the
// step no longer carried, which is the worst shape this bug can take.

test("every macro can make a fresh step, and it is the macro it was asked for", () => {
  let n = 0;
  const makeId = () => `id-${(n += 1)}`;
  for (const macro of MACRO_IDS) {
    const step = newStepFor(macro, makeId);
    assert.equal(step.kind, "macro");
    assert.equal(step.macro, macro);
    assert.ok(step.id.length > 0, `${macro} got no id`);
  }
});

test("a fresh step's seeded arguments are exactly these, for every macro", () => {
  // A full snapshot rather than spot checks: a default that disappears is
  // invisible in the UI until a player reads the sentence and believes it.
  const makeId = () => "ID";
  const seeded: Record<string, unknown> = {};
  for (const macro of MACRO_IDS) {
    const step = newStepFor(macro, makeId);
    const keys = Object.keys(step.args).sort();
    if (keys.length > 0 || step.until !== undefined) {
      seeded[macro] = { args: keys, until: step.until?.kind ?? null };
    }
  }
  assert.deepEqual(seeded, {
    "mine-at-belt": { args: ["belt"], until: "ore-hold-at-least" },
    "travel-to-belt": { args: ["belt"], until: null },
    "travel-to-station": { args: ["station"], until: null },
    "deliver-ore": { args: ["station"], until: null },
    "move-items": { args: ["from", "to"], until: null },
    "buy-item": { args: ["item", "price", "quantity"], until: null },
    "sell-item": { args: ["item", "price"], until: null },
    "invite-to-fleet": { args: ["who"], until: null },
    "hunt-player": { args: ["maxJumps", "range"], until: null },
    "send-chat": { args: ["channel", "message"], until: null },
    "set-destination": { args: ["destination"], until: null },
  });
});

test("hunt-player is born with the leash and scanner reach its sentence claims", () => {
  // The regression this whole section exists for. The values come from the
  // format's own constants, so the step and the runtime cannot disagree.
  const step = newStepFor("hunt-player", () => "ID");
  assert.deepEqual(step.args["maxJumps"], { kind: "count", value: DEFAULT_HUNT_MAX_JUMPS });
  assert.deepEqual(step.args["range"], { kind: "count", value: DEFAULT_HUNT_RANGE_AU });
  assert.equal(step.args["only"], undefined, "a hunt should start on 'any player', not on someone");
});

// ⚠ THE INVARIANT THAT KEEPS A FRESH STEP SAFE. Save is disabled while any
// BLOCKING problem stands, and the codec refuses a document with a required
// argument unset. Those are two separate judgements in two separate modules,
// and they have to agree: if the validator stays quiet about a fresh step that
// the codec would refuse, the player saves a bot into a PLATFORM-WIDE library
// that nobody — including them — can ever open again, because decode-on-read
// refuses it. The other way round is merely annoying: Save greyed out for a
// document that would have been fine.
//
// A step with no honest default (a fitting to switch to, a message to send) is
// SUPPOSED to arrive unset and be refused by both. That is the visible
// constraint CodeStruct argues for, and it is why this is an agreement test
// rather than a "everything must encode" test.
test("the validator and the codec agree about every fresh step, for every macro", () => {
  let n = 0;
  let refusedByCodec = 0;
  let blockedBySave = 0;
  const makeId = () => `n${(n += 1)}`;
  for (const macro of MACRO_IDS) {
    const state = { ...newEditorState(), steps: [newStepFor(macro, makeId)] };
    const doc = toScript(state);
    const blocking = validateScript(doc).filter((p) => p.severity === "blocking");
    const decoded = decodeScriptValue(JSON.parse(encodeScriptDoc(doc)));
    // ONE DIRECTION IS A BUG AND THE OTHER IS A CHOICE. A document the codec
    // would refuse must be blocked here, or it reaches the library unopenable.
    // The reverse — blocked while the codec would have accepted it — is the
    // validator being deliberately stricter than the format, and it should be:
    // `buy-item` can be ENCODED with no item picked, and a buy order with no
    // item is not something to let anyone save.
    if (!decoded.ok) {
      assert.ok(
        blocking.length > 0,
        `a fresh ${macro} step would be REFUSED on reload (${decoded.refusal}) and nothing stops it being saved`,
      );
      refusedByCodec += 1;
    }
    if (blocking.length > 0) {
      blockedBySave += 1;
    }
  }
  // Non-vacuous, and a record of the gap: both sides fire, and the validator
  // stops MORE than the codec does.
  assert.ok(refusedByCodec > 0, "no macro exercises the codec refusal — this test is asserting nothing");
  assert.ok(blockedBySave >= refusedByCodec, "the validator has become laxer than the codec");
});

test("a blocking problem on a fresh step always points at a row the player can open", () => {
  // A problem anchored to nothing is one the player cannot navigate to: the
  // plan marks a row by id, so a path that matches no row is a dead end.
  let n = 0;
  const makeId = () => `n${(n += 1)}`;
  for (const macro of MACRO_IDS) {
    const step = newStepFor(macro, makeId);
    const state = { ...newEditorState(), steps: [step] };
    const anchors = new Set([step.id, "name", "home", "program", "watches", ...state.watches.map((w) => w.id)]);
    for (const problem of validateScript(toScript(state))) {
      if (problem.severity !== "blocking") continue;
      assert.ok(
        anchors.has(problem.path) || problem.path === DEFAULT_LOOP_ID,
        `a fresh ${macro} step's problem is anchored to "${problem.path}", which is no row: ${problem.sentence}`,
      );
    }
  }
});

test("a fresh branch is valid the moment it appears", () => {
  // An empty branch is a blocking problem, so the control that makes one must
  // not hand the player a broken node.
  let n = 0;
  const branch = newBranch(() => `n${(n += 1)}`);
  assert.equal(branch.kind, "branch");
  assert.equal(branch.then.length, 1, "a new fork must start with a step on the 'then' side");
  assert.equal(branch.else.length, 0);
  assert.notEqual(branch.then[0]?.id, branch.id, "the branch and its first step share an id");
  const state = { ...newEditorState(), steps: [branch] };
  const blocking = validateScript(toScript(state)).filter((p) => p.severity === "blocking");
  assert.deepEqual(blocking, [], "a brand-new fork is born broken");
});

test("a fresh sub-bot is unset, and forces the bot to run once", () => {
  const subBot = newSubBot(() => "ID");
  assert.equal(subBot.kind, "sub-bot");
  assert.equal(subBot.scriptID, null, "a new sub-bot must not point at a bot the player did not choose");
  assert.equal(subBot.name, null);
});

test("every id a factory makes is fresh", () => {
  // `newBranch` calls its generator twice; a factory that used one id for both
  // the branch and its step would collide the moment it was duplicated.
  let n = 0;
  const makeId = () => `n${(n += 1)}`;
  const ids = [
    ...MACRO_IDS.map((macro) => newStepFor(macro, makeId).id),
    ...(() => {
      const b = newBranch(makeId);
      return [b.id, ...b.then.map((s) => s.id)];
    })(),
    newSubBot(makeId).id,
  ];
  assert.equal(new Set(ids).size, ids.length, "a factory reused an id");
});
