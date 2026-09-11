"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBotHost, MAX_ENDED_RUNS } = require("./botHost");

// The host is exercised with a FAKE browser stack (the loadStack seam): the
// real one is the shipping web/src modules, proven live; these tests pin the
// host's own obligations — claims, refusals, lifecycle, release-on-end.

const IDLE_SLICE = Object.freeze({
  status: "idle",
  name: null,
  phase: null,
  why: null,
  stepPath: null,
  interruptID: null,
  pauseReason: null,
  note: null,
  startError: null,
});

// FleetCompanionState's shape (web/src/store/clientStore.ts) — deliberately
// missing stepPath/pauseReason/note/lastAlert, which IDLE_SLICE above has and
// the companion slice never will. See applySnapshot()'s comment in botHost.js.
const IDLE_COMPANION_SLICE = Object.freeze({
  status: "idle",
  phase: null,
  action: null,
  why: null,
  role: null,
  inFleet: null,
  followingOrderFrom: null,
  lastOrderHeard: null,
  canTag: null,
  abandonment: null,
  startedAt: null,
  startError: null,
  failureReason: null,
});

function makeFakeStack(log) {
  return async () => ({
    decodeScriptValue: (doc) =>
      doc && doc.valid === true
        ? { ok: true, doc, warnings: [] }
        : { ok: false, refusal: "That bot could not be read." },
    analyzeBotRunPolicy: (doc) => ({
      riskClasses: Array.isArray(doc.riskClasses) ? doc.riskClasses : [],
      restartSafe: doc.restartSafe !== false,
    }),
    validateBotLaunchGrant: (grant, scriptRev, policy) => {
      if (!grant || Number(grant.scriptRev) !== scriptRev) {
        return { ok: false, code: "BOT_GRANT_REQUIRED", message: "Review this run." };
      }
      if (
        !Array.isArray(grant.riskClasses) ||
        grant.riskClasses.length !== policy.riskClasses.length ||
        policy.riskClasses.some((risk) => !grant.riskClasses.includes(risk))
      ) {
        return { ok: false, code: "BOT_GRANT_STALE", message: "Permissions changed." };
      }
      return {
        ok: true,
        grant: {
          scriptRev,
          riskClasses: [...policy.riskClasses],
          maxRuntimeMinutes: Number(grant.maxRuntimeMinutes),
        },
      };
    },
    // The companion's own risk-derivation and codec door — a plain fake of
    // companionRunPolicy.ts, not the real module (that module is proven live
    // on its own; these tests pin the HOST's obligations around it).
    //
    // The sentinel is part of that module's contract too, so the fake carries
    // it the way the real stack does: the host reads the revision off the stack
    // rather than holding a second copy of a bare 1 of its own.
    COMPANION_GRANT_SCRIPT_REV: 1,
    // ⚠ AND THE ROLE LABELS FOR THE SAME REASON. `companionScriptName` reads
    // them off the stack rather than holding a second copy, so a fake stack
    // without them makes every companion start throw on `labels[role]` --
    // which is how this fake was found wanting when the labels moved.
    COMPANION_ROLE_LABELS: {
      dps: "DPS",
      logi: "Logistics",
      tackle: "Tackle",
      support: "Support",
    },
    analyzeCompanionRunPolicy: (request) => ({
      riskClasses:
        request && (request.useDrones === true || (request.defenseModuleIDs || []).length > 0)
          ? ["fleet", "social", "combat"]
          : ["fleet", "social"],
      restartSafe: true,
    }),
    decodeFleetCompanionRequestValue: (value) => {
      const KNOWN_ROLES = ["dps", "logi", "tackle", "support"];
      if (!value || typeof value !== "object" || !KNOWN_ROLES.includes(value.role)) {
        return { ok: false, refusal: "That companion setup could not be read." };
      }
      return { ok: true, request: value };
    },
    // Decision 5's persisted clock gets the same treatment as the request: a
    // plain fake of the real codec door, refusing anything without a usable
    // timestamp so the host's own DROP-don't-refuse behaviour can be pinned.
    decodeCompanionAbandonmentValue: (value) =>
      value && typeof value === "object" && Number.isSafeInteger(value.abandonedAtMs)
        ? {
            ok: true,
            abandonment: {
              abandonedAtMs: value.abandonedAtMs,
              supervisorCharacterIDs: Array.isArray(value.supervisorCharacterIDs)
                ? value.supervisorCharacterIDs
                : [],
            },
          }
        : { ok: false, refusal: "That saved supervision state could not be read." },
    createClientStore: () => {
      const listeners = new Set();
      const state = {
        station: { online: null },
        customBot: { ...IDLE_SLICE },
        companion: { ...IDLE_COMPANION_SLICE },
        flight: { status: null },
        space: { snapshot: null },
        mining: { holds: [] },
      };
      const store = {
        _set(partial) {
          Object.assign(state, partial);
          for (const listener of listeners) {
            listener(state);
          }
        },
        station: { get: () => state.station },
        customBot: { get: () => state.customBot },
        companion: { get: () => state.companion },
        flight: { get: () => state.flight },
        space: { get: () => state.space },
        mining: { get: () => state.mining },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      log.push(["_store", store]);
      return store;
    },
    createAppFlow: (store, options) => {
      log.push(["createAppFlow", options.baseUrl, options.perSessionToken, options.initialSessionToken]);
      return {
        async selectCharacter(characterID) {
          log.push(["selectCharacter", characterID]);
          store._set({ station: { online: { characterID, characterName: "Test Pilot" } } });
        },
        async startCustomBot(doc) {
          log.push(["startCustomBot", doc]);
          store._set({ customBot: { ...IDLE_SLICE, status: "running", phase: "Working" } });
        },
        stopCustomBot() {
          log.push(["stopCustomBot"]);
        },
        async startFleetCompanion(request, resuming = null) {
          log.push(["startFleetCompanion", request, resuming]);
          store._set({
            companion: { ...IDLE_COMPANION_SLICE, status: "running", phase: "Flying", role: request.role },
          });
        },
        stopFleetCompanion() {
          log.push(["stopFleetCompanion"]);
        },
        async logout() {
          log.push(["logout"]);
        },
        // The vitals sampler's reads: populate the slices like the real flow.
        async loadFlightStatus() {
          store._set({ flight: { status: { docked: false, stationID: null } } });
        },
        async loadSpaceSnapshot() {
          store._set({
            space: { snapshot: { ship: { shieldRatio: 0.9, armorRatio: 1, hullRatio: 1 } } },
          });
        },
        async loadMiningHolds() {
          store._set({
            mining: {
              holds: [
                { label: "Ore hold", present: true, capacity: { used: 6000, capacity: 8000 } },
                { label: "Fuel bay", present: false, capacity: null },
              ],
            },
          });
        },
      };
    },
  });
}

function makeHost({ log = [], isCharacterHeld = () => false, ...extras } = {}) {
  return createBotHost({
    webAuth: { createSessionToken: () => "bot-token" },
    baseUrl: "http://127.0.0.1:0",
    isCharacterHeld,
    errorLogger: () => {},
    loadStack: makeFakeStack(log),
    createClaimSecret: () => "private-claim-capability",
    ...extras,
  });
}

const ACCOUNT = { accountID: 7, username: "test" };
const START = {
  account: ACCOUNT,
  characterID: 140000001,
  scriptID: "s1",
  scriptName: "Miner",
  scriptRev: 1,
  doc: { valid: true },
  grant: { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 720 },
};

// A companion request has no revision series (see COMPANION_GRANT_SCRIPT_REV's
// comment in botHost.js) — its grant's `scriptRev` is always the sentinel `1`.
const COMPANION_REQUEST = Object.freeze({
  role: "dps",
  defenseModuleIDs: [],
  fleeHealthFloor: 0.3,
  capacitorFloor: 0.2,
  maxFleeAttempts: 3,
  useDrones: false,
  droneRedeployHoldOffSeconds: 10,
  attemptsTagging: false,
  obeys: ["broadcast", "tag"],
  chatCommandSenders: [],
});
const COMPANION_START = {
  account: ACCOUNT,
  characterID: 140000002,
  kind: "companion",
  request: COMPANION_REQUEST,
  grant: { scriptRev: 1, riskClasses: ["fleet", "social"], maxRuntimeMinutes: 720 },
};

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("start flies the character on its own session and lists it", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start(START);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.bot.status, "running");
  assert.equal(outcome.bot.characterName, "Test Pilot");
  assert.equal(host.claimedBy(140000001), outcome.bot.botID);
  const listed = host.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].botID, outcome.bot.botID);
  // Another account sees nothing.
  assert.equal(host.list(8).length, 0);
  // The flow was seeded with the minted token — no password ever crossed.
  const flowCall = log.find((row) => row[0] === "createAppFlow");
  assert.deepEqual(flowCall.slice(2), [true, "bot-token"]);
});

