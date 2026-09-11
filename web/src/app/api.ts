// Typed BFF endpoints for the R2 page flow: who-cares login, persistent-
// session select/release. The bridge call tuple itself goes through
// bridge/callMethod.ts; these are the BFF's own session routes
// (docs/bridge-wire-contract.md, "BFF routes").
//
// The opaque bridgeSessionID never appears here: the BFF holds it server-side
// in its cookie-session store and attaches it to bridge calls itself.

import { BridgeCallError, callMethod } from "../bridge/callMethod.ts";
import { decodeBoundDogma, type BoundDogma } from "../bridge/boundDogma.ts";
import { decodeNameValidation, decodeValidRandomName } from "../bridge/charAccount.ts";
import { decodeAcceptContractAck, type AcceptContractAck } from "../bridge/contractWrites.ts";
import { decodeBeyonceWriteAck, type BeyonceWriteAck } from "../bridge/boundBeyonceWrites.ts";
import { decodeFleetApplyOutcome, type FleetApplyOutcome } from "../bridge/fleetWrites.ts";
import {
  decodeCharCreationTables,
  type CharCreationTables,
} from "../bridge/charCreation.ts";
import {
  clearSessionToken,
  sessionAuthHeaders,
  setSessionToken,
  tokenAuthHeaders,
  withSessionTokenQuery,
  withTokenQuery,
} from "./sessionToken.ts";
import {
  TransportQueueError,
  bridgeLane,
  type RequestPriority,
} from "./transport.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type {
  AgentRow,
  IndustryActivity,
  InventoryPlace,
  OnlineCharacterState,
  SlotFamily,
  StationStatic,
} from "../store/types.ts";
import type { NameRef } from "../store/names.ts";
import type { BotLaunchGrant, BotRiskClass } from "../bots/runPolicy.ts";
import type { FleetCompanionRequest } from "../nav/fleetCompanionLoop.ts";
import type {
  ScannerOperationsSnapshot,
  ScannerProbeOperation,
} from "../scanner/scannerCenter.ts";

export interface LoginResult {
  readonly accountID: number;
  readonly username: string;
  /** R2: true when this login auto-created the account on the server. */
  readonly accountCreated: boolean;
  /**
   * R107 — the signed session token the BFF handed back, so a per-session flow
   * can capture it onto its own call options instead of the per-tab global.
   * Null when the BFF returned no token (it always does on success today).
   */
  readonly sessionToken: string | null;
}

export interface SelectResult {
  readonly character: OnlineCharacterState;
  readonly station: StationStatic | null;
  readonly notifications: readonly JsonValue[];
}

export interface ApiOptions {
  /** Base URL prefix; default "" (same-origin against the BFF). */
  readonly baseUrl?: string;
  /** Injectable fetch for tests; default globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /**
   * R107 multibox — this call's OWN session token, threaded per flow so several
   * live characters can share one browser tab. When the `token` KEY is present
   * (even as null), this call is per-session: it authenticates with exactly this
   * token (Bearer when a non-empty string, no auth header when null) and NEVER
   * falls back to the per-tab global. When the key is ABSENT, the call keeps the
   * pre-R107 behavior and rides the global `sessionAuthHeaders()` / cookie. The
   * presence of the key — not its value — is what selects the mode.
   */
  readonly token?: string | null;
  /**
   * R92 — how this request competes for the client's request lanes. Defaults to
   * "read". Background polling should pass "poll" and anything the player just
   * clicked should pass "user"; see app/transport.ts for why a click must never
   * queue behind a poll.
   */
  readonly priority?: RequestPriority;
}

// R42/R107 — THE one place every BFF request in this file picks up its session
// token. Two modes, chosen by whether `options.token` is present:
//   • per-session (R107 multibox, key present): this flow's OWN token goes on as
//     `Authorization: Bearer`, and it NEVER falls back to the global — so a
//     backgrounded pilot's self-refresh can never ride the active pilot's token.
//   • single-session (pre-R107, key absent): the per-tab global token
//     (sessionStorage) rides as before, with the cookie under
//     `credentials: "same-origin"` as the migration fallback.
// Attaching it here rather than at each call site is the point: there are well
// over a hundred callers below and none of them should know about it.
/**
 * The browser-side deadline on every BFF request. The BFF's own longest legal
 * wait is a session-change route: the ten-second next-mutation cooldown plus
 * the forty-five-second readiness barrier — so this sits safely above that.
 * Without ANY deadline, a half-dead socket (sleeping laptop, wedged proxy)
 * froze a bot mid-tick forever with the panel saying "running": the await
 * simply never settled, and no bound can count a tick that never ends. The
 * abort surfaces as BRIDGE_NETWORK_ERROR, which the loops already treat as
 * transport-transient (settle, re-observe, bounded retry).
 */
const REQUEST_DEADLINE_MS = 65_000;

/**
 * What actually went wrong with a request that never produced a response.
 *
 * ⚠ THE POINT IS THE STATE OF THE LANE, NOT THE REQUEST THAT FAILED. The field
 * reports this was written for named a journal read, the space snapshot and a
 * location read — three unrelated routes failing in the same moment, which is
 * never three faults. It is one: the server stopped answering, everything piled
 * up behind it, and the request the player happened to make was a bystander.
 * Naming the bystander sends whoever reads the report to the wrong route, so the
 * lane's own verdict is appended to every transport failure.
 */
