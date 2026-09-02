"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBotHost } = require("./botHost");

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
    createClientStore: () => {
      const listeners = new Set();
      const state = {
        station: { online: null },
        customBot: { ...IDLE_SLICE },
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

test("a fresh start on the character replaces the finished record", async () => {
  const host = makeHost();
  const first = await host.start(START);
  await host.stop(first.bot.botID, 7);
  const second = await host.start(START);
  assert.equal(second.ok, true);
  const listed = host.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].botID, second.bot.botID);
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
