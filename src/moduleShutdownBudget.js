"use strict";

// Effective, held-module dogma only. Static type duration is not authority.
// Cycles outside this bounded observation contract retain conservative uncertainty.
const MAX_CYCLE_MS = 300_000;
const CYCLE_MARGIN_MS = 5_000;
function effectiveCycleMs(value) {
  const n = typeof value === "number" ? value : value?.type === "real" ? Number(value.value) : NaN;
  return Number.isFinite(n) && n > 0 && n <= MAX_CYCLE_MS ? n : null;
}
function shutdownBudgetMs(value, fallbackMs = 15_000) {
  const cycle = effectiveCycleMs(value);
  return cycle === null ? fallbackMs : Math.ceil(cycle) + CYCLE_MARGIN_MS;
}
module.exports = { effectiveCycleMs, shutdownBudgetMs };
