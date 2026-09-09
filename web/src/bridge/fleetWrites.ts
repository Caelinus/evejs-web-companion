// Fleet top-level WRITE acknowledgements (goal R94, now used by Fleet Center and bots).
//
// The LAST Phase-3 top-level writes batch. FAST-MODE educated-guess decoders for
// the 11 confirm-gated fleet writes across three TOP-LEVEL services whose seams
// were wired earlier (fleetProxy READS R69 / fleetObjectHandler bind R72 + bound
// reads R85):
//   • fleetObjectHandler — CreateFleet (⚠ mints a fleet; returns the bound handle;
//                          NEVER fired live)
//   • fleetProxy         — ApplyToJoinFleet (returns null/ack) / AddFleetFinderAdvert /
//                          RemoveFleetFinderAdvert / UpdateAdvertInfo (each returns
//                          the advert payload, or null when there is no advert)
//   • fleetMgr           — ForceLeaveFleet / AddToWatchlist / RemoveFromWatchlist /
//                          RegisterForDamageUpdates (return null) and ⚠ OUTWARD
//                          BroadcastToBubble / BroadcastToSystem (return null; NEVER
//                          broadcast live)
//
// Each BFF route answers the uniform dispatchBridgeWrite envelope
// `{ ok, applied, result, notifications }`; these decoders read that ack. `applied`
// is the BFF's "did not throw" signal; a panel re-reads (GetMyFleetFinderAdvert /
// the fleet bound reads) to prove the mutation.
//
// Server return shapes (educated guesses — Farmer is DOCKED + fleetless; the
// outward broadcasts and CreateFleet were NEVER fired live):
//   • the management / broadcast / apply writes → null
//   • the three advert writes → the buildAdvertPayload dict (or null: "no advert")
//   • CreateFleet → a bound-object handle (an OID/Moniker substruct, not decodable
//                   rows) — surfaced as applied-only.
//
// LOCAL coercions only — this module deliberately does NOT import from market*.ts
// (a separate session owns those files).

import { readPlainJsonField, type JsonValue } from "./wire.ts";
import { type FleetAdvert } from "./fleetAds.ts";

/** The uniform ack every confirm-gated fleet write returns. */
export interface FleetWriteAck {
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
 * Decode a plain fleet write ack (applied-only: CreateFleet, ApplyToJoinFleet, the
 * four fleetMgr management writes, and the two ⚠ OUTWARD broadcasts — all null- or
 * handle-returning). `applied` is the BFF's "did not throw" signal.
 */
export function decodeFleetWriteAck(response: JsonValue): FleetWriteAck {
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
  };
}

/**
 * Fleet-advert write ack (AddFleetFinderAdvert / RemoveFleetFinderAdvert /
 * UpdateAdvertInfo). The handler returns the updated advert payload (a
 * buildAdvertPayload dict) or null. Surface WHETHER an advert came back — the
 * authoritative post-state is a GetMyFleetFinderAdvert re-read (decodeMyFleetFinder
 * Advert in fleetAds.ts owns the full FleetAdvert decode). Kept deliberately light
 * in fast mode: `advertPresent` is the "an advert exists after this write" signal.
 */
export interface FleetAdvertWriteAck extends FleetWriteAck {
  readonly advertPresent: boolean;
}

function isDictPayload(value: JsonValue | null): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "dict"
  );
}

export function decodeFleetAdvertWriteAck(response: JsonValue): FleetAdvertWriteAck {
  return { ...decodeFleetWriteAck(response), advertPresent: isDictPayload(ackResult(response)) };
}

/**
 * Which half of the fleet-finder round trip an apply took.
 *
 * ⚠ THIS CORRECTS AN R94 FAST-MODE GUESS. ApplyToJoinFleet was recorded as
 * "returns null/ack" because it was never fired live; it in fact returns a
 * BOOLEAN, and that boolean is the whole protocol:
 *
 *   • `true`  — the advert needs the boss's approval, so a join REQUEST was
 *               stored and no invite exists. Retail turns exactly this into
 *               FleetApplicationReceived.
 *   • `false` — an INVITE was minted and notified. The client must now accept
 *               it; nothing else will.
 *
 * "unknown" is the honest third state for a result that is neither (an older
 * server, a shape we did not expect). Callers must treat it as "probably an
 * invite" and try the accept: the common path is the invite one, and a failed
 * accept costs one swallowed call, whereas refusing to accept strands a bot that
 * had an invite waiting for it.
 */
export type FleetApplyOutcome = "needs-approval" | "invited" | "unknown";

/** Read an ApplyToJoinFleet ack. See FleetApplyOutcome for why "unknown" tries. */
export function decodeFleetApplyOutcome(response: JsonValue): FleetApplyOutcome {
  const result = ackResult(response);
  if (result === true || result === 1) {
    return "needs-approval";
  }
  if (result === false || result === 0) {
    return "invited";
  }
  return "unknown";
}

// Re-export the advert type so a later panel can pair a write ack with the
// GetMyFleetFinderAdvert re-read without importing two modules.
export type { FleetAdvert };