test("the approved runtime deadline stops, logs out, and releases the character claim", async () => {
  const log = [];
  let deadline = null;
  const host = makeHost({
    log,
    now: () => 1_000,
    setDeadlineTimeout(callback, delayMs) {
      deadline = { callback, delayMs, unref() {} };
      return deadline;
    },
    clearDeadlineTimeout() {},
  });

  const started = await host.start({
    ...START,
    grant: { ...START.grant, maxRuntimeMinutes: 30 },
  });
  assert.equal(started.ok, true);
  assert.ok(deadline);
  assert.equal(deadline.delayMs, 30 * 60_000);

  deadline.callback();
  await settle();

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /approved run time ended/i);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.ok(log.some(([name]) => name === "stopCustomBot"));
  assert.ok(log.some(([name]) => name === "logout"));
});

test("a second bot may not take a claimed character", async () => {
  const host = makeHost();
  assert.equal((await host.start(START)).ok, true);
  const second = await host.start(START);
  assert.equal(second.ok, false);
  assert.equal(second.code, "BOT_ALREADY_RUNNING");
});

test("only the private per-run capability authorizes a claimed character", async () => {
  const host = makeHost();
  const started = await host.start(START);
  assert.equal(started.ok, true);
  assert.equal(host.authorizesClaim(140000001, "private-claim-capability"), true);
  assert.equal(host.authorizesClaim(140000001, started.bot.botID), false, "the public bot ID is not authority");
  assert.equal(host.authorizesClaim(140000001, "bogus"), false);
  assert.equal(host.authorizesClaim(140000002, "private-claim-capability"), false);
});

