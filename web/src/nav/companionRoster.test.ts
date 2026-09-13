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
  inFleetFrom,
  runFactsFor,
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

test("an empty op says so, rather than counting nothing", () => {
  // ⚠ ABOUT THE OP, NOT THE BROWSER. The roster is a list the player builds
  // now, so "nobody is signed in" would be a flat lie to somebody with four
  // pilots online and none of them added yet.
  assert.equal(companionSummaryWords(tallyCompanions([])), "No pilots in this op yet.");
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

// ─── the in-fleet column ─────────────────────────────────────────────────────

test("an idle pilot's fleet comes from the Fleet Center read, not from nowhere", () => {
  // Without this the column reads "not known" for every pilot until something
  // is started — and "who is not in the fleet yet" is half of what the roster
  // is for.
  assert.equal(inFleetFrom("ready", null, false), true);
  assert.equal(inFleetFrom("not-in-fleet", null, false), false);
});

test("⚠ a fleet nobody has read yet is NOT a pilot out of a fleet", () => {
  // `unknown` is nobody asked, `unavailable` is the read failed. Flattening
  // either into a no is how a roster tells a player to go and join a fleet they
  // are already in.
  assert.equal(inFleetFrom("unknown", null, false), null);
  assert.equal(inFleetFrom("unavailable", null, false), null);
  assert.equal(inFleetFrom(null, null, false), null);
});

test("a RUNNING companion reports the fleet it can see, over the panel's read", () => {
  // Its own decisions are made on that reading, so it is the one worth showing
  // about a run — even when the two disagree.
  assert.equal(inFleetFrom("not-in-fleet", true, true), true);
  assert.equal(inFleetFrom("ready", false, true), false);
});

test("a companion that has not reported yet falls back rather than saying no", () => {
  assert.equal(inFleetFrom("ready", null, true), true);
  assert.equal(inFleetFrom("unknown", null, true), null);
});

// ─── the run-only columns ────────────────────────────────────────────────────

const LAST_RUN = {
  followingOrderFrom: "own-ladder" as const,
  lastOrderHeard: "align",
  canTag: false,
};

test("⚠ a STOPPED companion's row stops talking about the run that ended", () => {
  // FOUND BY STOPPING ONE AND WATCHING THE ROW. The store slice keeps its last
  // readout after a run ends, so the roster went on printing "following its own
  // judgement - can tag: no" about a pilot doing nothing at all — and "can tag:
  // no" in particular reads as a standing fact about the pilot rather than the
  // last thing a finished run happened to see.
  assert.deepEqual(runFactsFor(false, LAST_RUN), {
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
  });
});

test("a run that IS holding the ship reports everything it knows", () => {
  assert.deepEqual(runFactsFor(true, LAST_RUN), LAST_RUN);
});

test("a pilot with no companion slice at all reads as unknown, never as no", () => {
  assert.deepEqual(runFactsFor(true, null), {
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
  });
});
