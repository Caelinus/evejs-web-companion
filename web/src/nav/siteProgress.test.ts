// Effort without progress — guarding the ledger, not the fighting.
//
// This file asserts the arithmetic of §13 of docs/drone-boat-block-spec.md and
// nothing about how a block uses it. The cases that matter are not the tidy
// ones, and three of them are the reason the module exists:
//
//   • THE TICKS THAT MUST NOT COUNT. Drones out of control range, drones never
//     engaged, a mixture of applying and not-applying ticks — each has its own
//     test below, because a stall counter that ticks through them abandons good
//     anomalies AND hides the real fault behind a plausible verdict. This is the
//     single most important rule in the module and it gets the most tests.
//   • THE RAT THAT REPAIRS ITSELF. Progress is measured against the LOWEST
//     health ever seen, so a rat pushing its bar back up cannot hand back
//     progress it already gave and then give it again, which would read as a
//     winnable fight forever.
//   • THE UNREADABLE ROW. It is not progress and it is not a stall. The
//     tri-state rule of this codebase: unreadable never decides.
//
// The last test is a coarse fuzz over nasty evidence shapes. It asserts two
// things only — that no sequence produces a NaN counter, and that every verdict
// is one the caller can act on — because a NaN compares false against every
// threshold, so a NaN stall counter is a stall that can never fire: the bug this
// module exists to fix, back again with the fix installed and silent.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSUMED_TICK_SECONDS,
  LEDGER_KEYS,
  MAX_SITE_RETURNS,
  MAX_TRACKED_SITES,
  SITE_VERDICT_STATES,
  STALL_TICKS,
  abandonedLabels,
  decodeLedger,
  describeVerdict,
  emptyLedger,
  encodeLedger,
  enterSite,
  isAbandoned,
  observeTick,
  visitsTo,
  type ProgressBoard,
  type ProgressEvidence,
  type SiteLedger,
} from "./siteProgress.ts";

const SITE = "QEE-288";

/** A tick of a fight that is going nowhere: applying, full-health primary, three
 *  rats on grid. Each test states the one input it is about. */
function ev(over: Partial<ProgressEvidence> = {}): ProgressEvidence {
  return {
    applying: true,
    primaryID: 101,
    primaryShieldRatio: 1,
    primaryArmorRatio: 1,
    primaryHullRatio: 1,
    hostileCount: 3,
    siteLabel: SITE,
    ...over,
  };
}

/** Health as one ratio spread over the three layers, so a test can say "the rat
 *  is at 80%" without arithmetic in the assertion. */
function at(fraction: number, over: Partial<ProgressEvidence> = {}): ProgressEvidence {
  return ev({
    primaryShieldRatio: fraction,
    primaryArmorRatio: fraction,
    primaryHullRatio: fraction,
    ...over,
  });
}

/** Feed the same evidence n times and hand back the last verdict. */
function repeat(ledger: SiteLedger, evidence: ProgressEvidence, times: number) {
  let carried = ledger;
  let verdict = observeTick(carried, evidence);
  for (let i = 1; i < times; i += 1) {
    carried = verdict.ledger;
    verdict = observeTick(carried, evidence);
  }
  return verdict;
}

test("the stall fires only after a full budget of applying ticks", () => {
  // One tick short is still "watching" — the block keeps fighting. The budget is
  // deliberately long enough that a cruiser's health bar moving slowly is never
  // mistaken for a stall, so the off-by-one here is the difference between
  // leaving a den and clearing it.
  const almost = repeat(emptyLedger(), ev(), STALL_TICKS - 1);
  assert.equal(almost.state, "watching");
  assert.equal(almost.abandon, false);
  assert.equal(almost.appliedTicks, STALL_TICKS - 1);

  const fired = observeTick(almost.ledger, ev());
  assert.equal(fired.state, "stalled");
  assert.equal(fired.cause, "nothing-dying");
  assert.equal(fired.abandon, true);
  assert.equal(fired.appliedTicks, STALL_TICKS);

  // And the counter stops there rather than counting into the thousands if the
  // caller keeps ticking after the answer arrived.
  const after = repeat(fired.ledger, ev(), 10);
  assert.equal(after.appliedTicks, STALL_TICKS);
  assert.equal(after.state, "stalled");
});

test("⚠ drones outside control range never tick the stall counter", () => {
  // The dangerous version of this feature blames the SITE for a fault at our own
  // end. A ship holding at 40 km with a 27.5 km control range applies nothing,
  // for ever, and none of that is evidence that the den is unwinnable.
  const verdict = repeat(emptyLedger(), ev({ applying: false }), STALL_TICKS * 5);
  assert.equal(verdict.state, "no-evidence");
  assert.equal(verdict.cause, "not-applying");
  assert.equal(verdict.abandon, false);
  assert.equal(verdict.appliedTicks, 0);
});