test("a character a web session holds is refused", async () => {
  const host = makeHost({ isCharacterHeld: (characterID) => characterID === 140000001 });
  const outcome = await host.start(START);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "CHARACTER_IN_USE");
  assert.equal(host.claimedBy(140000001), null);
});

test("an undecodable doc is refused before any session exists", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start({ ...START, doc: { valid: false } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOTSCRIPT_INVALID");
  assert.equal(log.some((row) => row[0] === "selectCharacter"), false);
});

test("a server run requires an exact revision-and-risk grant", async () => {
  const host = makeHost();
  assert.equal((await host.start({ ...START, grant: null })).code, "BOT_GRANT_REQUIRED");
  assert.equal(
    (await host.start({ ...START, grant: { ...START.grant, scriptRev: 2 } })).code,
    "BOT_GRANT_REQUIRED",
  );
  const risky = { ...START, doc: { valid: true, riskClasses: ["financial"] } };
  assert.equal((await host.start(risky)).code, "BOT_GRANT_STALE");
  assert.equal(
    (
      await host.start({
        ...risky,
        grant: { scriptRev: 1, riskClasses: ["financial"], maxRuntimeMinutes: 30 },
      })
    ).ok,
    true,
  );
});

test("stop releases the claim and the character", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(START);
  const stopped = await host.stop(started.bot.botID, 7);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.bot.status, "stopped");
  assert.notEqual(stopped.bot.endedAt, null);
  assert.equal(host.claimedBy(140000001), null);
  assert.equal(log.some((row) => row[0] === "logout"), true);
  // The record remains listable for inspection.
  assert.equal(host.list(7).length, 1);
});

test("activeCharacterIDs names exactly the characters bots are flying", async () => {
  const host = makeHost();
  assert.deepEqual(host.activeCharacterIDs(), []);
  const started = await host.start(START);
  assert.deepEqual(host.activeCharacterIDs(), [140000001]);
  await host.stop(started.bot.botID, 7);
  assert.deepEqual(host.activeCharacterIDs(), []);
});

test("stop is scoped to the owning account", async () => {
  const host = makeHost();
  const started = await host.start(START);
  const outcome = await host.stop(started.bot.botID, 8);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOT_NOT_FOUND");
  assert.notEqual(host.claimedBy(140000001), null);
});

