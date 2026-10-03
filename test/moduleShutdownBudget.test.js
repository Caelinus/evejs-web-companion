"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { shutdownBudgetMs } = require("../src/moduleShutdownBudget");
test("shutdown budget uses effective cycle plus bounded margin, including short cycles", () => {
  assert.equal(shutdownBudgetMs({ type: "real", value: 85680 }), 90680);
  assert.equal(shutdownBudgetMs(1000), 6000);
});
test("unknown, invalid or out-of-contract durations retain conservative fallback", () => {
  for (const value of [null, "85680", 0, -1, NaN, Infinity, 300001]) assert.equal(shutdownBudgetMs(value), 15000);
});
