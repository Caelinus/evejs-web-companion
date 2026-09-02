// The RUN-APPROVAL path for a saved bot — extracted ONCE so the Bots launcher
// and the Bot Manager's pilot rows share it rather than fork it, per this
// codebase's rule that a launcher "embeds the real components and forks
// nothing." No component, no fetch of its own, no clock — exactly the house
// style set by libraryView.ts and pilotRoster.ts: a pure core, unit-tested
// without a DOM, with a thin caller supplying the real fetch/confirm/starters.
//
// Both callers go through the SAME two steps for the SAME reason: decode the
// stored doc (decode-on-read — a saved bot is executable authority, and every
// byte reaching a runner passes the codec, never the caller's own trust of
// what it once wrote), then get the player's explicit approval before
// anything starts. Skipping either step here would silently re-introduce the
// fork this module exists to prevent.

import type { BotScript } from "./botScript.ts";
import { decodeScriptValue } from "./scriptCodec.ts";
import {
  analyzeBotRunPolicy,
  BOT_RISK_LABELS,
  createBotLaunchGrant,
  type BotLaunchGrant,
  type BotRunPolicy,
} from "./runPolicy.ts";

/** What became of a start attempt. Never throws — every failure is a value. */
export type StartOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "declined" } // the player said no at the confirm
  | { readonly kind: "refused"; readonly sentence: string }; // not found, codec refusal, or a failed call

/** What both start paths need to fetch the record and get player approval. */
export interface ApprovalDeps {
  fetchScript(scriptID: string): Promise<{ scriptID: string; rev: number; doc: unknown } | null>;
  confirm(message: string): boolean;
}

/** Deps for starting a bot IN THIS TAB. */
export interface LocalStartDeps extends ApprovalDeps {
  startCustomBot(doc: BotScript, scriptID: string): Promise<void>;
}

/** Deps for starting a bot ON THE SERVER, flying the caller's current character. */
export interface ServerStartDeps extends ApprovalDeps {
  startServerBot(characterID: number, scriptID: string, grant: BotLaunchGrant): Promise<unknown>;
  releaseSession(): Promise<void>;
}

/**
 * The confirm text. Pure — no window, no clock. Player-facing wording, copied
 * verbatim from Bots.svelte's `approveRun`: the no-risk sentence, the
 * sub-bot sentence, and the runtime-limit sentence with its minutes-vs-hours
 * phrasing are all already reviewed and must not drift between callers.
 */
export function runApprovalPrompt(name: string, policy: BotRunPolicy, runtimeMinutes: number | null): string {
  const permissions =
    policy.riskClasses.length === 0
      ? "No spending, destructive, social, fleet, mission, colony, inventory, or combat permission was found."
      : `This run may ${policy.riskClasses.map((risk) => BOT_RISK_LABELS[risk]).join("; ")}.`;
  const included = policy.containsSubBots
    ? "\n\nIt includes other saved bots, whose current contents will be loaded when it starts."
    : "";
  const limit =
    runtimeMinutes === null
      ? ""
      : `\n\nThe server will stop it after ${runtimeMinutes < 60 ? `${runtimeMinutes} minutes` : `${runtimeMinutes / 60} hours`}.`;
  return `Run “${name}”?\n\n${permissions}${included}${limit}`;
}

/**
 * Fetch, decode, and get approval for one saved bot — the part shared by both
 * start paths. Returns the decoded doc and the fetched record's rev on
 * success, so a caller-specific "started" outcome from here on is just
 * calling its own starter.
 */
async function loadAndApprove(
  deps: ApprovalDeps,
  scriptID: string,
  runtimeMinutes: number | null,
): Promise<{ kind: "approved"; doc: BotScript; rev: number; policy: BotRunPolicy } | StartOutcome> {
  const record = await deps.fetchScript(scriptID);
  if (record === null) {
    return { kind: "refused", sentence: "That bot could not be found." };
  }
  const decoded = decodeScriptValue(record.doc);
  if (!decoded.ok) {
    return { kind: "refused", sentence: decoded.refusal };
  }
  const policy = analyzeBotRunPolicy(decoded.doc);
  if (!deps.confirm(runApprovalPrompt(decoded.doc.name, policy, runtimeMinutes))) {
    return { kind: "declined" };
  }
  return { kind: "approved", doc: decoded.doc, rev: record.rev, policy };
}

/** Start a saved bot IN THIS TAB, flying the ship it already controls. */
export async function startHere(deps: LocalStartDeps, scriptID: string): Promise<StartOutcome> {
  let step: { kind: "approved"; doc: BotScript; rev: number; policy: BotRunPolicy } | StartOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, null);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  try {
    await deps.startCustomBot(step.doc, scriptID);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot." };
  }
  return { kind: "started" };
}

/**
 * Run a saved bot ON THE SERVER, flying THIS caller's current character.
 *
 * The handover is the SERVER's, in one request: /api/bots/start releases the
 * caller's own held session and claims the character for the bot atomically.
 * Started-first matters twice over — the login/select screens a tab falls to
 * poll the bot-flying marks, and a bot that already exists is on their FIRST
 * read (release-first left them blank until the next poll); and a refused
 * start changes nothing, so the caller just keeps flying (no take-the-hull-
 * back dance). `releaseSession` afterwards only syncs the caller's own UI —
 * its server-side session is already gone, so a failure there is NOT a failed
 * start: the bot has the hull either way.
 */
export async function startOnServer(
  deps: ServerStartDeps,
  scriptID: string,
  characterID: number,
  runtimeMinutes: number,
): Promise<StartOutcome> {
  let step: { kind: "approved"; doc: BotScript; rev: number; policy: BotRunPolicy } | StartOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, runtimeMinutes);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot on the server." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  const grant = createBotLaunchGrant(step.rev, step.policy, runtimeMinutes);
  try {
    // START FIRST. See the doc comment above — a refused start must change
    // nothing, so the release only happens once the server has accepted.
    await deps.startServerBot(characterID, scriptID, grant);
  } catch (cause) {
    return {
      kind: "refused",
      sentence: cause instanceof Error ? cause.message : "Could not start that bot on the server.",
    };
  }
  try {
    await deps.releaseSession();
  } catch {
    // The bot has the hull either way; the caller's next read notices.
  }
  return { kind: "started" };
}
