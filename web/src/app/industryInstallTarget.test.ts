// R109 slice 5: the Industry Manager's "set this job up", said once.

import test from "node:test";
import assert from "node:assert/strict";

import { createInstallTarget } from "./industryInstallTarget.ts";

const ASK = { characterID: 90000001, blueprintItemID: 1000000001, facilityID: 60000004, activity: "manufacturing" as const, runs: 4 };

test("an ask is pending until served, and serving drops it", () => {
  const target = createInstallTarget();
  assert.equal(target.pending.get(), null);
  target.ask(ASK);
  const request = target.pending.get();
  assert.deepEqual(request, { ...ASK, n: 1 });
  target.served(1);
  assert.equal(target.pending.get(), null);
});

test("serving an older ask does not drop a newer one", () => {
  const target = createInstallTarget();
  target.ask(ASK);
  target.ask({ ...ASK, runs: 9 });
  target.served(1);
  assert.equal(target.pending.get()?.runs, 9);
});

test("a subscriber hears every ask", () => {
  const target = createInstallTarget();
  const heard: (number | null)[] = [];
  const stop = target.pending.subscribe((request) => heard.push(request?.runs ?? null));
  target.ask(ASK);
  target.served(1);
  stop();
  assert.deepEqual(heard, [null, 4, null]);
});
