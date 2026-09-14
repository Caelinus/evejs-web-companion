// Courier-completion reward reads decoded to plain rows (goal R6, inventory
// Step 12, "how to add a page"). After Complete pays out, a wallet/LP/standings
// panel pulls account.GetCashBalance / LPSvc.GetAllMyCharacterWalletLPBalances /
// standingMgr.GetCharStandings on the held session; the BFF returns the raw
// retail-shaped results here and this module decodes them.
//
// Decoder rule (docs/bridge-wire-contract.md): amounts are decoded long-aware
// (never `typeof === "number" ? … : 0`, which zeroes a {type:"long"} value).
// ISK and LP are kept as bigint-safe decimal strings; standings are small
// floats kept as numbers.

import { readKeyVal, readPlainJsonField, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";
import type { CharStanding, WalletLPBalance } from "../store/types.ts";

/**
 * A bigint-safe decimal string for an integer-ish amount (ISK/LP), or a float
 * formatted as a plain decimal; null when absent/malformed. Handles a plain
 * number, a numeric string, a {type:"long"} wrapper (number OR decimal string
 * value), and a {type:"real"} wrapper (eve.js sends ISK money as a real), so a
 * wrapped amount never silently reads as 0.
 */
export function toAmountString(value: JsonValue | undefined): string | null {
  // A real reads exactly like the plain number it wraps.
  const amount = unwrapReal(value) ?? value;
  const long = unwrapLong(amount);
  if (long !== null) {
    return long.toString();
  }
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return String(amount);
  }
  if (typeof amount === "string" && /^-?\d+(\.\d+)?$/.test(amount)) {
    return amount;
  }
  return null;
}

function toFloat(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? 0 : Number(long);
}

/** Decode account.GetCashBalance (a plain number, or a long wrapper); null if absent. */
export function decodeCashBalance(result: JsonValue): string | null {
  return toAmountString(result);
}

/**
 * The value of one packed-row column, by name. A CRowset packed row is
 * `{type:"packedrow", columns:[[name, typeCode], …], values:[…]}` (positional)
 * or a named-`fields` variant; tolerate both.
 */
function packedRowValue(row: JsonValue, columnName: string): JsonValue | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as {
    columns?: unknown;
    values?: unknown;
    fields?: unknown;
  };
  if (Array.isArray(candidate.columns) && Array.isArray(candidate.values)) {
    const index = candidate.columns.findIndex(
      (col) => Array.isArray(col) && col[0] === columnName,
    );
    if (index >= 0) {
      return candidate.values[index] as JsonValue;
    }
  }
  if (
    candidate.fields &&
    typeof candidate.fields === "object" &&
    !Array.isArray(candidate.fields)
  ) {
    return (candidate.fields as Record<string, JsonValue>)[columnName];
  }
  return undefined;
}

/**
 * Decode LPSvc.GetAllMyCharacterWalletLPBalances: a CRowset (objectex2) whose
 * `list` is packed rows [issuerCorpID, loyaltyPoints]. Malformed rows are
 * dropped. LP amounts are kept as decimal strings.
 */
export function decodeLpBalances(result: JsonValue): WalletLPBalance[] {
  const list =
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    Array.isArray((result as { list?: unknown }).list)
      ? ((result as { list: readonly JsonValue[] }).list)
      : [];
  const rows: WalletLPBalance[] = [];
  for (const row of list) {
    const issuerCorpID = Number(unwrapLong(packedRowValue(row, "issuerCorpID")) ?? 0);
    const loyaltyPoints = toAmountString(packedRowValue(row, "loyaltyPoints")) ?? "0";
    if (issuerCorpID > 0) {
      rows.push({ issuerCorpID, loyaltyPoints });
    }
  }
  return rows;
}

/** Items of a {type:"list"} wrapper; [] otherwise. */
function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const candidate = value as { type?: unknown; items?: unknown };
    if (candidate.type === "list" && Array.isArray(candidate.items)) {
      return candidate.items as readonly JsonValue[];
    }
  }
  return [];
}

/**
 * Decode standingMgr.GetCharStandings: a header/lines Rowset whose header
 * columns are ["fromID", "standing"] and each line is a {type:"list"} of those
 * values. Malformed rows are dropped.
 */
export function decodeCharStandings(result: JsonValue): CharStanding[] {
  const args =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as { args?: JsonValue }).args
      : undefined;
  const entries =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? ((args as { entries?: unknown }).entries as unknown)
      : undefined;
  const entryList = Array.isArray(entries) ? (entries as ReadonlyArray<readonly JsonValue[]>) : [];
  const headerEntry = entryList.find((pair) => Array.isArray(pair) && pair[0] === "header");
  const linesEntry = entryList.find((pair) => Array.isArray(pair) && pair[0] === "lines");
  const columns = listItems(headerEntry ? (headerEntry[1] as JsonValue) : undefined);
  const lines = listItems(linesEntry ? (linesEntry[1] as JsonValue) : undefined);
  const fromIdx = columns.indexOf("fromID" as unknown as JsonValue);
  const standingIdx = columns.indexOf("standing" as unknown as JsonValue);
  const rows: CharStanding[] = [];
  for (const line of lines) {
    const values = listItems(line);
    const fromID = Number(unwrapLong(values[fromIdx]) ?? 0);
    const standing = toFloat(values[standingIdx]);
    if (fromID > 0) {
      rows.push({ fromID, standing });
    }
  }
  return rows;
}

// --- R89 LPSvc financial write acks -----------------------------------------
//
// FAST-MODE educated-guess decoders for the confirm-gated LPSvc WRITES
// (ExchangeConcordLP / TransferLPFromMyWalletToOtherCorp /
// TransferLPFromMyCorpWalletToOtherCorp). All return null server-side (a failed
// transfer throws, surfaced as a BFF error). ⚠ The two transfers MOVE LP and are
// NEVER fired live in the plumbing pass — the funding source is session-scoped
// (character wallet / session corp with a role check; see server.js). Educated
// guesses from the client + server code, not captured bytes.

/** The uniform ack every confirm-gated LPSvc write returns. */
export interface LpWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function lpAckTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Decode a plain LPSvc write ack (concord exchange / wallet transfer / corp transfer). */
export function decodeLpWriteAck(response: JsonValue): LpWriteAck {
  return {
    ok: lpAckTruthy(readPlainJsonField(response, "ok")),
    applied: lpAckTruthy(readPlainJsonField(response, "applied")),
  };
}
