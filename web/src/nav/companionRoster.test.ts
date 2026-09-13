// The Fleet companions window's words and sums, pure and DOM-free.
//
// What is worth pinning here is the same thing the module exists for: the two
// readings a roster can get wrong in a way nobody notices — calling a finished
// run a flying one, and telling a player "0 running" when the honest sentence
// is that nothing is flying at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  companionStatusWords,
  companionSummaryWords,
  serverCompanions,
  tallyCompanions,
} from "./companionRoster.ts";

test("a run's status is said in words, never in the store's own tokens (R9a)", () => {
  assert.equal(companionStatusWords("running"), "Running");
  assert.equal(companionStatusWords("paused"), "Paused");
  assert.equal(companionStatusWords("error"), "Stopped after a problem");
});

test("never started and stopped cleanly read the same, and neither is a raw token", () => {
  // The finished run's own outcome is on the panel below the roster; a row
  // restating it would be a second, staler copy of the same sentence.
  assert.equal(companionStatusWords("idle"), "Not running");
  assert.equal(companionStatusWords("stopped"), "Not running");
  assert.equal(companionStatusWords(null), "Not running");
});

// ─── which server rows are live ──────────────────────────────────────────────

const row = (over: Partial<{ kind: string; endedAt: string | null }> = {}) => ({
  kind: "companion",
  endedAt: null,
  ...over,
});

test("only companions are listed, never the scripted bots", () => {
  const rows = serverCompanions([row(), row({ kind: "script" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "companion");
});

test("⚠ a FINISHED companion is not a flying one, though it is still listed upstream", () => {
  // `listServerBots` keeps returning a bot after it stops so its last readout
  // stays readable. Filtering on a status word instead of `endedAt` would leave
  // yesterday's companion in a roster of who is flying right now — and this
  // window's Stop all would then try to stop it.
  const rows = serverCompanions([row({ endedAt: "2026-09-13T10:00:00Z" }), row()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.endedAt, null);
});

// ─── the summary line ────────────────────────────────────────────────────────

test("a paused companion is counted apart from an idle one", () => {
  // `holdsTheShip`'s rule, in the roster's own arithmetic: a paused companion
  // has not let go of the hull and is one press from flying it again.
  const tally = tallyCompanions(["running", "paused", "idle", null, "stopped"]);
  assert.deepEqual(tally, { running: 1, paused: 1, idle: 3 });
});

test("an empty browser says so, rather than counting nothing", () => {
  assert.equal(companionSummaryWords(tallyCompanions([])), "No pilots are signed in here.");
});

test("a roster with nobody flying never says '0 running'", () => {
  const words = companionSummaryWords(tallyCompanions(["idle", "idle"]));
  assert.equal(words, "No pilot is flying as a companion.");
  assert.doesNotMatch(words, /\b0\b/);
});

test("what IS flying is counted, and what is resting is named separately", () => {
  assert.equal(
    companionSummaryWords(tallyCompanions(["running", "running", "paused", "idle"])),
    "2 running, 1 paused, 1 idle",
  );
  assert.equal(companionSummaryWords(tallyCompanions(["running"])), "1 running");
});
