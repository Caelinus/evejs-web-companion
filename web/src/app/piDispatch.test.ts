// R108 slice 4: dispatching "restart extractors" for a pilot, from the PI board.
//
// What is checked, and why each matters:
//
//   1. IT GOES THROUGH THE SERVER BOT HOST, ALWAYS. The bot host holds the one
//      honest claims map: it refuses a pilot a web session or another bot is
//      flying, in its own words. Nothing here selects a character.
//
//   2. THE BOT IS AN ORDINARY SAVED BOT. The host starts only saved bots, so
//      the board keeps one in the library — found by name, saved once if
//      missing — and it is visible and editable in the Bot Manager like any
//      other. A copy someone has CHANGED is not the board's any more: it is
//      not started blind, and not silently replaced either.
//
//   3. THE RISK IS DERIVED, NOT ASSERTED. The grant carries what the real
//      policy analysis says the saved document does, so an edited bot cannot
//      ride a stale approval.
//
//   4. THE SERVER'S REFUSAL IS SHOWN IN ITS OWN WORDS, and every throwaway
//      token is signed out, refused or not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PI_RESTART_BOT_NAME,
  PI_RESTART_RUNTIME_MINUTES,
  isPiRestartBot,
  piRestartBotDoc,
  restartExtractorsFor,
  type PiDispatchDeps,
} from "./piDispatch.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { analyzeBotRunPolicy, validateBotLaunchGrant } from "../bots/runPolicy.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import type { BotLaunchGrant } from "../bots/runPolicy.ts";

const PILOT = 90000001;

interface Saved {
  scriptID: string;
  name: string;
  rev: number;
  doc: unknown;
}

function deps(
  library: Saved[] = [],
  options: { refuseSignIn?: boolean; refuseStart?: BridgeCallError } = {},
): PiDispatchDeps & { log: string[]; started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[] } {
  const log: string[] = [];
  const started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[] = [];
  return {
    log,
    started,
    async signIn(accountName) {
      if (options.refuseSignIn) throw new Error("refused");
      log.push(`signIn:${accountName}`);
      return "tok";
    },
    async signOut(token) {
      log.push(`signOut:${token}`);
    },
    async listScripts() {
      return library.map(({ scriptID, name, rev }) => ({ scriptID, name, rev }));
    },
    async getScript(scriptID) {
      const found = library.find((row) => row.scriptID === scriptID);
      return found ? { scriptID, rev: found.rev, doc: found.doc } : null;
    },
    async createScript(doc) {
      log.push("create");
      const row = { scriptID: `s${library.length + 1}`, name: (doc as { name: string }).name, rev: 1, doc };
      library.push(row);
      return { scriptID: row.scriptID, rev: 1 };
    },
    async startServerBot(characterID, scriptID, grant) {
      log.push(`start:${scriptID}`);
      if (options.refuseStart) throw options.refuseStart;
      started.push({ characterID, scriptID, grant });
    },
  };
}

function refusal(status: number, message: string): BridgeCallError {
  return new BridgeCallError("CALL_REFUSED" as never, message, status);
}

test("the board's bot is a valid saved bot: one Restart extractors step, nothing else", () => {
  const decoded = decodeScriptValue(JSON.parse(JSON.stringify(piRestartBotDoc())));
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.refusal);
  if (!decoded.ok) return;
  assert.equal(decoded.doc.name, PI_RESTART_BOT_NAME);
  assert.deepEqual(decoded.doc.program.map((node) => node.kind === "macro" && node.macro), ["restart-extractors"]);
  assert.deepEqual(decoded.doc.interrupts, []);
  assert.equal(isPiRestartBot(decoded.doc), true);
  // Changing colonies is all it does, and restarting it is safe.
  const policy = analyzeBotRunPolicy(decoded.doc);
  assert.deepEqual([...policy.riskClasses], ["colony"]);
});

test("with no saved copy, one is saved, then started for that pilot on the server", async () => {
  const d = deps();
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.deepEqual(outcome, { kind: "started" });
  assert.deepEqual(d.log, ["signIn:alpha", "create", "start:s1", "signOut:tok"]);
  const [run] = d.started;
  assert.equal(run!.characterID, PILOT);
  // The grant is one the server's own validator accepts for that document.
  const decoded = decodeScriptValue(piRestartBotDoc());
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  const verdict = validateBotLaunchGrant(run!.grant, 1, analyzeBotRunPolicy(decoded.doc));
  assert.equal(verdict.ok, true);
  assert.equal(run!.grant.maxRuntimeMinutes, PI_RESTART_RUNTIME_MINUTES);
});

test("an existing saved copy is reused, at its current revision, never saved twice", async () => {
  const library = [
    { scriptID: "x", name: "My mining bot", rev: 4, doc: {} },
    { scriptID: "pi", name: PI_RESTART_BOT_NAME, rev: 7, doc: piRestartBotDoc() },
  ];
  const d = deps(library);
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), { kind: "started" });
  assert.equal(d.log.includes("create"), false);
  assert.equal(d.started[0]!.scriptID, "pi");
  assert.equal(d.started[0]!.grant.scriptRev, 7);
});

test("⚠ a saved copy someone changed is not started, and not quietly replaced", async () => {
  const changed = { ...piRestartBotDoc(), program: [...piRestartBotDoc().program, { id: "u", kind: "macro", macro: "undock", args: {} }] };
  const d = deps([{ scriptID: "pi", name: PI_RESTART_BOT_NAME, rev: 3, doc: changed }]);
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.sentence : "", /has been changed/);
  assert.equal(d.log.some((event) => event === "create" || event.startsWith("start:")), false);
  assert.equal(d.log.at(-1), "signOut:tok");
});

test("⚠ the server's refusal is shown in its own words, and the token is still signed out", async () => {
  const inUse = "A web session is flying this character. Log it out (or wait for it to expire), then start the bot.";
  const d = deps([], { refuseStart: refusal(409, inUse) });
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), { kind: "refused", sentence: inUse });
  assert.equal(d.log.at(-1), "signOut:tok");
});

test("a request that never reached the server says so, not the transport's message", async () => {
  const d = deps([], { refuseStart: refusal(0, "POST /api/bots/start aborted: fetch failed") });
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.deepEqual(outcome, { kind: "refused", sentence: "The server could not be reached just now." });
});

test("a refused sign-in starts nothing", async () => {
  const d = deps([], { refuseSignIn: true });
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), {
    kind: "refused",
    sentence: "Could not sign in to this pilot's account just now.",
  });
  assert.deepEqual(d.started, []);
});

test("isPiRestartBot knows the board's bot from any other", () => {
  const decoded = decodeScriptValue(piRestartBotDoc());
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.equal(isPiRestartBot({ ...decoded.doc, interrupts: [{ id: "w", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" }] as never }), false);
  assert.equal(isPiRestartBot({ ...decoded.doc, program: [] }), false);
});

test("the run limit is the hour the board's row promises", () => {
  // bridge/piBoard.ts says "runs for an hour at most" before the button.
  assert.equal(PI_RESTART_RUNTIME_MINUTES, 60);
});
