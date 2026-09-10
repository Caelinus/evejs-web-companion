// The fleet companion's launch authority and codec — the companion-shaped
// mirror of runPolicy.ts, for the reasons docs/fleet-companion-plan.md,
// "4. The headless launch grant" (DECIDED), lays out:
//
//   • `validateBotLaunchGrant` (runPolicy.ts:183) is UNCHANGED. It reads only
//     `policy.riskClasses`, so any object shaped like a `BotRunPolicy` passes
//     through it — a script's or a companion's. Keeping the two producers
//     separate and the validator singular means a companion's grant is
//     re-derived and re-checked by the exact code path a script's is, instead
//     of a second, drifting copy of that logic.
//   • A companion has no macros and no program tree, so `macroIDs` and
//     `restartBlockers` are always empty and `containsSubBots` is always
//     false — there is nothing here for either to describe.
//
// ─── Risk derivation, decided ────────────────────────────────────────────────
//
// "fleet" is UNCONDITIONAL. `decideCompanionAction`'s first rung
// (fleetCompanionLoop.ts:280) yields the ship to a fleet warp on every tick,
// server-authoritative and never opted out of, and decision 5 lets the
// companion leave and rejoin a fleet on its own initiative. Both are "fleet"
// risk on their own; the request has no field that could turn either off.
//
// ⚠ `attemptsTagging` DOES NOT GATE THIS CLASS. It is tempting to read
// `attemptsTagging: false` as "no fleet risk" — it does not follow. Tagging
// only ADDS a write to a class that unconditional warp-yield and rejoin
// already put in the set; a reader expecting the flag to switch "fleet" off
// will not find that lever here, because there is nothing left for it to
// switch.
//
// "social" is UNCONDITIONAL too. The companion's fixed surface includes a
// fleet-chat send (decision 5's rejoin protocol, and any later chat-command
// acknowledgement), and nothing on `FleetCompanionRequest` gates whether that
// send may happen — `chatCommandSenders` only narrows whose ORDERS are heard,
// never whether the companion may itself speak. If a later phase adds a field
// that actually withholds the chat send, this class stops being unconditional
// and this comment (and the one above the function) must change with it.
//
// "combat" is the only conditional class, because it is the only one with a
// field that actually withholds it: no drones and no fitted defensive module
// means nothing on the ship can be cycled into a fight, so an unarmed
// companion earns no combat authority.
//
// No other class ever applies. Nothing on the request reaches a wallet, an
// item, a mission, or a colony, so "financial", "inventory", "mission" and
// "colony" are never in the set, and there is no destructive one-shot here for
// "destructive" to describe.
//
// ─── Restart safety, decided ─────────────────────────────────────────────────
//
// Always `restartSafe: true`. Every other loop's rungs (`decideCompanionAction`
// included) re-read authoritative server state on every tick before deciding
// anything — there is no in-memory "I already asked once" the way
// `accept-mission` has (runPolicy.ts:97-99: it may decline an offer, and
// replaying the block after a restart can decline a different one). Starting
// the companion over at the top of its ladder repeats no externally visible
// call; it just asks the same questions again and gets the same answers.

import { BOT_RISK_CLASSES, type BotRiskClass, type BotRunPolicy } from "./runPolicy.ts";
import type { MacroID } from "./botScript.ts";
import {
  FLEET_COMPANION_ORDER_SOURCES,
  FLEET_COMPANION_ROLES,
  MAX_CAPACITOR_FLOOR,
  MAX_DRONE_HOLD_OFF_SECONDS,
  MAX_FLEE_ATTEMPTS,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_CAPACITOR_FLOOR,
  MIN_DRONE_HOLD_OFF_SECONDS,
  MIN_FLEE_ATTEMPTS,
  MIN_FLEE_HEALTH_FLOOR,
  type FleetCompanionOrderSource,
  type FleetCompanionRequest,
  type FleetCompanionRole,
} from "../nav/fleetCompanionLoop.ts";

const NO_MACRO_IDS: readonly MacroID[] = Object.freeze([]);

/**
 * The value a companion's launch grant carries in its `scriptRev` slot.
 *
 * A companion request has no revision SERIES: there is no library, no "rev 3 of
 * this companion setup", just the one request the operator wrote. The canonical
 * hash of that request is its real identity. This sentinel exists ONLY to fill
 * the slot `validateBotLaunchGrant` (`runPolicy.ts`) already compares a grant
 * against, so a companion's grant stays the exact shape a script's is rather
 * than growing a second field for a version that does not exist. See
 * docs/fleet-companion-handoff.md, "3. Extend botHost".
 *
 * ⚠ IT LIVES HERE, IN THE LAYER BOTH SIDES IMPORT, FOR A REASON. The BFF's bot
 * host compares it and the browser's grant-builder sends it. It was originally
 * a constant private to `src/botHost.js` whose comment instructed future callers
 * to send "this exact value" — two copies of a bare `1`, in two languages, with
 * nothing to fail if one ever changed. A grant whose revision does not match is
 * refused as stale, so a drift between those copies would read to a player as
 * "this bot changed after its run was approved" with nothing actually changed.
 */