test("a script that ends on its own releases the character", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(START);
  const record = host.list(7)[0];
  assert.equal(record.status, "running");
  // The runner lets go: the store reports the terminal status.
  const store = lastStore(log);
  store._set({ customBot: { ...IDLE_SLICE, status: "stopped", phase: "Done" } });
  await settle();
  assert.equal(host.claimedBy(140000001), null);
  assert.equal(log.some((row) => row[0] === "logout"), true);
  const after = host.list(7)[0];
  assert.equal(after.botID, started.bot.botID);
  assert.equal(after.status, "stopped");
  assert.notEqual(after.endedAt, null);
});

test("a fresh start on the character keeps the finished record — the ring replaces per-character pruning", async () => {
  const host = makeHost();
  const first = await host.start(START);
  await host.stop(first.bot.botID, 7);
  const second = await host.start(START);
  assert.equal(second.ok, true);
  const listed = host.list(7);
  assert.equal(listed.length, 2, "the finished run must not be dropped just because the character restarted");
  assert.ok(listed.some((row) => row.botID === first.bot.botID && row.status === "stopped"));
  assert.ok(listed.some((row) => row.botID === second.bot.botID && row.status === "running"));
});

// The fake stack hands each start a fresh store; tests that poke the store
// after start need the one the LAST start used. Cheapest honest way: capture
// it off the subscribe seam — the host subscribes exactly once per start.
function lastStore(log) {
  const call = [...log].reverse().find((row) => row[0] === "_store");
  assert.notEqual(call, undefined, "no store was captured — did start() succeed?");
  return call[1];
}

// ── Durability: the running roster survives a restart ───────────────────────

function tempRosterPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-host-")), "server-bots.json");
}

function readRosterFile(rosterPath) {
  return JSON.parse(fs.readFileSync(rosterPath, "utf8")).bots;
}

test("the running roster is mirrored to disk and cleared when the bot ends", async () => {
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  const started = await host.start(START);
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    kind: "script",
    accountID: 7,
    username: "test",
    characterID: 140000001,
    scriptID: "s1",
    scriptName: "Miner",
    scriptRev: 1,
    scriptHash: started.bot.scriptHash,
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 720,
    expiresAt: started.bot.expiresAt,
    startedAt: started.bot.startedAt,
  });
  assert.match(persisted[0].scriptHash, /^[a-f0-9]{64}$/);
  await host.stop(started.bot.botID, 7);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("resume restarts a persisted bot on a fresh host (the restart path)", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  // "The BFF restarted": a brand-new host, same file, no in-memory state.
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    loadScript: (scriptID) =>
      scriptID === "s1" ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } } : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000001), listed[0].botID);
  // The file now names the NEW run.
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].startedAt, listed[0].startedAt);
});

test("resume looks up the script by ID alone — authorship is not account-scoped", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  // The saved bot library is platform-wide: this script's record was authored
  // by a DIFFERENT account (99) than the one flying it (7, from ACCOUNT/START).
  // loadScript takes scriptID alone and must not be asked to filter by account.
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    loadScript: (scriptID) =>
      scriptID === "s1"
        ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true }, authorAccountID: 99 }
        : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "running");
  // Authority over the running bot stays with the flying account (7), not the
  // script's author (99): visible to 7, invisible and unstoppable by 99.
  assert.equal(after.list(99).length, 0);
  const stoppedByAuthor = await after.stop(listed[0].botID, 99);
  assert.equal(stoppedByAuthor.ok, false);
  assert.equal(stoppedByAuthor.code, "BOT_NOT_FOUND");
  assert.notEqual(after.claimedBy(140000001), null);
});

test("resume refuses a script whose saved revision changed after launch", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 2, doc: { valid: true, edited: true } }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /changed after this run was authorized/i);
  assert.equal(after.claimedBy(140000001), null);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("resume never replays a consequential script without a fresh start", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start({
    ...START,
    doc: { valid: true, restartSafe: false, riskClasses: ["financial"] },
    grant: { ...START.grant, riskClasses: ["financial"] },
  });
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({
      scriptID: "s1",
      name: "Miner",
      rev: 1,
      doc: { valid: true, restartSafe: false, riskClasses: ["financial"] },
    }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /consequential action/i);
  assert.equal(after.claimedBy(140000001), null);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("legacy unpinned roster rows require a manual start", async () => {
  const rosterPath = tempRosterPath();
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      version: 1,
      bots: [
        {
          accountID: 7,
          username: "test",
          characterID: 140000001,
          scriptID: "s1",
          scriptName: "Miner",
          startedAt: new Date().toISOString(),
        },
      ],
    }),
    "utf8",
  );
  const host = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } }),
  });
  await host.resume();
  const [row] = host.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /no pinned script revision/i);
  assert.equal(host.claimedBy(140000001), null);
});

