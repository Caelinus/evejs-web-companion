// Reading corporation hangars for the PI board (R108 slice 5).
//
// ⚠ THE ONE READ THAT NEEDS A PILOT ONLINE. Colonies and personal hangars come
// from each pilot's gateway snapshot with nobody selected (piRosterRead.ts),
// but corp-owned goods are in no pilot's snapshot: the snapshot is filtered to
// the character as owner. The corp asset read (corpmgr, GET
// /api/bridge/corp-assets) runs on a HELD session, so it is made through a pilot
// of that corporation who is already online in this tab — riding that pilot's
// own session, never selecting anyone. A corp with none of its pilots online is
// reported as such; the board says so beside the numbers and offers no sign-in.
//
// ⚠ ONE PILOT PER CORPORATION, TRIED IN TURN. Every member reads the same
// hangars, so the first pilot that answers is the answer. A pilot that is
// refused (no hangar access, a stale session) is recorded against that pilot
// and the next one is tried: in a game where roles differ, one pilot's refusal
// must not hide goods another pilot can see.
//
// ⚠ ONE OFFICE AT A TIME, for the reason piRosterRead.ts reads one account at
// a time: the browser allows about six connections per origin, and the player's
// own clicks must not queue behind a sweep.

import { loadCorpAssets as apiLoadCorpAssets, resolveNames as apiResolveNames, type ApiOptions, type ResolveNamesResult } from "./api.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { NameRef } from "../store/names.ts";
import { decodeCorpAssetItems, decodeCorpAssetLocations } from "../bridge/corpAssets.ts";
import { corpDivisionOfFlag, isPlayerCorporation, type CorpStockItem, type CorpStockRead } from "../bridge/piStock.ts";

/** A pilot online in this tab, as the corp read needs it. */
export interface OnlinePilot {
  readonly characterID: number;
  readonly corporationID: number | null;
  /** The pilot's own session: every call here rides it. */
  readonly options: ApiOptions;
}

export interface PiCorpReadDeps {
  loadCorpAssets(locationID: number | null, options: ApiOptions): Promise<Record<string, JsonValue>>;
  resolveNames(items: readonly NameRef[], options: ApiOptions): Promise<ResolveNamesResult>;
  /** The browser's clock. */
  now(): number;
}

const LIVE_DEPS: PiCorpReadDeps = {
  loadCorpAssets: (locationID, options) => apiLoadCorpAssets(locationID, options),
  resolveNames: (items, options) => apiResolveNames(items, options),
  now: () => Date.now(),
};

// The server's classification of planetary goods, by category (the same rule
// the roster read applies to a pilot's own items in src/server.js).
const PLANETARY_CATEGORY_IDS = new Set([42, 43]);

function refusalWords(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0 ? error.message : null;
  return message ?? "the read failed";
}

function errorCode(body: Record<string, JsonValue>, field: string): string | null {
  const errors = body.errors;
  if (errors === null || typeof errors !== "object" || Array.isArray(errors)) return null;
  const code = (errors as Record<string, JsonValue>)[field];
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Every planetary stack in the corp's offices, through one pilot. Throws when refused. */
async function readThrough(pilot: OnlinePilot, deps: PiCorpReadDeps): Promise<{ items: CorpStockItem[]; name: string | null }> {
  const first = await deps.loadCorpAssets(null, pilot.options);
  const refused = errorCode(first, "inventory");
  if (refused !== null) {
    throw new Error(`the server refused the corporation asset read (${refused})`);
  }
  const locations = decodeCorpAssetLocations(first.inventory ?? null);
  const raw: { locationID: number; typeID: number; quantity: number; division: number | null }[] = [];
  for (const location of locations) {
    const body = await deps.loadCorpAssets(location.locationID, pilot.options);
    const code = errorCode(body, "locationInventory");
    if (code !== null) {
      throw new Error(`the server refused to list an office (${code})`);
    }
    for (const item of decodeCorpAssetItems(body.locationInventory ?? null)) {
      if (!PLANETARY_CATEGORY_IDS.has(item.categoryID) || item.units <= 0) continue;
      raw.push({
        locationID: location.locationID,
        typeID: item.typeID,
        quantity: item.units,
        division: corpDivisionOfFlag(item.flagID),
      });
    }
  }

  // Names in one round trip: the offices' stations and the corporation itself.
  // A name that does not come back is left null and worded by the board.
  const corporationID = pilot.corporationID!;
  const refs: NameRef[] = [
    { kind: "corporation", id: corporationID },
    ...[...new Set(raw.map((entry) => entry.locationID))].map((id) => ({ kind: "station" as const, id })),
  ];
  let names: Readonly<Record<string, string | null>> = {};
  try {
    names = (await deps.resolveNames(refs, pilot.options)).names;
  } catch {
    // Unnamed is still counted: the quantities are the point.
  }

  // One line per type, office and division.
  const merged = new Map<string, CorpStockItem>();
  for (const entry of raw) {
    const key = `${entry.typeID}:${entry.locationID}:${entry.division ?? ""}`;
    const known = merged.get(key);
    merged.set(key, known
      ? { ...known, quantity: known.quantity + entry.quantity }
      : {
          typeID: entry.typeID,
          quantity: entry.quantity,
          locationID: entry.locationID,
          locationName: names[`station:${entry.locationID}`] ?? null,
          division: entry.division,
        });
  }
  return { items: [...merged.values()], name: names[`corporation:${corporationID}`] ?? null };
}

/**
 * Read the hangars of every player corporation in `corporationIDs`, each
 * through the first of its pilots online here that answers.
 */
export async function readCorpStock(
  corporationIDs: readonly number[],
  online: readonly OnlinePilot[],
  deps: PiCorpReadDeps = LIVE_DEPS,
): Promise<CorpStockRead[]> {
  const reads: CorpStockRead[] = [];
  for (const corporationID of [...new Set(corporationIDs)].filter(isPlayerCorporation)) {
    const candidates = online.filter((pilot) => pilot.corporationID === corporationID);
    if (candidates.length === 0) {
      reads.push({
        corporationID,
        corporationName: null,
        state: "unreachable",
        viaCharacterID: null,
        readAtMs: null,
        items: [],
        refusals: [],
      });
      continue;
    }
    const refusals: { characterID: number; reason: string }[] = [];
    let done: CorpStockRead | null = null;
    for (const pilot of candidates) {
      try {
        const { items, name } = await readThrough(pilot, deps);
        done = {
          corporationID,
          corporationName: name,
          state: "read",
          viaCharacterID: pilot.characterID,
          readAtMs: deps.now(),
          items,
          refusals: [...refusals],
        };
        break;
      } catch (error) {
        refusals.push({ characterID: pilot.characterID, reason: refusalWords(error) });
      }
    }
    reads.push(done ?? {
      corporationID,
      corporationName: null,
      state: "failed",
      viaCharacterID: null,
      readAtMs: null,
      items: [],
      refusals,
    });
  }
  return reads;
}
