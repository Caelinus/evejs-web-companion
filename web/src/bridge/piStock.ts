// What you hold, across every pilot (goal R108 slice 5), as pure functions.
//
// Three sources, merged per commodity:
//
//   • a colony's own storage — read in the roster's snapshot, pin by pin;
//   • a pilot's hangars, ships and containers — the same snapshot's items;
//   • corporation hangars — read through a pilot of that corporation who is
//     online in this tab (app/piCorpRead.ts), because corp-owned goods are in
//     no pilot's snapshot and the corp asset read needs a held session.
//
// ---------------------------------------------------------------------------
// EVERY UNIT IS SAID WITH ITS PLACE.
//
// A total alone cannot be planned with: goods on the colony that uses them are
// already where they are needed, and goods in a station hangar need a hauler.
// So a holding is never merged across places — the line per commodity sums the
// columns, and keeps every holding under it with its place, its owner and when
// it was read.
//
// ---------------------------------------------------------------------------
// A MERGED VIEW IS NOT ONE MOMENT (piBoard.ts). Every holding carries its own
// read instant; the sources list says how old each part of the total is, and
// which part could not be read at all.

import type { Colony, ColonyPinKind } from "../store/types.ts";
import { colonyPlaceWords, formatDuration, serverNow } from "./planets.ts";
import type { PilotColonyReading, PilotStockStack } from "./piRoster.ts";
import { commodityName, tierOf, type PiRecipeBook, type PiTier } from "./piRecipes.ts";

/** Where a holding sits, in the three kinds that plan differently. */
export type HoldingSource = "colony" | "hangar" | "corp";

/** So much of one commodity, in one place. */
export interface Holding {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly quantity: number;
  readonly source: HoldingSource;
  /** "Alpha III launchpad", "Alpha VI - Moon 1 - Station, in Hauler One". */
  readonly placeWords: string;
  /** The pilot, or the corporation, it belongs to. */
  readonly ownerWords: string;
  /** The planet a colony holding sits on; null for a hangar or a corp office. */
  readonly planetID: number | null;
  /** When it was read, on the server's clock; null when unknown. */
  readonly readAtMs: number | null;
  /** The server's clock minus the browser's, for this holding's read. */
  readonly clockOffsetMs: number;
}

/** One corporation-owned stack, from the corp asset read. */
export interface CorpStockItem {
  readonly typeID: number;
  readonly quantity: number;
  readonly locationID: number;
  /** Null when the place could not be named — never the id (R7d). */
  readonly locationName: string | null;
  /** The hangar division, 1 to 7; null when the flag is not a division. */
  readonly division: number | null;
}

/** What reading one corporation's hangars came to. */
export interface CorpStockRead {
  readonly corporationID: number;
  readonly corporationName: string | null;
  /**
   * - `read`         a pilot of it answered; `items` is the whole answer
   * - `failed`       every pilot of it online here was tried and refused
   * - `unreachable`  none of its pilots is online in this tab
   */
  readonly state: "read" | "failed" | "unreachable";
  /** The pilot whose session read it. */
  readonly viaCharacterID: number | null;
  /** The browser's clock when the read landed. */
  readonly readAtMs: number | null;
  readonly items: readonly CorpStockItem[];
  /** Pilots tried before one answered (or all of them, when none did). */
  readonly refusals: readonly { readonly characterID: number; readonly reason: string }[];
}

// flagCorpSAG1..7 are flags 115..121: division N is flag 114 + N (the same
// mapping src/server.js keeps for the corp hangar routes).
const CORP_DIVISION_FLAG_BASE = 114;

/** The corp hangar division a flag names, or null for any other flag. */
export function corpDivisionOfFlag(flagID: number): number | null {
  const division = flagID - CORP_DIVISION_FLAG_BASE;
  return Number.isSafeInteger(division) && division >= 1 && division <= 7 ? division : null;
}