test("an on-disk roster row with no `kind` field resumes exactly as a script always has", async () => {
  // A real pre-existing roster file, written by a version of this module that
  // had no `kind` field at all — the compatibility requirement decision 3
  // (docs/fleet-companion-handoff.md) names explicitly: an old row must still
  // resume exactly as it does today, not be refused for the field it lacks.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  for (const row of raw.bots) {
    delete row.kind;
  }
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: (scriptID) =>
      scriptID === "s1" ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } } : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "script");
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000001), listed[0].botID);
});

test("vitals sampling projects ship health, hold fill and the bot's words", async () => {
  const host = makeHost();
  await host.start(START);
  await host.sampleAllVitals();
  const rows = host.activeBots();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].characterID, 140000001);
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].phase, "Working");
  const vitals = rows[0].vitals;
  assert.equal(vitals.docked, false);
  assert.equal(vitals.shield, 0.9);
  assert.equal(vitals.armor, 1);
  assert.equal(vitals.hull, 1);
  // Only PRESENT holds are reported.
  assert.deepEqual(vitals.holds, [{ label: "Ore hold", used: 6000, capacity: 8000 }]);
  // Nothing controllable or identifying rides on the unauthenticated rows.
  assert.equal("botID" in rows[0], false);
  assert.equal("accountID" in rows[0], false);
  assert.equal("scriptID" in rows[0], false);
});

test("a bot whose script vanished leaves a visible error record, not silence", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "error");
  assert.match(String(listed[0].why), /restarted/);
  assert.equal(after.claimedBy(140000001), null);
  // The failure is dropped from the roster file — it must not retry forever.
  assert.equal(readRosterFile(rosterPath).length, 0);
});

// A server bot has no browser to notify, so the "alert me" watch reaches the
// player ONLY through the record -> /api/bots -> the Server Bots readout. These
// pin that path, including that a later progress tick cannot erase an alert the
// player has not seen yet.

test("an alert on the store slice lands on the bot record and on the public row", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(START);
  const store = lastStore(log);
  assert.equal(host.list(7)[0].lastAlert, null, "no alert before one fires");

  store._set({
    customBot: {
      ...IDLE_SLICE,
      status: "running",
      phase: "Working",
      lastAlert: { message: "Your bot noticed: another player locks onto your ship.", atMs: 1_700_000_000_000 },
    },
  });
  await settle();

  const row = host.list(7)[0];
  assert.deepEqual(row.lastAlert, {
    message: "Your bot noticed: another player locks onto your ship.",
    atMs: 1_700_000_000_000,
  });
});

test("a later progress tick with no alert does NOT clear one already recorded", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(START);
  const store = lastStore(log);
  store._set({
    customBot: { ...IDLE_SLICE, status: "running", lastAlert: { message: "Trouble.", atMs: 5 } },
  });
  await settle();
  // The next ordinary tick carries no alert at all (the slice is rebuilt).
  store._set({ customBot: { ...IDLE_SLICE, status: "running", phase: "Mining" } });
  await settle();
  const row = host.list(7)[0];
  assert.equal(row.lastAlert && row.lastAlert.message, "Trouble.", "an unseen alert must not be erased");
  assert.equal(row.phase, "Mining", "while the rest of the readout still updates");
});

// ── The ended-run ring (M4: a bounded memory-only history, not a log) ──────

