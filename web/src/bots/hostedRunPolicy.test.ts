import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hostedRunPolicy, MAX_TIMER_DELAY_MS, MAX_TIMER_SAFE_RUN_HOURS, hostedDurationLabel } from "./hostedRunPolicy.ts";
import { validateBotLaunchGrant, analyzeBotRunPolicy } from "./runPolicy.ts";
import { startingStation } from "./botScript.ts";

test("finite policy offers presets through Farmer's 72-hour bound", () => {
  assert.deepEqual(hostedRunPolicy().durationChoices, [60, 240, 720, 1440, 2880, 4320]);
  assert.equal(hostedDurationLabel(10080), "7 days");
  assert.deepEqual(hostedRunPolicy(2), { maxRuntimeMinutes: 120, defaultRuntimeMinutes: 120, durationChoices: [60, 120] });
  for (const hours of [0, -1, Infinity, "", "forever", 1.5, MAX_TIMER_SAFE_RUN_HOURS + 1]) assert.throws(() => hostedRunPolicy(hours));
  const policy = analyzeBotRunPolicy({ format: "evejs-bot-script", version: 1, name: "Wait", notes: "", home: startingStation(), program: [], interrupts: [] });
  for (const minutes of hostedRunPolicy().durationChoices) {
    assert.ok(validateBotLaunchGrant({ scriptRev: 1, riskClasses: [], maxRuntimeMinutes: minutes }, 1, policy).ok);
  }
  assert.equal(validateBotLaunchGrant({ scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 2880 }, 1, policy).ok, true);
  assert.equal(validateBotLaunchGrant({ scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 4321 }, 1, policy).ok, false);
});

test("actual Node timeout accepts default and maximum permitted grants without overflow", () => {
  assert.equal(MAX_TIMER_SAFE_RUN_HOURS, 596);
  for (const hours of [168, MAX_TIMER_SAFE_RUN_HOURS]) {
    const delay = hostedRunPolicy(hours).maxRuntimeMinutes * 60_000;
    assert.ok(delay <= MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => assert.fail("must not fire immediately"), delay);
    try { assert.equal((timer as unknown as { _idleTimeout: number })._idleTimeout, delay); }
    finally { clearTimeout(timer); }
  }
});

test("deployment config, hosted credentials and validation share one bound", () => {
  const script = `const assert=require('node:assert/strict');
    const policy=require('./src/config').hostedRunPolicy;
    assert.equal(policy.maxRuntimeMinutes,72*60);
    const auth=require('./src/webAuth');
    assert.throws(()=>auth.createBotSessionToken({},Date.now()+74*3600000));
    assert.throws(()=>auth.extendBotSessionToken('forged',Date.now()+74*3600000));`;
  // The auth refusal happens before any signing/credential file write.
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env } });
});
