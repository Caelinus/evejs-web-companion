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
// in a bounded ring of the last MAX_ENDED_RUNS ended runs, GLOBAL across every
// account and character (see that constant's comment) — not one-per-character
// as before, and not a durable log.
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

// Terminal statuses: the runner has let go of the ship. Shared verbatim by
// the customBot slice and the companion slice (FleetCompanionRunState) — both
// name the same five states, so one set serves either kind's subscription.
const ENDED_STATUSES = new Set(["stopped", "error", "idle"]);

// The companion grant's `scriptRev` sentinel is NOT defined here. It lives in
// web/src/bots/companionRunPolicy.ts, the layer this host and the browser both
// import, because the browser sends it and this host compares it — see that
// constant's comment for why two copies of a bare 1 would be a bug waiting to
// surface as a bogus "this bot changed after its run was approved".

// The companion's roster-row `scriptName` — the slot a player reads in the
// Server Bots list — derived from the request's role rather than authored,
// because a companion request has no name field of its own (unlike a saved
// script). Not exhaustive by construction on purpose: an unrecognised role
// cannot reach here at all, since decodeFleetCompanionRequestValue refuses
// any value outside FLEET_COMPANION_ROLES before start() ever calls this.
const COMPANION_ROLE_LABELS = Object.freeze({
  dps: "DPS",
  logi: "Logistics",
  tackle: "Tackle",
  support: "Support",
});

function companionScriptName(role) {
  const label = COMPANION_ROLE_LABELS[role] || "companion";
  return `Fleet companion (${label})`;
}

// How often each running bot's ship vitals are sampled for the landing-page
// readout. Plain reads through the bot's own flow — the same polls an open
// tab would be making — never a world call.
const VITALS_SAMPLE_MS = 15_000;

// Ended runs are kept for the "recent runs" strip, not as a log: this is a
// MEMORY BOUND, so the ring holds the last MAX_ENDED_RUNS finalized records
// and nothing more. The cap is GLOBAL across every account, not per
// character — a busy account can age a quiet account's history out of the
// ring entirely. That is acceptable in a single-operator deployment (there is
// no tenant here to shortchange) and it is exactly why this is not a durable
// record: anyone who needs guaranteed history should look elsewhere, because
// this file already promises ended runs live in memory only and vanish on
// restart (see persistRoster below).
const MAX_ENDED_RUNS = 20;

