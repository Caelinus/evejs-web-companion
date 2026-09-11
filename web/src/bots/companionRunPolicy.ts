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
// "social" is UNCONDITIONAL too, and this is the one class whose justification
// is FORWARD-LOOKING rather than already-exercised. Phase 8 gives the companion
// a fleet-chat surface (the command parser, the sender gate, and the
// acknowledgement a heard order needs), and nothing on `FleetCompanionRequest`
// gates whether it may speak — `chatCommandSenders` only narrows whose ORDERS
// are heard, never whether the companion itself may send.
//
// ⚠ THAT IS DELIBERATE, NOT PREMATURE. A grant describes the authority a run is
// given, not what it has already done, and the alternative is worse in a way
// pilotRoster.ts:229 spells out: it renders an empty list as the sentence "No
// consequential permissions", because "an empty list is a sentence, not a
// blank". A pilot that will write fleet tags and speak in fleet chat must not
// describe itself that way in the Bot Manager, and a class that appeared
// mid-feature would make every already-approved grant read as stale.
//
// ⚠ WHAT IT IS NOT JUSTIFIED BY, since an earlier draft of this comment said so
// and was wrong: decision 5's abandonment protocol sends NO chat. It docks,
// leaves the fleet, waits, and accepts a gated invite — see
// `decideAbandonment` in fleetCompanionLoop.ts. If a later phase adds a field
// that actually withholds the chat send, this class stops being unconditional
// and this comment (and the one above the function) must change with it.
//
// "combat" is the only conditional class, because it is the only one with a
// field that actually withholds it: no drones, no fitted defensive module,
// and no fitted remote-repair module of any family means nothing on the ship
// can be cycled into a fight — and a logistics pilot with a working
// repairer is a PARTICIPANT in a fight just as much as a gunner is, so a
// remote module alone earns the same authority a defensive one does.
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
  type CompanionAbandonmentRecord,
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
  if (
    request.useDrones ||
    request.defenseModuleIDs.length > 0 ||
    request.remoteShieldModuleIDs.length > 0 ||
    request.remoteArmorModuleIDs.length > 0 ||
    request.remoteCapacitorModuleIDs.length > 0 ||
    // A fitted weapon is combat risk with no ambiguity to argue about.
    request.weaponModuleIDs.length > 0
  ) {
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
// dropping it would run a request that is not the one that was saved. That is
// also why `safeSpotBookmarkID` had to be added to `REQUEST_KEYS` below on the
// day phase 0b gave the request that field: until then this codec REFUSED any
// request carrying it, exactly as designed.
//
// The document is flat, so — unlike the script codec's nested tree — a plain
// sequence of early returns is the clearest control flow here; there is no
// recursion depth that would make a throw-caught-at-the-boundary style earn
// its keep.

const REQUEST_KEYS = new Set<string>([
  "role",
  "defenseModuleIDs",
  "remoteShieldModuleIDs",
  "remoteArmorModuleIDs",
  "remoteCapacitorModuleIDs",
  "weaponModuleIDs",
  "fleeHealthFloor",
  "capacitorFloor",
  "maxFleeAttempts",
  "useDrones",
  "droneRedeployHoldOffSeconds",
  "attemptsTagging",
  "obeys",
  "chatCommandSenders",
  "safeSpotBookmarkID",
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

/**
 * The rejoin allowlist is the fleet-mates seen on one tick, and a fleet does not
 * run into the low hundreds of pilots — the same reasoning, and the same
 * number, as `MAX_CHAT_COMMAND_SENDERS` above.
 */
const MAX_SUPERVISOR_IDS = 64;

const SAY = {
  notObject: "This companion setup is not a valid request.",
  unknownKey: "This companion setup has settings this app does not recognise.",
  badRole: "This companion setup does not say what role the pilot should fly.",
  badDefenseModuleIDs: "This companion setup's defensive module list is not valid.",
  badRemoteShieldModuleIDs: "This companion setup's remote shield-repair module list is not valid.",
  badRemoteArmorModuleIDs: "This companion setup's remote armour-repair module list is not valid.",
  badRemoteCapacitorModuleIDs: "This companion setup's remote capacitor-transfer module list is not valid.",
  badWeaponModuleIDs: "This companion setup's weapon module list is not valid.",
  badFleeHealthFloor: "This companion setup's flee-health threshold is not a valid number.",
  badCapacitorFloor: "This companion setup's capacitor threshold is not a valid number.",
  badMaxFleeAttempts: "This companion setup's flee-attempt limit is not a valid number.",
  badUseDrones: "This companion setup's drone setting is not valid.",
  badDroneRedeployHoldOffSeconds: "This companion setup's drone hold-off time is not a valid number.",
  badAttemptsTagging: "This companion setup's tagging setting is not valid.",
  badObeys: "This companion setup does not say which orders the pilot listens to.",
  badChatCommandSenders: "This companion setup's list of chat commanders is not valid.",
  badSafeSpotBookmarkID: "This companion setup's safe-spot bookmark is not valid.",
  badAbandonment: "This pilot's saved supervision state is not valid.",
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

  // Same shape and same bound as `defenseModuleIDs` above, by family — a
  // wrong guess here cycles the wrong repairer, so each is the player's own
  // pick, never guessed (see the request field's own comment).
  const remoteShieldModuleIDs = obj["remoteShieldModuleIDs"];
  if (!isPositiveSafeIntegerArray(remoteShieldModuleIDs, MAX_DEFENSE_MODULE_IDS)) {
    return { ok: false, refusal: SAY.badRemoteShieldModuleIDs };
  }
  const remoteArmorModuleIDs = obj["remoteArmorModuleIDs"];
  if (!isPositiveSafeIntegerArray(remoteArmorModuleIDs, MAX_DEFENSE_MODULE_IDS)) {
    return { ok: false, refusal: SAY.badRemoteArmorModuleIDs };
  }
  const remoteCapacitorModuleIDs = obj["remoteCapacitorModuleIDs"];
  if (!isPositiveSafeIntegerArray(remoteCapacitorModuleIDs, MAX_DEFENSE_MODULE_IDS)) {
    return { ok: false, refusal: SAY.badRemoteCapacitorModuleIDs };
  }
  // ABSENT DECODES TO EMPTY, on the same grounds as `safeSpotBookmarkID` below:
  // a request written before this field existed still reads, and it costs
  // nothing because the two mean the same thing. Empty is "lock what the fleet
  // calls, never fire" -- exactly what such a request already did.
  //
  // ⚠ THIS IS NOT PEDANTRY, IT IS THE RESTART PATH. `src/botHost.js` puts a
  // persisted roster row's own `request` back through this decoder on every BFF
  // restart, because for a companion that row IS the authority -- there is no
  // library entry to re-bind to. A strictly-required new field would refuse
  // every row written before it, and a headless companion would quietly fail to
  // come back from a restart it used to survive.
  const weaponRaw = obj["weaponModuleIDs"];
  const weaponModuleIDs = weaponRaw === undefined ? [] : weaponRaw;
  if (!isPositiveSafeIntegerArray(weaponModuleIDs, MAX_DEFENSE_MODULE_IDS)) {
    return { ok: false, refusal: SAY.badWeaponModuleIDs };
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

  // `null` is a REAL value here, not an absent one — "no safe spot has been
  // named" is the answer for most requests, and the ladder acts on it (it stops
  // rather than inventing somewhere to hide). Absent decodes to null so a
  // request written before this field existed still reads, which costs nothing:
  // the two mean the same thing.
  const safeSpotRaw = obj["safeSpotBookmarkID"];
  if (
    safeSpotRaw !== undefined &&
    safeSpotRaw !== null &&
    !(typeof safeSpotRaw === "number" && Number.isSafeInteger(safeSpotRaw) && safeSpotRaw > 0)
  ) {
    return { ok: false, refusal: SAY.badSafeSpotBookmarkID };
  }
  const safeSpotBookmarkID = typeof safeSpotRaw === "number" ? safeSpotRaw : null;

  const request: FleetCompanionRequest = {
    role: role as FleetCompanionRole,
    defenseModuleIDs: Object.freeze([...defenseModuleIDs]),
    remoteShieldModuleIDs: Object.freeze([...remoteShieldModuleIDs]),
    remoteArmorModuleIDs: Object.freeze([...remoteArmorModuleIDs]),
    remoteCapacitorModuleIDs: Object.freeze([...remoteCapacitorModuleIDs]),
    weaponModuleIDs: Object.freeze([...weaponModuleIDs]),
    fleeHealthFloor,
    capacitorFloor,
    maxFleeAttempts,
    useDrones,
    droneRedeployHoldOffSeconds,
    attemptsTagging,
    obeys: Object.freeze([...(obeys as FleetCompanionOrderSource[])]),
    chatCommandSenders: Object.freeze([...chatCommandSenders]),
    safeSpotBookmarkID,
  };
  return { ok: true, request: Object.freeze(request) };
}

// ─── The codec door for a persisted ABANDONMENT ──────────────────────────────
//
// Decision 5's thirty-minute wait is only a bound if its clock outlives a BFF
// restart, so the roster row carries it — and a value read back off disk is
// untrusted bytes for exactly the same reason the request beside it is. This is
// its one gate, in the same verdict shape.
//
// ⚠ THE CLOCK IS REFUSED IF IT IS IN THE FUTURE. `abandonedAtMs` is only ever
// written from this host's own clock, so a timestamp ahead of now is either a
// corrupted row or an edited one — and the failure it would cause is the whole
// point of persisting it: an abandonment dated an hour from now never expires,
// which is the unbounded wait the persistence exists to prevent. A row that
// cannot be trusted is refused, and a refused row starts a FRESH thirty
// minutes, which is bounded and safe.
//
// ⚠ AN EMPTY `supervisorCharacterIDs` IS VALID AND MEANS SOMETHING. It is what
// a companion abandoned before it ever saw a human legitimately has, and it
// reads as "accept no invite from anyone" — the safe direction. It must not be
// confused with a missing field, which is refused.

const ABANDONMENT_KEYS = new Set<string>(["abandonedAtMs", "supervisorCharacterIDs"]);

type CompanionAbandonmentVerdict =
  | { readonly ok: true; readonly abandonment: CompanionAbandonmentRecord }
  | { readonly ok: false; readonly refusal: string };

/** Decode an already-parsed, UNTRUSTED value into a `CompanionAbandonmentRecord`. */
export function decodeCompanionAbandonmentValue(
  value: unknown,
  nowMs: number = Date.now(),
): CompanionAbandonmentVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  const obj = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(obj)) {
    if (!ABANDONMENT_KEYS.has(key)) {
      return { ok: false, refusal: SAY.badAbandonment };
    }
  }
  const abandonedAtMs = obj["abandonedAtMs"];
  if (
    typeof abandonedAtMs !== "number" ||
    !Number.isSafeInteger(abandonedAtMs) ||
    abandonedAtMs <= 0 ||
    abandonedAtMs > nowMs
  ) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  const supervisorCharacterIDs = obj["supervisorCharacterIDs"];
  if (!isPositiveSafeIntegerArray(supervisorCharacterIDs, MAX_SUPERVISOR_IDS)) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  return {
    ok: true,
    abandonment: Object.freeze({
      abandonedAtMs,
      supervisorCharacterIDs: Object.freeze([...supervisorCharacterIDs]),
    }),
  };
}
