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

// ── The rolling window ──────────────────────────────────────────────────────
// The cap this replaced kept a run's FIRST lines and stopped writing. What an
// operator asks for is what a pilot did just before it stopped, so the window
// drops the oldest instead — and says how many.

function decides(count, from = 0) {
  return Array.from({ length: count }, (_, i) => line("decide", { says: `step ${from + i}` }));
}

test("a runaway run keeps its NEWEST lines, and the log says what it dropped", () => {
  const { store } = tempStore({ maxLines: 3 });
  store.append(CHARACTER, [line("start"), ...decides(10)]);

  const lines = store.read(CHARACTER, "current");
  assert.equal(lines.length, 3, "the ceiling counts the notice");
  assert.equal(lines[0].kind, "trimmed", "a log that drops a beginning must not do it silently");
  assert.equal(lines[0].dropped, 9, "and must say how much of the run is gone");
  assert.deepEqual(
    lines.slice(1).map((l) => l.says),
    ["step 8", "step 9"],
    "the END of the run is what survives — the whole point of the window",
  );
});

test("the newest lines win even before the file is compacted", () => {
  // Under the compaction threshold, so the file still holds every line and the
  // capping is `read`'s alone. Same answer either way.
  const { dir, store } = tempStore({ maxLines: 3 });
  store.append(CHARACTER, [line("start"), ...decides(4)]);

  assert.equal(
    fs.readFileSync(path.join(dir, `${CHARACTER}.jsonl`), "utf8").trim().split("\n").length,
    5,
    "nothing has been rewritten yet",
  );
  const lines = store.read(CHARACTER, "current");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].dropped, 3);
  assert.deepEqual(lines.slice(1).map((l) => l.says), ["step 2", "step 3"]);
});

test("a run that never ends does not grow a file that never ends", () => {
  const { dir, store } = tempStore({ maxLines: 4 });
  store.append(CHARACTER, [line("start")]);
  for (let batch = 0; batch < 40; batch++) {
    store.append(CHARACTER, decides(5, batch * 5));
  }

  const onDisk = fs.readFileSync(path.join(dir, `${CHARACTER}.jsonl`), "utf8").trim().split("\n");
  assert.ok(onDisk.length <= 8, `bounded by twice the ceiling, got ${onDisk.length}`);
  const lines = store.read(CHARACTER, "current");
  assert.equal(lines[0].kind, "trimmed");
  assert.equal(
    lines[0].dropped + (lines.length - 1),
    201,
    "every line of the run is either kept or counted as dropped",
  );
  assert.equal(lines[lines.length - 1].says, "step 199", "the last thing it did is still there");
});

test("a fresh store picks up a run already on disk rather than losing count", () => {
  // A BFF restart mid-run: the new process must not start counting from zero,
  // or the ceiling is never reached again and the file grows forever.
  const { dir, store } = tempStore({ maxLines: 3 });
  store.append(CHARACTER, [line("start"), ...decides(4)]);

  const resumed = createBotLogStore({ dir, maxLines: 3 });
  resumed.append(CHARACTER, decides(2, 4));

  const onDisk = fs.readFileSync(path.join(dir, `${CHARACTER}.jsonl`), "utf8").trim().split("\n");
  assert.equal(onDisk.length, 3, "the resumed store compacted rather than appending forever");
  const lines = resumed.read(CHARACTER, "current");
  assert.equal(lines[0].dropped, 5);
  assert.deepEqual(lines.slice(1).map((l) => l.says), ["step 4", "step 5"]);
});

test("a new run starts from a clean window — the notice does not carry over", () => {
  const { store } = tempStore({ maxLines: 3 });
  store.append(CHARACTER, [line("start", { script: "first" }), ...decides(10)]);
  store.append(CHARACTER, [line("start", { script: "second" }), line("issue", { says: "undock" })]);

  const lines = store.read(CHARACTER, "current");
  assert.deepEqual(lines.map((l) => l.kind), ["start", "issue"], "nothing has been dropped yet");
  assert.equal(store.read(CHARACTER, "previous")[0].kind, "trimmed", "the trimmed run is still readable");
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
