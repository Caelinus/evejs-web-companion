"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BRIDGE_WRITE_PAIR_KEYS,
  EARLIER_WRITE_PAIR_KEYS,
  FEATURE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  isBridgeWritePair,
  pickSafeBrowserSessionFields,
} = require("../src/bridgeCallPolicy");

test("the generic-call write policy covers the complete canonical plumbing inventory", () => {
  const worklist = fs.readFileSync(
    path.join(__dirname, "..", "docs", "plumbing-worklist.md"),
    "utf8",
  );
  const phaseBody = worklist.slice(
    worklist.indexOf("## PHASE 3"),
    worklist.indexOf("## ORCHESTRATOR NOTES"),
  );
  const declaredCount = [...phaseBody.matchAll(/^## PHASE [34].*\((\d+)\)/gm)]
    .reduce((total, match) => total + Number(match[1]), 0);

  assert.equal(declaredCount, 301, "the canonical worklist declares 152 + 149 writes");
  assert.equal(PLUMBING_SWEEP_WRITE_PAIR_KEYS.length, declaredCount);
  for (const key of PLUMBING_SWEEP_WRITE_PAIR_KEYS) {
    const separator = key.indexOf(".");
    const service = key.slice(0, separator);
    const method = key.slice(separator + 1);
    // The worklist uses the retail owner name skillMgr; after
    // GetMySkillHandler the web gateway dispatch seam is named skillHandler.
    const worklistService = service === "skillHandler" ? "skillMgr" : service;
    assert.ok(
      phaseBody.includes(worklistService),
      `${service} must be named by the canonical write phases`,
    );
    assert.ok(phaseBody.includes(method), `${key} must be named by the canonical write phases`);
    assert.equal(isBridgeWritePair(service, method), true, key);
  }
});

test("the write policy adds every pre-sweep and post-sweep write without duplicates", () => {
  assert.equal(EARLIER_WRITE_PAIR_KEYS.length, 49);
  assert.deepEqual(FEATURE_WRITE_PAIR_KEYS, ["repairSvc.RepairItems", "slash.SlashCmd"]);
  assert.equal(BRIDGE_WRITE_PAIR_KEYS.length, 352);
  assert.equal(new Set(BRIDGE_WRITE_PAIR_KEYS).size, BRIDGE_WRITE_PAIR_KEYS.length);

  assert.equal(isBridgeWritePair("charUnboundMgr", "SelectCharacterID"), true);
  assert.equal(isBridgeWritePair("fleetObjectHandler", "Init"), true);
  assert.equal(isBridgeWritePair("repairSvc", "RepairItems"), true);
  assert.equal(isBridgeWritePair("repairSvc", "GetRepairQuotes"), false);
  assert.equal(isBridgeWritePair("map", "GetStationInfo"), false);
  // ⚠⚠ The GM console. Listed as a write for one reason: so the generic
  // /api/bridge/call route cannot become a second, UNCONFIRMED way to run
  // /giveitem, /npc or /suicide against the live world.
  assert.equal(isBridgeWritePair("slash", "SlashCmd"), true);
});

test("browser session projection retains only explicit language preferences", () => {
  assert.deepEqual(SAFE_BROWSER_SESSION_FIELDS, [
    "languageID",
    "languageId",
    "languageid",
    "language",
  ]);
  assert.deepEqual(
    pickSafeBrowserSessionFields({
      userid: 999,
      userName: "spoofed-admin",
      charid: 7,
      corporationID: 8,
      roles: Number.MAX_SAFE_INTEGER,
      stationid: 60003760,
      solarSystemID: 30000142,
      shipid: 9001,
      languageID: "EN",
      language: "en",
      languageId: { nested: "not a scalar" },
    }),
    { languageID: "EN", language: "en" },
  );
  assert.deepEqual(pickSafeBrowserSessionFields(null), {});
  assert.deepEqual(pickSafeBrowserSessionFields([]), {});
});