export function transportFailureWords(path: string, cause: unknown): string {
  if (cause instanceof TransportQueueError) {
    // It never left the browser, so there is nothing to say about the server.
    return cause.message;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `${path} could not reach the BFF: ${detail} — ${bridgeLane.diagnose().verdict}`;
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    // ⚠ THE DEADLINE IS ARMED INSIDE THE LANE, NOT OUTSIDE IT. A request that
    // waited for a free lane must arrive at the server with its full budget; if
    // the clock started when the call was made, a queued request would time out
    // against a server that answered promptly. See app/transport.ts.
    response = await bridgeLane.run(options.priority ?? "read", path, () =>
      doFetch(`${options.baseUrl ?? ""}${path}`, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        ...init,
        headers: {
          ...("token" in options ? tokenAuthHeaders(options.token) : sessionAuthHeaders()),
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
      }),
    );
  } catch (cause) {
    throw new BridgeCallError(
      "BRIDGE_NETWORK_ERROR",
      transportFailureWords(path, cause),
      0,
      cause instanceof TransportQueueError
        ? cause.diagnosis.verdict
        : bridgeLane.diagnose().verdict,
    );
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    throw new BridgeCallError(
      "BRIDGE_BAD_RESPONSE",
      `${path} returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { ok?: unknown }).ok !== true ||
    !response.ok
  ) {
    const errorBody = (data ?? {}) as { error?: unknown; message?: unknown };
    throw new BridgeCallError(
      typeof errorBody.error === "string" ? errorBody.error : "BRIDGE_BAD_RESPONSE",
      typeof errorBody.message === "string"
        ? errorBody.message
        : `${path} failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  return data as Record<string, JsonValue>;
}

async function postJson(
  path: string,
  body: unknown,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  return requestJson(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
}

async function getJson(
  path: string,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  return requestJson(path, { method: "GET" }, options);
}

function asNumberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Who-cares login (roadmap section 6): any password signs an existing account in. */
export async function login(
  username: string,
  password: string,
  options: ApiOptions = {},
): Promise<LoginResult> {
  const data = await postJson("/api/login", { username, password }, options);
  const sessionToken =
    typeof data.sessionToken === "string" && data.sessionToken.length > 0
      ? data.sessionToken
      : null;
  // R42/R107: where the token lands depends on the mode.
  //   • single-session (no `token` key): take it into this TAB's global storage
  //     so every later request — and the SSE stream — carries this identity
  //     rather than whichever account last wrote the shared cookie.
  //   • per-session (key present): do NOT touch the global, or a second login in
  //     the same tab would collapse every flow onto the last account. The caller
  //     captures the returned token onto its own call options instead.
  if (sessionToken !== null && !("token" in options)) {
    setSessionToken(sessionToken);
  }
  const account = (data.account ?? {}) as { accountID?: JsonValue; username?: JsonValue };
  return {
    accountID: asNumberOrNull(account.accountID) ?? 0,
    username: typeof account.username === "string" ? account.username : username,
    accountCreated: data.accountCreated === true,
    sessionToken,
  };
}

export async function logout(options: ApiOptions = {}): Promise<void> {
  try {
    await postJson("/api/logout", {}, options);
  } finally {
    // R42/R107 — logout clears the carriers the BFF expires the cookie itself.
    // In single-session mode this also drops the tab's stored global token; in
    // per-session mode the global was never written (the flow owns its token and
    // clears its own call options), so leave it untouched. In a `finally`
    // because a logout that failed on the wire must still sign this session out
    // locally, or the next request would wear a session the player thinks they
    // left.
    if (!("token" in options)) {
      clearSessionToken();
    }
  }
}

/**
 * Bring a character online on a persistent browser-backed session:
 * POST /api/bridge/select dispatches the retail tuple
 * charUnboundMgr.SelectCharacterID on a gateway-minted live session and
 * returns the docked entry state (plus client-local static station identity).
 */
export async function selectCharacter(
  characterID: number,
  options: ApiOptions = {},
): Promise<SelectResult> {
  const data = await postJson("/api/bridge/select", { characterID }, options);
  const character = (data.character ?? {}) as Record<string, JsonValue>;
  const station = data.station;
  return {
    character: {
      characterID: asNumberOrNull(character.characterID) ?? characterID,
      characterName:
        typeof character.characterName === "string" ? character.characterName : "",
      stationID: asNumberOrNull(character.stationID),
      structureID: asNumberOrNull(character.structureID),
      solarSystemID: asNumberOrNull(character.solarSystemID),
      corporationID: asNumberOrNull(character.corporationID),
    },
    station:
      typeof station === "object" && station !== null && !Array.isArray(station)
        ? (station as unknown as StationStatic)
        : null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

// --- character creation -------------------------------------------------------
//
// All four of these run with NO CHARACTER ONLINE, which is the whole point: this
// is the screen a fresh account lands on. The two bridge reads go through the
// generic /api/bridge/call route, which falls back to a userid-only session when
// the BFF holds none; the picker read and the create write have their own
// account-level BFF routes (see accountLevelCall in src/server.js).

/** What the create screen asks for. Everything not named here the server rolls. */
export interface CreateCharacterRequest {
  readonly name: string;
  readonly raceID: number;
  /** 0 = female, 1 = male (carbon's genderFemale/genderMale). */
  readonly genderID: number;
  /** Omit to have the server roll one within the race. */
  readonly bloodlineID?: number;
  /** Omit to have the server roll one within the bloodline. */
  readonly ancestryID?: number;
}

export interface CreateCharacterResult {
  readonly characterID: number | null;
  /** What the rolls landed on, so the screen can say what it made. */
  readonly bloodlineID: number | null;
  readonly ancestryID: number | null;
}

/**
 * The create screen's picker tables: the world's own races and bloodlines
 * (retail, authoritative) joined with the SDE's ancestries.
 */
export async function loadCharCreationInfo(
  options: ApiOptions = {},
): Promise<CharCreationTables> {
  const data = await getJson("/api/bridge/char-creation-info", options);
  return decodeCharCreationTables(data as JsonValue);
}

/**
 * Create a character. CONFIRM-GATED at the BFF — `confirm: true` is not
 * ceremony, it is the difference between this route being reachable and being
 * fired, and the BFF refuses without it.
 *
 * The retail tuple is composed server-side from these named fields; a bloodline
 * that does not belong to the race, or an ancestry that does not belong to the
 * bloodline, is REFUSED there rather than corrected.
 */
export async function createCharacter(
  request: CreateCharacterRequest,
  options: ApiOptions = {},
): Promise<CreateCharacterResult> {
  const data = await postJson(
    "/api/bridge/character/create-with-doll",
    {
      name: request.name,
      raceID: request.raceID,
      genderID: request.genderID,
      ...(request.bloodlineID ? { bloodlineID: request.bloodlineID } : {}),
      ...(request.ancestryID ? { ancestryID: request.ancestryID } : {}),
      confirm: true,
    },
    options,
  );
  return {
    characterID: asNumberOrNull(data.characterID),
    bloodlineID: asNumberOrNull(data.bloodlineID),
    ancestryID: asNumberOrNull(data.ancestryID),
  };
}

/**
 * Ask the server whether a name is acceptable (charUnboundMgr.ValidateNameEx).
 *
 * ⚠ THE SERVER HAS THE LAST WORD ANYWAY — CreateCharacterWithDoll runs the same
 * validateCharacterName and rejects with CharNameInvalid. This read exists so a
 * refusal arrives while the player is typing rather than after they commit, and
 * so uniqueness (which no client-side rule can know) is checked against the real
 * roster. A null code means the read itself did not answer; that is not a
 * verdict, and the screen must not treat it as one.
 */
export async function validateCharacterName(
  name: string,
  options: ApiOptions = {},
): Promise<number | null> {
  const outcome = await callMethod("charUnboundMgr", "ValidateNameEx", [name], null, options);
  return decodeNameValidation(outcome.result);
}

/** A random valid name for a race (charUnboundMgr.GetValidRandomName). */
export async function rollRandomCharacterName(
  raceID: number,
  options: ApiOptions = {},
): Promise<string | null> {
  const outcome = await callMethod(
    "charUnboundMgr",
    "GetValidRandomName",
    [raceID],
    null,
    options,
  );
  return decodeValidRandomName(outcome.result);
}

/**
 * Read-only static station identity by ID (goal R6b): the same client-local
 * StationStatic the select route returns, fetched so the Station panel can
 * refresh its identity after the docked station changes (autopilot arrival /
 * manual dock). Not a gateway/bridge call — read-only static reference data.
 */
export async function loadStationStatic(
  stationID: number,
  options: ApiOptions = {},
): Promise<StationStatic | null> {
  const data = await getJson(`/api/map/station/${stationID}`, options);
  const station = data.station;
  return typeof station === "object" && station !== null && !Array.isArray(station)
    ? (station as unknown as StationStatic)
    : null;
}

/** Release the persistent session (character goes offline via the retail disconnect path). */
export async function releaseSession(
  options: ApiOptions = {},
): Promise<{ released: boolean }> {
  const data = await postJson("/api/bridge/release", {}, options);
  return { released: data.released === true };
}

// --- R3 Inventory & Ship (bound-object bridge) -----------------------------
// The browser addresses items/ships by their game IDs; the BFF holds the
// bound-object handles and returns the raw retail-shaped List/GetCapacity
// results, which app/flow.ts decodes with bridge/inventoryShip.ts.

/** One inventory container's raw reads (retail-shaped; decoded in the flow). */
export interface RawContainer {
  readonly list: JsonValue;
  readonly capacity: JsonValue;
  readonly error: string | null;
}

export interface RawInventoryPanel {
  readonly stationID: number | null;
  readonly activeShipID: number | null;
  readonly hangar: RawContainer;
  readonly cargo: RawContainer & { readonly shipID: number | null };
  /** Per-type m³ from static data (typeID → volume); a type it does not know is absent. */
  readonly volumes: Readonly<Record<string, number>>;
}

function readRawContainer(value: JsonValue | undefined): RawContainer {
  const container = (value ?? {}) as Record<string, JsonValue>;
  return {
    list: container.list ?? null,
    capacity: container.capacity ?? null,
    error: typeof container.error === "string" ? container.error : null,
  };
}

/** Load the full Inventory & Ship panel (station hangar + active-ship cargo). */
export async function loadInventory(
  options: ApiOptions = {},
): Promise<RawInventoryPanel> {
  const data = await getJson("/api/bridge/inventory", options);
  const cargo = (data.cargo ?? {}) as Record<string, JsonValue>;
  const volumes =
    data.volumes && typeof data.volumes === "object" && !Array.isArray(data.volumes)
      ? (data.volumes as Record<string, number>)
      : {};
  return {
    stationID: asNumberOrNull(data.stationID),
    activeShipID: asNumberOrNull(data.activeShipID),
    hangar: readRawContainer(data.hangar),
    cargo: { ...readRawContainer(data.cargo), shipID: asNumberOrNull(cargo.shipID) },
    volumes,
  };
}

/** Move one item hangar <-> active-ship cargo. */
export async function moveItem(
  itemID: number,
  direction: "toCargo" | "toHangar",
  qty: number | null,
  options: ApiOptions = {},
): Promise<void> {
  const body: Record<string, JsonValue> = { itemID, direction };
  if (qty !== null) {
    body.qty = qty;
  }
  await postJson("/api/bridge/inventory/move", body, options);
}

/** Stack all loose stacks in the hangar or the active-ship cargo. */
export async function stackItems(
  target: "hangar" | "cargo",
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/inventory/stack", { target }, options);
}

/** Board a ship sitting in the station hangar (it becomes the active ship). */
export async function boardShip(
  shipID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/ship/board", { shipID }, options);
}

/**
 * Board the character's corvette while docked (the retail station-services
 * "Board my Corvette"): the server spawns one in the hangar if needed, applies
 * its starter fit, and makes it the active ship. The route's confirm gate
 * protects against stray POSTs; the deliberate button press satisfies it here.
 */
export async function boardCorvette(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/ship/board-corvette", { confirm: true }, options);
}

/**
 * Leave the active ship while docked — the character ends up in their capsule
 * (the server creates one at the station if none exists). The ship stays in
 * the hangar, so this is reversible by boarding it again.
 */
export async function leaveShip(
  shipID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/ship/leave", { shipID, confirm: true }, options);
}

// --- R14 Inventory depth + corporation hangars ------------------------------
// The browser names a PLACE — the hangar, the ship's cargo, a container, a
// corporation division by its ordinal — and the BFF maps that to the retail
// flagIDs. No flag number is ever sent from here.

/**
 * What a mutation ACTUALLY did, re-read by the BFF after the call. invbroker
 * declines silently in several branches (a source location that no longer
 * matches, no room, a division the character cannot take from): it returns null
 * WITHOUT raising, so a 200 is not proof anything moved. `declinedSilently`
 * means the server refused and gave no reason — which is reported as exactly
 * that rather than dressed up as a cause.
 */
export interface TransferResult {
  readonly applied: boolean;
  readonly moved: readonly number[];
  readonly declined: readonly number[];
  readonly declinedSilently: boolean;
  readonly notFound: readonly number[];
}

function asNumberList(value: JsonValue | undefined): readonly number[] {
  return Array.isArray(value) ? value.map((entry) => Number(entry) || 0).filter((id) => id > 0) : [];
}

/**
 * Move items between any two places. One call carries them all, because they
 * are the same retail call with different arguments: a single item with a
 * `qty` is a SPLIT (a partial-quantity Add), several items are one MultiAdd.
 */
export async function transferItems(
  itemIDs: readonly number[],
  from: InventoryPlace,
  to: InventoryPlace,
  qty: number | null = null,
  options: ApiOptions = {},
): Promise<TransferResult> {
  const body: Record<string, JsonValue> = {
    itemIDs: [...itemIDs],
    from: from as unknown as JsonValue,
    to: to as unknown as JsonValue,
  };
  if (qty !== null) {
    body.qty = qty;
  }
  const data = await postJson("/api/bridge/inventory/transfer", body, options);
  return {
    applied: data.applied === true,
    moved: asNumberList(data.moved),
    declined: asNumberList(data.declined),
    declinedSilently: data.declinedSilently === true,
    notFound: asNumberList(data.notFound),
  };
}

export interface MergeResult {
  readonly applied: boolean;
  readonly merged: number;
  readonly declinedSilently: boolean;
}

/** Re-merge one stack into another of the same type (drag-onto-stack). */
export async function mergeStacks(
  sourceItemID: number,
  destinationItemID: number,
  place: InventoryPlace,
  qty: number | null = null,
  options: ApiOptions = {},
): Promise<MergeResult> {
  const body: Record<string, JsonValue> = {
    sourceItemID,
    destinationItemID,
    place: place as unknown as JsonValue,
  };
  if (qty !== null) {
    body.qty = qty;
  }
  const data = await postJson("/api/bridge/inventory/merge", body, options);
  return {
    applied: data.applied === true,
    merged: Number(data.merged) || 0,
    declinedSilently: data.declinedSilently === true,
  };
}

export interface TrashResult {
  readonly applied: boolean;
  readonly destroyed: readonly number[];
  readonly survived: readonly number[];
  readonly declinedSilently: boolean;
}

/**
 * DESTROY items. Irreversible, so the BFF refuses outright without `confirm`,
 * and the UI asks first — this flag is the second gate behind that, exactly as
 * the rig destroy is fenced.
 */
export async function trashItems(
  itemIDs: readonly number[],
  place: InventoryPlace,
  options: ApiOptions = {},
): Promise<TrashResult> {
  const data = await postJson(
    "/api/bridge/inventory/trash",
    { itemIDs: [...itemIDs], place: place as unknown as JsonValue, confirm: true },
    options,
  );
  return {
    applied: data.applied === true,
    destroyed: asNumberList(data.destroyed),
    survived: asNumberList(data.survived),
    declinedSilently: data.declinedSilently === true,
  };
}

export interface RawContainerReads {
  readonly containerID: number;
  readonly list: JsonValue;
  readonly capacity: JsonValue;
  /** Per-type m³ for the rows above, so a caller can work out what FITS. */
  readonly volumes: Readonly<Record<string, number>>;
}

/** Open a container and read its contents. */
export async function openContainer(
  containerID: number,
  options: ApiOptions = {},
): Promise<RawContainerReads> {
  const data = await getJson(`/api/bridge/inventory/container/${containerID}`, options);
  return {
    containerID: asNumberOrNull(data.containerID) ?? containerID,
    list: data.list ?? null,
    capacity: data.capacity ?? null,
    // Normalised here, exactly as the inventory panel's read does it: a bridge
    // that does not send the field yields an empty map, which reads downstream
    // as "no volume known for this type" rather than as zero.
    volumes:
      data.volumes && typeof data.volumes === "object" && !Array.isArray(data.volumes)
        ? (data.volumes as Record<string, number>)
        : {},
  };
}

/** A ship's bays as the BFF reports them (goal R40); still to be decoded. */
export interface RawShipBaysResult {
  readonly shipID: number;
  readonly bays: JsonValue;
}

/**
 * Read which bays a ship has, how full each is, and what is in it. Works for
 * ANY ship the character can see — the one they are flying and the ones sitting
 * in the hangar alike.
 */
export async function getShipBays(
  shipID: number,
  options: ApiOptions = {},
  keys: readonly string[] = [],
): Promise<RawShipBaysResult> {
  // Naming the bays turns 27 capacity calls into as many as were asked for,
  // which is what makes this affordable on a bot's loot path rather than only
  // once for a panel.
  const query = keys.length > 0 ? `?keys=${encodeURIComponent(keys.join(","))}` : "";
  const data = await getJson(`/api/bridge/ship/${shipID}/bays${query}`, options);
  return {
    shipID: asNumberOrNull(data.shipID) ?? shipID,
    bays: data.bays ?? null,
  };
}

/** One corporation hangar division as the BFF reports it (rows still raw). */
export interface RawCorpDivision {
  readonly division: number;
  readonly name: string | null;
  readonly list: JsonValue;
  readonly error: string | null;
}

export interface RawCorpHangar {
  readonly available: boolean;
  readonly reason: string | null;
  readonly divisions: readonly RawCorpDivision[];
}

/**
 * Read the corporation hangar at the docked station: which divisions exist,
 * what they are CALLED, and what is in each. A division the character lacks
 * the query role for simply reads empty — the server filters it, and that
 * filtering is the authority (the UI's own greying-out is cosmetic).
 */
export async function loadCorpHangar(options: ApiOptions = {}): Promise<RawCorpHangar> {
  const data = await getJson("/api/bridge/inventory/corp", options);
  const divisions = Array.isArray(data.divisions) ? data.divisions : [];
  return {
    available: data.available === true,
    reason: typeof data.reason === "string" ? data.reason : null,
    divisions: divisions.map((entry) => {
      const row = (entry ?? {}) as Record<string, JsonValue>;
      return {
        division: Number(row.division) || 0,
        name: typeof row.name === "string" && row.name !== "" ? row.name : null,
        list: row.list ?? null,
        error: typeof row.error === "string" ? row.error : null,
      };
    }),
  };
}

// --- R12 Ship fitting ------------------------------------------------------
// The BFF drives the same bound-object two-step as the inventory routes (a
// slot flag instead of hangar/cargo) and returns the raw retail-shaped reads,
// decoded in the flow with bridge/fitting.ts. The browser addresses a SLOT by
// family + index ("the third high slot") — slot flagIDs live on the BFF only.

/** The raw fitting reads (retail-shaped; decoded in the flow). */
export interface RawFittingReads {
  readonly activeShipID: number | null;
  readonly slots: JsonValue;
  readonly shipInfo: JsonValue;
  readonly online: JsonValue;
  readonly errors: {
    readonly slots: string | null;
    readonly shipInfo: string | null;
    readonly online: string | null;
  };
  /**
   * Per-module-type charge fitment, for SORTING the ammo picker only. Advisory:
   * the server decides what actually loads.
   */
  readonly chargeFits: JsonValue;
}

/** Read the active ship's fitting: slots, resources, and online state. */
export async function loadFitting(options: ApiOptions = {}): Promise<RawFittingReads> {
  const data = await getJson("/api/bridge/fitting", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    activeShipID: asNumberOrNull(data.activeShipID),
    slots: data.slots ?? null,
    shipInfo: data.shipInfo ?? null,
    online: data.online ?? null,
    chargeFits: data.chargeFits ?? null,
    errors: {
      slots: typeof errors.slots === "string" ? errors.slots : null,
      shipInfo: typeof errors.shipInfo === "string" ? errors.shipInfo : null,
      online: typeof errors.online === "string" ? errors.online : null,
    },
  };
}

/**
 * A fitting change's outcome. `applied` is the BFF's RE-READ of the slots
 * after the call, not an echo of the request: the server can decline a fit
 * silently (a module you have no skill for simply does not move), so a
 * successful response is not on its own proof anything happened.
 */
export interface FittingChangeResult {
  readonly applied: boolean;
}

/** Fit a module from the station hangar or the ship's cargo into a slot. */
export async function fitModule(
  itemID: number,
  source: "hangar" | "cargo",
  slot: { readonly family: SlotFamily; readonly index: number } | "auto",
  options: ApiOptions = {},
): Promise<FittingChangeResult> {
  const body: Record<string, JsonValue> =
    slot === "auto"
      ? { itemID, source, family: "auto" }
      : { itemID, source, family: slot.family, index: slot.index };
  const data = await postJson("/api/bridge/fitting/fit", body, options);
  return { applied: data.applied === true };
}

/** Unfit a module back to the station hangar or the ship's cargo. */
export async function unfitModule(
  itemID: number,
  destination: "hangar" | "cargo",
  options: ApiOptions = {},
): Promise<FittingChangeResult> {
  const data = await postJson(
    "/api/bridge/fitting/unfit",
    { itemID, destination },
    options,
  );
  return { applied: data.applied === true };
}

/**
 * Bring a fitted module online or take it offline. A refusal (not enough CPU
 * or powergrid, capacitor, max online of that group) arrives as the handler's
 * OWN message on a typed BridgeCallError — it is never guessed here.
 */
export async function setModuleOnline(
  itemID: number,
  online: boolean,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/fitting/state", { itemID, online }, options);
}

/**
 * DESTROY a fitted rig. Rigs cannot be unfitted — removing one destroys it —
 * so the BFF refuses this call outright unless `confirm` is true. The UI asks
 * first; this flag is the second gate behind that.
 */
export async function destroyRig(
  itemID: number,
  options: ApiOptions = {},
): Promise<FittingChangeResult> {
  const data = await postJson(
    "/api/bridge/fitting/destroy-rig",
    { itemID, confirm: true },
    options,
  );
  return { applied: data.applied === true };
}

/**
 * R21 slice B — the bound-dogma snapshot: the active ship and every fitted
 * module, each with the SERVER's post-dogma attribute map (skills + hull +
 * in-space effects already applied). Read alongside the fitting panel so a
 * clicked module can show its EFFECTIVE stats; decoded by bridge/boundDogma.ts,
 * which folds each of the 11 independent reads' {result}/{error} envelopes into
 * typed cells. The Fitting window consumes only `allInfo`.
 */
export async function boundDogma(options: ApiOptions = {}): Promise<BoundDogma> {
  const data = await getJson("/api/bridge/bound-dogma", options);
  return decodeBoundDogma(data);
}

// --- R15 Industry ----------------------------------------------------------
// Industry needs no bound-object machinery: the whole retail surface is
// top-level, so the BFF simply issues five independent calls and hands back
// their raw retail-shaped results, decoded in the flow with bridge/industry.ts.
// Names and recipes come separately from static data, which never varies by
// player and so never needs the live session at all.

/** One of the five industry reads, with its own error (they are independent). */
export interface RawIndustryRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

export interface RawIndustryReads {
  readonly ownerID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly blueprints: RawIndustryRead;
  readonly jobs: RawIndustryRead;
  readonly jobCounts: RawIndustryRead;
  readonly facilities: RawIndustryRead;
  readonly activityModifiers: RawIndustryRead;
}

function asIndustryRead(value: JsonValue | undefined): RawIndustryRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

/** Read the player's blueprints, jobs, job slots, and available facilities. */
export async function loadIndustry(options: ApiOptions = {}): Promise<RawIndustryReads> {
  const data = await getJson("/api/bridge/industry", options);
  return {
    ownerID: asNumberOrNull(data.ownerID),
    stationID: asNumberOrNull(data.stationID),
    solarSystemID: asNumberOrNull(data.solarSystemID),
    blueprints: asIndustryRead(data.blueprints),
    jobs: asIndustryRead(data.jobs),
    jobCounts: asIndustryRead(data.jobCounts),
    facilities: asIndustryRead(data.facilities),
    activityModifiers: asIndustryRead(data.activityModifiers),
  };
}

/**
 * The static recipes for a set of blueprint types: which activities each one
 * supports, what they consume, and how long they take. Read-only reference
 * data — no live session is involved, so this survives a lost bridge session.
 */
export async function loadIndustryDefinitions(
  blueprintTypeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  if (blueprintTypeIDs.length === 0) {
    return {};
  }
  const data = await postJson(
    "/api/industry/blueprints",
    { blueprintTypeIDs: [...blueprintTypeIDs] },
    options,
  );
  const definitions = data.definitions;
  return typeof definitions === "object" && definitions !== null && !Array.isArray(definitions)
    ? (definitions as Readonly<Record<string, JsonValue>>)
    : {};
}

/** What an install would draw on: the request the preview and the install share. */
export interface IndustryJobRequest {
  readonly blueprintItemID: number;
  readonly blueprintTypeID: number;
  /** An activity NAME. The activityID lives only on the BFF. */
  readonly activity: IndustryActivity;
  readonly facilityID: number;
  readonly runs: number;
  readonly licensedRuns?: number;
  readonly productTypeID?: number;
}

export interface IndustryPreviewResult {
  /** typeID -> how much of it the player HAS at the input hangar (server-read). */
  readonly available: Readonly<Record<string, number>>;
}

/**
 * What the player HAS of each material the job would consume, from the
 * server's own preview seam. The installation FEE is deliberately absent: no
 * allowlisted retail call quotes a cost without also installing the job, so the
 * panel says so rather than showing an invented estimate.
 */
export async function previewIndustryJob(
  request: IndustryJobRequest,
  options: ApiOptions = {},
): Promise<IndustryPreviewResult> {
  const data = await postJson(
    "/api/bridge/industry/preview",
    { ...request } as unknown as Record<string, JsonValue>,
    options,
  );
  const available = data.available;
  const normalized: Record<string, number> = {};
  if (typeof available === "object" && available !== null && !Array.isArray(available)) {
    for (const [typeID, quantity] of Object.entries(available)) {
      normalized[typeID] = Number(quantity) || 0;
    }
  }
  return { available: normalized };
}

/**
 * An industry mutation's outcome. `applied` is the BFF's RE-READ of the job
 * after the call, never an echo of the request — the R12/R14 lesson.
 */
export interface IndustryChangeResult {
  readonly applied: boolean;
  readonly declinedSilently: boolean;
  readonly jobID: number | null;
  /** The re-read job row (raw; decoded by bridge/industry.ts). */
  readonly job: JsonValue;
}

function asIndustryChange(data: Record<string, JsonValue>): IndustryChangeResult {
  return {
    applied: data.applied === true,
    declinedSilently: data.declinedSilently === true,
    jobID: asNumberOrNull(data.jobID),
    job: data.job ?? null,
  };
}

/**
 * INSTALL a job. This spends materials and charges an installation fee, so the
 * BFF refuses the route outright without `confirm`. The UI asks first; this
 * flag is the second gate behind that, exactly as `trashItems` and `destroyRig`
 * are fenced.
 */
export async function installIndustryJob(
  request: IndustryJobRequest,
  options: ApiOptions = {},
): Promise<IndustryChangeResult> {
  const data = await postJson(
    "/api/bridge/industry/install",
    { ...request, confirm: true } as unknown as Record<string, JsonValue>,
    options,
  );
  return asIndustryChange(data);
}

/** DELIVER a finished job — the retail `CompleteJob`. Only ever gives. */
export async function deliverIndustryJob(
  jobID: number,
  options: ApiOptions = {},
): Promise<IndustryChangeResult> {
  const data = await postJson("/api/bridge/industry/deliver", { jobID }, options);
  return asIndustryChange(data);
}

/**
 * CANCEL a job. The materials and the installation fee are NOT returned, so
 * the BFF refuses without `confirm` and the UI says what will be lost first.
 */
export async function cancelIndustryJob(
  jobID: number,
  options: ApiOptions = {},
): Promise<IndustryChangeResult> {
  const data = await postJson(
    "/api/bridge/industry/cancel",
    { jobID, confirm: true },
    options,
  );
  return asIndustryChange(data);
}

// --- R16 Market ------------------------------------------------------------
// Like industry, the whole retail market surface is top-level, so the BFF
// issues independent calls and hands back their raw retail-shaped results,
// decoded in the flow with bridge/market.ts. All of it is `marketProxy` — the
// `market` service is a dead stub (see src/server.js) — and the sorting /
// filtering / best-price logic is CLIENT-side, because in retail it is too.

/** One market read, with its own error (they are independent). */
export interface RawMarketRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

export interface RawMarketReads {
  readonly typeID: number | null;
  readonly characterID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly book: RawMarketRead;
  readonly ownOrders: RawMarketRead;
  readonly orderHistory: RawMarketRead;
  readonly transactions: RawMarketRead;
  readonly escrow: RawMarketRead;
  readonly cashBalance: RawMarketRead;
  readonly priceHistory: RawMarketRead;
  /** Non-null when the market DAEMON is not answering (≠ "no orders"). */
  readonly marketUnavailable: string | null;
}

function asMarketRead(value: JsonValue | undefined): RawMarketRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

/**
 * Read the market: an item's order book (when a type is chosen), the player's
 * own orders, their closed-order history, their trades, their escrow, their
 * price history and their ISK.
 */
export async function loadMarket(
  typeID: number | null,
  options: ApiOptions = {},
): Promise<RawMarketReads> {
  const query = typeID && typeID > 0 ? `?typeID=${encodeURIComponent(String(typeID))}` : "";
  const data = await getJson(`/api/bridge/market${query}`, options);
  return {
    typeID: asNumberOrNull(data.typeID),
    characterID: asNumberOrNull(data.characterID),
    stationID: asNumberOrNull(data.stationID),
    solarSystemID: asNumberOrNull(data.solarSystemID),
    book: asMarketRead(data.book),
    ownOrders: asMarketRead(data.ownOrders),
    orderHistory: asMarketRead(data.orderHistory),
    transactions: asMarketRead(data.transactions),
    escrow: asMarketRead(data.escrow),
    cashBalance: asMarketRead(data.cashBalance),
    priceHistory: asMarketRead(data.priceHistory),
    marketUnavailable:
      typeof data.marketUnavailable === "string" ? data.marketUnavailable : null,
  };
}

/**
 * What a market write ACTUALLY did.
 *
 * ⚠ `applied` is the BFF's RE-READ (of the wallet, of the player's own orders),
 * never an echo of the request — the R12/R14/R15 lesson. ⚠ `charged` is the
 * wallet balance BEFORE minus the balance AFTER: the only authoritative
 * statement about what an order cost. The estimated broker fee the confirm step
 * showed never appears here, and is never compared against this.
 */
export interface MarketChangeResult {
  readonly applied: boolean;
  readonly declinedSilently: boolean;
  /** ISK taken (positive) or returned (negative), as a decimal string. */
  readonly charged: string | null;
  readonly balanceAfter: string | null;
  /** The re-read own-orders rowset (raw; decoded by bridge/market.ts). */
  readonly ownOrders: JsonValue;
}

function asMarketChange(data: Record<string, JsonValue>): MarketChangeResult {
  return {
    applied: data.applied === true,
    declinedSilently: data.declinedSilently === true,
    charged: typeof data.charged === "string" ? data.charged : null,
    balanceAfter: typeof data.balanceAfter === "string" ? data.balanceAfter : null,
    ownOrders: data.ownOrders ?? null,
  };
}

/** What the browser sends to place an order. Prices are already rounded. */
export interface MarketBuyRequest {
  readonly typeID: number;
  readonly price: number;
  readonly quantity: number;
  readonly durationDays: number;
}

export interface MarketSellRequest {
  /** The specific STACK being sold — selling is item-based, not type-based. */
  readonly itemID: number;
  readonly typeID: number;
  readonly price: number;
  readonly quantity: number;
  readonly durationDays: number;
}

/**
 * PLACE A BUY ORDER. Sets ISK aside immediately and charges a broker's fee, so
 * the BFF refuses the route outright without `confirm`. The UI asks first; this
 * flag is the second gate behind that.
 */
export async function placeMarketBuyOrder(
  request: MarketBuyRequest,
  options: ApiOptions = {},
): Promise<MarketChangeResult> {
  const data = await postJson(
    "/api/bridge/market/buy",
    { ...request, confirm: true } as unknown as Record<string, JsonValue>,
    options,
  );
  return asMarketChange(data);
}

/** PLACE A SELL ORDER. Hands the goods over and charges a broker's fee. */
export async function placeMarketSellOrder(
  request: MarketSellRequest,
  options: ApiOptions = {},
): Promise<MarketChangeResult> {
  const data = await postJson(
    "/api/bridge/market/sell",
    { ...request, confirm: true } as unknown as Record<string, JsonValue>,
    options,
  );
  return asMarketChange(data);
}

/**
 * CANCEL an order. Returns what it was holding; the broker's fee already paid
 * is NOT returned, which is why the UI says so before asking.
 */
export async function cancelMarketOrder(
  orderID: string,
  options: ApiOptions = {},
): Promise<MarketChangeResult> {
  const data = await postJson("/api/bridge/market/cancel", { orderID, confirm: true }, options);
  return asMarketChange(data);
}

/** CHANGE an order's price. Charges a fee, and moves a buy order's escrow. */
export async function modifyMarketOrder(
  orderID: string,
  price: number,
  options: ApiOptions = {},
): Promise<MarketChangeResult> {
  const data = await postJson(
    "/api/bridge/market/modify",
    { orderID, price, confirm: true },
    options,
  );
  return asMarketChange(data);
}

// --- Fleet management writes + the fleet-state read (fleet-mgmt bot blocks) ---
// The writes are confirm-gated server-side; the reader passes `confirm:true` as the
// second gate. Each returns the uniform ack; callers re-read /bound-fleet to prove
// the mutation (⚠ these decoders are fast-mode educated guesses — never fired live,
// so a live QA pass is owed). The bound-fleet READ, by contrast, is verified live:
// a char with no fleet gets a FleetNotFound per read (a real "not in a fleet"), so
// a null fleetID after decode is authoritative, not a blanking failure.

/** Raw /api/bridge/bound-fleet envelope; decode with bridge/boundFleet.decodeBoundFleet. */
export async function loadBoundFleet(options: ApiOptions = {}): Promise<Record<string, JsonValue>> {
  return getJson("/api/bridge/bound-fleet", options);
}

/** FORM a fleet (you become boss). Confirm-gated. */
export async function createFleet(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/fleet/create", { confirm: true }, options);
}

/** INVITE a character into the session's own fleet (must already be in one). */
export async function inviteToFleet(inviteeCharID: number, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/fleet/invite", { inviteeCharID, confirm: true }, options);
}

/**
 * ACCEPT a pending fleet invite for the session character (in the current ship).
 * An invitee is not in the fleet yet, so the route needs the fleetID carried by
 * OnFleetInvite in order to bind the invited fleet before accepting.
 */
export async function acceptFleetInvite(
  fleetID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(
    "/api/bridge/fleet/invite/accept",
    { fleetID, confirm: true },
    options,
  );
}

/**
 * The fleet-finder reads: the listing of adverts open to THIS session, plus the
 * session's own advert. Decode with bridge/fleetAds.
 *
 * The listing is filtered server-side (`isAdvertOpenToSession`), so it can only
 * ever show fleets this character was eligible to join in the first place.
 */
export async function loadFleetAds(options: ApiOptions = {}): Promise<Record<string, JsonValue>> {
  return getJson("/api/bridge/fleet-ads", options);
}

/**
 * APPLY to an advertised fleet found in the finder. Confirm-gated.
 *
 * ⚠ AN APPLY DOES NOT JOIN YOU. On an open advert the server mints a fleet
 * INVITE and notifies you; membership happens only when the client accepts it.
 * That is the designed round trip, and the returned outcome says which half you
 * are in — so callers MUST act on it rather than waiting for membership that
 * will never arrive on its own.
 *
 * `autoAccept` is an instruction carried on the minted invite ("accept without
 * prompting the player"), which a client is expected to honour; it is not a
 * server-side auto-join, and passing it does not remove the accept step.
 */
export async function applyToJoinFleet(
  fleetID: number,
  options: ApiOptions = {},
): Promise<FleetApplyOutcome> {
  const ack = await postJson(
    "/api/bridge/fleet/apply",
    { fleetID, autoAccept: true, confirm: true },
    options,
  );
  return decodeFleetApplyOutcome(ack);
}

/** LEAVE the session character's current fleet. Confirm-gated. */
export async function leaveFleet(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/fleet/leave", { confirm: true }, options);
}

// --- Activity Center reads -------------------------------------------------
// These are thin wrappers over existing aggregate BFF routes. Activity is
// deliberately read-only: notification/calendar mutators live elsewhere and
// are never exposed by its flow or panel.

/** Raw settled notificationMgr reads; bridge/activity.ts preserves each arm. */
export async function loadActivityNotifications(
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  return getJson("/api/bridge/notifications", options);
}

/** Raw current-month calendar reads; bridge/activity.ts preserves each arm. */
export async function loadActivityCalendar(
  month: number,
  year: number,
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  const query = `?month=${encodeURIComponent(String(month))}&year=${encodeURIComponent(String(year))}`;
  return getJson(`/api/bridge/calendar${query}`, options);
}

// --- R17 Mail ---------------------------------------------------------------
// The BFF cold-starts the delta sync and hands back the RAW retail-shaped
// arms, decoded in the flow with bridge/mail.ts — except the message BODY,
// which arrives as plain TEXT because mailMgr.GetBody answers a zlib-DEFLATED
// buffer and the BFF inflates it. The browser never handles a compressed byte.

export interface RawMailInbox {
  readonly characterID: number | null;
  /** The raw SyncMail answer: {newMail, oldMail, mailStatus}. */
  readonly sync: JsonValue;
  /** Raw GetMailHeaders rows, when a status row had no header; else null. */
  readonly backfill: JsonValue;
  readonly unreadCount: number;
}

export async function loadMail(options: ApiOptions = {}): Promise<RawMailInbox> {
  const data = await getJson("/api/bridge/mail", options);
  return {
    characterID: asNumberOrNull(data.characterID),
    sync: data.sync ?? null,
    backfill: data.backfill ?? null,
    unreadCount: Number(data.unreadCount) || 0,
  };
}

export interface MailBodyResult {
  readonly messageID: number;
  /** ⚠ Already inflated by the BFF — plain text, never compressed bytes. */
  readonly body: string | null;
  /** True when the body arrived but would not inflate. */
  readonly unreadable: boolean;
  /** From a RE-READ after opening; null when that re-read failed. */
  readonly markedRead: boolean | null;
  readonly unreadCount: number | null;
}

export async function loadMailBody(
  messageID: number,
  markRead: boolean,
  options: ApiOptions = {},
): Promise<MailBodyResult> {
  const query = `?messageID=${encodeURIComponent(String(messageID))}${markRead ? "&markRead=1" : ""}`;
  const data = await getJson(`/api/bridge/mail/body${query}`, options);
  return {
    messageID: Number(data.messageID) || messageID,
    body: typeof data.body === "string" ? data.body : null,
    unreadable: data.unreadable === true,
    markedRead: typeof data.markedRead === "boolean" ? data.markedRead : null,
    unreadCount: asNumberOrNull(data.unreadCount),
  };
}

export interface MailSendRequest {
  /** ⚠ A LIST on the way in, even though headers read it back as a string. */
  readonly toCharacterIDs: readonly number[];
  readonly title: string;
  readonly body: string;
}

export interface MailSendResult {
  /** Did the message really land? From the sender-copy re-read, not the 200. */
  readonly applied: boolean;
  /** True when the server answered success and wrote nothing. */
  readonly declinedSilently: boolean;
  readonly messageID: number | null;
  readonly unreadCount: number | null;
  readonly recipientCount: number;
  /** What the server said when it declined without a reason. */
  readonly message: string | null;
}

/**
 * Send mail. No `confirm` gate, unlike R12/R14/R15/R16: nothing is spent and
 * nothing is deleted. The BFF still refuses an empty recipient list, because
 * the SERVER cannot — its NO_RECIPIENTS guard can never fire through the
 * gateway, so mail to nobody would be written and would look sent.
 */
export async function sendMail(
  request: MailSendRequest,
  options: ApiOptions = {},
): Promise<MailSendResult> {
  const data = await postJson(
    "/api/bridge/mail/send",
    request as unknown as Record<string, JsonValue>,
    options,
  );
  return {
    applied: data.applied === true,
    declinedSilently: data.declinedSilently === true,
    messageID: asNumberOrNull(data.messageID),
    unreadCount: asNumberOrNull(data.unreadCount),
    recipientCount: Number(data.recipientCount) || 0,
    message: typeof data.message === "string" ? data.message : null,
  };
}

// --- R17 Contracts ----------------------------------------------------------
// The BFF issues five independent reads plus a fan-out for the contracts
// ASSIGNED to this character, and hands back their raw retail-shaped results,
// decoded in the flow with bridge/contracts.ts.
//
// One WRITE: accepting a contract. It is confirm-gated at the BFF and guarded
// again in the game server, which refuses a contract you cannot accept and your
// own unassigned contract. Everything else on the contract surface — creating,
// completing, deleting, bidding — has a route but no caller here yet.

export interface RawContractRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

/** The contracts assigned to this character, each fetched in full. */
export interface RawAssignedContracts {
  /** One GetContract bundle per contract, decoded in the flow. */
  readonly results: readonly JsonValue[];
  /**
   * How many are assigned in total — BEFORE the BFF's fan-out limit. Larger
   * than `results.length` means the list was cut short, not that contracts went
   * missing.
   */
  readonly numAssigned: number;
  readonly error: string | null;
}

export interface RawContractReads {
  readonly characterID: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly browse: RawContractRead;
  readonly outstanding: RawContractRead;
  readonly accepted: RawContractRead;
  readonly expired: RawContractRead;
  readonly summary: RawContractRead;
  readonly assigned: RawAssignedContracts;
  /**
   * ⚠ True ONLY when the browse SUCCEEDED and found nothing. EveJS has no
   * NPC/seed contract generator, so an empty public browse is EXPECTED — but
   * "the browse failed" and "this world has no contracts yet" are different
   * facts and the panel must never confuse them.
   */
  readonly worldHasNoContracts: boolean;
}

function asContractRead(value: JsonValue | undefined): RawContractRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

function asAssignedContracts(value: JsonValue | undefined): RawAssignedContracts {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const results = Array.isArray(row.results) ? (row.results as readonly JsonValue[]) : [];
  return {
    results,
    // An older BFF sends no count at all; the rows themselves are then the
    // whole truth, so nothing claims the list was cut short.
    numAssigned: Number(row.numAssigned) || results.length,
    error: typeof row.error === "string" ? row.error : null,
  };
}

export async function loadContracts(
  page: number,
  options: ApiOptions = {},
): Promise<RawContractReads> {
  const query = page > 0 ? `?page=${encodeURIComponent(String(page))}` : "";
  const data = await getJson(`/api/bridge/contracts${query}`, options);
  return {
    characterID: asNumberOrNull(data.characterID),
    page: Number(data.page) || 0,
    pageSize: Number(data.pageSize) || 100,
    browse: asContractRead(data.browse),
    outstanding: asContractRead(data.outstanding),
    accepted: asContractRead(data.accepted),
    expired: asContractRead(data.expired),
    summary: asContractRead(data.summary),
    assigned: asAssignedContracts(data.assigned),
    worldHasNoContracts: data.worldHasNoContracts === true,
  };
}

/** One contract in full. */
export async function loadContractDetail(
  contractID: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await getJson(
    `/api/bridge/contracts/detail?contractID=${encodeURIComponent(String(contractID))}`,
    options,
  );
  return data.detail ?? null;
}

/**
 * TAKE ON a contract. Moves ISK and items, and CANNOT be undone — which is why
 * the BFF route refuses outright without `confirm: true` and the panel asks
 * first.
 *
 * `forCorp` is false here and has no caller passing anything else: accepting on
 * a corporation's behalf needs a corp role this panel cannot see, and guessing
 * wrong would spend the corporation's ISK instead of the player's.
 */
export async function acceptContract(
  contractID: number,
  options: ApiOptions = {},
): Promise<AcceptContractAck> {
  const data = await postJson(
    "/api/bridge/contracts/accept",
    { contractID, forCorp: false, confirm: true },
    options,
  );
  return decodeAcceptContractAck(data as unknown as JsonValue);
}

// --- R37 Personal Assets ----------------------------------------------------
// READS ONLY. Raw retail shapes out; decoding is bridge/personalAssets.ts's
// job, as everywhere else.

export interface RawAssetStations {
  readonly characterID: number | null;
  /** charMgr.ListStations' CRowset, untouched. null when the read failed. */
  readonly stations: JsonValue;
  /** ⚠ True ONLY when the read SUCCEEDED and was empty. */
  readonly ownsNothing: boolean;
  readonly error: string | null;
}

export interface RawAssetStationItems {
  readonly stationID: number;
  /** charMgr.ListStationItems' list, untouched. null when the read failed. */
  readonly items: JsonValue;
  /** Per-type m³ from static data; a type it does not know is simply absent. */
  readonly volumes: Readonly<Record<string, number>>;
  readonly hasNoItems: boolean;
  readonly error: string | null;
}

/** Every station holding this character's items. */
export async function loadAssetStations(
  options: ApiOptions = {},
): Promise<RawAssetStations> {
  const data = await getJson("/api/bridge/assets", options);
  return {
    characterID: asNumberOrNull(data.characterID),
    stations: data.stations ?? null,
    ownsNothing: data.ownsNothing === true,
    error: typeof data.error === "string" ? data.error : null,
  };
}

/** What is at one of them. */
export async function loadAssetStationItems(
  stationID: number,
  options: ApiOptions = {},
): Promise<RawAssetStationItems> {
  const data = await getJson(
    `/api/bridge/assets/station?stationID=${encodeURIComponent(String(stationID))}`,
    options,
  );
  const volumes =
    data.volumes && typeof data.volumes === "object" && !Array.isArray(data.volumes)
      ? (data.volumes as Record<string, number>)
      : {};
  return {
    stationID: Number(data.stationID) || stationID,
    items: data.items ?? null,
    volumes,
    hasNoItems: data.hasNoItems === true,
    error: typeof data.error === "string" ? data.error : null,
  };
}

/** One person match from /api/characters/find. */
export interface CharacterMatch {
  readonly characterID: number;
  readonly name: string;
}

/**
 * Find someone to write to, by NAME. ⚠ The one place the names rule runs
 * backwards (see the route): the player types a name, the panel carries the id
 * invisibly, and no numeric ID is ever shown.
 */
export async function findCharacters(
  q: string,
  options: ApiOptions = {},
): Promise<readonly CharacterMatch[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const data = await getJson(`/api/characters/find?q=${encodeURIComponent(trimmed)}`, options);
  return Array.isArray(data.matches)
    ? (data.matches as unknown as readonly CharacterMatch[])
    : [];
}

/** One tradable-item match from /api/market/find. */
export interface MarketTypeMatch {
  readonly typeID: number;
  readonly name: string;
  readonly groupName: string;
}

/** One branch of the market tree. */
export interface MarketGroupNode {
  readonly marketGroupID: number;
  readonly name: string;
  /**
   * Whether it holds items DIRECTLY. A group can have both children and types,
   * so this is not "is a leaf" — the panel shows items here as well as letting
   * you descend.
   */
  readonly hasTypes: boolean;
}

/**
 * Browse the market tree. `parentGroupID` of 0 (or absent) returns the roots.
 *
 * Static reference data, like `findMarketTypes` — so browsing works even when
 * the market daemon is not answering, and a player can find out what EXISTS
 * before asking what it costs.
 */
export async function loadMarketGroups(
  parentGroupID: number,
  options: ApiOptions = {},
): Promise<readonly MarketGroupNode[]> {
  const data = await getJson(`/api/market/groups?parent=${encodeURIComponent(String(parentGroupID))}`, options);
  const rows = Array.isArray((data as { groups?: unknown }).groups)
    ? ((data as { groups: unknown[] }).groups)
    : [];
  return rows.map((row) => {
    const entry = row as Record<string, unknown>;
    return {
      marketGroupID: Number(entry.marketGroupID) || 0,
      name: String(entry.name ?? ""),
      hasTypes: entry.hasTypes === true,
    };
  });
}

/** The tradable items sitting directly in one market group. */
export async function loadMarketGroupTypes(
  marketGroupID: number,
  options: ApiOptions = {},
): Promise<{ readonly types: readonly MarketTypeMatch[]; readonly total: number; readonly capped: boolean }> {
  const data = await getJson(`/api/market/group-types?group=${encodeURIComponent(String(marketGroupID))}`, options);
  const rows = Array.isArray((data as { types?: unknown }).types)
    ? ((data as { types: unknown[] }).types)
    : [];
  return {
    types: rows.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        typeID: Number(entry.typeID) || 0,
        name: String(entry.name ?? ""),
        groupName: String(entry.groupName ?? "Unknown"),
      };
    }),
    total: Number((data as { total?: unknown }).total) || 0,
    capped: (data as { capped?: unknown }).capped === true,
  };
}

/**
 * Search tradable items by NAME. Static reference data, so it works before the
 * market itself answers — and it is the only way the panel ever obtains a
 * typeID, because the player must never be asked for one (R7d).
 */
export async function findMarketTypes(
  q: string,
  options: ApiOptions = {},
): Promise<readonly MarketTypeMatch[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const data = await getJson(
    `/api/market/find?q=${encodeURIComponent(trimmed)}`,
    options,
  );
  return Array.isArray(data.matches)
    ? (data.matches as unknown as readonly MarketTypeMatch[])
    : [];
}

/** One ore family (a type group in the Asteroid category) from /api/ore/families. */
export interface OreFamily {
  readonly groupID: number;
  readonly name: string;
}

/**
 * List the ore families the bot editor's ore picker can offer. Static
 * reference data, like `findMarketTypes` — no gateway call, so it works even
 * before a character is selected.
 */
export async function listOreFamilies(options: ApiOptions = {}): Promise<readonly OreFamily[]> {
  const data = await getJson("/api/ore/families", options);
  return Array.isArray((data as { families?: unknown }).families)
    ? ((data as { families: unknown }).families as unknown as readonly OreFamily[])
    : [];
}

/** One belt the BFF's shared belt memory says is dry, from /api/bots/belt-memory. */
export interface DryBeltRow {
  readonly beltName: string;
  readonly all: boolean;
  readonly families: readonly number[];
}

/**
 * Read the shared belt memory for one solar system, by NAME (belt entity ids
 * are grid-local — see src/beltMemory.js). In-process on the BFF, never
 * persisted, and shared by every pilot's mining bot.
 */
export async function readBeltMemory(
  system: string,
  options: ApiOptions = {},
): Promise<readonly DryBeltRow[]> {
  const data = await getJson(`/api/bots/belt-memory?system=${encodeURIComponent(system)}`, options);
  return Array.isArray((data as { belts?: unknown }).belts)
    ? ((data as { belts: unknown }).belts as unknown as readonly DryBeltRow[])
    : [];
}

/**
 * Tell the shared belt memory that `beltName` in `system` has no rocks left
 * (`groupID` null) or none of one ore family (`groupID` = the family's type
 * group).
 */
export async function rememberBeltDry(
  system: string,
  beltName: string,
  groupID: number | null,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/belt-memory", { system, beltName, groupID }, options);
}

/** The fleet's standing call, from /api/bots/squad-board. */
export interface SquadPrimary {
  readonly targetID: number;
  readonly calledByCharacterID: number | null;
}

/**
 * The primary this character's FLEET has called, or null when nobody has called
 * anything (or the call has gone stale). BFF-local, shared by every pilot in
 * that fleet — see src/squadBoard.js.
 *
 * ⚠ THE FLEET IS THE SERVER'S ANSWER, NOT A PARAMETER. The route keys on the
 * fleet the BFF resolved for this session, so there is nothing to pass and no
 * way to read another fleet's call. A session whose fleet is unknown is refused
 * (409 FLEET_UNKNOWN), which the caller reads as "no call" — never as an error
 * worth stopping a bot for.
 */
export async function readSquadPrimary(options: ApiOptions = {}): Promise<SquadPrimary | null> {
  const data = await getJson("/api/bots/squad-board", options);
  const primary = data.primary;
  if (typeof primary !== "object" || primary === null || Array.isArray(primary)) {
    return null;
  }
  const row = primary as Record<string, JsonValue>;
  const targetID = asNumberOrNull(row.targetID);
  return targetID === null ? null : { targetID, calledByCharacterID: asNumberOrNull(row.calledByCharacterID) };
}

/** Call a primary for this character's fleet, or clear the call with null. */
export async function callSquadPrimary(
  targetID: number | null,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/squad-board", { targetID }, options);
}

/**
 * Ship a batch of flight-recorder lines to THIS character's log (the BFF keys
 * on the held session's character, so there is nothing to name here). Fire and
 * forget by design: the caller drops the batch if this throws.
 */
export async function appendBotLog(
  entries: readonly unknown[],
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/bot-log", { entries }, options);
}

/** One character's bot log — the current run, or the one before it. */
export async function readBotLog(
  which: "current" | "previous" = "current",
  options: ApiOptions = {},
): Promise<readonly JsonValue[]> {
  const data = await getJson(`/api/bots/bot-log?which=${which}`, options);
  return Array.isArray(data.lines) ? (data.lines as readonly JsonValue[]) : [];
}

// --- R4 Agents & Missions (agentMgr bridge) --------------------------------
// The BFF holds the bound agent handle; the browser addresses agents by game ID
// and decodes the raw retail-shaped conversation/briefing/journal results with
// bridge/agents.ts.

export interface AgentListResult {
  readonly stationID: number | null;
  readonly agents: readonly AgentRow[];
}

/** The station's agents (agentMgr.GetAgents, filtered to the docked station). */
export async function loadAgents(options: ApiOptions = {}): Promise<AgentListResult> {
  const data = await getJson("/api/bridge/agents", options);
  return {
    stationID: asNumberOrNull(data.stationID),
    agents: Array.isArray(data.agents) ? (data.agents as unknown as readonly AgentRow[]) : [],
  };
}

/**
 * Drive the agent conversation: DoAction(actionID). `actionID` null opens the
 * conversation; a token from availableActions requests / accepts / declines.
 * Returns the raw retail-shaped DoAction result (decoded in the flow).
 */
export async function agentAction(
  agentID: number,
  actionID: number | null,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/bridge/agents/${agentID}/action`, { actionID }, options);
  return data.result ?? null;
}

export interface RawBriefingReads {
  readonly briefing: JsonValue;
  readonly objective: JsonValue;
  readonly location: JsonValue;
  readonly errors: {
    readonly briefing: string | null;
    readonly objective: string | null;
    readonly location: string | null;
  };
}

/** The bound-agent mission briefing reads (raw; decoded in the flow). */
export async function loadBriefing(
  agentID: number,
  options: ApiOptions = {},
): Promise<RawBriefingReads> {
  const data = await getJson(`/api/bridge/agents/${agentID}/briefing`, options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    briefing: data.briefing ?? null,
    objective: data.objective ?? null,
    location: data.location ?? null,
    errors: {
      briefing: typeof errors.briefing === "string" ? errors.briefing : null,
      objective: typeof errors.objective === "string" ? errors.objective : null,
      location: typeof errors.location === "string" ? errors.location : null,
    },
  };
}

/** The mission journal (agentMgr.GetMyJournalDetails; raw, decoded in the flow). */
export async function loadJournal(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson("/api/bridge/journal", options);
  return data.result ?? null;
}

// --- R6a Agent Finder (static agent reference data) ------------------------
// The Agent Finder lists agents from the static agentAuthority reference table
// (GET /api/agents/find) — read-only static data like /api/map/graph, NOT a
// gateway/bridge call. The BFF filters by kind/level and caps; the browser
// annotates each row with jumps from the current system (client-side BFS) and
// sorts nearest-first. This raw result carries the server-resolved names.

/** One agent from /api/agents/find (station/system names resolved server-side). */
export interface FoundAgent {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
  readonly corporationID: number | null;
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindAgentsResult {
  readonly kind: string;
  readonly level: number | null;
  readonly total: number;
  readonly capped: boolean;
  readonly agents: readonly FoundAgent[];
}

export interface FindAgentsFilters {
  /** Mission kind (default "courier"; "all" disables the kind filter). */
  readonly kind?: string;
  readonly level?: number | null;
  /** Server-side result cap (default 500 on the BFF; clamped to [1, 5000]). */
  readonly limit?: number;
}

function asFoundAgent(value: JsonValue): FoundAgent {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    agentID: asNumberOrNull(row.agentID) ?? 0,
    name: typeof row.name === "string" ? row.name : `Agent ${asNumberOrNull(row.agentID) ?? 0}`,
    level: asNumberOrNull(row.level),
    missionKind: typeof row.missionKind === "string" ? row.missionKind : null,
    missionTypeLabel: typeof row.missionTypeLabel === "string" ? row.missionTypeLabel : null,
    corporationID: asNumberOrNull(row.corporationID),
    factionID: asNumberOrNull(row.factionID),
    stationID: asNumberOrNull(row.stationID),
    stationName: typeof row.stationName === "string" ? row.stationName : null,
    solarSystemID: asNumberOrNull(row.solarSystemID),
    solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null,
  };
}

/** Find agents from the static reference table (filtered + capped server-side). */
export async function findAgents(
  filters: FindAgentsFilters = {},
  options: ApiOptions = {},
): Promise<FindAgentsResult> {
  const params = new URLSearchParams();
  if (filters.kind !== undefined) {
    params.set("kind", filters.kind);
  }
  if (filters.level !== undefined && filters.level !== null) {
    params.set("level", String(filters.level));
  }
  if (filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  const query = params.toString();
  const data = await getJson(`/api/agents/find${query ? `?${query}` : ""}`, options);
  return {
    kind: typeof data.kind === "string" ? data.kind : "courier",
    level: asNumberOrNull(data.level),
    total: asNumberOrNull(data.total) ?? 0,
    capped: data.capped === true,
    agents: Array.isArray(data.agents) ? data.agents.map(asFoundAgent) : [],
  };
}

// --- R6 Courier-completion reward readout (Step 12) ------------------------
// The post-completion wallet / LP / standings pull reads (account.GetCashBalance,
// LPSvc.GetAllMyCharacterWalletLPBalances, standingMgr.GetCharStandings). The
// BFF returns the raw retail-shaped results, decoded in the flow with
// bridge/rewards.ts. The journal (the fourth Step-12 read) uses loadJournal.

export interface RawRewardReads {
  readonly cash: JsonValue;
  readonly lp: JsonValue;
  readonly standings: JsonValue;
  readonly errors: {
    readonly cash: string | null;
    readonly lp: string | null;
    readonly standings: string | null;
  };
}

/** The wallet / LP / standings reward reads (raw; decoded in the flow). */
export async function loadRewards(options: ApiOptions = {}): Promise<RawRewardReads> {
  const data = await getJson("/api/bridge/rewards", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    cash: data.cash ?? null,
    lp: data.lp ?? null,
    standings: data.standings ?? null,
    errors: {
      cash: typeof errors.cash === "string" ? errors.cash : null,
      lp: typeof errors.lp === "string" ? errors.lp : null,
      standings: typeof errors.standings === "string" ? errors.standings : null,
    },
  };
}

// --- R50 Wallet + Corp Wallet ----------------------------------------------
// One pull for both tabs: the personal balance (account.GetCashBalance) and the
// corporation division balances (account.GetWalletDivisionsInfo), plus the
// server-side-resolved division NAMES (corpRegistry.GetCorporation). Amounts are
// raw retail shapes decoded in web/src/bridge/wallet.ts.

export interface RawWalletReads {
  readonly cash: JsonValue;
  readonly divisions: JsonValue;
  /** Division ordinal (1..7) -> player-authored name, resolved by the BFF. */
  readonly divisionNames: JsonValue;
  // R54 — the personal ledger: the journal (a Rowset), the transactions (a
  // list<KeyVal>), and the ref-type -> label static map (a cached list). All raw.
  readonly journal: JsonValue;
  readonly transactions: JsonValue;
  readonly entryTypes: JsonValue;
  readonly errors: {
    readonly cash: string | null;
    readonly divisions: string | null;
    readonly corp: string | null;
    readonly journal: string | null;
    readonly transactions: string | null;
    readonly entryTypes: string | null;
  };
}

/** The personal + corp-division wallet reads plus the ledger (raw; decoded in the flow). */
export async function loadWallet(options: ApiOptions = {}): Promise<RawWalletReads> {
  const data = await getJson("/api/bridge/wallet", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  const errorText = (key: string): string | null =>
    typeof errors[key] === "string" ? (errors[key] as string) : null;
  return {
    cash: data.cash ?? null,
    divisions: data.divisions ?? null,
    divisionNames: data.divisionNames ?? {},
    journal: data.journal ?? null,
    transactions: data.transactions ?? null,
    entryTypes: data.entryTypes ?? null,
    errors: {
      cash: errorText("cash"),
      divisions: errorText("divisions"),
      corp: errorText("corp"),
      journal: errorText("journal"),
      transactions: errorText("transactions"),
      entryTypes: errorText("entryTypes"),
    },
  };
}

// --- R55 Standings ----------------------------------------------------------
// One pull carries the character's own standings (standingMgr.GetCharStandings)
// and the corporation's (standingMgr.GetCorpStandings). Passing `fromID` also
// asks for that entity's drill-down — the standing HISTORY
// (GetStandingTransactions) and the per-member COMPOSITION
// (GetStandingCompositions). All raw retail shapes, decoded in
// web/src/bridge/standings.ts.

export interface RawStandingsReads {
  readonly char: JsonValue;
  readonly corp: JsonValue;
  /** Echoed selected entity for the drill-down; null on the base read. */
  readonly fromID: number | null;
  readonly transactions: JsonValue;
  readonly compositions: JsonValue;
  readonly errors: {
    readonly char: string | null;
    readonly corp: string | null;
    readonly transactions: string | null;
    readonly compositions: string | null;
  };
}

/** The character + corporation standings (and, when `fromID` is given, that
 *  entity's history + composition). Raw retail shapes, decoded in the flow. */
export async function loadStandings(
  fromID: number | null = null,
  options: ApiOptions = {},
): Promise<RawStandingsReads> {
  const query = fromID && fromID > 0 ? `?fromID=${encodeURIComponent(String(fromID))}` : "";
  const data = await getJson(`/api/bridge/standings${query}`, options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  const errorText = (key: string): string | null =>
    typeof errors[key] === "string" ? (errors[key] as string) : null;
  return {
    char: data.char ?? null,
    corp: data.corp ?? null,
    fromID: asNumberOrNull(data.fromID),
    transactions: data.transactions ?? null,
    compositions: data.compositions ?? null,
    errors: {
      char: errorText("char"),
      corp: errorText("corp"),
      transactions: errorText("transactions"),
      compositions: errorText("compositions"),
    },
  };
}

// --- R56 Character Sheet ----------------------------------------------------
// One pull carries four independent charMgr reads: GetPublicInfo3 (identity),
// GetCharacterDescription (bio), GetHomeStation, GetCloneInfo. Each keeps its own
// error on the BFF (Promise.allSettled), so one failure never blanks the rest.
// All raw retail shapes, decoded in web/src/bridge/characterSheet.ts.

export interface RawCharacterSheetReads {
  readonly publicInfo: JsonValue;
  readonly description: JsonValue;
  readonly homeStation: JsonValue;
  readonly cloneInfo: JsonValue;
  readonly errors: {
    readonly publicInfo: string | null;
    readonly description: string | null;
    readonly homeStation: string | null;
    readonly cloneInfo: string | null;
  };
}

/** The four character-sheet reads (raw retail shapes, decoded in the flow). */
export async function loadCharacterSheet(
  options: ApiOptions = {},
): Promise<RawCharacterSheetReads> {
  const data = await getJson("/api/bridge/character-sheet", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  const errorText = (key: string): string | null =>
    typeof errors[key] === "string" ? (errors[key] as string) : null;
  return {
    publicInfo: data.publicInfo ?? null,
    description: data.description ?? null,
    homeStation: data.homeStation ?? null,
    cloneInfo: data.cloneInfo ?? null,
    errors: {
      publicInfo: errorText("publicInfo"),
      description: errorText("description"),
      homeStation: errorText("homeStation"),
      cloneInfo: errorText("cloneInfo"),
    },
  };
}

// --- R7 Local + Corp chat --------------------------------------------------
// The BFF holds the bridgeSessionID; the browser addresses channels by name.
// READ is a backlog poll (chat delivery bypasses the notification drain), so
// the panel polls /api/bridge/chat/:channel while open. The raw `chat` object
// (roster + backlog) is decoded in the flow with bridge/chat.ts.

/** Read a chat channel's roster + recent backlog (raw; decoded in the flow). */
export async function readChat(
  channel: "local" | "corp",
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await getJson(`/api/bridge/chat/${channel}`, options);
  return data.chat ?? null;
}

/** Send a message to a chat channel; returns the raw send echo. */
export async function sendChat(
  channel: "local" | "corp",
  message: string,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/bridge/chat/${channel}/send`, { message }, options);
  return data.chat ?? null;
}

// --- R10 Live event channel (SSE) ------------------------------------------
// The BFF republishes its gateway push WebSocket to the browser as Server-Sent
// Events on GET /api/bridge/events (same-origin, cookie-authed). Frames are
// either gateway frames (`source: "evejs-web-gateway"`) or BFF status frames
// (`source: "evejs-web-bff"`, `type: "stream-status"`).
//
// EventSource handles reconnection itself, so this is deliberately thin. It is
// a LIVENESS channel only — every bridge response still carries its notification
// drain — so a browser without EventSource, or one whose stream never connects,
// simply keeps polling.

export interface BridgeEventSubscription {
  close(): void;
}

export interface BridgeEventHandlers {
  readonly onFrame: (frame: JsonValue) => void;
  readonly onOpen?: () => void;
  readonly onError?: () => void;
}

/** Minimal EventSource surface, so tests can inject a fake. */
export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  close(): void;
}

