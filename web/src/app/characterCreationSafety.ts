import { BridgeCallError } from "../bridge/callMethod.ts";

/** Only proven pre-dispatch refusals can reopen Create without recovery. */
export function creationNeedsRecovery(cause: unknown): boolean {
  return !(cause instanceof BridgeCallError) || cause.status === 0 || cause.status >= 500 ||
    ["BRIDGE_BAD_RESPONSE", "BRIDGE_NETWORK_ERROR", "CREATION_UNVERIFIED", "CREATION_PENDING", "CREATION_REVIEW_REQUIRED"].includes(cause.code);
}
