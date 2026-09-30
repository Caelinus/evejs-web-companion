import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlanePoll } from "./controlPlanePoll.ts";
import { readFileSync } from "node:fs";

test("401 suspends polling, preserves running fleet projection, and normal login reconnect resumes reads", async () => {
  let expired = false, calls = 0, last = "", scheduled = 0;
  const errors: boolean[] = [];
  const poll = createControlPlanePoll({ read: async () => { calls++; if (expired) throw { status: 401 }; return "MINING"; },
    received: value => { last = value; }, failed: (_error, authLost) => { errors.push(authLost); },
    schedule: () => { scheduled++; return 1; }, cancel: () => {},
  });
  await poll.refresh(); expired = true; await poll.refresh();
  for (let i = 0; i < 10; i++) await poll.refresh();
  assert.equal(calls, 2); assert.equal(scheduled, 1); assert.equal(last, "MINING"); assert.deepEqual(errors, [true]);
  // The ordinary sign-in UI renews its tab credential; reconnect only reads.
  expired = false; await poll.reconnect(); assert.equal(calls, 3); assert.equal(last, "MINING");
  poll.stop(); await poll.reconnect(); assert.equal(calls, 3);
});
test("transport failures back off, requests do not overlap, and reconnect has no hosted mutation dependencies", async () => {
  const waits: number[] = []; let calls = 0;
  const poll = createControlPlanePoll({ read: async () => { calls++; throw { status: 503 }; }, received: () => {}, failed: () => {},
    schedule: (_fn, ms) => { waits.push(ms); return 1; }, cancel: () => {},
  });
  await Promise.all([poll.refresh(), poll.refresh()]);
  assert.equal(calls, 1);
  for (let i = 0; i < 6; i++) await poll.refresh();
  assert.deepEqual(waits.slice(0, 4), [6000, 12000, 24000, 30000]);
  poll.stop();
  const shell = readFileSync(new URL("../ui/MiningCommandCenter.svelte", import.meta.url), "utf8");
  assert.match(shell, /await login\(accountName.trim\(\), ""\)/);
  assert.match(shell, /ready && authenticated/); // keeps existing panel mounted on auth expiry
  assert.doesNotMatch(shell, /stopMiningOperation|selectCharacter|logout\(/);
});