test("⚠ drones that were never engaged never tick the stall counter", () => {
  // Same rule, different fault: the drones are in the bay or idle in space, the
  // primary is locked and at full health, and the block is doing nothing to it.
  // The block reports `applying: false` and the ledger stays silent however long
  // that goes on.
  const verdict = repeat(emptyLedger(), at(1, { applying: false }), STALL_TICKS * 3);
  assert.equal(verdict.appliedTicks, 0);
  assert.notEqual(verdict.state, "stalled");
  assert.equal(verdict.ledger.stallTicks, 0);
});

test("⚠ a mix of applying and idle ticks counts only the applying ones", () => {
  // The realistic shape: drones chasing a target that keeps burning out of
  // range, so the block applies on some ticks and not others. Elapsed time runs
  // far past the budget; applied time does not.
  let ledger = emptyLedger();
  let applied = 0;
  for (let i = 0; i < STALL_TICKS * 4; i += 1) {
    const applying = i % 4 === 0; // one tick in four is actually on target
    const verdict = observeTick(ledger, ev({ applying }));
    ledger = verdict.ledger;
    if (applying) applied += 1;
    assert.equal(verdict.appliedTicks, Math.min(applied, STALL_TICKS));
    // The verdict must not fire until the APPLIED count reaches the budget,
    // however many wall-clock ticks have gone by — and once it has fired it
    // stays fired through the idle ticks that follow, or the block would
    // flip-flop between leaving and staying every time the drones went quiet.
    assert.equal(verdict.state === "stalled", applied >= STALL_TICKS);
  }
});

test("health going down at all resets the stall counter", () => {
  // "Health went down", never "it died". A single volley landing on a
  // battlecruiser rat is progress and puts the whole budget back.
  const stuck = repeat(emptyLedger(), at(1), STALL_TICKS - 2);
  assert.equal(stuck.appliedTicks, STALL_TICKS - 2);

  const hurt = observeTick(stuck.ledger, at(0.97));
  assert.equal(hurt.state, "progressing");
  assert.equal(hurt.cause, "hurt-it");
  assert.equal(hurt.appliedTicks, 0);
  assert.equal(hurt.abandon, false);
});

test("a rat that repairs itself back up does not erase the progress already made", () => {
  // Progress is measured against the LOWEST reading ever seen. Against the LAST
  // reading instead, this rat would read as progressing every time it dipped and
  // the stall would never fire — which is exactly the fight the player most
  // needs the bot to walk away from.
  let ledger = observeTick(emptyLedger(), at(1)).ledger;
  const low = observeTick(ledger, at(0.8));
  assert.equal(low.state, "progressing");
  assert.equal(low.ledger.bestHealth, 0.8 * 3);
  ledger = low.ledger;

  // It reps back up to 90%: not progress, and the 80% low is not forgotten.
  const repped = observeTick(ledger, at(0.9));
  assert.equal(repped.state, "watching");
  assert.equal(repped.cause, "applying");
  assert.equal(repped.appliedTicks, 1);
  assert.equal(repped.ledger.bestHealth, 0.8 * 3);

  // Drones claw it back to 85% — below the last reading, still above the low —
  // and that is not progress either. The fight is a treadmill and says so.
  const clawed = observeTick(repped.ledger, at(0.85));
  assert.equal(clawed.state, "watching");
  assert.equal(clawed.appliedTicks, 2);
  assert.equal(clawed.ledger.bestHealth, 0.8 * 3);

  // Left on the treadmill long enough, the verdict lands.
  const eventually = repeat(clawed.ledger, at(0.85), STALL_TICKS);
  assert.equal(eventually.state, "stalled");
});

