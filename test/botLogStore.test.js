"use strict";

// The bot log's storage rule: one file per character, rotated when a run
// starts, bounded, and never able to throw at the caller — a diary that cannot
// be written must not become a reason a ship stops.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBotLogStore } = require("../src/botLogStore");

// ESI's own documented example character id — obviously synthetic, nobody's.
const CHARACTER = 90000001;
const OTHER = 90000002;

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botlog-"));
  return { dir, store: createBotLogStore({ dir, ...options }) };
}

function line(kind, extra = {}) {
  return { t: new Date().toISOString(), kind, run: "r1", ...extra };
}

test("lines land in that character's log and read back in order", () => {
  const { store } = tempStore();
  store.append(CHARACTER, [line("start", { script: "Miner" }), line("issue", { says: "undock" })]);

  const lines = store.read(CHARACTER, "current");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "start");
  assert.equal(lines[1].says, "undock");
  assert.equal(lines[1].characterID, CHARACTER, "the store stamps whose log it is");
});

test("one character never sees another's log", () => {
  const { store } = tempStore();
  store.append(CHARACTER, [line("start"), line("issue", { says: "undock" })]);
  assert.deepEqual(store.read(OTHER, "current"), []);
});

test("a pilot who has never run a bot has an empty log, not a failure", () => {
  const { store } = tempStore();
  assert.deepEqual(store.read(CHARACTER, "current"), []);
  assert.deepEqual(store.read(CHARACTER, "previous"), []);
});

test("a new run rotates: the last run becomes previous, the new one starts empty", () => {
  const { store } = tempStore();
  store.append(CHARACTER, [line("start", { script: "first" }), line("issue", { says: "undock" })]);
  store.append(CHARACTER, [line("start", { script: "second" })]);

  const current = store.read(CHARACTER, "current");
  const previous = store.read(CHARACTER, "previous");
  assert.deepEqual(current.map((l) => l.script), ["second"], "the new run is alone in the current log");
  assert.equal(previous.length, 2, "and the whole previous run is still readable");
  assert.equal(previous[0].script, "first");
});

test("only two runs are kept — the third start drops the oldest", () => {
  const { store } = tempStore();
  store.append(CHARACTER, [line("start", { script: "first" })]);
  store.append(CHARACTER, [line("start", { script: "second" })]);
  store.append(CHARACTER, [line("start", { script: "third" })]);

  assert.deepEqual(store.read(CHARACTER, "current").map((l) => l.script), ["third"]);
  assert.deepEqual(store.read(CHARACTER, "previous").map((l) => l.script), ["second"]);
});

test("a run that spans a rotation keeps the lines that came before it", () => {
  const { store } = tempStore();
  // One batch carrying the END of one run and the START of the next: the tail
  // must land in the old file, not be rotated away with it.
  store.append(CHARACTER, [line("start", { script: "first" })]);
  store.append(CHARACTER, [line("end", { reason: "stopped" }), line("start", { script: "second" })]);

  const previous = store.read(CHARACTER, "previous");
  assert.deepEqual(previous.map((l) => l.kind), ["start", "end"], "the old run kept its own ending");
  assert.deepEqual(store.read(CHARACTER, "current").map((l) => l.kind), ["start"]);
});

test("a runaway run is capped, and the log SAYS it was cut off", () => {
  const { store } = tempStore({ maxLines: 3 });
  store.append(CHARACTER, [line("start"), line("decide"), line("decide"), line("decide"), line("decide")]);

  const lines = store.read(CHARACTER, "current");
  assert.equal(lines.length, 4, "three lines plus the notice");
  assert.equal(lines[3].kind, "truncated", "a log that stops recording must not do it silently");
});

test("a store that cannot write drops lines and counts them — it never throws", () => {
  const { dir, store } = tempStore();
  // Make the directory itself impossible to use: a file where the dir must be.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "not a directory", "utf8");

  assert.doesNotThrow(() => store.append(CHARACTER, [line("start"), line("issue")]));
  assert.equal(store.append(CHARACTER, [line("issue")]), 0);
  assert.ok(store.stats().dropped > 0, "a recorder that has stopped working stays discoverable");
  assert.deepEqual(store.read(CHARACTER, "current"), [], "and reading it is still not a failure");
});

test("a half-written line is reported, not silently dropped", () => {
  const { dir, store } = tempStore();
  store.append(CHARACTER, [line("start")]);
  fs.appendFileSync(path.join(dir, `${CHARACTER}.jsonl`), '{"kind":"issue"', "utf8");

  const lines = store.read(CHARACTER, "current");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].kind, "unreadable");
});

test("a character id that is not one writes nothing", () => {
  const { store } = tempStore();
  assert.equal(store.append(0, [line("start")]), 0);
  assert.equal(store.append("../escape", [line("start")]), 0);
});
