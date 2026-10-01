import * as api from "./api.ts";
import type { SupportCollectionAction, SupportCollectionReceipt } from "../nav/miningSupportCollection.ts";

/** Dispatch only; the owner must verify fresh inventories before settlement. */
export async function dispatchSupportCollectionAction(action: SupportCollectionAction, runID: string,
  scope: { readonly shipID: number; readonly solarSystemID: number }, options: api.ApiOptions): Promise<SupportCollectionReceipt> {
  if (action.kind === "transfer") {
    const result = await api.transferItems([action.itemID], { kind: "container", itemID: action.containerID },
      action.bay === "cargo" ? { kind: "cargo" } : { kind: "shipBay", bay: action.bay }, action.quantity, options,
      { claimRunID: runID, expectedScope: scope });
    // Claimed transfer verification accounts for splits/merges/reminted IDs.
    // The source ID need not survive in `moved`; exact local deltas follow.
    const acknowledged = result.applied && !result.declined.length && !result.notFound.length;
    return { acknowledged, ...(!acknowledged ? { reason: "collection-transfer-not-applied" } : {}) };
  }
  const result = await api.compressOreInSpace(action.itemID, action.facilityID, options, scope);
  return { acknowledged: result.compressed, compressionTuple: result.result,
    ...(!result.compressed ? { reason: "collected-ore-compression-refused" } : {}) };
}
