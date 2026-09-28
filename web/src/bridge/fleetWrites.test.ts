import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeFleetApplyOutcome, decodeFleetWriteAck, decodeFleetAdvertWriteAck } from "./fleetWrites.ts";
import type { JsonValue } from "./wire.ts";

// --- R94 fleet top-level write acks (Phase-3 WRITES) -----------------------

test("decodeFleetWriteAck reads ok/applied off the BFF envelope", () => {
  const ack = decodeFleetWriteAck({ ok: true, applied: true, result: null });
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("decodeFleetWriteAck is false for a non-object / empty response (never throws)", () => {
  assert.deepEqual(decodeFleetWriteAck(null as unknown as JsonValue), { ok: false, applied: false });
  assert.deepEqual(decodeFleetWriteAck({ ok: false, applied: false }), {
    ok: false,
    applied: false,
  });
});

test("decodeFleetAdvertWriteAck reports advertPresent=true when the handler returned an advert dict", () => {
  const advert: JsonValue = { type: "dict", entries: [["fleetID", 1]] } as unknown as JsonValue;
  const ack = decodeFleetAdvertWriteAck({ ok: true, applied: true, result: advert });
  assert.equal(ack.applied, true);
  assert.equal(ack.advertPresent, true);
});

test("decodeFleetAdvertWriteAck reports advertPresent=false when the handler returned null (no advert)", () => {
  const ack = decodeFleetAdvertWriteAck({ ok: true, applied: true, result: null });
  assert.equal(ack.applied, true);
  assert.equal(ack.advertPresent, false);
});

// ── ApplyToJoinFleet's answer ────────────────────────────────────────────────
// ⚠ CORRECTS AN R94 FAST-MODE GUESS. This write was recorded as "returns
// null/ack" because it was never fired live. It returns a BOOLEAN, and that
// boolean is the protocol: true = the boss must approve, false = an invite was
// minted and the client must accept it. Getting this wrong is what made the
// join-by-name block hang on a healthy fleet.

test("decodeFleetApplyOutcome: true is the approval path, false is a minted invite", () => {
  assert.equal(decodeFleetApplyOutcome({ ok: true, applied: true, result: true }), "needs-approval");
  assert.equal(decodeFleetApplyOutcome({ ok: true, applied: true, result: false }), "invited");
  // Some servers answer a python bool as 1/0.
  assert.equal(decodeFleetApplyOutcome({ ok: true, applied: true, result: 1 }), "needs-approval");
  assert.equal(decodeFleetApplyOutcome({ ok: true, applied: true, result: 0 }), "invited");
});

test("decodeFleetApplyOutcome: anything else is 'unknown', which callers must TRY", () => {
  // Not "assume approval". An unknown answer must fall through to accepting,
  // because the invite half is the common one and a bot that refuses to accept
  // strands itself with an invitation sitting unanswered.
  for (const result of [null, undefined, "yes", {}] as unknown[]) {
    assert.equal(
      decodeFleetApplyOutcome({ ok: true, applied: true, result } as unknown as JsonValue),
      "unknown",
    );
  }
  assert.equal(decodeFleetApplyOutcome(null as unknown as JsonValue), "unknown");
});