// NPC corporations own no hangars a player plans with: EVE's documented id
// range for them is 1,000,000 to 1,999,999 (as standings.ts reads it).
const NPC_CORP_MIN = 1_000_000;
const NPC_CORP_MAX = 1_999_999;

/** A player corporation, whose hangars are worth reading. */
export function isPlayerCorporation(corporationID: number | null | undefined): corporationID is number {
  return typeof corporationID === "number"
    && Number.isSafeInteger(corporationID)
    && corporationID > 0
    && (corporationID < NPC_CORP_MIN || corporationID > NPC_CORP_MAX);
}

/** Whole numbers the way the rest of the app writes them. */
export function countWords(value: number): string {
  return Math.round(Math.max(0, value)).toLocaleString("en-US");
}

const PIN_WORDS: Readonly<Record<ColonyPinKind, string>> = Object.freeze({
  command: "command centre",
  "extractor-control": "extractor",
  extractor: "extractor head",
  factory: "factory",
  storage: "storage",
  launchpad: "launchpad",
  other: "structure",
});

function colonyHoldings(
  colony: Colony,
  ownerWords: string,
  reading: PilotColonyReading,
): Holding[] {
  // One holding per commodity per KIND of structure: two storage units on one
  // planet are "Alpha III storage", not two lines the player cannot tell apart.
  const merged = new Map<string, Holding>();
  for (const pin of colony.pins) {
    for (const item of pin.contents) {
      const key = `${pin.kind}:${item.typeID}`;
      const known = merged.get(key);
      if (known) {
        merged.set(key, { ...known, quantity: known.quantity + item.quantity });
        continue;
      }
      merged.set(key, {
        typeID: item.typeID,
        typeName: item.typeName.length > 0 ? item.typeName : null,
        quantity: item.quantity,
        source: "colony",
        placeWords: `${colonyPlaceWords(colony)} ${PIN_WORDS[pin.kind]}`,
        ownerWords,
        planetID: colony.planetID,
        readAtMs: reading.readAtMs,
        clockOffsetMs: reading.report.clockOffsetMs,
      });
    }
  }
  return [...merged.values()];
}

function stationWords(stack: PilotStockStack): string {
  const place = stack.locationName ?? "a place this map does not name";
  if (stack.holder === "ship") {
    return stack.holderName ? `${place}, in ${stack.holderName}'s cargo` : `${place}, in a ship's cargo`;
  }
  if (stack.holder === "container") {
    return stack.holderName ? `${place}, in ${stack.holderName}` : `${place}, in a container`;
  }
  return `${place} hangar`;
}

/**
 * Every holding the roster's readings state: colony storage and personal
 * hangars. `names` names the pilots; one the hangar no longer knows is still
 * counted, under a plain description.
 */
export function holdingsFromReadings(
  readings: ReadonlyMap<number, PilotColonyReading>,
  names: ReadonlyMap<number, string>,
): Holding[] {
  const holdings: Holding[] = [];
  for (const [characterID, reading] of readings) {
    const ownerWords = names.get(characterID) ?? "A pilot no longer in the hangar";
    for (const colony of reading.report.colonies) {
      holdings.push(...colonyHoldings(colony, ownerWords, reading));
    }
    for (const stack of reading.stock ?? []) {
      holdings.push({
        typeID: stack.typeID,
        typeName: stack.typeName,
        quantity: stack.quantity,
        source: "hangar",
        placeWords: stationWords(stack),
        ownerWords,
        planetID: null,
        readAtMs: reading.readAtMs,
        clockOffsetMs: reading.report.clockOffsetMs,
      });
    }
  }
  return holdings;
}

