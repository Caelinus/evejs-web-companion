// The combat log's totals (shotsLog.ts). Pure, no DOM.
//
// The one claim worth a test file of its own: these numbers are a sum over a
// BOUNDED TAIL of a channel that is allowed to drop, so they are never a fight
// total — and the panel has to say so, every time, with the denominator
// attached. A total that quietly grows a "damage this fight" label is a lie the
// player has no way to detect.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DAMAGE_LOG_LIMIT, damageText, shotTotals, totalsCaption } from "./shotsLog.ts";
import type { DamageEvent } from "../store/types.ts";

function shot(over: Partial<DamageEvent>): DamageEvent {
  return {
    id: 1,
    direction: "dealt",
    amount: 10,
    otherPartyID: null,
    weaponTypeID: null,
    ...over,
  } as DamageEvent;
}

test("dealt and taken are summed apart, never netted against each other", () => {
  const totals = shotTotals([
    shot({ id: 1, direction: "dealt", amount: 10 }),
    shot({ id: 2, direction: "taken", amount: 4 }),
    shot({ id: 3, direction: "dealt", amount: 2.5 }),
  ]);
  assert.equal(totals.dealt, 12.5);
  assert.equal(totals.taken, 4);
  assert.equal(totals.shots, 3);
});

test("⚠ A MISS IS COUNTED AS A SHOT AND ADDS NO DAMAGE", () => {
  // The server reports a miss as amount <= 0. It is still something that
  // happened — the denominator has to include it — but adding it would be
  // inventing healing, and dropping the row would make the log disagree with
  // the count under it.
  const totals = shotTotals([
    shot({ id: 1, direction: "dealt", amount: 0 }),
    shot({ id: 2, direction: "taken", amount: -3 }),
    shot({ id: 3, direction: "dealt", amount: 5 }),
  ]);
  assert.equal(totals.dealt, 5);
  assert.equal(totals.taken, 0, "a negative amount must not subtract from what was taken");
  assert.equal(totals.shots, 3, "a miss is still a shot");
});

test("an empty log totals nothing and says there is nothing to add up", () => {
  const totals = shotTotals([]);
  assert.equal(totals.dealt, 0);
  assert.equal(totals.taken, 0);
  assert.equal(totals.shots, 0);
  assert.equal(totals.truncated, false);
  assert.match(totalsCaption(totals), /Nothing to add up/);
});

test("⚠ THE CAPTION ALWAYS NAMES ITS DENOMINATOR", () => {
  // This is the whole reason the caption exists. Two numbers on their own read
  // as a scoreboard for the engagement; the same two numbers over "the last 6
  // shots" cannot be mistaken for one.
  const six = totalsCaption(shotTotals(Array.from({ length: 6 }, (_, i) => shot({ id: i }))));
  assert.match(six, /the last 6 shots/);
  const one = totalsCaption(shotTotals([shot({ id: 1 })]));
  assert.match(one, /the last shot/, "one shot is not 'the last 1 shots'");
});

test("⚠ a FULL log says earlier shots are missing, rather than implying a whole fight", () => {
  const full = shotTotals(Array.from({ length: DAMAGE_LOG_LIMIT }, (_, i) => shot({ id: i })));
  assert.equal(full.truncated, true);
  const caption = totalsCaption(full);
  assert.match(caption, new RegExp(String(DAMAGE_LOG_LIMIT)));
  assert.match(caption, /not in these figures/, "a full log must admit what it dropped");
});

test("a short log is not marked truncated, and still refuses the words 'fight total'", () => {
  const caption = totalsCaption(shotTotals([shot({ id: 1 }), shot({ id: 2 })]));
  assert.match(caption, /Not a fight total/);
});

test("⚠ the cap is IMPORTED, never a second copy of the number", async () => {
  // A cap written down twice is a cap that goes wrong in one place, silently,
  // the first time it moves. This asserts the module really re-exports the
  // store's own value rather than declaring its own.
  const { DAMAGE_LOG_LIMIT: fromStore } = await import("../store/clientStore.ts");
  assert.equal(DAMAGE_LOG_LIMIT, fromStore);
  const source = readFileSync(new URL("./shotsLog.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ DAMAGE_LOG_LIMIT \} from "\.\.\/store\/clientStore\.ts"/);
  assert.equal(
    /DAMAGE_LOG_LIMIT\s*=\s*\d/.test(source),
    false,
    "the module declared its own copy of the cap",
  );
});

test("damageText prints a landed hit to one decimal, and a miss as a dash", () => {
  // One decimal because the server sends fractions and rounding 0.4 to "0"
  // would make a landed hit look like a miss.
  assert.equal(damageText(0.4), "0.4");
  assert.equal(damageText(12), "12.0");
  assert.equal(damageText(0), "—", "a miss is words, never a bare zero");
  assert.equal(damageText(-1), "—");
});
