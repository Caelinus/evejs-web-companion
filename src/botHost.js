"use strict";

// ── Server-side bot host ─────────────────────────────────────────────────────
//
// Bots used to run ENTIRELY in the browser tab that started them: the tab
// closes (or a phone locks its screen) and the ship sits. This module runs the
// SAME bot stack — clientStore + appFlow + scriptRunner, imported unchanged
// from web/src via Node's TypeScript type-stripping — inside the BFF process,
// driving the BFF's own HTTP surface over loopback. The browser becomes a
// remote control: start/stop/inspect from any device, and disconnecting
// changes nothing.
//
// Architecturally a server bot is just ANOTHER SESSION (the R107 multibox
// work): its flow holds its own session token, its select lands in the same
// bridgeSessions map as a tab's, and every world call goes through the same
// audited routes. Nothing here talks to the gateway directly.
//
// AUTHENTICATION — no password crosses this module. The bot-start route runs
// under requireAuth, so the caller has already proven they hold the account;
// the host mints a fresh session token for the bot IN-PROCESS (webAuth) and
// seeds it into the flow via `initialSessionToken`. If /api/login ever grows a
// real password check, nothing here breaks.
//
// ONE HULL, ONE DRIVER. Starting a bot on a character any live web session is
// flying is refused (CHARACTER_IN_USE), and while a bot holds a character the
// /api/bridge/select guard refuses tabs (CHARACTER_IN_USE_BY_BOT) — the bot's
// own select passes because its fetch carries `x-evejs-bot-id`. The claim is
// registered synchronously BEFORE the first await so concurrent starts cannot
// both win.
//
// LIFECYCLE. A bot ends when its script finishes, hits an error, loses its
// session, or is stopped; ending always releases the character (logout), so
// the hull is immediately flyable from a tab. Finished records stay listable
// until the next bot starts on that character.
//
// DURABLE ACROSS RESTARTS. The RUNNING roster (who/what, never a token) is
// mirrored to `persistPath` on every start and end. The immutable script
// revision/hash and its restart policy are pinned with that row. `resume()` may
// start at step one ONLY when the exact saved revision still exists and every
// block is observed-state/restart-safe. A costly, destructive, social, or
// otherwise non-idempotent script stops visibly and waits for a fresh player
// start instead of replaying intent after a crash.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// An unguessable per-run claim capability. The public botID is deliberately NOT
// accepted by the select guard: account-scoped bot listings expose bot IDs, so
// using one as authority would let an ordinary browser impersonate the host.
const BOT_HEADER = "x-evejs-bot-claim";

// Terminal customBot-slice statuses: the runner has let go of the ship.
const ENDED_STATUSES = new Set(["stopped", "error", "idle"]);

// How often each running bot's ship vitals are sampled for the landing-page
// readout. Plain reads through the bot's own flow — the same polls an open
// tab would be making — never a world call.
const VITALS_SAMPLE_MS = 15_000;