test("more than MAX_ENDED_RUNS ended runs keeps exactly MAX_ENDED_RUNS, evicting the oldest first", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });
  const botIDs = [];
  for (let i = 0; i < MAX_ENDED_RUNS + 5; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_100_000 + i });
    const stopped = await host.stop(started.bot.botID, 7);
    botIDs.push(stopped.bot.botID);
  }
  const listed = host.list(7);
  assert.equal(listed.length, MAX_ENDED_RUNS);
  const survivingIDs = new Set(listed.map((row) => row.botID));
  for (let i = 0; i < 5; i++) {
    assert.equal(survivingIDs.has(botIDs[i]), false, `run ${i} (the oldest) should have aged out`);
  }
  for (let i = 5; i < botIDs.length; i++) {
    assert.equal(survivingIDs.has(botIDs[i]), true, `run ${i} should still be in the ring`);
  }
});

test("eviction picks the globally oldest endedAt, not the oldest by start (Map insertion) order", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });

  // This bot STARTS first (first into the records Map) but is stopped LAST,
  // so it ends up with the NEWEST endedAt of anyone here. If eviction ever
  // regressed to Map/insertion order it would pick this one to evict; sorting
  // by endedAt must spare it instead.
  clock.value = 0;
  const lateFinisher = await host.start({ ...START, characterID: 900_150_000 });
  assert.equal(lateFinisher.ok, true);

  // Fill the ring to capacity with runs that both start AND end after
  // lateFinisher started, but whose endedAt values are all earlier than the
  // one lateFinisher will get.
  let oldestBotID = null;
  for (let i = 0; i < MAX_ENDED_RUNS; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_150_001 + i });
    const stopped = await host.stop(started.bot.botID, 7);
    if (i === 0) {
      oldestBotID = stopped.bot.botID;
    }
  }

  // Now finalize lateFinisher with the largest endedAt of the batch — its
  // finish pushes the ended count past the cap and forces an eviction.
  clock.value = 1000;
  await host.stop(lateFinisher.bot.botID, 7);

  const listed = host.list(7);
  assert.equal(listed.length, MAX_ENDED_RUNS);
  const survivingIDs = new Set(listed.map((row) => row.botID));
  assert.equal(survivingIDs.has(oldestBotID), false, "the run with the oldest endedAt is evicted");
  assert.equal(
    survivingIDs.has(lateFinisher.bot.botID),
    true,
    "the run that started earliest but ENDED latest must survive",
  );
});

test("a running bot is never evicted, even once the ring is full", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });
  for (let i = 0; i < MAX_ENDED_RUNS; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_200_000 + i });
    await host.stop(started.bot.botID, 7);
  }
  assert.equal(host.list(7).length, MAX_ENDED_RUNS);

  clock.value = 1000;
  const running = await host.start({ ...START, characterID: 900_299_000 });
  assert.equal(running.ok, true);

  // One more finalized run pushes the ended count past the cap, forcing an
  // eviction while `running` is still in flight.
  clock.value = 1001;
  const another = await host.start({ ...START, characterID: 900_299_001 });
  await host.stop(another.bot.botID, 7);

  const listed = host.list(7);
  const runningRows = listed.filter((row) => row.status === "running");
  const endedRows = listed.filter((row) => row.status !== "running");
  assert.equal(runningRows.length, 1);
  assert.equal(runningRows[0].botID, running.bot.botID, "the ring's cap never touches a running record");
  assert.equal(endedRows.length, MAX_ENDED_RUNS, "the ended-only ring still holds exactly the cap");
});

test("two ended runs for the SAME character both survive (the old one-per-character rule would have dropped one)", async () => {
  const host = makeHost();
  const first = await host.start(START);
  await host.stop(first.bot.botID, 7);
  const second = await host.start(START);
  await host.stop(second.bot.botID, 7);
  const listed = host.list(7);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((row) => row.botID === first.bot.botID && row.status === "stopped"));
  assert.ok(listed.some((row) => row.botID === second.bot.botID && row.status === "stopped"));
});

test("list(accountID) stays account-filtered, ended runs included", async () => {
  const host = makeHost();
  const ownedByOwner = await host.start(START);
  await host.stop(ownedByOwner.bot.botID, 7);
  const other = { accountID: 8, username: "other" };
  const ownedByOther = await host.start({ ...START, account: other, characterID: 140_099_999 });
  await host.stop(ownedByOther.bot.botID, 8);

  const ownerRows = host.list(7);
  assert.equal(ownerRows.length, 1);
  assert.equal(ownerRows[0].botID, ownedByOwner.bot.botID);

  const otherRows = host.list(8);
  assert.equal(otherRows.length, 1);
  assert.equal(otherRows[0].botID, ownedByOther.bot.botID);
});