test("an unreadable health row is neither progress nor a stall", () => {
  // Unreadable never decides. A null must not reset the counter (an unreadable
  // grid would look like a winning one) and must not tick it (a den would be
  // abandoned because the server stopped filling a field in).
  const stuck = repeat(emptyLedger(), at(1), 5);
  assert.equal(stuck.appliedTicks, 5);

  const blind = repeat(stuck.ledger, ev({ primaryShieldRatio: null }), STALL_TICKS * 3);
  assert.equal(blind.state, "no-evidence");
  assert.equal(blind.cause, "unreadable");
  assert.equal(blind.appliedTicks, 5, "an unreadable row moved the counter");

  // ⚠ AND A PARTLY READABLE ROW IS AN UNREADABLE ROW. Summing whichever layers
  // happen to arrive means the quantity changes shape between ticks: a full
  // rat whose shield row goes missing would look like it had lost a third of
  // itself, and the stall would reset on damage nobody did.
  const partial = observeTick(stuck.ledger, ev({ primaryShieldRatio: null, primaryArmorRatio: 1, primaryHullRatio: 1 }));
  assert.equal(partial.state, "no-evidence");
  assert.equal(partial.appliedTicks, 5);

  // A null primary is the same kind of gap, and specifically must not be read
  // as a target switch: one blank tick between two readings of the same rat
  // would otherwise launder a repaired health bar into a fresh baseline.
  const noTarget = observeTick(stuck.ledger, ev({ primaryID: null }));
  assert.equal(noTarget.state, "no-evidence");
  assert.equal(noTarget.ledger.bestHealth, stuck.ledger.bestHealth);
  assert.equal(noTarget.ledger.primaryID, 101);
});

test("a hostile leaving the grid is progress even with no health readings at all", () => {
  // The only progress available on a grid whose health rows will not read: the
  // rat count went down, so something died, so the site is not unwinnable.
  const stuck = repeat(emptyLedger(), ev({ hostileCount: 4 }), 6);
  assert.equal(stuck.appliedTicks, 6);

  const dead = observeTick(
    stuck.ledger,
    ev({
      hostileCount: 3,
      primaryShieldRatio: null,
      primaryArmorRatio: null,
      primaryHullRatio: null,
    }),
  );
  assert.equal(dead.state, "progressing");
  assert.equal(dead.cause, "killed-one");
  assert.equal(dead.appliedTicks, 0);

  // A fresh wave landing is the opposite direction and is NOT a stall — it just
  // moves the baseline, so the next kill out of the bigger wave still reads.
  const wave = observeTick(dead.ledger, ev({ hostileCount: 7 }));
  assert.equal(wave.state, "watching");
  assert.equal(wave.ledger.hostiles, 7);

  // An unreadable count never overwrites the last readable one with a guess.
  const blind = observeTick(wave.ledger, ev({ hostileCount: null }));
  assert.equal(blind.ledger.hostiles, 7);
});

test("a new primary resets the stall counter but not the site's return count", () => {
  // We are hurting something else now, so the old count says nothing about the
  // new target — but the per-site tally is about the SITE and outlives every
  // target switch, every wave and every trip home.
  let ledger = enterSite(emptyLedger(), SITE);
  ledger = enterSite(ledger, SITE); // flew home, repaired, came back once
  assert.equal(visitsTo(ledger, SITE), 2);

  const stuck = repeat(ledger, at(1, { primaryID: 101 }), STALL_TICKS - 1);
  assert.equal(stuck.appliedTicks, STALL_TICKS - 1);

  const switched = observeTick(stuck.ledger, at(1, { primaryID: 202 }));
  assert.equal(switched.state, "watching");
  assert.equal(switched.cause, "new-primary");
  assert.equal(switched.appliedTicks, 0);
  assert.equal(switched.ledger.primaryID, 202);
  assert.equal(switched.ledger.bestHealth, 3);
  assert.equal(visitsTo(switched.ledger, SITE), 2, "a target switch forgave a return");
  assert.equal(switched.visits, 2);
});

test("the site's return count reaches its cap and gives up", () => {
  // Two returns — the third arrival — and the label is finished, however well
  // the current wave happens to be going. The whole point is not coming back,
  // and "it is going well right now" is what it looked like the last two times.
  let ledger = enterSite(emptyLedger(), SITE);
  assert.equal(isAbandoned(ledger, SITE), false);
  ledger = enterSite(ledger, SITE);
  assert.equal(isAbandoned(ledger, SITE), false, "one return is not a verdict");
  assert.equal(observeTick(ledger, at(1)).state, "watching");

  ledger = enterSite(ledger, SITE);
  assert.equal(visitsTo(ledger, SITE), MAX_SITE_RETURNS + 1);
  assert.equal(isAbandoned(ledger, SITE), true);

  // Even a tick that is plainly winning reads as give-up.
  const winning = observeTick(ledger, at(0.2));
  assert.equal(winning.state, "give-up");
  assert.equal(winning.cause, "keeps-sending-me-home");
  assert.equal(winning.abandon, true);
  assert.equal(winning.visits, 3);
  assert.deepEqual(abandonedLabels(winning.ledger), [SITE]);

  // A different den is untouched by its neighbour's verdict.
  const other = enterSite(winning.ledger, "ABC-123");
  assert.equal(isAbandoned(other, "ABC-123"), false);
  assert.equal(observeTick(other, at(1, { siteLabel: "ABC-123" })).state, "watching");
  assert.equal(visitsTo(other, SITE), 3, "a new site reset the old site's count");
});

