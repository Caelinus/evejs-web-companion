import test from "node:test";
import assert from "node:assert/strict";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { creationNeedsRecovery } from "./characterCreationSafety.ts";

test("transport and malformed-success outcomes never enable a blind second creation", () => {
  for (const [code, status] of [["BRIDGE_NETWORK_ERROR", 0], ["BRIDGE_BAD_RESPONSE", 200], ["CREATION_UNVERIFIED", 409], ["CREATION_PENDING", 409], ["GATEWAY_TIMEOUT", 504]] as const)
    assert.equal(creationNeedsRecovery(new BridgeCallError(code, code, status)), true, code);
  assert.equal(creationNeedsRecovery(new Error("Connection lost")), true);
});
test("definitive name/slot/input refusals remain correctable", () => {
  for (const code of ["CharNameInvalid", "NO_CHARACTER_SLOT", "BLOODLINE_INVALID", "RACE_UNKNOWN"])
    assert.equal(creationNeedsRecovery(new BridgeCallError(code, code, 400)), false);
});
