// The worked example (goal R1b): the R1 reference call
// charUnboundMgr.GetCharacterSelectionData, typed end to end.
//
// Handler contract (eve.js charService.Handle_GetCharacterSelectionData,
// mirrored from decompiled charselData.py): a 4-tuple
// (userDetails, trainingDetails, characterDetails, wars) where
// characterDetails is a {type:"list"} of util.KeyVal rows keyed to the
// session userid. This module types the tuple, decodes the KeyVal rows into
// CharacterSummary (store/types.ts), and exposes the one-call helper the
// R2 character-sheet page will start from.

import { callMethod, type CallMethodOptions } from "./callMethod.ts";
import {
  isKeyValValue,
  isListValue,
  readKeyVal,
  unwrapLong,
  unwrapReal,
  type JsonValue,
  type KeyValValue,
  type ListValue,
  type BridgeNotification,
} from "./wire.ts";
import type { CharacterSummary } from "../store/types.ts";

export const CHARACTER_SELECTION_SERVICE = "charUnboundMgr";
export const CHARACTER_SELECTION_METHOD = "GetCharacterSelectionData";

/**
 * The retail 4-tuple as it crosses the bridge. userDetails is a list of one
 * util.KeyVal; trainingDetails is currently [null, null]; wars is a list.
 */
export type CharacterSelectionDataResult = readonly [
  userDetails: ListValue<KeyValValue>,
  trainingDetails: JsonValue,
  characterDetails: ListValue<KeyValValue>,
  wars: ListValue,
];

export interface CharacterSelectionData {
  /** The wire tuple, untouched, for callers that need fields not yet decoded. */
  readonly raw: CharacterSelectionDataResult;
  /** Decoded characterDetails rows. */
  readonly characters: readonly CharacterSummary[];
  readonly notifications: readonly BridgeNotification[];
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** Decode one util.KeyVal characterDetails row. Returns null for non-rows. */
export function decodeCharacterRow(row: unknown): CharacterSummary | null {
  if (!isKeyValValue(row)) {
    return null;
  }
  const characterID = asNumber(readKeyVal(row, "characterID"));
  if (characterID === null) {
    return null;
  }
  return {
    characterID,
    characterName: asString(readKeyVal(row, "characterName")) ?? "Unknown",
    gender: asNumber(readKeyVal(row, "gender")),
    typeID: asNumber(readKeyVal(row, "typeID")),
    corporationID: asNumber(readKeyVal(row, "corporationID")),
    allianceID: asNumber(readKeyVal(row, "allianceID")),
    stationID: asNumber(readKeyVal(row, "stationID")),
    solarSystemID: asNumber(readKeyVal(row, "solarSystemID")),
    regionID: asNumber(readKeyVal(row, "regionID")),
    // eve.js sends ISK money as a {type:"real"} wrapper; a bare number also reads.
    balance: unwrapReal(readKeyVal(row, "balance")),
    skillPoints: asNumber(readKeyVal(row, "skillPoints")),
    shipTypeID: asNumber(readKeyVal(row, "shipTypeID")),
    shipName: asString(readKeyVal(row, "shipName")),
    securityStatus: asNumber(readKeyVal(row, "securityStatus")),
    title: asString(readKeyVal(row, "title")),
    unreadMailCount: asNumber(readKeyVal(row, "unreadMailCount")),
    logoffDate: unwrapLong(readKeyVal(row, "logoffDate")),
    skillTypeID: asNumber(readKeyVal(row, "skillTypeID")),
    toLevel: asNumber(readKeyVal(row, "toLevel")),
    trainingStartTime: unwrapLong(readKeyVal(row, "trainingStartTime")),
    trainingEndTime: unwrapLong(readKeyVal(row, "trainingEndTime")),
    queueEndTime: unwrapLong(readKeyVal(row, "queueEndTime")),
  };
}

/** Decode the wire tuple. Tolerates malformed rows by skipping them. */
export function decodeCharacterSelectionData(
  result: JsonValue,
): { raw: CharacterSelectionDataResult; characters: readonly CharacterSummary[] } {
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error(
      "GetCharacterSelectionData did not return the retail 4-tuple (userDetails, trainingDetails, characterDetails, wars).",
    );
  }
  const characterDetails = result[2];
  if (!isListValue(characterDetails)) {
    throw new Error("GetCharacterSelectionData characterDetails is not a {type:\"list\"} value.");
  }
  const characters = characterDetails.items
    .map((row) => decodeCharacterRow(row))
    .filter((row): row is CharacterSummary => row !== null);
  return {
    raw: result as unknown as CharacterSelectionDataResult,
    characters,
  };
}

/**
 * The typed reference call: charUnboundMgr.GetCharacterSelectionData() with
 * no args/kwargs; identity comes from the BFF-pinned session userid.
 */
export async function getCharacterSelectionData(
  options: CallMethodOptions = {},
): Promise<CharacterSelectionData> {
  const outcome = await callMethod<JsonValue>(
    CHARACTER_SELECTION_SERVICE,
    CHARACTER_SELECTION_METHOD,
    [],
    null,
    options,
  );
  const decoded = decodeCharacterSelectionData(outcome.result);
  return {
    raw: decoded.raw,
    characters: decoded.characters,
    notifications: outcome.notifications,
  };
}