test("the verdict names which evidence fired, in player words", () => {
  // §13 is explicit that a generic "site too hard" teaches the player nothing:
  // "nothing was dying" and "this den keeps sending me home" are different
  // facts and a player acts on them differently.
  const stalled = repeat(emptyLedger(), at(1), STALL_TICKS);
  const stallWords = describeVerdict(stalled) ?? "";
  assert.match(stallWords, /Nothing here was dying/);
  assert.match(stallWords, new RegExp(String(STALL_TICKS * ASSUMED_TICK_SECONDS)));
  assert.match(stallWords, new RegExp(SITE));

  let ledger = emptyLedger();
  for (let i = 0; i <= MAX_SITE_RETURNS; i += 1) ledger = enterSite(ledger, SITE);
  const gaveUp = describeVerdict(observeTick(ledger, at(1))) ?? "";
  assert.match(gaveUp, /third time/);
  assert.match(gaveUp, new RegExp(SITE));

  // An ordinary fighting tick has no sentence at all — the block says its own
  // things while the fight is still a fight.
  assert.equal(describeVerdict(observeTick(emptyLedger(), at(1))), null);

  // Plain ASCII only: these strings go to the player.
  for (const words of [stallWords, gaveUp]) {
    assert.ok(/^[\x20-\x7e]*$/.test(words), `non-ASCII in "${words}"`);
  }
});

test("the ledger round-trips through a board exactly", () => {
  // The board is `Readonly<Record<string, number | string | null>>` — numbers
  // and strings, nothing richer — so the per-site counts are packed the way
  // `anomsVisited` packs its label list, and the flattening has to be lossless
  // or the run forgets an abandoned den across a reload.
  let ledger = enterSite(emptyLedger(), SITE);
  ledger = enterSite(ledger, "ABC-123");
  ledger = enterSite(ledger, SITE);
  ledger = observeTick(ledger, at(0.4, { primaryID: 77, hostileCount: 5 })).ledger;
  ledger = observeTick(ledger, at(0.4, { primaryID: 77, hostileCount: 5 })).ledger;

  const board = encodeLedger(ledger);
  for (const [key, value] of Object.entries(board)) {
    const kind = value === null ? "null" : typeof value;
    assert.ok(kind === "null" || kind === "number" || kind === "string", `${key} was a ${kind}`);
  }
  assert.equal(board[LEDGER_KEYS.sites], `${SITE}:2,ABC-123:1`);
  assert.equal(board[LEDGER_KEYS.label], SITE);
  assert.equal(board[LEDGER_KEYS.stall], 2);

  const back = decodeLedger(board as ProgressBoard);
  assert.deepEqual(back, {
    siteLabel: SITE,
    primaryID: 77,
    bestHealth: 0.4 * 3,
    stallTicks: 2,
    hostiles: 5,
    sites: [{ label: SITE, visits: 2 }, { label: "ABC-123", visits: 1 }],
  });
  // And the second lap of the round trip is identical to the first.
  assert.deepEqual(encodeLedger(back), board);

  // A board carrying none of our keys is the first tick of a run.
  assert.deepEqual(decodeLedger({ anomsVisited: "QEE-288" }), emptyLedger());
  assert.deepEqual(decodeLedger(null), emptyLedger());
});

test("a junk board decodes to something the counter can still work with", () => {
  // The board outlives the code: it is persisted with the run, so a value from
  // an older build arrives as whatever it arrives as. The one thing that must
  // never come out of here is a NaN, because NaN compares false against every
  // threshold — a NaN stall counter is a stall that can never fire, which is the
  // original bug back again with the fix installed and silent.
  const junk = decodeLedger({
    [LEDGER_KEYS.label]: 17,
    [LEDGER_KEYS.primary]: "not a number",
    [LEDGER_KEYS.best]: "3.0",
    [LEDGER_KEYS.stall]: "twelve",
    [LEDGER_KEYS.hostiles]: -4,
    [LEDGER_KEYS.sites]: ",QEE-288:,ZZ-1:2,:3,ABC-123:2,,BAD:0,ABC-123:9",
  });
  assert.equal(junk.siteLabel, null);
  assert.equal(junk.primaryID, null);
  assert.equal(junk.bestHealth, null);
  assert.equal(junk.stallTicks, 0);
  assert.equal(junk.hostiles, 0);
  // An entry with no count, no label, or a zero count is not a visit anybody
  // made and is dropped; a label listed twice keeps the first count, because
  // picking the larger of two disagreeing numbers would be inventing evidence.
  assert.deepEqual(junk.sites, [{ label: "ZZ-1", visits: 2 }, { label: "ABC-123", visits: 2 }]);
  assert.equal(Number.isFinite(observeTick(junk, at(1)).appliedTicks), true);

  // A label carrying a separator cannot be encoded, so it is never tracked: the
  // site keeps today's behaviour rather than being handed another site's count.
  const odd = enterSite(emptyLedger(), "QEE,288");
  assert.equal(visitsTo(odd, "QEE,288"), 0);
  assert.deepEqual(odd.sites, []);
});