/** Corporation hangar holdings, for the corps that were read. */
export function holdingsFromCorpReads(
  reads: readonly CorpStockRead[],
  book: PiRecipeBook | null,
): Holding[] {
  const holdings: Holding[] = [];
  for (const read of reads) {
    if (read.state !== "read") continue;
    const ownerWords = read.corporationName ?? "Your corporation";
    for (const item of read.items) {
      const place = item.locationName ?? "a station this map does not name";
      holdings.push({
        typeID: item.typeID,
        typeName: book ? commodityName(book, item.typeID) : null,
        quantity: item.quantity,
        source: "corp",
        placeWords: item.division === null ? `${place} office` : `${place} office, division ${item.division}`,
        ownerWords,
        planetID: null,
        // The corp read is stamped on the browser's clock, so no correction.
        readAtMs: read.readAtMs,
        clockOffsetMs: 0,
      });
    }
  }
  return holdings;
}

/** One commodity, summed across everywhere it is held. */
export interface StockLine {
  readonly typeID: number;
  readonly typeName: string;
  readonly tier: PiTier | null;
  readonly inColonies: number;
  readonly inHangars: number;
  readonly inCorp: number;
  readonly total: number;
  /** Every holding, colony first, then hangars, then corp; largest first within each. */
  readonly holdings: readonly Holding[];
}

export interface StockTierGroup {
  readonly tier: PiTier | null;
  readonly label: string;
  readonly lines: readonly StockLine[];
}

export interface StockSummary {
  readonly kinds: number;
  readonly inColonies: number;
  readonly inHangars: number;
  readonly inCorp: number;
}

const TIER_LABELS: Readonly<Record<PiTier, string>> = Object.freeze({
  0: "Raw",
  1: "P1 - basic",
  2: "P2 - refined",
  3: "P3 - specialised",
  4: "P4 - advanced",
});

/** "P2", "raw" — the short tag beside a commodity. */
export function tierTag(tier: PiTier | null): string | null {
  return tier === null ? null : tier === 0 ? "raw" : `P${tier}`;
}

const SOURCE_ORDER: Readonly<Record<HoldingSource, number>> = Object.freeze({ colony: 0, hangar: 1, corp: 2 });

/** Colony first, then hangars, then corp; largest first within each. */
export function compareHoldings(left: Holding, right: Holding): number {
  return SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || right.quantity - left.quantity;
}

function nameOf(holdings: readonly Holding[], book: PiRecipeBook | null, typeID: number): string {
  return (book ? commodityName(book, typeID) : null)
    ?? holdings.find((holding) => holding.typeName !== null)?.typeName
    ?? "A commodity this table does not name";
}

/** Every holding, as one line per commodity. */
export function stockLines(holdings: readonly Holding[], book: PiRecipeBook | null): StockLine[] {
  const byType = new Map<number, Holding[]>();
  for (const holding of holdings) {
    if (holding.quantity <= 0) continue;
    const list = byType.get(holding.typeID) ?? [];
    list.push(holding);
    byType.set(holding.typeID, list);
  }
  const lines: StockLine[] = [];
  for (const [typeID, list] of byType) {
    const sum = (source: HoldingSource) =>
      list.filter((holding) => holding.source === source).reduce((total, holding) => total + holding.quantity, 0);
    const inColonies = sum("colony");
    const inHangars = sum("hangar");
    const inCorp = sum("corp");
    lines.push({
      typeID,
      typeName: nameOf(list, book, typeID),
      tier: book ? tierOf(book, typeID) : null,
      inColonies,
      inHangars,
      inCorp,
      total: inColonies + inHangars + inCorp,
      holdings: Object.freeze([...list].sort(compareHoldings)),
    });
  }
  return lines.sort((left, right) => left.typeName.localeCompare(right.typeName));
}

/** Lines grouped by tier, lowest first; commodities the book does not classify last. */
export function stockByTier(lines: readonly StockLine[]): StockTierGroup[] {
  const groups: StockTierGroup[] = [];
  for (const tier of [0, 1, 2, 3, 4, null] as const) {
    const inTier = lines.filter((line) => line.tier === tier);
    if (inTier.length > 0) {
      groups.push({ tier, label: tier === null ? "Other" : TIER_LABELS[tier], lines: inTier });
    }
  }
  return groups;
}

