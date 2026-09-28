// The shared group-start runner: order, refusals, progress and wording.
//
// These cases used to live in squadStart.test.ts against the companion-only
// copy. They are here now because the rules are not about companions, and the
// Bot Manager's saved-bot group launcher depends on exactly the same two:
// pilots go one at a time, and one refusal never strands the rest.
import test from "node:test";
import assert from "node:assert/strict";

import {
  groupStartFinished,
  groupStartSummary,
  startForGroup,
  type GroupStartEntry,
} from "./groupStart.ts";

// Synthetic throughout: 90000001-and-up mirrors ESI's documented example id.
const PILOT_A = 90000001;
const PILOT_B = 90000002;
const PILOT_C = 90000003;

const NOBODY = "Nobody here to start.";

test("every pilot is started, one at a time, in group order", async () => {
  // ⚠ SEQUENCE IS THE ASSERTION, not merely that all three were called. A
  // browser allows about six connections per origin, so parallel starts fill
  // that pool and the next request of any kind queues behind them.
  const order: string[] = [];
  let inFlight = 0;
  const entries = await startForGroup([PILOT_A, PILOT_B, PILOT_C], async (characterID) => {
    inFlight += 1;
    assert.equal(inFlight, 1, "two starts were in flight at once");
    order.push(`start:${characterID}`);
    await Promise.resolve();
    inFlight -= 1;
  });
  assert.deepEqual(order, [`start:${PILOT_A}`, `start:${PILOT_B}`, `start:${PILOT_C}`]);
  assert.deepEqual(
    entries.map((entry) => entry.state),
    ["started", "started", "started"],
  );
});

test("ONE REFUSAL MUST NOT STRAND THE REST OF A GROUP", async () => {
  const entries = await startForGroup([PILOT_A, PILOT_B, PILOT_C], async (characterID) => {
    if (characterID === PILOT_B) {
      throw new Error("A web session is flying this character.");
    }
  });
  assert.deepEqual(
    entries.map((entry) => entry.state),
    ["started", "refused", "started"],
  );
  assert.equal(entries[1]?.sentence, "A web session is flying this character.");
});

test("a throw that carries no message still reads as something", async () => {
  const entries = await startForGroup([PILOT_A], async () => {
    throw new Error("");
  });
  assert.equal(entries[0]?.state, "refused");
  assert.equal(entries[0]?.sentence, "That pilot could not be started.");
});

test("a non-Error rejection is still a sentence, never 'undefined'", async () => {
  const entries = await startForGroup([PILOT_A], async () => {
    // eslint-disable-next-line no-throw-literal
    throw "nope";
  });
  assert.equal(entries[0]?.sentence, "That pilot could not be started.");
});

test("progress is reported as each pilot moves, not once at the end", async () => {
  const snapshots: string[][] = [];
  await startForGroup(
    [PILOT_A, PILOT_B],
    async () => {},
    (entries) => snapshots.push(entries.map((entry) => entry.state)),
  );
  // Queued pair, A starting, A started, B starting, B started.
  assert.deepEqual(snapshots[0], ["queued", "queued"]);
  assert.ok(
    snapshots.some((states) => states[0] === "starting" && states[1] === "queued"),
    "the first pilot never showed as starting while the second waited",
  );
  assert.deepEqual(snapshots.at(-1), ["started", "started"]);
});

test("a progress snapshot cannot be mutated from outside", async () => {
  const held: GroupStartEntry[][] = [];
  await startForGroup(
    [PILOT_A],
    async () => {},
    (entries) => {
      const copy = entries as GroupStartEntry[];
      held.push(copy);
      // A caller that stores the array it was handed must not be able to
      // rewrite what the runner reports next.
      copy[0] = { characterID: PILOT_A, state: "refused", sentence: "tampered" };
    },
  );
  assert.equal(held.at(-1)?.[0]?.sentence, "tampered");
  const entries = await startForGroup([PILOT_A], async () => {});
  assert.equal(entries[0]?.state, "started");
});

test("an empty group starts nothing and says the CALLER's words", async () => {
  let called = 0;
  const entries = await startForGroup([], async () => {
    called += 1;
  });
  assert.equal(called, 0);
  assert.deepEqual(entries, []);
  // ⚠ THE EMPTY SENTENCE IS NOT THIS MODULE'S. "Nobody was started" means
  // something different per caller, so the runner must not invent one.
  assert.equal(groupStartSummary(entries, NOBODY), NOBODY);
});

test("finished means every pilot reached a final state", () => {
  assert.equal(groupStartFinished([]), true);
  assert.equal(
    groupStartFinished([{ characterID: PILOT_A, state: "starting" }]),
    false,
  );
  assert.equal(
    groupStartFinished([
      { characterID: PILOT_A, state: "started" },
      { characterID: PILOT_B, state: "refused", sentence: "no" },
    ]),
    true,
  );
});

test("the summary counts both halves honestly", () => {
  const started = (characterID: number): GroupStartEntry => ({ characterID, state: "started" });
  const refused = (characterID: number): GroupStartEntry => ({
    characterID,
    state: "refused",
    sentence: "no",
  });
  assert.equal(groupStartSummary([started(PILOT_A)], NOBODY), "One pilot is flying.");
  assert.equal(
    groupStartSummary([started(PILOT_A), started(PILOT_B)], NOBODY),
    "2 pilots are flying.",
  );
  assert.equal(groupStartSummary([refused(PILOT_A)], NOBODY), "That pilot could not start.");
  assert.equal(
    groupStartSummary([refused(PILOT_A), refused(PILOT_B)], NOBODY),
    "None of the 2 could start.",
  );
  assert.equal(
    groupStartSummary([started(PILOT_A), refused(PILOT_B)], NOBODY),
    "1 flying, 1 could not start.",
  );
});

test("every summary is plain ASCII", () => {
  const entries: GroupStartEntry[] = [
    { characterID: PILOT_A, state: "started" },
    { characterID: PILOT_B, state: "refused", sentence: "no" },
  ];
  for (const words of [
    groupStartSummary([], NOBODY),
    groupStartSummary([entries[0]!], NOBODY),
    groupStartSummary([entries[1]!], NOBODY),
    groupStartSummary(entries, NOBODY),
  ]) {
    assert.match(words, /^[\x20-\x7e]*$/, `not plain ASCII: ${words}`);
  }
});