// The browser stack, imported once per process and shared by every bot. Kept
// lazy so `require("./botHost")` stays cheap and the BFF boots even if the
// web sources are absent (the routes then fail per-start, not at boot).
let stackPromise = null;
function defaultLoadStack() {
  if (stackPromise === null) {
    const webSrc = path.resolve(__dirname, "..", "web", "src");
    const webUrl = (rel) => pathToFileURL(path.join(webSrc, rel)).href;
    stackPromise = (async () => {
      const [sessionToken, clientStore, flow, codec, runPolicy, companionRunPolicy] = await Promise.all([
        import(webUrl("app/sessionToken.ts")),
        import(webUrl("store/clientStore.ts")),
        import(webUrl("app/flow.ts")),
        import(webUrl("bots/scriptCodec.ts")),
        import(webUrl("bots/runPolicy.ts")),
        import(webUrl("bots/companionRunPolicy.ts")),
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
        // The companion's own risk-derivation and codec door — same BotRunPolicy
        // shape, same validateBotLaunchGrant, per companionRunPolicy.ts's header.
        analyzeCompanionRunPolicy: companionRunPolicy.analyzeCompanionRunPolicy,
        decodeFleetCompanionRequestValue: companionRunPolicy.decodeFleetCompanionRequestValue,
        decodeCompanionAbandonmentValue: companionRunPolicy.decodeCompanionAbandonmentValue,
        COMPANION_GRANT_SCRIPT_REV: companionRunPolicy.COMPANION_GRANT_SCRIPT_REV,
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

  /**
   * botID -> record, running and ended alike. Ended (finalized) records are
   * bounded to MAX_ENDED_RUNS by evictOldEndedRuns(), a global ring across
   * every account and character — see the constant's comment for why.
   * Running records are never touched by that ring.
   */
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
          const row = {
            kind: record.kind === "companion" ? "companion" : "script",
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
          };
          if (record.kind === "companion") {
            // THE DIVERGENCE FROM A SCRIPT (docs/fleet-companion-handoff.md,
            // "3. Extend botHost"): a script doc is NOT persisted, because the
            // saved-script library is the authority and loadScript re-binds a
            // restart to the exact stored revision (see the comment on the
            // `doc` branch in start(), below). A companion request has no
            // library — the roster row IS the authority, so the flat request
            // is persisted right alongside its hash rather than a reference.
            row.request = record.companionRequest;
            // DECISION 5'S THIRTY-MINUTE CLOCK, and the whole reason it is a
            // bound rather than a suggestion. An abandoned companion (nobody
            // in its fleet this host is not flying) gets safe, drops fleet and
            // waits exactly this long before releasing the hull. Held only in
            // the loop's memory, that wait would restart every time this
            // process did — an unbounded wait assembled out of bounded ones.
            // Null whenever supervision is fine, which is almost always.
            row.abandonment = record.companionAbandonment;
          }
          bots.push(row);
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
      // "script" when absent, matching the same default the roster row and
      // resume() give an on-disk record with no `kind` field at all.
      kind: record.kind === "companion" ? "companion" : "script",
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
  /**
   * The persisted half of the companion slice's abandonment, or null.
   *
   * Deliberately narrow: the loop's own `safeSpotWarpIssued`/`safeSpotWarpSeen`
   * describe a warp that is over the moment this process dies, and writing them
   * down would let a resumed run believe it had already reached safety. The
   * clock and the rejoin allowlist are the only two facts worth keeping — see
   * CompanionAbandonmentRecord in web/src/nav/fleetCompanionLoop.ts.
   */
  function companionAbandonmentOf(snapshot) {
    const running = snapshot && snapshot.abandonment;
    if (!running || !Number.isSafeInteger(Number(running.abandonedAtMs))) {
      return null;
    }
    return {
      abandonedAtMs: Number(running.abandonedAtMs),
      supervisorCharacterIDs: Array.isArray(running.supervisorCharacterIDs)
        ? running.supervisorCharacterIDs.map(Number)
        : [],
    };
  }

  function sameAbandonment(left, right) {
    if (left === null || right === null) {
      return left === right;
    }
    return (
      left.abandonedAtMs === right.abandonedAtMs &&
      left.supervisorCharacterIDs.length === right.supervisorCharacterIDs.length &&
      left.supervisorCharacterIDs.every((id, index) => id === right.supervisorCharacterIDs[index])
    );
  }

  function applySnapshot(record, snapshot) {
    record.status = snapshot.status;
    record.phase = snapshot.phase;
    record.why = snapshot.why;
    record.startError = snapshot.startError ?? null;
    if (record.kind === "companion") {
      // The companion slice (FleetCompanionState, web/src/store/clientStore.ts)
      // has no stepPath, pauseReason, note, or lastAlert — those are
      // script-runner-shaped fields FleetCompanionProgress simply does not
      // carry (fleetCompanionLoop.ts). Leaving the record's own fields
      // untouched keeps them at their initial `null` rather than inventing a
      // value for a column the companion has no honest answer to.
      //
      // The companion's OWN distinguishing fields — action, role, inFleet,
      // followingOrderFrom, lastOrderHeard, canTag, failureReason — are read
      // by the store subscription below but have no slot on this record or on
      // publicBot()'s wire shape yet: that shape is `ServerBot`
      // (web/src/app/api.ts) and web/src/ui/**, both out of scope for this
      // change. Nothing here fabricates a place for them either.
      //
      // `abandonment` is the ONE exception, and it is not a readout: it is
      // durable state this host owns (see persistRoster). Written through to
      // disk ONLY when it actually changes — this runs on every store push,
      // roughly once every two seconds per bot, and an abandonment changes at
      // most twice in a run.
      const next = companionAbandonmentOf(snapshot);
      if (!sameAbandonment(record.companionAbandonment, next)) {
        record.companionAbandonment = next;
        persistRoster();
      }
      return;
    }
    record.stepPath = snapshot.stepPath;
    record.pauseReason = snapshot.pauseReason;
    record.note = snapshot.note;
    if (snapshot.lastAlert) {
      record.lastAlert = { message: String(snapshot.lastAlert.message), atMs: Number(snapshot.lastAlert.atMs) };
    }
  }

  // The ring: keep at most MAX_ENDED_RUNS finalized records, evicting the
  // OLDEST by endedAt — not by Map insertion order, which is start order and
  // can disagree with finish order (a long-running bot can finalize well
  // after a short one that started later). Running records are excluded from
  // both the count and the eviction; they are never subject to this cap.
  function evictOldEndedRuns() {
    const ended = [];
    for (const record of records.values()) {
      if (record.finalized) {
        ended.push(record);
      }
    }
    if (ended.length <= MAX_ENDED_RUNS) {
      return;
    }
    ended.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
    const excess = ended.length - MAX_ENDED_RUNS;
    for (let i = 0; i < excess; i++) {
      records.delete(ended[i].botID);
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
    // Now that this record is finalized, keep the ended-run ring within
    // MAX_ENDED_RUNS. Purely an in-memory trim — it never touches the disk
    // roster, which only ever held running bots.
    evictOldEndedRuns();
    const flow = record.flow;
    record.flow = null;
    record.store = null;
    if (flow) {
      try {
        // Two different stop switches on the SAME flow object — stopCustomBot
        // only reaches the scriptRunner, stopFleetCompanion only the companion
        // controller. Calling the wrong one for this record's kind is a no-op
        // that leaves the actual loop running, unstoppable, past this point.
        if (record.kind === "companion") {
          flow.stopFleetCompanion();
        } else {
          flow.stopCustomBot();
        }
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
    kind = "script",
    scriptID,
    scriptName,
    scriptRev,
    doc,
    request,
    abandonment = null,
    grant,
    resumed = false,
    expectedScriptRev = null,
    expectedScriptHash = null,
    expectedExpiresAt = null,
  }) {
    const isCompanion = kind === "companion";
    let resumingAbandonment = null;
    let stack;
    try {
      stack = await loadStack();
    } catch (error) {
      logError(error);
      return { ok: false, code: "BOT_STACK_UNAVAILABLE", message: "The server could not load the bot engine." };
    }

    let normalizedRev;
    let normalizedHash;
    let runPolicy;
    let decodedDoc = null;
    let decodedRequest = null;
    let recordScriptID;
    let recordScriptName;

    if (isCompanion) {
      // The persisted (or freshly submitted) request is untrusted bytes like
      // any other — decodeFleetCompanionRequestValue is its ONE gate, mirroring
      // decodeScriptValue below. Not a single field of it is trusted before
      // this call returns ok.
      const decoded = stack.decodeFleetCompanionRequestValue(request);
      if (!decoded.ok) {
        return { ok: false, code: "BOTCOMPANION_INVALID", message: decoded.refusal };
      }
      decodedRequest = decoded.request;
      // A persisted abandonment is untrusted bytes exactly like the request
      // beside it, and gets the same one gate. A row that fails to decode is
      // DROPPED rather than refused: the companion simply starts a fresh
      // thirty minutes, which is still bounded and still safe — whereas
      // refusing the whole start would leave a pilot flying with no host.
      if (abandonment !== null && abandonment !== undefined) {
        const decodedAbandonment = stack.decodeCompanionAbandonmentValue(abandonment, now());
        resumingAbandonment = decodedAbandonment.ok ? decodedAbandonment.abandonment : null;
      }
      // See COMPANION_GRANT_SCRIPT_REV in companionRunPolicy.ts: a request has no
      // revision series, so this sentinel — never a real version — fills the
      // slot validateBotLaunchGrant already compares. The canonical hash is
      // the request's actual identity.
      normalizedRev = stack.COMPANION_GRANT_SCRIPT_REV;
      normalizedHash = hashScript(decodedRequest);
      if (
        expectedScriptRev !== null &&
        (normalizedRev !== Number(expectedScriptRev) || normalizedHash !== String(expectedScriptHash || ""))
      ) {
        return {
          ok: false,
          code: "BOT_SCRIPT_CHANGED",
          message:
            "The saved companion setup changed after this run was authorized. Start it again to review the new version.",
        };
      }
      // Re-derived from the decoded request every time — on a fresh start AND
      // on resume — never trusted off the persisted row. This is the check
      // decision 4 says must still earn its place: the persisted request must
      // re-derive to EXACTLY the risk classes the grant carries.
      runPolicy = stack.analyzeCompanionRunPolicy(decodedRequest);
      // Reuse the script's roster slots (docs/fleet-companion-handoff.md,
      // "3. Extend botHost") rather than inventing companion-shaped fields:
      // scriptID is a fixed literal (there is no library entry to look up),
      // scriptName is derived from the request's role so a player reads a
      // sensible pilot name in the roster instead of a blank column.
      recordScriptID = "companion";
      recordScriptName = companionScriptName(decodedRequest.role);
    } else {
      // A stored bot doc is untrusted bytes like any other; the codec is the door.
      const decoded = stack.decodeScriptValue(doc);
      if (!decoded.ok) {
        return { ok: false, code: "BOTSCRIPT_INVALID", message: decoded.refusal };
      }
      decodedDoc = decoded.doc;
      normalizedRev = Number(scriptRev);
      if (!Number.isSafeInteger(normalizedRev) || normalizedRev <= 0) {
        return { ok: false, code: "BOTSCRIPT_REVISION_REQUIRED", message: "The saved bot revision is missing." };
      }
      normalizedHash = hashScript(decodedDoc);
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
      runPolicy = stack.analyzeBotRunPolicy(decodedDoc);
      if (runPolicy.containsSubBots) {
        return {
          ok: false,
          code: "BOT_SUBBOT_GRANT_UNAVAILABLE",
          message: "A server bot cannot yet grant permissions to included saved bots. Inline them before starting this run.",
        };
      }
      recordScriptID = scriptID;
      recordScriptName = scriptName;
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
      kind: isCompanion ? "companion" : "script",
      scriptID: recordScriptID,
      scriptName: recordScriptName,
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
      // The roster row's authority for a companion (see persistRoster's
      // comment) — null for a script, which is authored by the library instead.
      companionRequest: isCompanion ? decodedRequest : null,
      // Seeded from the persisted row on a resume, then owned by
      // applySnapshot. Null for a script and for a fresh companion start.
      companionAbandonment: isCompanion ? resumingAbandonment : null,
    };
    // Claim BEFORE the first await — two concurrent starts must not both win,
    // and the select guard must already know this bot when its select arrives.
    claims.set(characterID, botID);
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
      // customBot (or companion) slice onto the record, and treat the loop
      // letting go of the ship as the end of the bot.
      let sawRunning = false;
      record.unsubscribe = store.subscribe((state) => {
        const snapshot = isCompanion ? state.companion : state.customBot;
        applySnapshot(record, snapshot);
        if (snapshot.status === "running" || snapshot.status === "paused") {
          sawRunning = true;
        }
        if (sawRunning && ENDED_STATUSES.has(snapshot.status)) {
          void finalize(record);
        }
      });

      if (isCompanion) {
        await flow.startFleetCompanion(decodedRequest, resumingAbandonment);
        applySnapshot(record, store.companion.get());
      } else {
        await flow.startCustomBot(decodedDoc);
        applySnapshot(record, store.customBot.get());
      }
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
          // Same two-switch distinction as finalize() below — stop the
          // controller this record actually holds, not the script runner by
          // default.
          if (record.kind === "companion") {
            record.flow.stopFleetCompanion();
          } else {
            record.flow.stopCustomBot();
          }
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
  // silently drop off the roster: a finished error record, subject to the
  // same ended-run ring as any other finalized record (evicted below).
  function recordResumeFailure(row, message) {
    const botID = crypto.randomUUID();
    records.set(botID, {
      botID,
      accountID: Number(row.accountID),
      username: String(row.username || ""),
      characterID: Number(row.characterID),
      characterName: null,
      kind: row.kind === "companion" ? "companion" : "script",
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
    evictOldEndedRuns();
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
      const kind = row.kind === "companion" ? "companion" : "script";
      try {
        const account = await loadAccount(String(row.username || ""));
        if (!account || account.banned) {
          recordResumeFailure(row, "the account is gone or banned.");
          continue;
        }
        let script = null;
        if (kind === "script") {
          script = loadScript(String(row.scriptID || ""));
          if (!script) {
            recordResumeFailure(row, "the saved bot no longer exists.");
            continue;
          }
        }
        // scriptHash is the canonical identity either way — a real script
        // hash for a script row, hashScript(request) for a companion row
        // (see persistRoster's comment) — so this check is unchanged by kind.
        if (!Number.isSafeInteger(Number(row.scriptRev)) || !/^[a-f0-9]{64}$/.test(String(row.scriptHash || ""))) {
          recordResumeFailure(
            row,
            kind === "companion"
              ? "its older restart record has no pinned request hash. Start it again manually."
              : "its older restart record has no pinned script revision. Start it again manually.",
          );
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
        const grant = {
          scriptRev: row.scriptRev,
          riskClasses: Array.isArray(row.riskClasses) ? row.riskClasses : [],
          maxRuntimeMinutes: row.maxRuntimeMinutes,
        };
        const outcome =
          kind === "companion"
            ? await start({
                account,
                characterID,
                kind: "companion",
                // No library entry to re-bind to — the persisted row's own
                // `request` field IS the authority (persistRoster's comment).
                // It goes through decodeFleetCompanionRequestValue again
                // inside start(), exactly like a fresh start's request.
                request: row.request,
                // The clock this companion was already waiting on. Keeping it
                // is what makes decision 5's thirty minutes a bound rather
                // than a fresh thirty minutes per restart.
                abandonment: row.abandonment ?? null,
                grant,
                resumed: true,
                expectedScriptRev: row.scriptRev,
                expectedScriptHash: row.scriptHash,
                expectedExpiresAt: row.expiresAt,
              })
            : await start({
                account,
                characterID,
                kind: "script",
                scriptID: script.scriptID,
                scriptName: script.name,
                scriptRev: script.rev,
                doc: script.doc,
                grant,
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

module.exports = { createBotHost, BOT_HEADER, MAX_ENDED_RUNS };
