// R103 Phase-4 BOUND WRITE acks — WB-BEYONCE: the 7 nav/bookmark writes
// (CmdGotoPoint / CmdGotoBookmark / CmdAbandonLoot / CmdFleetTagTarget /
// CmdJumpThroughFleet / BookmarkLocation / BookmarkScanResult) that hang off the
// R5a beyonce remote-park bind (Moniker("beyonce", solarSystemID)). Two of the
// seven (CmdFleetTagTarget / CmdJumpThroughFleet) now have api.ts wrappers
// (setFleetTargetTag / jumpThroughFleet) — the rest are still plumbing only,
// with no UI caller yet.
//
// Each write dispatches as a BOUND method off parkBindSpec(solarSystemID) — the
// BFF reads the session's OWN live flight to recover the current system, binds the
// park, and holds the OID handle (the browser never sees it), NOT the top-level
// /call seam. Every BFF route is confirm-gated (refuses without `confirm:true`),
// requires the ship in space, and folds the server return into the uniform ack
// `{ok, applied, result, flight, notifications}` (dispatchBoundBeyonceWrite in
// server.js — it re-reads flight after the write, so the ack also carries the
// updated flight snapshot).
//
// ⚠ OWNERSHIP: every handler resolves ship / scene / char from the SESSION;
// CmdJumpThroughFleet's (charID, shipID) name a fleet-mate's bridge but are
// validated against the session's own fleet membership — no caller-forgeable
// foreign ship. No arg-injection flag.
//
// ⚠ FAST-MODE / educated guess: none fired live this batch (operator owns EveJS;
// no server restart), so this decoder was written from the beyonce handler code,
// not captured bytes. The Cmd* nav handlers return null; the two Bookmark* writers
// return the new bookmark id — `result` carries each through UNTOUCHED for a future
// nav/bookmark UI. `applied` is the confirm-gate's did-not-throw signal; a panel
// re-reads the flight snapshot / bookmarks to prove the mutation.
//
// ⚠ These are WRITES: never call a decoder to DRIVE a mutation — the confirm-gated
// BFF route is the only path, and it refuses without `confirm: true`.

import { readPlainJsonField, type JsonValue } from "./wire.ts";

function truthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** The uniform ack every confirm-gated R103 bound beyonce nav/bookmark write returns. */
export interface BeyonceWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
  /** The raw server return — null for the nav verbs, a bookmark id for the bookmark writers. */
  readonly result: JsonValue | null;
  /** The post-write flight snapshot the BFF re-reads, or null if absent. */
  readonly flight: JsonValue | null;
}

/**
 * Decode an R103 bound beyonce nav/bookmark write ack. `applied` is the confirm-
 * gate's did-not-throw signal; `result` passes the handler return through and
 * `flight` the post-write snapshot. FAST-MODE: never fired live, so this is an
 * educated guess from the beyonce handler code.
 */
export function decodeBeyonceWriteAck(response: JsonValue): BeyonceWriteAck {
  const result = readPlainJsonField(response, "result");
  const flight = readPlainJsonField(response, "flight");
  return {
    ok: truthy(readPlainJsonField(response, "ok")),
    applied: truthy(readPlainJsonField(response, "applied")),
    result: result === undefined ? null : (result as JsonValue),
    flight: flight === undefined ? null : (flight as JsonValue),
  };
}
