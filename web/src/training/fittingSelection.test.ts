import test from "node:test";
import assert from "node:assert/strict";
import { acceptStageFitting, fittingsForHull } from "./fittingSelection.ts";
import type { CorporationSavedFitting } from "./types.ts";

const fit: CorporationSavedFitting = {
  fittingID: 7, ownerID: 98000001, shipTypeID: 32880, name: "Start Venture",
  savedDate: "134285151537020000", fingerprint: "abc", items: [{ typeID: 483, flagID: 27, quantity: 2 }],
  invalid: false, reason: null,
};

test("stage choices filter by hull and reject malformed fittings", () => {
  assert.deepEqual(fittingsForHull([fit, { ...fit, fittingID: 8, shipTypeID: 89240 },
    { ...fit, fittingID: 9, invalid: true }], 32880).map((item) => item.fittingID), [7]);
});

test("explicit acceptance changes Training Center selection only", () => {
  const old = { PIONEER: { scope: "CORPORATION" as const, ownerID: fit.ownerID, fittingID: 5 } };
  const next = acceptStageFitting(old, "VENTURE", fit.ownerID, fit);
  assert.equal(next.VENTURE?.fittingID, 7);
  assert.equal(next.VENTURE?.acceptedSavedDate, fit.savedDate);
  assert.equal(next.VENTURE?.acceptedFingerprint, fit.fingerprint);
  assert.equal(next.PIONEER, old.PIONEER);
  assert.deepEqual(Object.keys(old), ["PIONEER"]);
  assert.throws(() => acceptStageFitting({}, "VENTURE", 99, fit));
});