export const COMPANION_GRANT_SCRIPT_REV = 1;

/** Build the same `BotRunPolicy` shape a script produces, from a companion request. */
export function analyzeCompanionRunPolicy(request: FleetCompanionRequest): BotRunPolicy {
  const risks = new Set<BotRiskClass>(["fleet", "social"]);
  if (request.useDrones || request.defenseModuleIDs.length > 0) {
    risks.add("combat");
  }
  return Object.freeze({
    macroIDs: NO_MACRO_IDS,
    riskClasses: Object.freeze(BOT_RISK_CLASSES.filter((risk) => risks.has(risk))),
    restartSafe: true,
    restartBlockers: NO_MACRO_IDS,
    containsSubBots: false,
  });
}

// ─── The codec door for a persisted request ──────────────────────────────────
//
// The BFF's durable bot roster persists a companion request as plain JSON and
// re-reads it on every restart (docs/fleet-companion-plan.md, "4. The headless
// launch grant"), exactly the way it re-reads a stored script document. This
// is that request's ONE gate, mirroring scriptCodec.ts's `decodeScriptValue`
// verdict shape: `{ ok: true, request }` on success, `{ ok: false, refusal }`
// with one plain sentence otherwise.
//
// Unlike `decodeScriptValue`, there is no warnings channel and no clamp-with-a-
// warning: a `FleetCompanionRequest` is flat, produced by one settings form and
// never hand-edited, so there is no "generous to a hand-edited share" case to
// serve, and every one of its numbers already has a real domain bound
// (fleetCompanionLoop.ts's `MIN_`/`MAX_` constants) rather than an arbitrary
// clamp range invented here. A value outside that bound is not a slightly-off
// number to bring back into range; it is a request this app's own UI could
// never have produced, so it refuses.
//
// UNKNOWN EXTRA KEYS ARE REFUSED, not ignored — the same choice
// `readDocument` makes for a script document (scriptCodec.ts's `unknownKey`),
// and for the same reason: a stored key this codec does not recognise is a
// field a later version wrote and this version cannot honour, and silently
// dropping it would run a request that is not the one that was saved. A
// `safeSpotBookmarkID` field is coming in a later phase and is deliberately
// OUT OF SCOPE here — this codec will need a matching update the day that
// field exists, exactly as intended.
//
// The document is flat, so — unlike the script codec's nested tree — a plain
// sequence of early returns is the clearest control flow here; there is no
// recursion depth that would make a throw-caught-at-the-boundary style earn
// its keep.

const REQUEST_KEYS = new Set<string>([
  "role",
  "defenseModuleIDs",
  "fleeHealthFloor",
  "capacitorFloor",
  "maxFleeAttempts",
  "useDrones",
  "droneRedeployHoldOffSeconds",
  "attemptsTagging",
  "obeys",
  "chatCommandSenders",
]);

/**
 * A ship has at most 8 high + 8 mid + 8 low slots on any hull in this game, so
 * 24 is a generous ceiling on "fitted defensive modules" — comfortably above
 * anything a real fit can carry, never a real limit a player would hit.
 */
const MAX_DEFENSE_MODULE_IDS = 24;

/**
 * `chatCommandSenders` names EXTRA commanders on top of whoever the fleet
 * roster already grants; a fleet does not run into the low hundreds of
 * pilots, so 64 bounds the list without ever binding an honest one.
 */
const MAX_CHAT_COMMAND_SENDERS = 64;

const SAY = {
  notObject: "This companion setup is not a valid request.",
  unknownKey: "This companion setup has settings this app does not recognise.",
  badRole: "This companion setup does not say what role the pilot should fly.",
  badDefenseModuleIDs: "This companion setup's defensive module list is not valid.",
  badFleeHealthFloor: "This companion setup's flee-health threshold is not a valid number.",
  badCapacitorFloor: "This companion setup's capacitor threshold is not a valid number.",
  badMaxFleeAttempts: "This companion setup's flee-attempt limit is not a valid number.",
  badUseDrones: "This companion setup's drone setting is not valid.",
  badDroneRedeployHoldOffSeconds: "This companion setup's drone hold-off time is not a valid number.",
  badAttemptsTagging: "This companion setup's tagging setting is not valid.",
  badObeys: "This companion setup does not say which orders the pilot listens to.",
  badChatCommandSenders: "This companion setup's list of chat commanders is not valid.",
} as const;