export interface BridgeEventOptions extends ApiOptions {
  /** Injectable EventSource factory for tests; default globalThis.EventSource. */
  readonly eventSource?: (url: string) => EventSourceLike;
}

/**
 * Subscribe to the live bridge event channel. Returns a handle whose `close()`
 * detaches; call it when the character goes offline or the page unmounts.
 */
export function subscribeBridgeEvents(
  handlers: BridgeEventHandlers,
  options: BridgeEventOptions = {},
): BridgeEventSubscription {
  // R42/R107 — `EventSource` cannot set request headers, so this is the one URL
  // in the client that carries the session token in its query string. Without it
  // the stream would fall back to the shared cookie and a second character would
  // watch the first's account go about its business: a per-session subscription
  // with a shared push channel is half a feature. Per-session (key present)
  // carries this flow's OWN token; otherwise the per-tab global. See
  // `requireStreamAuth` in src/server.js for why the query carrier is bounded to
  // this route alone.
  const eventsPath = `${options.baseUrl ?? ""}/api/bridge/events`;
  const url =
    "token" in options ? withTokenQuery(eventsPath, options.token) : withSessionTokenQuery(eventsPath);
  const factory =
    options.eventSource ??
    (typeof globalThis.EventSource === "function"
      ? (target: string) =>
          new globalThis.EventSource(target, {
            withCredentials: true,
          }) as unknown as EventSourceLike
      : null);
  if (!factory) {
    // No EventSource in this environment: report the failure once so the caller
    // stays on its polls rather than waiting for events that cannot arrive.
    handlers.onError?.();
    return { close() {} };
  }

  let source: EventSourceLike;
  try {
    source = factory(url);
  } catch {
    handlers.onError?.();
    return { close() {} };
  }

  let closed = false;
  source.onopen = () => {
    if (!closed) {
      handlers.onOpen?.();
    }
  };
  source.onmessage = (event) => {
    if (closed) {
      return;
    }
    let frame: JsonValue;
    try {
      frame = JSON.parse(event.data) as JsonValue;
    } catch {
      return; // A malformed frame is ignored, never thrown at the page.
    }
    handlers.onFrame(frame);
  };
  source.onerror = () => {
    if (!closed) {
      handlers.onError?.();
    }
  };

  return {
    close() {
      closed = true;
      try {
        source.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// --- R5a Flight (manually-stepped space movement) --------------------------
// The BFF holds the beyonce bound park handle server-side and returns the raw
// flight-status snapshot (decoded in the flow with bridge/flight.ts). Movement
// refusals pass through as the handler's own CALL_REFUSED message.

/** One flight step's outcome: the raw flight snapshot after the step + notifications. */
export interface FlightStepResult {
  readonly flight: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readFlightStep(data: Record<string, JsonValue>): FlightStepResult {
  return {
    flight: data.flight ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/** Read the current flight status (location + ship movement state). */
export async function getFlightStatus(options: ApiOptions = {}): Promise<FlightStepResult> {
  return readFlightStep(await getJson("/api/bridge/flight/status", options));
}

export interface HealthResult {
  /** The BFF answered AND the EveJS gateway RUNTIME is up, so a login can land. */
  readonly ready: boolean;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

/**
 * The boot health ping (GET /api/health). "Ready" = the BFF answered ok AND the
 * EveJS gateway RUNTIME reports ready (`gateway.runtime.ready`) — which is all a
 * login needs (it only reads `/account` off the gateway).
 *
 * ⚠ NOT the top-level `gateway.ready`: that flag is stricter than login — it
 * also demands the optional characterEvents gateway TOKEN, so a perfectly usable
 * server with that token unset (the normal dev setup) reports `gateway.ready:
 * false` while `gateway.runtime.ready: true`. Gating on the top-level flag is
 * what made login refuse against a live server. `gateway.ready` is still honored
 * as a fallback for fully-configured deployments.
 *
 * Deliberately never throws: an unreachable BFF/gateway (getStatus rejects → the
 * route 500s), or a not-ready runtime, all resolve to `{ ready: false }`.
 */
export async function getHealth(options: ApiOptions = {}): Promise<HealthResult> {
  try {
    const data = await getJson("/api/health", options);
    if (data.ok !== true) {
      return { ready: false };
    }
    const gateway = asObject(data.gateway);
    const runtime = asObject(gateway?.runtime);
    return { ready: runtime?.ready === true || gateway?.ready === true };
  } catch {
    return { ready: false };
  }
}

/** Undock from the station (ship.Undock; the session enters space). */
export async function undock(options: ApiOptions = {}): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/undock", {}, options));
}

/**
 * Warp to a chosen gate/celestial.
 *
 * `minRange` null is the autopilot's own warp (CmdWarpToStuffAutopilot); a
 * number is the right-click "warp to within N" form (CmdWarpToStuff with a
 * minRange kwarg). Retail's own default for the menu is 0.
 */
export async function warpTo(
  destinationID: number,
  minRange: number | null = null,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  const body = minRange === null ? { destinationID } : { destinationID, minRange };
  return readFlightStep(await postJson("/api/bridge/flight/warp", body, options));
}

/**
 * Approach a gate/target at full speed (beyonce.CmdSetSpeedFraction(1) +
 * CmdFollowBall). The range is retail's: the menu approach uses 50 m, and the
 * autopilot's close-the-gap step uses 0.
 */
export async function approach(
  destinationID: number,
  range: number | null = null,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  const body = range === null ? { destinationID } : { destinationID, range };
  return readFlightStep(await postJson("/api/bridge/flight/approach", body, options));
}

/**
 * Hold a set distance from a target (the same CmdFollowBall as approach, with a
 * non-zero range). Default 1000 m, floored at 50 m by the BFF.
 */
export async function keepAtRange(
  targetID: number,
  range: number | null = null,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  const body = range === null ? { targetID } : { targetID, range };
  return readFlightStep(await postJson("/api/bridge/flight/keep-at-range", body, options));
}

/** Circle a target at a set distance (beyonce.CmdOrbit). Default 1000 m. */
export async function orbit(
  targetID: number,
  range: number | null = null,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  const body = range === null ? { targetID } : { targetID, range };
  return readFlightStep(await postJson("/api/bridge/flight/orbit", body, options));
}

/** Point the ship at a target and hold that heading (beyonce.CmdAlignTo). */
export async function alignTo(
  targetID: number,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/align", { targetID }, options));
}

/** Cut the engines (beyonce.CmdStop). */
export async function stopShip(options: ApiOptions = {}): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/stop", {}, options));
}

/** Jump through an NPC stargate (beyonce.CmdStargateJump). */
export async function jump(
  fromGateID: number,
  toGateID: number,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  return readFlightStep(
    await postJson("/api/bridge/flight/jump", { fromGateID, toGateID }, options),
  );
}

/** Dock at the destination station (beyonce.CmdDock). */
export async function dock(
  stationID: number,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/dock", { stationID }, options));
}

/**
 * SET (or CLEAR, `tag: null`) the fleet target tag on an entity
 * (beyonce.CmdFleetTagTarget). Confirm-gated at the BFF.
 *
 * ⚠ THE ACK IS NOT PROOF. The server silently refuses a non-commander by
 * returning a plain `false` from CmdFleetTagTarget, and its only caller
 * (D:\evet\server\src\services\ship\beyonceService.js:3320) discards that
 * boolean and returns null unconditionally — so `{ok: true, applied: true}`
 * comes back identically whether the tag landed or was dropped on the floor.
 * A caller MUST confirm by seeing the tag show up in a later `targetTags`
 * read; this call's own success tells you nothing.
 */
export async function setFleetTargetTag(
  itemID: number,
  tag: string | null,
  options: ApiOptions = {},
): Promise<BeyonceWriteAck> {
  const data = await postJson(
    "/api/bridge/flight/fleet-tag-target",
    { itemID, tag, confirm: true },
    options,
  );
  return decodeBeyonceWriteAck(data as unknown as JsonValue);
}

/**
 * JUMP through a fleet-mate's cyno bridge (beyonce.CmdJumpThroughFleet).
 * Confirm-gated at the BFF; consumes bridge fuel and transitions the session
 * to a new system, so it also waits out the route-transition handshake there.
 *
 * `otherCharID`/`otherShipID` name the bridge owner's character and ship; the
 * BFF validates both against the session's own fleet membership server-side,
 * so a foreign (non-fleet) ship cannot be named here to hijack a bridge.
 */
export async function jumpThroughFleet(
  otherCharID: number,
  otherShipID: number,
  beaconID: number,
  solarSystemID: number,
  options: ApiOptions = {},
): Promise<BeyonceWriteAck> {
  const data = await postJson(
    "/api/bridge/flight/jump-through-fleet",
    { otherCharID, otherShipID, beaconID, solarSystemID, confirm: true },
    options,
  );
  return decodeBeyonceWriteAck(data as unknown as JsonValue);
}

// --- R11 Space overview + ship HUD -----------------------------------------
// A read-only snapshot of what the ship can see plus the active ship's
// shield/armor/hull/capacitor (decoded in the flow with bridge/space.ts). The
// page polls it ~1s while in space; distance/sorting/filtering are computed in
// the browser, exactly as the retail client does.

/** One space-snapshot read: the raw snapshot + the drained notifications. */
export interface SpaceSnapshotResult {
  readonly space: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/** Read what is currently around the ship (and the ship's own condition). */
export async function getSpaceSnapshot(
  options: ApiOptions = {},
): Promise<SpaceSnapshotResult> {
  const data = await getJson("/api/bridge/space/snapshot", options);
  return {
    space: data.space ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

// --- R23 slice A: targeting + module activation -----------------------------
//
// THE GENERIC IN-SPACE ACTION LAYER. Nothing here names mining, combat,
// salvaging or ewar. A target is a target; a module is a module; the effect
// name is an argument the caller supplies (or omits, in which case the SERVER
// resolves the module's own default activation effect from its typeID — the
// browser never guesses which effect a module runs). Slice B drives a mining
// laser through these five functions; a later combat goal drives a turret
// through the same five unchanged.

/** What the server says is locked right now — the only authority. */
export interface TargetsResult {
  readonly targetIDs: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/**
 * One lock/unlock outcome. Both flags come from a RE-READ of GetTargets after
 * the mutation, never from the mutation's own 200.
 *
 * `locked`  — the lock has landed and the target is usable.
 * `acquiring` — the server accepted the attempt and is still acquiring it.
 * `released` — it is no longer locked (the unlock answer).
 */
export interface TargetActionResult {
  readonly targetID: number;
  readonly locked: boolean;
  readonly acquiring: boolean;
  readonly released: boolean;
  readonly targetIDs: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/**
 * One module activate/deactivate outcome, verified against the space snapshot's
 * activeModuleIDs. `active` / `stopped` are NULL when the snapshot could not
 * answer — "unknown", never "off".
 */
export interface ModuleActionResult {
  readonly itemID: number;
  readonly active: boolean | null;
  readonly stopped: boolean | null;
  readonly activeModuleIDs: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readNotifications(data: Record<string, JsonValue>): readonly JsonValue[] {
  return Array.isArray(data.notifications) ? data.notifications : [];
}

/** Read the locked-target list (dogmaIM.GetTargets). */
export async function getTargets(options: ApiOptions = {}): Promise<TargetsResult> {
  const data = await getJson("/api/bridge/targets", options);
  return { targetIDs: data.targetIDs ?? null, notifications: readNotifications(data) };
}

/** Lock a target (dogmaIM.AddTarget). Acquisition is not instant. */
export async function lockTarget(
  targetID: number,
  options: ApiOptions = {},
): Promise<TargetActionResult> {
  const data = await postJson("/api/bridge/targets/lock", { targetID }, options);
  return {
    targetID,
    locked: data.locked === true,
    acquiring: data.acquiring === true,
    released: false,
    targetIDs: data.targetIDs ?? null,
    notifications: readNotifications(data),
  };
}

/**
 * Release ONE lock (dogmaIM.RemoveTarget, preceded by CancelAddTarget so the
 * same button also abandons a lock that is still being acquired). The bulk
 * verbs are not on the gateway allowlist at all, so a stray click here can only
 * ever cost one lock.
 */
export async function unlockTarget(
  targetID: number,
  options: ApiOptions = {},
): Promise<TargetActionResult> {
  const data = await postJson("/api/bridge/targets/unlock", { targetID }, options);
  return {
    targetID,
    locked: false,
    acquiring: false,
    released: data.released === true,
    targetIDs: data.targetIDs ?? null,
    notifications: readNotifications(data),
  };
}

function readModuleAction(itemID: number, data: Record<string, JsonValue>): ModuleActionResult {
  return {
    itemID,
    active: typeof data.active === "boolean" ? data.active : null,
    stopped: typeof data.stopped === "boolean" ? data.stopped : null,
    activeModuleIDs: data.activeModuleIDs ?? null,
    notifications: readNotifications(data),
  };
}

/**
 * Switch a module on (dogmaIM.Activate).
 *
 * `effect` is optional BY DESIGN: omit it and the server resolves the module's
 * own default activation effect. `repeat` is retail's cycle flag — -1 keeps
 * cycling (the default), 0 runs a single cycle. `targetID` is omitted for
 * modules that act on the ship itself.
 */
export async function activateModule(
  itemID: number,
  opts: { effect?: string; targetID?: number | null; repeat?: -1 | 0 } = {},
  options: ApiOptions = {},
): Promise<ModuleActionResult> {
  const body: Record<string, JsonValue> = { itemID };
  if (opts.effect) {
    body.effect = opts.effect;
  }
  if (opts.targetID) {
    body.targetID = opts.targetID;
  }
  if (opts.repeat === 0) {
    body.repeat = 0;
  }
  return readModuleAction(itemID, await postJson("/api/bridge/modules/activate", body, options));
}

/**
 * Switch a module off (dogmaIM.Deactivate).
 *
 * Pass `typeID` whenever the caller knows it (every fitting slot carries it):
 * an afterburner/MWD only actually STOPS when Deactivate names its propulsion
 * effect, and the BFF resolves that name from the typeID — the server infers
 * the default effect on activate but not on deactivate, and the generic path
 * answers success while the prop mod keeps cycling.
 */
export async function deactivateModule(
  itemID: number,
  opts: { effect?: string; typeID?: number } = {},
  options: ApiOptions = {},
): Promise<ModuleActionResult> {
  const body: Record<string, JsonValue> = { itemID };
  if (opts.effect) {
    body.effect = opts.effect;
  }
  if (opts.typeID) {
    body.typeID = opts.typeID;
  }
  return readModuleAction(itemID, await postJson("/api/bridge/modules/deactivate", body, options));
}

// --- R23 slice B: the mining loop -------------------------------------------
//
// mine -> haul -> refine -> sell. There is no "start mining" call here and no
// mining cycle: mining a rock IS the generic lockTarget + activateModule above
// with a mining laser, flying to the belt is warpTo/orbit, and selling the
// minerals is the market functions. These five are only what was missing — a
// place to see the ore, a way to get it home, the scanner, and the refinery.

/** The ship's mining holds, each already named by the BFF (never a flagID). */
export interface MiningHoldsResult {
  readonly activeShipID: number | null;
  readonly holds: JsonValue;
}

/** What the scanner saw: `[[entityID, yieldTypeID, remainingQuantity]]`. */
export interface SurveyScanResult {
  readonly results: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/** The refinery's quote, with the station's ISK TAX RATE reported separately. */
export interface ReprocessingQuoteResult {
  readonly stationID: number | null;
  readonly taxRate: JsonValue;
  readonly quotes: JsonValue;
}

/**
 * What an unload or a reprocess ACTUALLY did, verified by re-reading. `moved` /
 * `processed` are null when the verification read itself failed — "we could not
 * check", which the page reports as such and never as success.
 */
export interface MiningActionResult {
  readonly requested: readonly number[];
  readonly moved: readonly number[] | null;
  readonly remaining: readonly number[] | null;
  readonly notifications: readonly JsonValue[];
}

function readIDArray(value: JsonValue | undefined): readonly number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => Number(entry) || 0).filter((entry) => entry > 0);
}

/** Read the ship's ore / gas / ice holds (falling back to cargo). */
export async function getMiningHolds(options: ApiOptions = {}): Promise<MiningHoldsResult> {
  const data = await getJson("/api/bridge/ship/ore-hold", options);
  return {
    activeShipID: Number(data.activeShipID) || null,
    holds: data.holds ?? null,
  };
}

/** Move mined ore from the ship's holds into the station hangar (docked only). */
export async function unloadMiningHolds(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<MiningActionResult> {
  const data = await postJson(
    "/api/bridge/ship/ore-hold/unload",
    { itemIDs: [...itemIDs] },
    options,
  );
  return {
    requested: readIDArray(data.requested) ?? [],
    moved: readIDArray(data.moved),
    remaining: readIDArray(data.remaining),
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/** Run the survey scanner (miningScanMgr.perform_scan). Read-only. */
export async function runSurveyScan(options: ApiOptions = {}): Promise<SurveyScanResult> {
  const data = await getJson("/api/bridge/mining/scan", options);
  return {
    results: data.results ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Ask the station's refinery what these stacks WOULD yield, and what it will
 * take. A pure read: nothing is consumed and no ISK is charged by this call.
 */
export async function getReprocessingQuote(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<ReprocessingQuoteResult> {
  const query = encodeURIComponent(itemIDs.join(","));
  const data = await getJson(`/api/bridge/reprocessing/quote?itemIDs=${query}`, options);
  return {
    stationID: Number(data.stationID) || null,
    taxRate: data.taxRate ?? null,
    quotes: data.quotes ?? null,
  };
}

/**
 * ⚠ REPROCESS. This CONSUMES the chosen stacks and CHARGES the station's ISK
 * tax, so the BFF refuses it outright unless `confirm` is true. The panel asks
 * first — showing the quote and the tax — and this flag is the second gate
 * behind that, exactly as destroyRig does for a rig.
 */
export async function reprocessItems(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<MiningActionResult> {
  const data = await postJson(
    "/api/bridge/reprocessing/reprocess",
    { itemIDs: [...itemIDs], confirm: true },
    options,
  );
  return {
    requested: readIDArray(data.requested) ?? [],
    moved: readIDArray(data.processed),
    remaining: readIDArray(data.remaining),
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

// --- R5b Travel (client-side route solver static data) ---------------------
// The system-adjacency graph the browser route solver runs BFS over is served
// as read-only static reference data (GET /api/map/graph) — NOT a gateway call
// and NOT a server-side travel job (roadmap §7 / G2).

/** The compact system-adjacency graph payload (systems name map + edge tuples). */
export interface SystemGraphResult {
  readonly systems: Readonly<Record<string, string>>;
  readonly edges: ReadonlyArray<readonly [number, number, number, number]>;
}

/** Fetch the system-adjacency graph for the client-side route solver. */
export async function loadSystemGraph(options: ApiOptions = {}): Promise<SystemGraphResult> {
  const data = await getJson("/api/map/graph", options);
  return {
    systems:
      typeof data.systems === "object" && data.systems !== null && !Array.isArray(data.systems)
        ? (data.systems as Record<string, string>)
        : {},
    edges: Array.isArray(data.edges)
      ? (data.edges as ReadonlyArray<readonly [number, number, number, number]>)
      : [],
  };
}

/**
 * A destination resolved to its solar system — a station or system from static
 * reference data, or (R38) a player-owned structure from the live world.
 */
export interface ResolvedDestination {
  readonly id: number;
  readonly kind: "station" | "system" | "structure" | "unknown";
  readonly solarSystemID: number | null;
  readonly systemName: string | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  /**
   * R38 — true when this came back `unknown` because a player-structure lookup
   * could not be completed, rather than because nothing bears the ID. A caller
   * must not cache the miss when this is set.
   */
  readonly lookupFailed: boolean;
}

/**
 * Resolve a picked destination ID to its solar system (a courier destination is
 * a station; the route solver works on systems).
 *
 * R38 — mostly static reference data, but a player-owned structure is a legal
 * destination that exists only at runtime, so the route answers `kind:"structure"`
 * for one. The structure's name and system are echoed into `stationName` /
 * `stationID` as well, because a structure IS a dockable place and every
 * existing caller already reads those fields; a caller that needs to tell the
 * two apart reads `kind`.
 */
export async function resolveDestination(
  id: number,
  options: ApiOptions = {},
): Promise<ResolvedDestination> {
  const data = await getJson(`/api/map/resolve/${id}`, options);
  return {
    id,
    kind:
      data.kind === "station" || data.kind === "system" || data.kind === "structure"
        ? data.kind
        : "unknown",
    solarSystemID: asNumberOrNull(data.solarSystemID),
    systemName: typeof data.systemName === "string" ? data.systemName : null,
    stationID: asNumberOrNull(data.stationID),
    stationName: typeof data.stationName === "string" ? data.stationName : null,
    lookupFailed: data.lookupFailed === true,
  };
}

// --- R7a Map name search (set a destination by name) -----------------------
// The Travel tab searches the static solar-system + station tables by name
// (GET /api/map/find) so a player can set a destination without knowing EVE IDs.
// Read-only static reference data like /api/map/graph — NOT a gateway/bridge
// call. The chosen match's `id` is handed to startRoute (the R5b route solver +
// autopilot); the flow annotates jumps-away client-side from the map graph.

/** One name-search match from /api/map/find (a solar system or a station). */
export interface MapLocation {
  readonly id: number;
  readonly name: string;
  readonly kind: "system" | "station";
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindMapLocationsResult {
  readonly q: string;
  readonly kind: string | null;
  readonly total: number;
  readonly capped: boolean;
  readonly matches: readonly MapLocation[];
}

function asMapLocation(value: JsonValue): MapLocation {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const kind = row.kind === "station" ? "station" : "system";
  return {
    id: asNumberOrNull(row.id) ?? 0,
    name: typeof row.name === "string" ? row.name : `Location ${asNumberOrNull(row.id) ?? 0}`,
    kind,
    solarSystemID: asNumberOrNull(row.solarSystemID),
    solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null,
  };
}

/** Search the static map by name (systems + stations, or narrowed by kind). */
export async function findMapLocations(
  q: string,
  kind: "system" | "station" | null = null,
  options: ApiOptions = {},
): Promise<FindMapLocationsResult> {
  const params = new URLSearchParams();
  params.set("q", q);
  if (kind) {
    params.set("kind", kind);
  }
  const data = await getJson(`/api/map/find?${params.toString()}`, options);
  return {
    q: typeof data.q === "string" ? data.q : q,
    kind: typeof data.kind === "string" ? data.kind : null,
    total: asNumberOrNull(data.total) ?? 0,
    capped: data.capped === true,
    matches: Array.isArray(data.matches) ? data.matches.map(asMapLocation) : [],
  };
}

// ─── Player Bot Builder library (goal D2/D3) ─────────────────────────────────
// Platform-wide CRUD over the BFF's data/bot-scripts.json (src/botScriptStore.js)
// — the library is shared by every account, so a row may be someone else's.
// Web-app data, NOT a bridge/gateway call. The caller decodes a loaded `doc`
// through the browser codec (decode-on-read) before trusting it.

export interface BotScriptSummary {
  readonly scriptID: string;
  readonly name: string;
  readonly rev: number;
  readonly updatedAt: string;
  /**
   * Which account SAVED this bot. The library is platform-wide, so a row here
   * may well have been written by another account — this says who, and nothing
   * more. It confers no rights: authority over characters and running bots is
   * checked server-side and is still per account. Null when the server did not
   * say. NEVER RENDER THIS (R7d — a raw id never reaches a screen); show
   * `authorName` instead.
   */
  readonly authorAccountID: number | null;
  /**
   * The name that account went by when the bot was saved — the renderable half
   * of authorship, recorded at save time rather than looked up, so the library
   * never has to enumerate accounts to draw a list. Null for bots saved before
   * the library went platform-wide; render those as "—", never as a blank.
   */
  readonly authorName: string | null;
}

function asBotScriptSummary(value: JsonValue): BotScriptSummary {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    scriptID: typeof row.scriptID === "string" ? row.scriptID : "",
    name: typeof row.name === "string" ? row.name : "Untitled bot",
    rev: asNumberOrNull(row.rev) ?? 1,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    authorAccountID: asNumberOrNull(row.authorAccountID),
    authorName: typeof row.authorName === "string" && row.authorName.length > 0 ? row.authorName : null,
  };
}

export async function listBotScripts(options: ApiOptions = {}): Promise<BotScriptSummary[]> {
  const data = await getJson("/api/botscripts", options);
  return Array.isArray(data.scripts) ? data.scripts.map(asBotScriptSummary) : [];
}

export async function getBotScript(
  scriptID: string,
  options: ApiOptions = {},
): Promise<{
  scriptID: string;
  rev: number;
  authorAccountID: number | null;
  authorName: string | null;
  doc: JsonValue;
} | null> {
  try {
    const data = await getJson(`/api/botscripts/${encodeURIComponent(scriptID)}`, options);
    return {
      scriptID: typeof data.scriptID === "string" ? data.scriptID : scriptID,
      rev: asNumberOrNull(data.rev) ?? 1,
      authorAccountID: asNumberOrNull(data.authorAccountID),
      authorName: typeof data.authorName === "string" && data.authorName.length > 0 ? data.authorName : null,
      doc: data.doc ?? null,
    };
  } catch (error) {
    if (error instanceof BridgeCallError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createBotScript(
  doc: unknown,
  options: ApiOptions = {},
): Promise<{ scriptID: string; rev: number }> {
  const data = await postJson("/api/botscripts", { doc }, options);
  return { scriptID: typeof data.scriptID === "string" ? data.scriptID : "", rev: asNumberOrNull(data.rev) ?? 1 };
}

export async function updateBotScript(
  scriptID: string,
  doc: unknown,
  baseRev: number,
  options: ApiOptions = {},
): Promise<{ rev: number }> {
  const data = await postJson(`/api/botscripts/${encodeURIComponent(scriptID)}`, { doc, baseRev }, options);
  return { rev: asNumberOrNull(data.rev) ?? 1 };
}

export async function deleteBotScript(scriptID: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/botscripts/${encodeURIComponent(scriptID)}/delete`, {}, options);
}

// ─── Server-side bots (src/botHost.js) ───────────────────────────────────────
// A bot the SERVER flies on a session of its own, so it keeps running when
// this tab goes away. These calls are the remote control: start a saved
// script on a character, watch its readout, stop it. Account-scoped like the
// script library above.

export interface ServerBot {
  readonly botID: string;
  readonly characterID: number;
  readonly characterName: string | null;
  readonly scriptID: string;
  readonly scriptName: string;
  readonly scriptRev: number;
  readonly scriptHash: string;
  readonly restartSafe: boolean;
  readonly riskClasses: readonly BotRiskClass[];
  readonly maxRuntimeMinutes: number;
  readonly expiresAt: string | null;
  readonly status: string;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
  readonly pauseReason: string | null;
  readonly note: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Set when the server restarted this bot after coming back up. */
  readonly resumedAt: string | null;
  /**
   * The last thing an "alert me" watch said on this bot, and when. A server bot has
   * no browser to notify, so this readout IS the alert's delivery.
   */
  readonly lastAlert: { readonly message: string; readonly atMs: number } | null;
}

function asServerBot(value: JsonValue): ServerBot {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    botID: typeof row.botID === "string" ? row.botID : "",
    characterID: asNumberOrNull(row.characterID) ?? 0,
    characterName: typeof row.characterName === "string" ? row.characterName : null,
    scriptID: typeof row.scriptID === "string" ? row.scriptID : "",
    scriptName: typeof row.scriptName === "string" ? row.scriptName : "Untitled bot",
    scriptRev: asNumberOrNull(row.scriptRev) ?? 0,
    scriptHash: typeof row.scriptHash === "string" ? row.scriptHash : "",
    restartSafe: row.restartSafe === true,
    riskClasses: Array.isArray(row.riskClasses)
      ? row.riskClasses.filter((risk): risk is BotRiskClass => typeof risk === "string") as BotRiskClass[]
      : [],
    maxRuntimeMinutes: asNumberOrNull(row.maxRuntimeMinutes) ?? 0,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    status: typeof row.status === "string" ? row.status : "unknown",
    phase: typeof row.phase === "string" ? row.phase : null,
    why: typeof row.why === "string" ? row.why : null,
    stepPath: typeof row.stepPath === "string" ? row.stepPath : null,
    pauseReason: typeof row.pauseReason === "string" ? row.pauseReason : null,
    note: typeof row.note === "string" ? row.note : null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
    endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    resumedAt: typeof row.resumedAt === "string" ? row.resumedAt : null,
    lastAlert: asLastAlert(row.lastAlert),
  };
}

/** Decode a bot's last alert; a malformed or absent one reads as no alert. */
function asLastAlert(value: JsonValue | undefined): { message: string; atMs: number } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, JsonValue>;
  const message = typeof row.message === "string" ? row.message : null;
  if (message === null || message.length === 0) {
    return null;
  }
  return { message, atMs: asNumberOrNull(row.atMs) ?? 0 };
}

export async function listServerBots(options: ApiOptions = {}): Promise<ServerBot[]> {
  const data = await getJson("/api/bots", options);
  return Array.isArray(data.bots) ? data.bots.map(asServerBot) : [];
}

/** One hold's fill level in a bot-flown ship's vitals sample. */
export interface ActiveBotHold {
  readonly label: string;
  readonly used: number | null;
  readonly capacity: number | null;
}

/** The last ship-state sample the host took for a running bot (~15s cadence). */
export interface ActiveBotVitals {
  readonly sampledAt: string | null;
  /** null = not known yet; true = docked (health bars don't apply). */
  readonly docked: boolean | null;
  readonly shield: number | null;
  readonly armor: number | null;
  readonly hull: number | null;
  readonly holds: readonly ActiveBotHold[];
}

/** A running server bot as the UNAUTHENTICATED landing screens see it. */
export interface ActiveServerBot {
  readonly characterID: number;
  readonly status: string;
  readonly phase: string | null;
  readonly why: string | null;
  readonly note: string | null;
  readonly vitals: ActiveBotVitals | null;
}

function asActiveServerBot(value: JsonValue): ActiveServerBot {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const rawVitals =
    typeof row.vitals === "object" && row.vitals !== null && !Array.isArray(row.vitals)
      ? (row.vitals as Record<string, JsonValue>)
      : null;
  return {
    characterID: asNumberOrNull(row.characterID) ?? 0,
    status: typeof row.status === "string" ? row.status : "unknown",
    phase: typeof row.phase === "string" ? row.phase : null,
    why: typeof row.why === "string" ? row.why : null,
    note: typeof row.note === "string" ? row.note : null,
    vitals: rawVitals
      ? {
          sampledAt: typeof rawVitals.sampledAt === "string" ? rawVitals.sampledAt : null,
          docked: typeof rawVitals.docked === "boolean" ? rawVitals.docked : null,
          shield: asNumberOrNull(rawVitals.shield),
          armor: asNumberOrNull(rawVitals.armor),
          hull: asNumberOrNull(rawVitals.hull),
          holds: Array.isArray(rawVitals.holds)
            ? rawVitals.holds.map((hold) => {
                const entry = (hold ?? {}) as Record<string, JsonValue>;
                return {
                  label: typeof entry.label === "string" ? entry.label : "Hold",
                  used: asNumberOrNull(entry.used),
                  capacity: asNumberOrNull(entry.capacity),
                };
              })
            : [],
        }
      : null,
  };
}

/**
 * The running server bots as the landing screens see them. Unauthenticated by
 * design — the login/character screens mark bot-flown pilots and show their
 * ship vitals before any sign-in exists.
 */
export async function listActiveServerBots(options: ApiOptions = {}): Promise<ActiveServerBot[]> {
  const data = await getJson("/api/bots/active", options);
  return Array.isArray(data.bots) ? data.bots.map(asActiveServerBot) : [];
}

export async function startServerBot(
  characterID: number,
  scriptID: string,
  grant: BotLaunchGrant,
  options: ApiOptions = {},
): Promise<ServerBot> {
  const data = await postJson(
    "/api/bots/start",
    { characterID, scriptID, grant: grant as unknown as JsonValue },
    options,
  );
  return asServerBot(data.bot ?? null);
}

/**
 * The companion sibling of `startServerBot` — same route, same shape, same
 * grant handling; only what is being launched differs. A companion request
 * has no script library entry to name by id, so this carries the flat
 * request itself in place of a `scriptID`, and `kind: "companion"` tells
 * `/api/bots/start` (src/server.js) which branch to take. `botHost.start()`
 * (src/botHost.js) is the one place that decodes and trusts it.
 */
export async function startServerCompanion(
  characterID: number,
  request: FleetCompanionRequest,
  grant: BotLaunchGrant,
  options: ApiOptions = {},
): Promise<ServerBot> {
  const data = await postJson(
    "/api/bots/start",
    {
      characterID,
      kind: "companion",
      request: request as unknown as JsonValue,
      grant: grant as unknown as JsonValue,
    },
    options,
  );
  return asServerBot(data.bot ?? null);
}

export async function stopServerBot(botID: string, options: ApiOptions = {}): Promise<ServerBot> {
  const data = await postJson(`/api/bots/${encodeURIComponent(botID)}/stop`, {}, options);
  return asServerBot(data.bot ?? null);
}

// --- R7c Batch name resolution (names everywhere) --------------------------
// Turn raw IDs into names across every tab in ONE round-trip. POST /api/names
// takes { items: [{kind, id}] } and returns { names: { "kind:id": name|null } }
// over the static reference getters — read-only, like /api/map/find, NOT a
// gateway/bridge call. A null value is a definitive "unknown" (an NPC/type not
// in the static tables); the client name-cache caches it so it never refetches.

export interface ResolveNamesResult {
  /** Keyed by `${kind}:${id}`; value is the resolved name or null (unknown). */
  readonly names: Readonly<Record<string, string | null>>;
  /**
   * R38 — keys whose lookup could NOT be completed (no character online, a
   * gateway error, or past the per-request structure cap).
   *
   * ⚠ NOT THE SAME AS A null IN `names`. A null there is the server's definite
   * finding that nothing bears that ID; a key listed here means the question
   * was never answered. The name cache must not store these, or one lookup
   * failure would pin a place to its fallback for the rest of the session.
   */
  readonly unresolved: readonly string[];
}

/** Batch-resolve a set of `{kind, id}` refs to names (kind:id → name | null). */
export async function resolveNames(
  items: readonly NameRef[],
  options: ApiOptions = {},
): Promise<ResolveNamesResult> {
  const data = await postJson("/api/names", { items }, options);
  const raw =
    typeof data.names === "object" && data.names !== null && !Array.isArray(data.names)
      ? (data.names as Record<string, JsonValue>)
      : {};
  const names: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    names[key] = typeof value === "string" ? value : null;
  }
  const unresolved = Array.isArray(data.unresolved)
    ? (data.unresolved as JsonValue[]).filter(
        (key): key is string => typeof key === "string",
      )
    : [];
  return { names, unresolved };
}

// --- R107 The hangar's training column, for pilots who are NOT signed in ----
// GET /api/roster/training?characterIDs=a,b,c answers what each of those pilots
// is training, read from the gateway's live queue snapshot.
//
// ⚠ IT REPLACES A FIELD THAT LIES. charUnboundMgr.GetCharacterSelectionData
// carries skillTypeID / toLevel / trainingEndTime per character and the hangar
// used to believe them; on this emulator they are always null, even for a pilot
// with an active fifty-skill queue, so every training row read as IDLE. See the
// route in src/server.js for the measurement.

export interface RosterTrainingRow {
  readonly characterID: number;
  /** The skill being trained; null is the positive finding "the queue is empty". */
  readonly skillTypeID: number | null;
  /** Already resolved by the server — the roster needs no name lookup for it. */
  readonly skillName: string | null;
  readonly toLevel: number | null;
  /** When the level completes, epoch ms, or null when nothing is training. */
  readonly endsAtMs: number | null;
}

/**
 * What each of these pilots is training. Only pilots the server could actually
 * answer for come back: an id that is missing from the result was NOT answered
 * (not this account's, or the read failed), and the caller must keep whatever it
 * already had for it rather than reading the gap as an empty queue.
 */
export async function loadRosterTraining(
  characterIDs: readonly number[],
  options: ApiOptions = {},
): Promise<readonly RosterTrainingRow[]> {
  const ids = characterIDs.filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    return [];
  }
  const data = await getJson(
    `/api/roster/training?characterIDs=${encodeURIComponent(ids.join(","))}`,
    options,
  );
  if (!Array.isArray(data.training)) {
    return [];
  }
  const rows: RosterTrainingRow[] = [];
  for (const entry of data.training as JsonValue[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, JsonValue>;
    const characterID = asNumberOrNull(row.characterID);
    if (characterID === null) {
      continue;
    }
    rows.push({
      characterID,
      skillTypeID: asNumberOrNull(row.skillTypeID),
      skillName: typeof row.skillName === "string" ? row.skillName : null,
      toLevel: asNumberOrNull(row.toLevel),
      endsAtMs: asNumberOrNull(row.endsAtMs),
    });
  }
  return rows;
}

// --- R24 slice C: module cycle times (static reference data) ----------------
// POST /api/types/cycle-times takes { typeIDs } and returns { baseCycleMs }.
// Read-only static data over attribute 73 (`duration`) — like /api/names, NOT a
// gateway/bridge call. The wire name says `base` because that is what it is:
// the type's duration before skills, bonuses, rigs or heat. Where the server
// has pushed a real cycle event, THAT figure wins.

export interface CycleTimesResult {
  /** typeID -> milliseconds, or null where the type has no duration at all. */
  readonly baseCycleMs: Readonly<Record<number, number | null>>;
}

export async function loadBaseCycleTimes(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<CycleTimesResult> {
  const data = await getJson(
    `/api/types/cycle-times?typeIDs=${encodeURIComponent(typeIDs.join(","))}`,
    options,
  );
  const raw =
    typeof data.baseCycleMs === "object" && data.baseCycleMs !== null && !Array.isArray(data.baseCycleMs)
      ? (data.baseCycleMs as Record<string, JsonValue>)
      : {};
  const baseCycleMs: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const typeID = Number(key) || 0;
    if (typeID <= 0) {
      continue;
    }
    const ms = Number(value);
    baseCycleMs[typeID] = Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return { baseCycleMs };
}

// --- R25 slice A: drones -----------------------------------------------------
//
// Four routes, and NOT ONE of them can be trusted on its own return value. The
// server's launch handler answers 200 with an empty dict when it refuses, and
// all three entity orders answer an empty dict on SUCCESS and error tuples
// otherwise. So every function below reports what the BFF read back OUT OF
// SPACE afterwards, and `inSpace: null` means the re-read failed — never "you
// have no drones".

/** The whole Drones panel in one read: bay, space, and the server's limits. */
export interface DronesResult {
  readonly activeShipID: number | null;
  /** null when the bay could not be read — NOT an empty bay. */
  readonly bay: JsonValue;
  /** null when the snapshot could not be read — NOT "no drones in space". */
  readonly inSpace: JsonValue;
  /** Raw dogmaIM.ShipGetInfo, decoded by bridge/drones.ts (no new call). */
  readonly shipInfo: JsonValue;
  readonly errors: Readonly<Record<string, string | null>>;
}

/**
 * What a launch or an order ACTUALLY changed, as the snapshot reports it.
 *
 * `launched` is present only for a launch, and is the honest claim: the drones
 * in space now that were not in space before. A drone the server declined
 * simply does not appear, so the panel says "nothing launched" instead of
 * echoing a phantom success.
 */
export interface DroneActionResult {
  readonly inSpace: JsonValue;
  readonly launched: JsonValue;
  /**
   * R34 — the raw call RESULT dict, which is where the server writes its OWN
   * plain-language reason for every drone it refused, keyed by droneID.
   *
   * ⚠ IT WAS BEING DROPPED IN THE BFF, and that was the whole of the defect
   * R33 worked around by predicting: `droneOrderRoute` forwarded only
   * `outcome.notifications`, so thirteen sentences the server had already
   * written for the player never left the building. Undecoded here on purpose —
   * `bridge/drones.ts` reads it, `bridge/refusals.ts` turns it into words.
   *
   * Present only for the three in-space orders. A launch answers with a
   * different per-item shape and is still judged by `launched` alone.
   */
  readonly result: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readDroneAction(data: Record<string, JsonValue>): DroneActionResult {
  return {
    inSpace: data.inSpace ?? null,
    launched: data.launched ?? null,
    result: data.result ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

export async function getDrones(options: ApiOptions = {}): Promise<DronesResult> {
  const data = await getJson("/api/bridge/drones", options);
  const rawErrors =
    typeof data.errors === "object" && data.errors !== null && !Array.isArray(data.errors)
      ? (data.errors as Record<string, JsonValue>)
      : {};
  const errors: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(rawErrors)) {
    errors[key] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return {
    activeShipID: Number(data.activeShipID) || null,
    bay: data.bay ?? null,
    inSpace: data.inSpace ?? null,
    shipInfo: data.shipInfo ?? null,
    errors,
  };
}

/**
 * Launch from the bay (ship.LaunchDrones).
 *
 * ⚠ THIS IS THE DEFENCE. An idle combat drone auto-engages whatever shoots the
 * ship it came from — the server's own behaviour, on by default — so a miner
 * who launches is defended without another click. `engageDrones` below is for
 * choosing a victim, not for being protected.
 */
export async function launchDrones(
  drones: readonly { readonly itemID: number; readonly quantity?: number }[],
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  const body: JsonValue = drones.map((entry) => ({
    itemID: entry.itemID,
    quantity: entry.quantity ?? 1,
  }));
  return readDroneAction(await postJson("/api/bridge/drones/launch", { drones: body }, options));
}

/** Set drones on a target (entity.CmdEngage). */
export async function engageDrones(
  droneIDs: readonly number[],
  targetID: number,
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  return readDroneAction(
    await postJson("/api/bridge/drones/engage", { droneIDs: [...droneIDs], targetID }, options),
  );
}

/** Put mining drones on a rock (entity.CmdMineRepeatedly). */
export async function mineWithDrones(
  droneIDs: readonly number[],
  targetID: number,
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  return readDroneAction(
    await postJson("/api/bridge/drones/mine", { droneIDs: [...droneIDs], targetID }, options),
  );
}

/**
 * Bring drones home (entity.CmdReturnBay). The runtime flies them back and
 * scoops them itself inside 2500 m, so they stay visibly "coming home" for the
 * length of the trip — which is exactly what the re-read reports.
 */
export async function recallDrones(
  droneIDs: readonly number[],
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  return readDroneAction(
    await postJson("/api/bridge/drones/recall", { droneIDs: [...droneIDs] }, options),
  );
}

/**
 * Take control of drones this ship is not flying (entity.CmdReconnectToDrones).
 *
 * The recovery path for an ORPHANED drone — one this character owns that the
 * current hull does not control, after a lost session, a ship swap, or a pod
 * and reboard. Until this existed a web-client player had no way to get such a
 * drone back at all: Recall and Engage both need control the ship does not have.
 */
export async function reconnectDrones(
  droneIDs: readonly number[],
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  return readDroneAction(
    await postJson(
      "/api/bridge/entity/drones/reconnect",
      { droneIDs: [...droneIDs], confirm: true },
      options,
    ),
  );
}

/**
 * Scoop drones straight into the bay (ship.ScoopDrone).
 *
 * The other half of recovery, and the one that needs no control at all: a drone
 * close enough to scoop comes home whether or not this ship can fly it. In
 * space only, and the server owns the range check — the page never pre-refuses
 * on distance it would have to guess.
 */
export async function scoopDrones(
  droneIDs: readonly number[],
  options: ApiOptions = {},
): Promise<DroneActionResult> {
  return readDroneAction(
    await postJson(
      "/api/bridge/drones/scoop",
      { droneIDs: [...droneIDs], confirm: true },
      options,
    ),
  );
}

/**
 * Spend unallocated skill points into one skill (skillHandler.ApplyFreeSkillPoints).
 *
 * ⚠ ONE SKILL AT A TIME, BY TYPE. The server caps the amount at what the skill
 * is missing for its next level and at the free SP actually held, and refuses
 * outright for a skill that is currently training or that the character does not
 * know. It returns the NEW free-SP total, which is the only trustworthy answer
 * about what was actually spent.
 */
export async function applyFreeSkillPoints(
  skillTypeID: number,
  points: number,
  options: ApiOptions = {},
): Promise<number | null> {
  const data = await postJson(
    "/api/bridge/skills/apply-free-points",
    { skills: skillTypeID, points, confirm: true },
    options,
  );
  return asNumberOrNull(data.result);
}

// --- Overloading --------------------------------------------------------------
//
// ⚠ OVERLOADING DAMAGES THE MODULE. It runs harder and takes heat; a module left
// overloaded burns out and stops. The server owns every rule — it refuses a
// module that is offline, incapacitated, not overloadable, or on a pilot without
// Thermodynamics — and those refusals reach the player in the server's words.
//
// The effectID is omitted: the server resolves the module's own overload effect
// from its type, exactly as activation resolves the default activation effect.

/** Start overloading one module (dogmaIM.Overload). */
export async function overloadModule(
  moduleID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/dogma/module/overload", { moduleID, confirm: true }, options);
}

/** Stop overloading one module (dogmaIM.StopOverload). */
export async function stopOverloadModule(
  moduleID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/dogma/module/stop-overload", { moduleID, confirm: true }, options);
}

/**
 * Start a nanite repair on one module (dogmaIM.InitiateModuleRepair).
 *
 * ⚠ THE COMPLEMENT TO OVERLOADING, and the reason it is not optional: heat
 * damages modules, and without this the client can burn a module out with no
 * way to bring it back. It CONSUMES Nanite Repair Paste from the ship, and the
 * server refuses when there is none — in its own words.
 */
export async function repairModule(
  moduleID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/dogma/module/repair/start", { moduleID, confirm: true }, options);
}

/** Stop an in-progress module repair (dogmaIM.StopModuleRepair). */
export async function stopRepairModule(
  moduleID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/dogma/module/repair/stop", { moduleID, confirm: true }, options);
}

/**
 * Bank every compatible weapon on the ship (dogmaIM.LinkAllWeapons), so one
 * click fires the group.
 *
 * The ship is the SESSION's own active hull, pinned by the BFF — these routes
 * used to take a browser-supplied shipID and no longer do.
 */
export async function linkAllWeapons(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/dogma/weapons/link-all", { confirm: true }, options);
}

/** Break every weapon bank on the ship (dogmaIM.UnlinkAllModules). */
export async function unlinkAllWeapons(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/dogma/weapons/unlink-all", { confirm: true }, options);
}

// --- Ammunition ---------------------------------------------------------------
//
// Where the charges come from and go to is a WORD — "cargo" or "hangar" — never
// a location id: the BFF pins the concrete ids from the session's own active
// ship and docked station, so a browser cannot aim a load at somewhere else.
export type AmmoPlace = "cargo" | "hangar";

/**
 * Load charges into modules (dogmaIM.LoadAmmo).
 *
 * ⚠ COMPATIBILITY IS THE SERVER'S CALL. Which charges a module accepts lives in
 * dogma attributes the browser has no allowlisted read for, so the panel offers
 * what is in the chosen inventory and lets the server refuse the rest with its
 * own words. Guessing here would mean hiding ammunition that would have worked.
 *
 * A bank master may expand server-side to every linked weapon, which is part of
 * why the BFF confirms this.
 */
export async function loadAmmo(
  moduleIDs: readonly number[],
  chargeItemIDs: readonly number[],
  source: AmmoPlace,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(
    "/api/bridge/dogma/ammo/load",
    { moduleIDs: [...moduleIDs], chargeItemIDs: [...chargeItemIDs], source, confirm: true },
    options,
  );
}

/**
 * Unload charges from modules (dogmaIM.UnloadAmmo).
 *
 * An omitted quantity empties the module completely, which is what the panel
 * asks for — a partial unload has no control, because there is no question it
 * answers that "take it all out and load something else" does not.
 */
export async function unloadAmmo(
  moduleIDs: readonly number[],
  destination: AmmoPlace,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(
    "/api/bridge/dogma/ammo/unload",
    { moduleIDs: [...moduleIDs], destination, confirm: true },
    options,
  );
}

// --- The GM console -----------------------------------------------------------

/**
 * Run one of this world's own chat commands (slash.SlashCmd).
 *
 * ⚠⚠ DEV-ONLY, AND IT REACHES EVERYTHING. ~150 commands, including destructive
 * ones (/suicide), world-spawning ones (/npc) and the item-granting ones this
 * exists for (/giveitem, /gmships, /gmweapons, /giveskill). eve.js applies no
 * role gate to any of them; the BFF's confirmation is the only gate.
 *
 * The command goes VERBATIM — this is an operator's console, and a client that
 * curated the command list would be a worse, staler copy of the server's own.
 * The reply is the server's own message, INCLUDING its failures: eve.js catches
 * a bad command and returns "Command failed: …" rather than throwing, so a
 * refusal arrives as an ordinary success with a sentence in it. Callers must
 * render that sentence rather than reading the 200 as "it worked".
 */
export async function runGmCommand(
  command: string,
  options: ApiOptions = {},
): Promise<string> {
  const data = await postJson("/api/bridge/gm/slash", { command, confirm: true }, options);
  return typeof data.result === "string" ? data.result : "";
}

/** The repair shop's quote for these items: which of them it lists as damaged. */
export async function getRepairQuotes(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<JsonValue> {
  const query = itemIDs.map((id) => encodeURIComponent(String(id))).join(",");
  const data = await getJson(`/api/bridge/station/repair-quotes?itemIDs=${query}`, options);
  return data.quotes ?? null;
}

/** Pay the station to repair these items (the server debits the wallet). */
export async function repairItems(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/station/repair", { itemIDs: [...itemIDs], confirm: true }, options);
}

/** Apply one PI network edit (restart an extractor programme). */
export async function restartExtractorProgram(
  planetID: number,
  pinID: number,
  resourceTypeID: number,
  options: ApiOptions = {},
): Promise<void> {
  // Command 13 = INSTALLPROGRAM(pinID, programTypeID, headRadius). A null head
  // radius keeps the pin's existing drill area — a pure "run it again".
  await postJson(
    "/api/bridge/planet/network/update",
    { planetID, changes: [[13, [pinID, resourceTypeID, null]]], confirm: true },
    options,
  );
}

/** The character's saved-fitting library, raw (decoded by bridge/fittings.ts). */
export async function loadSavedFittings(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson("/api/bridge/fittings", options);
  return data.fittings ?? null;
}

/** Apply a saved fitting to a ship — modules pulled from the docked hangar. */
export async function applySavedFitting(
  shipID: number,
  sourceLocationID: number,
  modulesByFlag: Readonly<Record<number, number>>,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(
    "/api/bridge/inventory/fit-fitting",
    { shipID, sourceLocationID, modulesByFlag: modulesByFlag as unknown as JsonValue, confirm: true },
    options,
  );
}

/**
 * The onboard scanner's full state — the session's OWN system's anomalies /
 * signatures / static sites / structures, raw (decoded by
 * bridge/boundSmallServices.decodeFullState). Rides the small-services route.
 */
export async function loadScanFullState(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await loadBoundSmallServices(options);
  const reads = (data.reads ?? {}) as Record<string, JsonValue>;
  const slot = (reads.GetFullState ?? {}) as Record<string, JsonValue>;
  if (typeof slot.error === "string" && slot.error.length > 0) {
    // A failed arm is UNKNOWN, never a successfully empty system. Existing bot
    // callers catch this and keep their observation null rather than acting on
    // an invented empty scan.
    throw new Error("The current system scanner state is unavailable.");
  }
  return slot.result ?? null;
}

/** Whole independently-failing small-services envelope (keeps scan errors). */
export async function loadBoundSmallServices(
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  return getJson("/api/bridge/bound-small-services", options);
}

/** Static formation reference result (often an honest proxy-cache reference). */
export async function loadScannerFormations(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson("/api/bridge/formations", options);
  return data.formations ?? null;
}

function scannerVector(value: JsonValue | undefined): readonly [number, number, number] {
  if (!Array.isArray(value)) {
    return [0, 0, 0];
  }
  return [0, 1, 2].map((index) => asNumberOrNull(value[index]) ?? 0) as unknown as readonly [number, number, number];
}

/** Decode EveJS's current held-session scanner authority. */
export async function loadScannerOperations(
  options: ApiOptions = {},
): Promise<ScannerOperationsSnapshot> {
  const data = await getJson("/api/bridge/scanner/state", options);
  const scanner = data.scanner && typeof data.scanner === "object" && !Array.isArray(data.scanner)
    ? data.scanner as Record<string, JsonValue>
    : {};
  const launcherRow = scanner.launcher && typeof scanner.launcher === "object" && !Array.isArray(scanner.launcher)
    ? scanner.launcher as Record<string, JsonValue>
    : null;
  const probes: ScannerProbeOperation[] = Array.isArray(scanner.probes)
    ? scanner.probes.flatMap((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, JsonValue>;
        const probeID = asNumberOrNull(row.probeID);
        const typeID = asNumberOrNull(row.typeID);
        if (probeID === null || probeID <= 0 || typeID === null || typeID <= 0) return [];
        return [{
          probeID,
          typeID,
          pos: scannerVector(row.pos),
          destination: scannerVector(row.destination),
          scanRange: asNumberOrNull(row.scanRange) ?? 0,
          rangeStep: asNumberOrNull(row.rangeStep) ?? 0,
          state: asNumberOrNull(row.state) ?? 0,
          expiry: typeof row.expiry === "string" ? row.expiry : "0",
        }];
      })
    : [];
  return {
    inSpace: scanner.inSpace === true,
    solarSystemID: asNumberOrNull(scanner.solarSystemID),
    shipID: asNumberOrNull(scanner.shipID),
    maxActiveProbes: Math.max(0, asNumberOrNull(scanner.maxActiveProbes) ?? 0),
    launcher: launcherRow === null || (asNumberOrNull(launcherRow.moduleID) ?? 0) <= 0
      ? null
      : {
          moduleID: asNumberOrNull(launcherRow.moduleID)!,
          typeID: asNumberOrNull(launcherRow.typeID),
          online: launcherRow.online === true,
          chargeTypeID: asNumberOrNull(launcherRow.chargeTypeID),
          loadedCount: Math.max(0, asNumberOrNull(launcherRow.loadedCount) ?? 0),
          launchCount: Math.max(0, asNumberOrNull(launcherRow.launchCount) ?? 0),
        },
    probes,
  };
}

/** Safe product actions accept no authority-bearing browser arguments. */
export async function launchScannerProbes(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/scanner/launch", { confirm: true }, options);
}

export async function recoverScannerProbes(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/scanner/recover", { confirm: true }, options);
}

export async function requestScannerAnalysis(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/scanner/analyze", { confirm: true }, options);
}

/** Ask the current-system manager to reconnect the session character's probes. */
export async function reconnectScannerProbes(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/scanner/reconnect", { confirm: true }, options);
}

/**
 * ⚠ JETTISON — dumps these cargo items into space as a container ANYONE can take.
 * The BFF route is confirm-gated (ship/Jettison); this is the only path.
 */
export async function jettisonItems(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bridge/ship/jettison", { itemIDs: [...itemIDs], confirm: true }, options);
}

/** What one in-space compression attempt answered. */
export interface CompressionAttempt {
  /**
   * True when the server really swapped the stack. False means it refused — and
   * it refuses a missing facility, an out-of-range one, a foreign item and an
   * ore that has no compressed form all with the same silence, so the caller
   * re-reads its hold rather than guessing which.
   */
  readonly compressed: boolean;
  /** The raw tuple on success: [srcItem, srcType, srcQty, outItem, outType, outQty]. */
  readonly result: JsonValue | null;
}

/**
 * Compress ONE ore stack in the ship's hold, using a mining support ship on grid
 * as the facility (its own hull, or a fleet-mate's, running an Industrial Core
 * plus a compression module). Confirm-gated at the BFF.
 */
export async function compressOreInSpace(
  itemID: number,
  facilityID: number,
  options: ApiOptions = {},
): Promise<CompressionAttempt> {
  const data = await postJson(
    "/api/bridge/mining/compress",
    { itemID, facilityID, confirm: true },
    options,
  );
  return {
    compressed: data.compressed === true,
    result: data.result ?? null,
  };
}

/** A full-sweep directional scan covers the whole sky. */
export const DSCAN_FULL_SWEEP_RADIANS = Math.PI * 2;

/** One astronomical unit, in metres — the unit a scanner range is set in. */
export const AU_METERS = 149_597_870_700;

/**
 * Run a directional (D-scan) sweep from the session's own ship: the R104
 * ConeScan bound write (confirm-gated on the BFF like every scan-control
 * write). Returns the raw hit list — util.KeyVal rows of {id, typeID, groupID}
 * — decoded by bridge/boundScanWrites.decodeDirectionalScanHitIDs. The server
 * clamps the range to the ship's own scanner reach, so an oversized ask is
 * safe. A full sweep needs SOME direction vector; +x is arbitrary and ignored.
 */
export async function coneScan(
  angleRadians: number,
  rangeMeters: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(
    "/api/bridge/scan/cone-scan",
    { angle: angleRadians, range: rangeMeters, dx: 1, dy: 0, dz: 0, confirm: true },
    options,
  );
  return data.result ?? null;
}

/** The character's active bookmarks, raw (decoded by bridge/bookmarks.ts). */
export async function loadActiveBookmarks(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson("/api/bridge/bookmarks", options);
  return data.active ?? null;
}

/** Warp to a saved bookmark (the server resolves site/point/mission scope). */
export async function warpToBookmark(
  bookmarkID: number,
  minRange: number,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/warp-bookmark", { bookmarkID, minRange }, options));
}

/** Warp to a scanned site by its scan-signature label ("QEE-288"). */
export async function warpToScanSite(
  target: string,
  minRange: number,
  options: ApiOptions = {},
): Promise<FlightStepResult> {
  return readFlightStep(await postJson("/api/bridge/flight/warp-scan", { target, minRange }, options));
}

/**
 * Order salvage drones onto a wreck (entity.CmdSalvage). targetID 0 lets the
 * runtime AUTO-PICK a salvageable wreck — the sane default for a sweep.
 */
export async function salvageDrones(
  droneIDs: readonly number[],
  targetID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(
    "/api/bridge/entity/drones/salvage",
    { droneIDs: [...droneIDs], targetID, confirm: true },
    options,
  );
}

// --- R28 Skills: the character sheet and the training queue -------------------
//
// ONE read and ONE write, because that is what the server has. Adding a skill,
// removing one and reordering are all "save this list" — the same call retail
// makes — so there is no add/remove/move endpoint to keep in step with three
// different server behaviours.
//
// The write's answer is NOT its own return value: the BFF re-reads the sheet
// after every save and returns THAT, so a caller cannot accidentally believe a
// queue edit that never landed.

/** The whole Skills panel in one read: sheet, queue, and the server's clock. */
export interface SkillsResult {
  /** Raw; decoded by bridge/skills.ts. Carries serverNowMs for the countdown. */
  readonly skills: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readSkills(data: Record<string, JsonValue>): SkillsResult {
  return {
    skills: data.skills ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

export async function getSkills(options: ApiOptions = {}): Promise<SkillsResult> {
  return readSkills(await getJson("/api/bridge/skills", options));
}

/**
 * Save the whole training queue (skillMgr.SaveNewQueue).
 *
 * Sending [] pauses training. The server validates the list as a WHOLE and
 * refuses all of it with one of eleven public codes if any part is wrong — the
 * refusal arrives as a BridgeCallError whose message is that bare code, which
 * bridge/skills.ts turns into a sentence.
 */
export async function saveSkillQueue(
  entries: readonly { readonly typeID: number; readonly toLevel: number }[],
  options: ApiOptions = {},
): Promise<SkillsResult> {
  const body: JsonValue = entries.map((entry) => ({
    typeID: entry.typeID,
    toLevel: entry.toLevel,
  }));
  return readSkills(await postJson("/api/bridge/skills/queue", { entries: body }, options));
}

// --- R41 Planets: the character's colonies ------------------------------------
//
// ONE read and no write. This is not a bridge `callMethod` — the BFF answers it
// from the gateway's owner-scoped snapshot, so it costs the deny-by-default
// allowlist nothing. See src/server.js for why the planetMgr reads that would
// have needed allowlisting were declined.

/** The whole Planets panel in one read, decoded by bridge/planets.ts. */
export interface PlanetsResult {
  /** Raw colony rows; every id in them is for an icon, never for display. */
  readonly planets: JsonValue;
}

export async function getPlanets(options: ApiOptions = {}): Promise<PlanetsResult> {
  const data = await getJson("/api/bridge/planets", options);
  return { planets: data as JsonValue };
}