// The browser stack, imported once per process and shared by every bot. Kept
// lazy so `require("./botHost")` stays cheap and the BFF boots even if the
// web sources are absent (the routes then fail per-start, not at boot).
let stackPromise = null;
function defaultLoadStack() {
  if (stackPromise === null) {
    const webSrc = path.resolve(__dirname, "..", "web", "src");
    const webUrl = (rel) => pathToFileURL(path.join(webSrc, rel)).href;
    stackPromise = (async () => {
      const [sessionToken, clientStore, flow, codec, runPolicy] = await Promise.all([
        import(webUrl("app/sessionToken.ts")),
        import(webUrl("store/clientStore.ts")),
        import(webUrl("app/flow.ts")),
        import(webUrl("bots/scriptCodec.ts")),
        import(webUrl("bots/runPolicy.ts")),
      ]);
      // The server has no sessionStorage; force the in-memory fallback. Bots
      // never use the global token anyway (perSessionToken), but the module
      // must not touch a browser API on import of anything else.
      sessionToken.setSessionTokenStorage(null);
      return {
        createClientStore: clientStore.createClientStore,
        createAppFlow: flow.createAppFlow,
        decodeScriptValue: codec.decodeScriptValue,
        analyzeBotRunPolicy: runPolicy.analyzeBotRunPolicy,
        validateBotLaunchGrant: runPolicy.validateBotLaunchGrant,
      };
    })();
    stackPromise.catch(() => {
      stackPromise = null; // a failed load may be retried on the next start
    });
  }
  return stackPromise;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashScript(doc) {
  return crypto.createHash("sha256").update(stableJson(doc), "utf8").digest("hex");
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) {
    return false;
  }
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The flow opens a live-event channel after select; a headless bot does not
// need push (every bridge response still carries its notification drain), so
// it gets a channel that is never live.
function stubEventSource() {
  return { close() {}, addEventListener() {}, removeEventListener() {} };
}

function createBotHost(options) {
  const auth = options.webAuth;
  const baseUrl = options.baseUrl;
  // Injected from server.js: is ANY held bridge session flying this character?
  const isCharacterHeld = options.isCharacterHeld || (() => false);
  const logError = options.errorLogger || (() => {});
  const loadStack = options.loadStack || defaultLoadStack;
  const createClaimSecret = options.createClaimSecret || (() => crypto.randomBytes(32).toString("base64url"));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setDeadlineTimeout = options.setDeadlineTimeout || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearDeadlineTimeout = options.clearDeadlineTimeout || ((timer) => clearTimeout(timer));
  const nowISO = () => new Date(now()).toISOString();
  // Durability: where the running roster is mirrored (absent = memory-only),
  // and the reads resume() needs to rebuild a bot from its persisted row.
  const persistPath = options.persistPath || null;
  const loadAccount = options.loadAccount || (async () => null);
  // The saved-script library is platform-wide: any account's characters may
  // run any account's script. `loadScript(scriptID) -> Record | null` looks a
  // script up by ID alone — it does NOT check who authored it. Authority over
  // characters and running bots stays account-scoped elsewhere in this file
  // (claims, list(), stop()); only the script lookup is global.
  const loadScript = options.loadScript || (() => null);

  /** botID -> record, running and ended alike (ended pruned per character). */
  const records = new Map();
  /** characterID -> botID for RUNNING bots only — the claim the guards read. */
  const claims = new Map();

  // Mirror the RUNNING roster to disk (atomic tmp+rename, like webAuth's
  // stores). No token, claim capability, or doc is persisted. The revision and
  // canonical hash bind a restart to the exact document the player launched.
  function persistRoster() {
    if (persistPath === null) {
      return;
    }
    try {
      const bots = [];
      for (const record of records.values()) {
        if (!record.finalized) {
          bots.push({
            accountID: record.accountID,
            username: record.username,
            characterID: record.characterID,
            scriptID: record.scriptID,
            scriptName: record.scriptName,
            scriptRev: record.scriptRev,
            scriptHash: record.scriptHash,
            restartSafe: record.restartSafe,
            riskClasses: record.riskClasses,
            maxRuntimeMinutes: record.maxRuntimeMinutes,
            expiresAt: record.expiresAt,
            startedAt: record.startedAt,
          });
        }
      }
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tempPath = `${persistPath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 2, bots }, null, 2), "utf8");
      fs.renameSync(tempPath, persistPath);
    } catch (error) {
      logError(error);
    }
  }

  function readRoster() {
    if (persistPath === null) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      return Array.isArray(parsed && parsed.bots) ? parsed.bots : [];
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        logError(error);
      }
      return [];
    }
  }

  function publicBot(record) {
    return {
      botID: record.botID,
      accountID: record.accountID,
      characterID: record.characterID,
      characterName: record.characterName,
      resumedAt: record.resumedAt,
      vitals: record.vitals,
      scriptID: record.scriptID,
      scriptName: record.scriptName,
      scriptRev: record.scriptRev,
      scriptHash: record.scriptHash,
      restartSafe: record.restartSafe,
      riskClasses: record.riskClasses,
      maxRuntimeMinutes: record.maxRuntimeMinutes,
      expiresAt: record.expiresAt,
      status: record.status,
      phase: record.phase,
      why: record.why,
      stepPath: record.stepPath,
      pauseReason: record.pauseReason,
      note: record.note,
      lastAlert: record.lastAlert,
      startError: record.startError,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    };
  }

  // Fold the store's customBot slice into the record — same words the in-tab
  // readout shows, so the phone and a tab never tell different stories.
  //
  // ⚠ `lastAlert` is the reason an "alert me" watch is worth anything on a server
  // bot: the bot runs in THIS process with no browser to notify, so the alert's
  // only route to the player is the record → /api/bots → the Server Bots readout.
  // It is never cleared here — an alert a player has not seen yet must not be
  // erased by the next progress tick.
  function applySnapshot(record, snapshot) {
    record.status = snapshot.status;
    record.phase = snapshot.phase;
    record.why = snapshot.why;
    record.stepPath = snapshot.stepPath;
    record.pauseReason = snapshot.pauseReason;
    record.note = snapshot.note;
    record.startError = snapshot.startError ?? null;
    if (snapshot.lastAlert) {
      record.lastAlert = { message: String(snapshot.lastAlert.message), atMs: Number(snapshot.lastAlert.atMs) };
    }
  }

  // End of a run, from EITHER side (script finished/errored, or stop()):
  // release the claim and the character. Idempotent — the store subscription
  // and an explicit stop can both land here.
  async function finalize(record) {
    if (record.finalized) {
      return;
    }
    record.finalized = true;
    record.endedAt = nowISO();
    if (record.deadlineTimer) {
      clearDeadlineTimeout(record.deadlineTimer);
      record.deadlineTimer = null;
    }
    if (record.unsubscribe) {
      try {
        record.unsubscribe();
      } catch {}
      record.unsubscribe = null;
    }
    if (claims.get(record.characterID) === record.botID) {
      claims.delete(record.characterID);
    }
    // The roster on disk must stop naming this bot BEFORE the slow logout —
    // a crash mid-teardown must not resurrect a bot that already ended.
    persistRoster();
    const flow = record.flow;
    record.flow = null;
    record.store = null;
    if (flow) {
      try {
        flow.stopCustomBot();
      } catch {}
      try {
        // Releases the bridge session — the character goes offline and the
        // hull is immediately available to a tab.
        await flow.logout();
      } catch (error) {
        logError(error);
      }
    }
  }

  async function start({
    account,
    characterID,
    scriptID,
    scriptName,
    scriptRev,
    doc,
    grant,
    resumed = false,
    expectedScriptRev = null,
    expectedScriptHash = null,
    expectedExpiresAt = null,
  }) {
    let stack;
    try {
      stack = await loadStack();
    } catch (error) {
      logError(error);
      return { ok: false, code: "BOT_STACK_UNAVAILABLE", message: "The server could not load the bot engine." };
    }

    // A stored bot doc is untrusted bytes like any other; the codec is the door.
    const decoded = stack.decodeScriptValue(doc);
    if (!decoded.ok) {
      return { ok: false, code: "BOTSCRIPT_INVALID", message: decoded.refusal };
    }
    const normalizedRev = Number(scriptRev);
    if (!Number.isSafeInteger(normalizedRev) || normalizedRev <= 0) {
      return { ok: false, code: "BOTSCRIPT_REVISION_REQUIRED", message: "The saved bot revision is missing." };
    }
    const normalizedHash = hashScript(decoded.doc);
    if (
      expectedScriptRev !== null &&
      (normalizedRev !== Number(expectedScriptRev) || normalizedHash !== String(expectedScriptHash || ""))
    ) {
      return {
        ok: false,
        code: "BOT_SCRIPT_CHANGED",
        message: "The saved bot changed after this run was authorized. Start it again to review the new version.",
      };
    }
    const runPolicy = stack.analyzeBotRunPolicy(decoded.doc);
    if (runPolicy.containsSubBots) {
      return {
        ok: false,
        code: "BOT_SUBBOT_GRANT_UNAVAILABLE",
        message: "A server bot cannot yet grant permissions to included saved bots. Inline them before starting this run.",
      };
    }
    const grantVerdict = stack.validateBotLaunchGrant(grant, normalizedRev, runPolicy);
    if (!grantVerdict.ok) {
      return { ok: false, code: grantVerdict.code, message: grantVerdict.message };
    }
    if (resumed && !runPolicy.restartSafe) {
      return {
        ok: false,
        code: "BOT_RESTART_REQUIRES_CONFIRMATION",
        message: "This bot can repeat a consequential action, so it was not restarted automatically. Review and start it again.",
      };
    }
    const expiresAt =
      expectedExpiresAt === null
        ? new Date(now() + grantVerdict.grant.maxRuntimeMinutes * 60_000).toISOString()
        : String(expectedExpiresAt);
    const deadlineMs = Date.parse(expiresAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now()) {
      return {
        ok: false,
        code: "BOT_GRANT_EXPIRED",
        message: "This bot's approved run time has ended. Review and start it again.",
      };
    }

    if (claims.has(characterID)) {
      return { ok: false, code: "BOT_ALREADY_RUNNING", message: "A server bot is already flying this character." };
    }
    if (isCharacterHeld(characterID)) {
      return {
        ok: false,
        code: "CHARACTER_IN_USE",
        message: "A web session is flying this character. Log it out (or wait for it to expire), then start the bot.",
      };
    }

    const botID = crypto.randomUUID();
    const record = {
      botID,
      accountID: Number(account.accountID),
      username: String(account.username || ""),
      characterID,
      characterName: null,
      scriptID,
      scriptName,
      scriptRev: normalizedRev,
      scriptHash: normalizedHash,
      restartSafe: runPolicy.restartSafe === true,
      riskClasses: [...runPolicy.riskClasses],
      maxRuntimeMinutes: grantVerdict.grant.maxRuntimeMinutes,
      expiresAt,
      resumedAt: resumed ? nowISO() : null,
      vitals: null,
      status: "starting",
      phase: null,
      why: null,
      stepPath: null,
      pauseReason: null,
      note: null,
      lastAlert: null,
      startError: null,
      startedAt: nowISO(),
      endedAt: null,
      finalized: false,
      flow: null,
      store: null,
      unsubscribe: null,
      claimSecret: createClaimSecret(),
      deadlineTimer: null,
    };
    // Claim BEFORE the first await — two concurrent starts must not both win,
    // and the select guard must already know this bot when its select arrives.
    claims.set(characterID, botID);
    // One retained record per character: starting anew drops the old story.
    for (const [id, old] of records) {
      if (old.characterID === characterID && old.finalized) {
        records.delete(id);
      }
    }
    records.set(botID, record);

    try {
      const token = auth.createSessionToken(account);
      const store = stack.createClientStore();
      // Same fetch the server itself trusts, plus the bot's name on every
      // request so the select guard can tell the bot's own select from a tab's.
      const botFetch = (input, init) => {
        const headers = new Headers(init && init.headers);
        headers.set(BOT_HEADER, record.claimSecret);
        return globalThis.fetch(input, { ...init, headers });
      };
      const flow = stack.createAppFlow(store, {
        baseUrl,
        fetch: botFetch,
        perSessionToken: true,
        initialSessionToken: token,
        eventSource: stubEventSource,
      });
      record.flow = flow;
      record.store = store;

      await flow.selectCharacter(characterID);
      const online = store.station.get().online;
      record.characterName = online ? online.characterName : null;

      // The readout is store-driven exactly like the in-tab panel: project the
      // customBot slice onto the record, and treat the runner letting go of
      // the ship as the end of the bot.
      let sawRunning = false;
      record.unsubscribe = store.subscribe((state) => {
        applySnapshot(record, state.customBot);
        if (state.customBot.status === "running" || state.customBot.status === "paused") {
          sawRunning = true;
        }
        if (sawRunning && ENDED_STATUSES.has(state.customBot.status)) {
          void finalize(record);
        }
      });

      await flow.startCustomBot(decoded.doc);
      applySnapshot(record, store.customBot.get());
      if (record.startError !== null) {
        await finalize(record);
        return { ok: false, code: "BOT_START_FAILED", message: record.startError };
      }
      const remainingMs = Math.max(1, Date.parse(record.expiresAt) - now());
      record.deadlineTimer = setDeadlineTimeout(() => {
        if (record.finalized) {
          return;
        }
        record.status = "stopped";
        record.why = "The approved run time ended, so the server stopped this bot.";
        void finalize(record);
      }, remainingMs);
      if (typeof record.deadlineTimer.unref === "function") {
        record.deadlineTimer.unref();
      }
      persistRoster();
      // First vitals sample right away (fire-and-forget), so the landing
      // page's next poll already has ship state instead of a blank line.
      void sampleBotVitals(record);
      return { ok: true, bot: publicBot(record) };
    } catch (error) {
      logError(error);
      record.status = "error";
      record.why = error && error.message ? String(error.message) : "The bot could not be started.";
      await finalize(record);
      return { ok: false, code: "BOT_START_FAILED", message: record.why };
    }
  }

  async function stop(botID, accountID) {
    const record = records.get(botID);
    if (!record || record.accountID !== Number(accountID)) {
      return { ok: false, code: "BOT_NOT_FOUND" };
    }
    if (!record.finalized) {
      if (record.flow) {
        try {
          record.flow.stopCustomBot();
        } catch {}
      }
      record.status = "stopped";
      await finalize(record);
    }
    return { ok: true, bot: publicBot(record) };
  }

  function list(accountID) {
    const rows = [];
    for (const record of records.values()) {
      if (record.accountID === Number(accountID)) {
        rows.push(publicBot(record));
      }
    }
    rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return rows;
  }

  /** The RUNNING bot claiming this character, or null — the select guard. */
  function claimedBy(characterID) {
    return claims.get(characterID) || null;
  }

  /** True only for the private capability carried by this run's loopback fetch. */
  function authorizesClaim(characterID, secret) {
    const botID = claims.get(Number(characterID));
    const record = botID ? records.get(botID) : null;
    return Boolean(record && !record.finalized && sameSecret(record.claimSecret, secret));
  }

  /**
   * Character IDs a bot is flying RIGHT NOW. Served without auth (the login
   * and character screens mark bot-flown pilots before any sign-in exists), so
   * it is deliberately just the IDs — no names, scripts, or accounts.
   */
  function activeCharacterIDs() {
    return [...claims.keys()];
  }

  /**
   * The landing-page readout rows for every RUNNING bot: which character,
   * what the bot is doing, and the last vitals sample. Like
   * activeCharacterIDs this is served without auth, so it carries game state
   * only — no account names, script ids, or bot ids (nothing controllable).
   */
  function activeBots() {
    const rows = [];
    for (const record of records.values()) {
      if (!record.finalized) {
        rows.push({
          characterID: record.characterID,
          status: record.status,
          phase: record.phase,
          why: record.why,
          note: record.note,
          vitals: record.vitals,
        });
      }
    }
    return rows;
  }

  // ── Vitals sampling (the landing-page ship readout) ────────────────────────
  // Every VITALS_SAMPLE_MS each running bot answers "how is the ship?": flight
  // status (docked or not), the space snapshot's own-ship shield/armor/hull
  // (only meaningful in space), and the mining holds (cargo/ore fill). These
  // are the SAME store-backed reads an open tab polls; a failed sample keeps
  // the previous one (stale-but-honest beats blank).
  async function sampleBotVitals(record) {
    const flow = record.flow;
    const store = record.store;
    if (!flow || !store || record.finalized) {
      return;
    }
    try {
      await flow.loadFlightStatus();
      const flight = store.flight.get().status;
      const docked = flight === null ? null : flight.docked === true;
      if (docked === false) {
        await flow.loadSpaceSnapshot();
      }
      await flow.loadMiningHolds();
      const snapshot = docked === false ? store.space.get().snapshot : null;
      const ship = snapshot ? snapshot.ship : null;
      const holds = store.mining.get().holds || [];
      record.vitals = {
        sampledAt: nowISO(),
        docked,
        shield: ship ? ship.shieldRatio : null,
        armor: ship ? ship.armorRatio : null,
        hull: ship ? ship.hullRatio : null,
        holds: holds
          .filter((hold) => hold.present)
          .map((hold) => ({
            label: hold.label,
            used: hold.capacity ? hold.capacity.used : null,
            capacity: hold.capacity ? hold.capacity.capacity : null,
          })),
      };
    } catch {
      // Best-effort: the last sample stands until a read succeeds again.
    }
  }

  /** Sample every running bot now (the timer's tick; exposed for tests). */
  async function sampleAllVitals() {
    const running = [...records.values()].filter((record) => !record.finalized);
    await Promise.all(running.map((record) => sampleBotVitals(record)));
  }

  const vitalsTimer = setInterval(() => {
    void sampleAllVitals();
  }, options.vitalsIntervalMs || VITALS_SAMPLE_MS);
  if (typeof vitalsTimer.unref === "function") {
    vitalsTimer.unref(); // never the reason the process stays alive
  }

  // A bot that could not come back must SAY SO where the player looks, not
  // silently drop off the roster: a finished error record, replacing any older
  // finished story for that character (the same one-record-per-character rule
  // start applies).
  function recordResumeFailure(row, message) {
    for (const [id, old] of records) {
      if (old.characterID === Number(row.characterID) && old.finalized) {
        records.delete(id);
      }
    }
    const botID = crypto.randomUUID();
    records.set(botID, {
      botID,
      accountID: Number(row.accountID),
      username: String(row.username || ""),
      characterID: Number(row.characterID),
      characterName: null,
      scriptID: String(row.scriptID || ""),
      scriptName: String(row.scriptName || "Untitled bot"),
      scriptRev: Number(row.scriptRev || 0),
      scriptHash: String(row.scriptHash || ""),
      restartSafe: false,
      riskClasses: Array.isArray(row.riskClasses) ? row.riskClasses.map(String) : [],
      maxRuntimeMinutes: Number(row.maxRuntimeMinutes || 0),
      expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
      resumedAt: null,
      vitals: null,
      status: "error",
      phase: null,
      why: `This bot was running when the server restarted and could not be restarted: ${message}`,
      stepPath: null,
      pauseReason: null,
      note: null,
      startError: null,
      startedAt: String(row.startedAt || nowISO()),
      endedAt: nowISO(),
      finalized: true,
      flow: null,
      store: null,
      unsubscribe: null,
      claimSecret: null,
      deadlineTimer: null,
    });
  }

  /**
   * Bring the persisted roster back after a restart. Call ONLY once the server
   * is listening — every bot drives it over loopback. Sequential on purpose
   * (like the tab's own pilot restore): the first select warms a cold gateway,
   * and one wedged character cannot wedge the file rewrite at the end.
   */
  async function resume() {
    const rows = readRoster();
    for (const row of rows) {
      const characterID = Number(row.characterID);
      try {
        const account = await loadAccount(String(row.username || ""));
        if (!account || account.banned) {
          recordResumeFailure(row, "the account is gone or banned.");
          continue;
        }
        const script = loadScript(String(row.scriptID || ""));
        if (!script) {
          recordResumeFailure(row, "the saved bot no longer exists.");
          continue;
        }
        if (!Number.isSafeInteger(Number(row.scriptRev)) || !/^[a-f0-9]{64}$/.test(String(row.scriptHash || ""))) {
          recordResumeFailure(row, "its older restart record has no pinned script revision. Start it again manually.");
          continue;
        }
        if (row.restartSafe !== true) {
          recordResumeFailure(row, "it can repeat a consequential action. Review and start it again manually.");
          continue;
        }
        if (!Number.isFinite(Date.parse(String(row.expiresAt || ""))) || Date.parse(String(row.expiresAt)) <= now()) {
          recordResumeFailure(row, "its approved run time has ended. Start it again manually.");
          continue;
        }
        const outcome = await start({
          account,
          characterID,
          scriptID: script.scriptID,
          scriptName: script.name,
          scriptRev: script.rev,
          doc: script.doc,
          grant: {
            scriptRev: row.scriptRev,
            riskClasses: Array.isArray(row.riskClasses) ? row.riskClasses : [],
            maxRuntimeMinutes: row.maxRuntimeMinutes,
          },
          resumed: true,
          expectedScriptRev: row.scriptRev,
          expectedScriptHash: row.scriptHash,
          expectedExpiresAt: row.expiresAt,
        });
        if (!outcome.ok) {
          recordResumeFailure(row, outcome.message || outcome.code);
        }
      } catch (error) {
        logError(error);
        recordResumeFailure(row, error && error.message ? String(error.message) : "an unexpected error.");
      }
    }
    // Rewrite the file to what actually came back, dropping the failures.
    persistRoster();
  }

  /** Stop every running bot (server shutdown — best effort). */
  async function stopAll() {
    const running = [...records.values()].filter((record) => !record.finalized);
    await Promise.all(running.map((record) => finalize(record)));
  }

  return {
    start,
    stop,
    list,
    claimedBy,
    authorizesClaim,
    activeCharacterIDs,
    activeBots,
    sampleAllVitals,
    resume,
    stopAll,
    BOT_HEADER,
  };
}

module.exports = { createBotHost, BOT_HEADER };