test("the tracked-site cap never evicts a site the run has given up on", () => {
  // ⚠ An abandoned label that the run forgets is the same loop closing again
  // with extra steps — §13's own warning about the lap restart, in the one other
  // place the list can shrink.
  let ledger = emptyLedger();
  for (let i = 0; i <= MAX_SITE_RETURNS; i += 1) ledger = enterSite(ledger, "DEAD-1");
  for (let i = 0; i < MAX_TRACKED_SITES + 8; i += 1) ledger = enterSite(ledger, `OK-${i}`);
  assert.ok(ledger.sites.length <= MAX_TRACKED_SITES);
  assert.equal(isAbandoned(ledger, "DEAD-1"), true);
  assert.deepEqual(abandonedLabels(ledger), ["DEAD-1"]);
  assert.deepEqual(decodeLedger(encodeLedger(ledger) as ProgressBoard).sites, ledger.sites);
});

test("no sequence of evidence produces a NaN counter or a verdict nobody can act on", () => {
  // Coarse fuzz: every nasty value this module could be handed, crossed with
  // every other, fed as sequences so the carried ledger takes part. The
  // assertion is deliberately weak — sane counter, known verdict, a board that
  // round-trips — because a wrong-but-sane verdict is a bad evening and a NaN
  // counter is a bot that loops for ever.
  const NASTY: unknown[] = [null, undefined, NaN, Infinity, -Infinity, -1, 0, 0.5, 1, 2, "1", {}, []];
  const LABELS: unknown[] = [null, undefined, SITE, "", "  ", "A,B", "A:B", 5, {}];
  const states = new Set<string>(SITE_VERDICT_STATES);
  let cases = 0;

  for (const applying of [true, false, null, undefined, "yes"]) {
    for (const primaryID of NASTY) {
      for (const layer of NASTY) {
        for (const hostileCount of NASTY) {
          for (const siteLabel of LABELS) {
            const evidence = {
              applying,
              primaryID,
              primaryShieldRatio: layer,
              primaryArmorRatio: layer,
              primaryHullRatio: layer,
              hostileCount,
              siteLabel,
            } as unknown as ProgressEvidence;
            // Three ticks, so the carried ledger is part of the input too.
            let verdict = observeTick(emptyLedger(), evidence);
            verdict = observeTick(verdict.ledger, evidence);
            verdict = observeTick(verdict.ledger, ev());
            const where = JSON.stringify({ applying, primaryID: String(primaryID), layer: String(layer), hostileCount: String(hostileCount), siteLabel: String(siteLabel) });

            assert.ok(states.has(verdict.state), `bad state for ${where}`);
            assert.equal(typeof verdict.abandon, "boolean", `bad abandon for ${where}`);
            assert.ok(
              Number.isInteger(verdict.appliedTicks) && verdict.appliedTicks >= 0 && verdict.appliedTicks <= STALL_TICKS,
              `counter was ${String(verdict.appliedTicks)} for ${where}`,
            );
            assert.equal(verdict.appliedTicks, verdict.ledger.stallTicks, `counter disagreed with the ledger for ${where}`);
            assert.ok(Number.isInteger(verdict.visits) && verdict.visits >= 0, `bad visit count for ${where}`);
            assert.equal(verdict.abandon, verdict.state === "stalled" || verdict.state === "give-up", `abandon disagreed with the state for ${where}`);
            const health = verdict.ledger.bestHealth;
            assert.ok(health === null || (Number.isFinite(health) && health >= 0 && health <= 3), `bad baseline for ${where}`);
            // Whatever came out of it has to survive a trip through the board.
            const round = decodeLedger(encodeLedger(verdict.ledger) as ProgressBoard);
            assert.equal(Number.isInteger(round.stallTicks) && round.stallTicks >= 0, true, `bad decoded counter for ${where}`);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 5 * NASTY.length ** 3 * LABELS.length);
});
