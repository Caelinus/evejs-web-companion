// The station repair shop's quote — repairSvc.GetRepairQuotes, decoded.
//
// WHAT THE SHOP ANSWERS
//
// The quote is a dict keyed by the item id we asked about; the value carries an
// `items` list of the damaged parts the shop found on that item. An item the
// shop lists with NO parts is undamaged — that is how "nothing to repair" is
// said on this wire, so an empty list is dropped here rather than rendered as a
// zero-cost repair.
//
// ⚠ THE COST IS READ, NEVER COMPUTED. Whether a part row carries a price at all
// is the server's business; when none of them do, `cost` stays null and the UI
// says the price is unknown instead of inventing 0 ISK next to a button that
// debits a real wallet. The wallet charge is applied server-side by RepairItems
// regardless of what we managed to read here.

import {
  isListValue,
  readDictPairs,
  readKeyVal,
  readPlainJsonField,
  readRowField,
} from "./wire.ts";

/** One damaged item in the shop's quote: what it is and what it would cost. */
export interface RepairQuoteRow {
  /** The item the shop found damage on — the ship hull, or a fitted module. */
  readonly itemID: number;
  /** How many damaged parts the shop listed under it (never zero here). */
  readonly damagedParts: number;
  /** Summed price of those parts, or null when the rows carry no price. */
  readonly cost: number | null;
}

/** The damaged-parts list under one quoted item, whichever shape it arrived in. */
function quotedParts(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isListValue(value)) {
    return value.items;
  }
  const nested = readKeyVal(value, "items") ?? readPlainJsonField(value, "items");
  if (Array.isArray(nested)) {
    return nested;
  }
  return isListValue(nested) ? nested.items : [];
}

/** A part row's price, from whichever row shape the handler chose; null if absent. */
function partCost(row: unknown): number | null {
  const raw = readRowField(row, "cost") ?? readPlainJsonField(row, "cost");
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * The DAMAGED items in a `repairSvc.GetRepairQuotes` result, in wire order.
 * Items the shop reports no damage on are left out; a result that is not a dict
 * decodes as no damage, which is the same answer an empty dict gives.
 */
export function decodeRepairQuotes(raw: unknown): readonly RepairQuoteRow[] {
  const quotes: RepairQuoteRow[] = [];
  for (const [key, value] of readDictPairs(raw)) {
    const itemID = Number(key);
    if (!Number.isSafeInteger(itemID) || itemID <= 0) {
      continue;
    }
    const parts = quotedParts(value);
    if (parts.length === 0) {
      continue;
    }
    let cost: number | null = null;
    for (const part of parts) {
      const price = partCost(part);
      if (price !== null) {
        cost = (cost ?? 0) + price;
      }
    }
    quotes.push({ itemID, damagedParts: parts.length, cost });
  }
  return quotes;
}

/**
 * What the whole quote would cost, or null unless EVERY quoted item carried a
 * price. A total summed over only the rows we could read would understate the
 * charge the wallet is about to take, so a partial reading is reported as no
 * reading at all.
 */
export function repairQuoteTotal(quotes: readonly RepairQuoteRow[]): number | null {
  if (quotes.length === 0 || quotes.some((quote) => quote.cost === null)) {
    return null;
  }
  return quotes.reduce((sum, quote) => sum + (quote.cost ?? 0), 0);
}