// Not exported: this module's public surface is exactly the two functions
// above and below. A caller narrows the return value's `ok` field directly
// rather than importing a name for its shape.
type FleetCompanionRequestVerdict =
  | { readonly ok: true; readonly request: FleetCompanionRequest }
  | { readonly ok: false; readonly refusal: string };

function isPositiveSafeIntegerArray(value: unknown, max: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
  );
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Decode an already-parsed, UNTRUSTED value into a `FleetCompanionRequest`. */
export function decodeFleetCompanionRequestValue(value: unknown): FleetCompanionRequestVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, refusal: SAY.notObject };
  }
  const obj = value as Readonly<Record<string, unknown>>;

  // Own enumerable keys only — never followed as a prototype path, only ever
  // checked against the closed key set below.
  for (const key of Object.keys(obj)) {
    if (!REQUEST_KEYS.has(key)) {
      return { ok: false, refusal: SAY.unknownKey };
    }
  }

  const role = obj["role"];
  if (typeof role !== "string" || !FLEET_COMPANION_ROLES.includes(role as FleetCompanionRole)) {
    return { ok: false, refusal: SAY.badRole };
  }

  const defenseModuleIDs = obj["defenseModuleIDs"];
  if (!isPositiveSafeIntegerArray(defenseModuleIDs, MAX_DEFENSE_MODULE_IDS)) {
    return { ok: false, refusal: SAY.badDefenseModuleIDs };
  }

  const fleeHealthFloor = obj["fleeHealthFloor"];
  if (!isFiniteNumberInRange(fleeHealthFloor, MIN_FLEE_HEALTH_FLOOR, MAX_FLEE_HEALTH_FLOOR)) {
    return { ok: false, refusal: SAY.badFleeHealthFloor };
  }

  const capacitorFloor = obj["capacitorFloor"];
  if (!isFiniteNumberInRange(capacitorFloor, MIN_CAPACITOR_FLOOR, MAX_CAPACITOR_FLOOR)) {
    return { ok: false, refusal: SAY.badCapacitorFloor };
  }

  const maxFleeAttempts = obj["maxFleeAttempts"];
  if (
    typeof maxFleeAttempts !== "number" ||
    !Number.isSafeInteger(maxFleeAttempts) ||
    maxFleeAttempts < MIN_FLEE_ATTEMPTS ||
    maxFleeAttempts > MAX_FLEE_ATTEMPTS
  ) {
    return { ok: false, refusal: SAY.badMaxFleeAttempts };
  }

  const useDrones = obj["useDrones"];
  if (typeof useDrones !== "boolean") {
    return { ok: false, refusal: SAY.badUseDrones };
  }

  const droneRedeployHoldOffSeconds = obj["droneRedeployHoldOffSeconds"];
  if (
    !isFiniteNumberInRange(droneRedeployHoldOffSeconds, MIN_DRONE_HOLD_OFF_SECONDS, MAX_DRONE_HOLD_OFF_SECONDS)
  ) {
    return { ok: false, refusal: SAY.badDroneRedeployHoldOffSeconds };
  }

  const attemptsTagging = obj["attemptsTagging"];
  if (typeof attemptsTagging !== "boolean") {
    return { ok: false, refusal: SAY.badAttemptsTagging };
  }

  const obeys = obj["obeys"];
  if (
    !Array.isArray(obeys) ||
    obeys.length > FLEET_COMPANION_ORDER_SOURCES.length ||
    obeys.some((source) => !FLEET_COMPANION_ORDER_SOURCES.includes(source as FleetCompanionOrderSource))
  ) {
    return { ok: false, refusal: SAY.badObeys };
  }

  const chatCommandSenders = obj["chatCommandSenders"];
  if (!isPositiveSafeIntegerArray(chatCommandSenders, MAX_CHAT_COMMAND_SENDERS)) {
    return { ok: false, refusal: SAY.badChatCommandSenders };
  }

  const request: FleetCompanionRequest = {
    role: role as FleetCompanionRole,
    defenseModuleIDs: Object.freeze([...defenseModuleIDs]),
    fleeHealthFloor,
    capacitorFloor,
    maxFleeAttempts,
    useDrones,
    droneRedeployHoldOffSeconds,
    attemptsTagging,
    obeys: Object.freeze([...(obeys as FleetCompanionOrderSource[])]),
    chatCommandSenders: Object.freeze([...chatCommandSenders]),
  };
  return { ok: true, request: Object.freeze(request) };
}