// ── Fleet companion (kind: "companion") ──────────────────────────────────────
// A companion has no saved-script library entry: its request travels with the
// start call, or (on resume) IS the persisted roster row itself — see
// persistRoster's comment in botHost.js. These pin the kind branch through
// start(), persistRoster(), resume(), applySnapshot(), and the two-switch stop
// distinction (stopFleetCompanion vs stopCustomBot) in stop()/finalize().

test("a companion flies on its own session, through startFleetCompanion, never startCustomBot", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start(COMPANION_START);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.bot.kind, "companion");
  assert.equal(outcome.bot.status, "running");
  // Reused roster slots (docs/fleet-companion-handoff.md, "3. Extend
  // botHost"): a fixed scriptID literal (no library entry exists to name),
  // and a scriptName derived from the request's role.
  assert.equal(outcome.bot.scriptID, "companion");
  assert.equal(outcome.bot.scriptName, "Fleet companion (DPS)");
  assert.ok(log.some((row) => row[0] === "startFleetCompanion"));
  assert.equal(log.some((row) => row[0] === "startCustomBot"), false);
});

test("stopping a companion calls stopFleetCompanion, never stopCustomBot", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(COMPANION_START);
  const stopped = await host.stop(started.bot.botID, 7);
  assert.equal(stopped.ok, true);
  assert.ok(log.some((row) => row[0] === "stopFleetCompanion"), "the companion's own stop switch must fire");
  assert.equal(log.some((row) => row[0] === "stopCustomBot"), false, "the wrong switch is a silent no-op");
  assert.equal(host.claimedBy(140000002), null);
});

test("a companion that ends on its own (the companion slice, not customBot) releases the character", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({ companion: { ...IDLE_COMPANION_SLICE, status: "stopped", why: "Fleet gone." } });
  await settle();
  assert.equal(host.claimedBy(140000002), null);
  assert.ok(log.some((row) => row[0] === "logout"));
  const after = host.list(7)[0];
  assert.equal(after.status, "stopped");
  assert.equal(after.why, "Fleet gone.");
});

test("a companion's progress maps status/phase/why honestly, and leaves script-shaped fields null", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({
    companion: {
      ...IDLE_COMPANION_SLICE,
      status: "running",
      phase: "Escorting",
      action: "wait",
      why: "Waiting on the fleet.",
      role: "dps",
    },
  });
  await settle();
  const row = host.list(7)[0];
  assert.equal(row.status, "running");
  assert.equal(row.phase, "Escorting");
  assert.equal(row.why, "Waiting on the fleet.");
  // FleetCompanionState (web/src/store/clientStore.ts) has no stepPath,
  // pauseReason, or note — applySnapshot() must leave these at their initial
  // null rather than inventing a value for a column the companion has no
  // honest answer to.
  assert.equal(row.stepPath, null);
  assert.equal(row.pauseReason, null);
  assert.equal(row.note, null);
});

test("the persisted roster row for a companion carries kind, the flat request, and its hash — not a script doc", async () => {
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  const started = await host.start(COMPANION_START);
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].kind, "companion");
  assert.equal(persisted[0].scriptID, "companion");
  assert.equal(persisted[0].scriptName, "Fleet companion (DPS)");
  // A companion request has no revision series — this is the sentinel
  // COMPANION_GRANT_SCRIPT_REV, never a real revision (see its comment).
  assert.equal(persisted[0].scriptRev, 1);
  assert.deepEqual(persisted[0].request, COMPANION_REQUEST);
  assert.match(persisted[0].scriptHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted[0].scriptHash, started.bot.scriptHash);
  assert.deepEqual(persisted[0].riskClasses, ["fleet", "social"]);
});

test("resume rebuilds a companion from its persisted request alone — no library lookup", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    // A companion resume must never consult the saved-script library — there
    // is nothing there for it to find.
    loadScript: () => {
      throw new Error("a companion resume must not look up a saved script");
    },
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "companion");
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000002), listed[0].botID);
});