export function stockSummary(lines: readonly StockLine[]): StockSummary {
  return {
    kinds: lines.length,
    inColonies: lines.reduce((total, line) => total + line.inColonies, 0),
    inHangars: lines.reduce((total, line) => total + line.inHangars, 0),
    inCorp: lines.reduce((total, line) => total + line.inCorp, 0),
  };
}

/** "read 2 minutes ago", said of one holding. */
export function holdingAgeWords(holding: Holding, browserNowMs: number): string {
  if (holding.readAtMs === null) return "read at an unknown time";
  return `read ${formatDuration(serverNow(holding.clockOffsetMs, browserNowMs) - holding.readAtMs)} ago`;
}

/** One line of "where this came from". */
export interface StockSourceLine {
  readonly words: string;
  readonly warn: boolean;
}

export interface StockSourcesInput {
  readonly members: readonly number[];
  readonly readings: ReadonlyMap<number, PilotColonyReading>;
  readonly names: ReadonlyMap<number, string>;
  readonly corpReads: readonly CorpStockRead[];
  readonly browserNowMs: number;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What each part of the total rests on, and what it is missing. Said
 * continuously, beside the numbers — never raised as a dialog.
 */
export function stockSources(input: StockSourcesInput): StockSourceLine[] {
  const lines: StockSourceLine[] = [];
  const nameOfPilot = (id: number) => input.names.get(id) ?? "A pilot no longer in the hangar";
  const read = input.members.filter((id) => input.readings.has(id));
  const withStock = read.filter((id) => input.readings.get(id)?.stock != null);
  const withoutStock = read.filter((id) => input.readings.get(id)?.stock == null);
  const unread = input.members.filter((id) => !input.readings.has(id));

  if (withStock.length > 0) {
    let oldest: number | null = null;
    for (const id of withStock) {
      const reading = input.readings.get(id)!;
      if (reading.readAtMs === null) continue;
      const age = serverNow(reading.report.clockOffsetMs, input.browserNowMs) - reading.readAtMs;
      oldest = oldest === null ? age : Math.max(oldest, age);
    }
    const pilots = `${withStock.length} pilot${withStock.length === 1 ? "" : "s"}`;
    lines.push({
      words: oldest === null
        ? `Colonies and personal hangars - ${pilots}`
        : `Colonies and personal hangars - ${pilots}, oldest read ${formatDuration(oldest)} ago`,
      warn: false,
    });
  }
  if (withoutStock.length > 0) {
    lines.push({
      words: `Personal hangars of ${listWords(withoutStock.map(nameOfPilot))} not read yet. Refresh reads them.`,
      warn: true,
    });
  }
  if (unread.length > 0) {
    lines.push({
      words: `${listWords(unread.map(nameOfPilot))} not read, so nothing they hold is counted.`,
      warn: true,
    });
  }

  for (const corp of input.corpReads) {
    const members = read.filter((id) => input.readings.get(id)?.corporationID === corp.corporationID);
    const label = corp.corporationName
      ? `${corp.corporationName} hangars`
      : members.length > 0
        ? `Corp hangars of ${listWords(members.map(nameOfPilot))}'s corporation`
        : "Corp hangars";
    const refused = corp.refusals.map((refusal) => `${nameOfPilot(refusal.characterID)} refused: ${refusal.reason}`);
    if (corp.state === "read") {
      const age = corp.readAtMs === null ? "" : ` ${formatDuration(input.browserNowMs - corp.readAtMs)} ago`;
      const via = corp.viaCharacterID === null ? "" : ` through ${nameOfPilot(corp.viaCharacterID)}`;
      lines.push({
        words: `${label} - read${via}${age}${refused.length > 0 ? ` (${refused.join("; ")})` : ""}`,
        warn: false,
      });
    } else if (corp.state === "failed") {
      lines.push({ words: `${label} - not read. ${refused.join("; ")}`, warn: true });
    } else {
      lines.push({
        words: `${label} - not read: none of its pilots is online in this tab. Bring one online and Refresh.`,
        warn: true,
      });
    }
  }
  return lines;
}
