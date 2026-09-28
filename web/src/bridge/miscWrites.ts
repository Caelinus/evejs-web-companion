// Misc-utility service WRITE acks (goal R93, Phase-3 WRITES — PLUMBING ONLY).
//
// FAST-MODE educated-guess decoders for the 13 confirm-gated misc-utility WRITES
// across six TOP-LEVEL services whose reads were wired earlier:
//   • agentMgr    — RemoveOfferFromJournal / GotoLocation / WarpToLocation /
//                   WarpToAgentInSpace (nav/journal; return null; docked => no-op)
//   • petitioner  — CreatePetition (⚠ outward; stub returns false) / PetitionerChat /
//                   CancelPetition (return null)
//   • industryManager — CompleteManyJobs (returns the list of delivered job payloads)
//   • planetMgr   — DeleteLaunch (⚠ destructive; returns the store delete result)
//   • structureDirectory — SetStructureDescription (guarded; returns null)
//   • structureAssetSafety — MovePersonalAssetsToSafety / MoveCorpAssetsToSafety /
//                   MoveSafetyWrapToStructure (⚠ consequential; return null)
//
// Each BFF route answers the uniform dispatchBridgeWrite envelope
// `{ ok, applied, result, notifications }`; these decoders read that ack.
//
// Server return shapes (educated guesses — Farmer is DOCKED; the destructive/
// outward writes were NEVER fired live):
//   • the nav / chat / cancel / description / asset-safety writes → null
//   • CreatePetition            → false (a stub rejection in this world)
//   • CompleteManyJobs          → {type:"list", items:[<delivered job payload>, …]}
//
// LOCAL coercions only — this module deliberately does NOT import from market*.ts
// (a separate session owns those files).

import { isListValue, readPlainJsonField, type JsonValue } from "./wire.ts";

/** The uniform ack every confirm-gated misc write returns. */
export interface MiscWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function ackTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Read the `result` field off a BFF write-ack envelope (null when absent). */
function ackResult(response: JsonValue): JsonValue | null {
  const result = readPlainJsonField(response, "result");
  return result === undefined ? null : result;
}

/**
 * Decode a plain misc write ack (applied-only: the agentMgr nav/journal writes,
 * PetitionerChat / CancelPetition, SetStructureDescription, and the three
 * asset-safety moves — all null-returning). `applied` is the BFF's "did not
 * throw" signal; a panel re-reads to prove the mutation.
 */
export function decodeMiscWriteAck(response: JsonValue): MiscWriteAck {
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
  };
}

/**
 * CreatePetition ack. ⚠ OUTWARD — opens a support ticket; NEVER fired live. In
 * THIS stub world the handler returns `false` (rejected), so `accepted` is the
 * raw handler result read off `result` (true only if a real ticket was opened).
 */
export interface CreatePetitionAck extends MiscWriteAck {
  readonly accepted: boolean;
}

export function decodeCreatePetitionAck(response: JsonValue): CreatePetitionAck {
  return { ...decodeMiscWriteAck(response), accepted: ackResult(response) === true };
}

/**
 * CompleteManyJobs ack: the handler returns the list of delivered job payloads.
 * Surface the delivered COUNT (the payload shape is job-specific; a panel re-reads
 * GetJobsByOwner for the authoritative post-state).
 */
export interface CompleteManyJobsAck extends MiscWriteAck {
  readonly deliveredCount: number;
}

export function decodeCompleteManyJobsAck(response: JsonValue): CompleteManyJobsAck {
  const result = ackResult(response);
  const items = isListValue(result) ? result.items : Array.isArray(result) ? result : [];
  return { ...decodeMiscWriteAck(response), deliveredCount: items.length };
}