test("resume refuses a persisted companion request that no longer decodes", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  raw.bots[0].request = { role: "not-a-real-role" };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /restarted/);
  assert.equal(after.claimedBy(140000002), null);
  // The failure is dropped from the roster file — it must not retry forever.
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("an undecodable companion request is refused before any session exists", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start({ ...COMPANION_START, request: { role: "not-a-real-role" } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOTCOMPANION_INVALID");
  assert.equal(log.some((row) => row[0] === "selectCharacter"), false);
});

test("a companion whose persisted request re-derives DIFFERENT risk classes than its grant is refused on resume", async () => {
  // The check decision 4 says must still earn its place: re-derive risk
  // classes from the persisted request (never trust the stored riskClasses
  // column) and compare against what the grant carries via
  // validateBotLaunchGrant — unchanged.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  // The request on disk now asks for drones — analyzeCompanionRunPolicy would
  // add "combat" — but the persisted grant's riskClasses were pinned to the
  // ORIGINAL (drone-less) request and were never updated to match.
  raw.bots[0].request = { ...COMPANION_REQUEST, useDrones: true };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /restarted/);
  assert.equal(after.claimedBy(140000002), null);
});

// ── Decision 5: the abandonment clock is durable ────────────────────────────
//
// A companion with nobody in its fleet this host is not flying gets safe, drops
// fleet and waits a bounded thirty minutes before releasing the hull. The bound
// is only a bound if its start time outlives a restart — otherwise every
// restart hands it a fresh thirty minutes, which is an unbounded wait assembled
// out of bounded ones.

const ABANDONED = Object.freeze({ abandonedAtMs: 1_700_000_000_000, supervisorCharacterIDs: [90000001] });

test("an abandonment pushed by the companion loop is written into the roster row", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  assert.equal(readRosterFile(rosterPath)[0].abandonment, null);
  lastStore(log)._set({
    companion: {
      ...IDLE_COMPANION_SLICE,
      status: "running",
      phase: "Abandoned",
      abandonment: ABANDONED,
    },
  });
  assert.deepEqual(readRosterFile(rosterPath)[0].abandonment, ABANDONED);
});

test("the roster is NOT rewritten on every tick — only when the abandonment changes", async () => {
  // applySnapshot runs on every store push, roughly once every two seconds per
  // bot. An abandonment changes at most twice in a run, so the write is gated
  // on a real change rather than on the push.
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  const running = { ...IDLE_COMPANION_SLICE, status: "running", phase: "Abandoned", abandonment: ABANDONED };
  store._set({ companion: running });
  const afterFirst = fs.statSync(rosterPath).mtimeMs;
  for (let tick = 0; tick < 5; tick += 1) {
    store._set({ companion: { ...running, why: `tick ${tick}` } });
  }
  assert.equal(fs.statSync(rosterPath).mtimeMs, afterFirst);
});

test("supervision returning clears the persisted clock too", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({
    companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: ABANDONED },
  });
  assert.notEqual(readRosterFile(rosterPath)[0].abandonment, null);
  store._set({ companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: null } });
  assert.equal(readRosterFile(rosterPath)[0].abandonment, null);
});

test("resume hands the ORIGINAL clock back to the loop, not a fresh one", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const before = makeHost({ log, persistPath: rosterPath });
  await before.start(COMPANION_START);
  lastStore(log)._set({
    companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: ABANDONED },
  });

  const resumeLog = [];
  const after = makeHost({
    log: resumeLog,
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
  });
  await after.resume();
  const call = resumeLog.find((row) => row[0] === "startFleetCompanion");
  assert.notEqual(call, undefined);
  assert.deepEqual(call[2], ABANDONED, "the resumed run must continue the same thirty minutes");
});

test("an undecodable persisted clock is DROPPED, never fatal to the start", async () => {
  // A row that cannot be trusted starts a fresh thirty minutes, which is still
  // bounded and still safe. Refusing the whole start would instead leave a
  // pilot flying with no host to stop it.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  raw.bots[0].abandonment = { abandonedAtMs: "the other day" };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const resumeLog = [];
  const after = makeHost({
    log: resumeLog,
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
  });
  await after.resume();
  assert.equal(after.list(7).length, 1, "the companion must still come back");
  const call = resumeLog.find((row) => row[0] === "startFleetCompanion");
  assert.equal(call[2], null);
});

test("a script row never grows an abandonment field", async () => {
  // It is companion-shaped state; a script has no supervision gate at all.
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  await host.start(START);
  assert.equal("abandonment" in readRosterFile(rosterPath)[0], false);
});
