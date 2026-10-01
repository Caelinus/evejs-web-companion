import type { CompressionCompatibility } from "../app/api.ts";
import { planLootTransfers, preferredBays } from "../bridge/bayRouting.ts";
import { unwrapLong, type JsonValue } from "../bridge/wire.ts";
import type { InventoryItemRow, ShipBay } from "../store/types.ts";
import type { SupportPositionScope } from "./miningSupportPositioning.ts";

export interface SupportCollectionPolicy {
  readonly mode: "TRACTOR_ONLY" | "TRACTOR_AND_COLLECT";
  readonly compressCollectedOre: boolean;
}
export interface CollectedStack {
  readonly bay: string; readonly itemID: number; readonly typeID: number; readonly quantity: number;
}
export type SupportCollectionAction =
  | { readonly kind: "transfer"; readonly containerID: number; readonly itemID: number; readonly typeID: number; readonly quantity: number; readonly bay: string }
  | { readonly kind: "compress"; readonly itemID: number; readonly typeID: number; readonly quantity: number; readonly bay: string; readonly outputTypeID: number; readonly facilityID: number };
export interface SupportCollectionReceipt {
  readonly acknowledged: boolean; readonly reason?: string; readonly compressionTuple?: JsonValue | null;
}
export interface SupportCollectionMemory {
  readonly scope: SupportPositionScope | null; readonly runID: string | null;
  readonly stacks: readonly CollectedStack[];
  readonly pending: { readonly action: SupportCollectionAction; readonly sourceBefore: readonly InventoryItemRow[] | null;
    readonly holdBefore: readonly InventoryItemRow[]; readonly receipt: SupportCollectionReceipt | null } | null;
  readonly fault: string | null;
}
export const freshSupportCollectionMemory = (): SupportCollectionMemory => ({ scope: null, runID: null, stacks: [], pending: null, fault: null });
export interface SupportCollectionInput {
  readonly scope: SupportPositionScope; readonly runID: string; readonly policy: SupportCollectionPolicy;
  readonly source: { readonly containerID: number; readonly rows: readonly InventoryItemRow[] | null } | null;
  /** Strictly decoded caller-owned ship bays, never another miner's inventory. */
  readonly bays: readonly ShipBay[] | null;
  readonly receivedAtMs: number; readonly nowMs: number; readonly mayWork: boolean;
  /** Exact container is settled and its positive claim remains held. */
  readonly readyContainerID: number | null;
  readonly ownActiveTypeListIDs: readonly number[];
  readonly compatibility: readonly CompressionCompatibility[] | null;
}
export interface SupportCollectionResult {
  readonly state: "IDLE" | "WAIT" | "EMPTY" | "MOVED" | "COMPRESSED" | "FULL" | "UNKNOWN" | "PARTIAL" | "BLOCKED";
  readonly reason: string | null; readonly action: SupportCollectionAction | null;
  readonly movedQuantity: number; readonly sourceEmpty: boolean;
  readonly retainClaim: boolean; readonly memory: SupportCollectionMemory;
}
const sameScope = (a: SupportPositionScope | null, b: SupportPositionScope) => a !== null &&
  a.characterID === b.characterID && a.sessionEpoch === b.sessionEpoch && a.shipID === b.shipID &&
  a.fleetID === b.fleetID && a.solarSystemID === b.solarSystemID && a.fittingSignature === b.fittingSignature;
const validRows = (rows: readonly InventoryItemRow[] | null): rows is readonly InventoryItemRow[] => rows !== null &&
  new Set(rows.map(row => row.itemID)).size === rows.length && rows.every(row => Number.isSafeInteger(row.itemID) && row.itemID > 0 &&
    Number.isSafeInteger(row.typeID) && row.typeID > 0 && Number.isSafeInteger(row.quantity) && row.quantity > 0);
const quantity = (rows: readonly InventoryItemRow[], itemID: number, typeID: number) => rows.find(row => row.itemID === itemID && row.typeID === typeID)?.quantity ?? 0;
const unchanged = (before: readonly InventoryItemRow[], after: readonly InventoryItemRow[], except: readonly number[]) => {
  const signature = (rows: readonly InventoryItemRow[]) => rows.filter(row => !except.includes(row.itemID))
    .map(row => `${row.itemID}:${row.typeID}:${row.quantity}:${row.singleton}`).sort().join("|");
  return signature(before) === signature(after);
};

/** One proven ore transfer or whole-stack compression. A pending mutation is
 * observed before another can be planned; ambiguity retains the container lease. */
export function decideSupportCollection(input: SupportCollectionInput, previous: SupportCollectionMemory): SupportCollectionResult {
  let memory: SupportCollectionMemory = structuredClone(previous);
  const result = (state: SupportCollectionResult["state"], reason: string | null = null, action: SupportCollectionAction | null = null,
    movedQuantity = 0, sourceEmpty = false): SupportCollectionResult => ({ state, reason, action, movedQuantity, sourceEmpty,
      retainClaim: memory.pending !== null || memory.fault !== null || !sourceEmpty, memory });
  if (!sameScope(memory.scope, input.scope) || memory.runID !== input.runID) {
    if (memory.pending) return result("BLOCKED", "collection-scope-changed-with-unresolved-transfer");
    memory = { ...freshSupportCollectionMemory(), scope: { ...input.scope }, runID: input.runID };
  }
  if (!Number.isFinite(input.receivedAtMs) || !Number.isFinite(input.nowMs) || input.receivedAtMs > input.nowMs ||
    input.nowMs - input.receivedAtMs >= 10000 || input.bays === null || new Set(input.bays.map(bay => bay.key)).size !== input.bays.length)
    return result("UNKNOWN", "collection-observation-unavailable");
  const bayRows = (key: string): readonly InventoryItemRow[] | null => {
    const bay = input.bays!.find(row => row.key === key);
    return bay?.present === true && bay.error === null && validRows(bay.items) ? bay.items : null;
  };
  // An unobserved stack change invalidates whole-stack collected provenance.
  if (!memory.pending) memory = { ...memory, stacks: memory.stacks.filter(stack => {
    const rows = bayRows(stack.bay); return rows !== null && quantity(rows, stack.itemID, stack.typeID) === stack.quantity;
  }) };
  if (memory.pending) {
    const pending = memory.pending, action = pending.action, after = bayRows(action.bay), receipt = pending.receipt;
    if (after === null || receipt === null) return result("UNKNOWN", "inventory-result-unresolved");
    if (action.kind === "transfer") {
      const source = input.source?.containerID === action.containerID ? input.source.rows : null;
      if (!validRows(source) || !validRows(pending.sourceBefore)) return result("UNKNOWN", "source-result-unresolved");
      const beforeQuantity = quantity(pending.sourceBefore, action.itemID, action.typeID);
      const loss = beforeQuantity - quantity(source, action.itemID, action.typeID);
      const gained = after.filter(row => row.typeID === action.typeID && row.quantity - quantity(pending.holdBefore, row.itemID, row.typeID) > 0);
      const destination = gained.length === 1 ? gained[0] : undefined;
      const gain = destination ? destination.quantity - quantity(pending.holdBefore, destination.itemID, destination.typeID) : 0;
      const sourceRemainder = source.find(row => row.itemID === action.itemID);
      const proven = loss === action.quantity && gain === loss && destination &&
        (!sourceRemainder || sourceRemainder.typeID === action.typeID) &&
        unchanged(pending.sourceBefore, source, [action.itemID]) && unchanged(pending.holdBefore, after, [destination.itemID]);
      if (proven) {
        const old = memory.stacks.find(stack => stack.bay === action.bay && stack.itemID === destination.itemID && stack.typeID === action.typeID);
        const before = quantity(pending.holdBefore, destination.itemID, destination.typeID);
        const eligible = before === 0 || old?.quantity === before;
        memory = { ...memory, pending: null, stacks: [...memory.stacks.filter(stack => stack.itemID !== destination.itemID),
          ...(eligible ? [{ bay: action.bay, itemID: destination.itemID, typeID: action.typeID, quantity: destination.quantity }] : [])].slice(-128),
          fault: receipt.acknowledged ? null : "transfer-observed-after-ambiguous-receipt" };
        return result(receipt.acknowledged ? "MOVED" : "PARTIAL", eligible ? null : "compression-provenance-unavailable", null, loss, source.length === 0);
      }
      if (loss === 0 && unchanged(pending.sourceBefore, source, []) && unchanged(pending.holdBefore, after, []) && !receipt.acknowledged) {
        memory = { ...memory, pending: null, fault: receipt.reason ?? "collection-transfer-refused" }; return result("BLOCKED", memory.fault);
      }
      return result("PARTIAL", "source-loss-and-hold-gain-unconfirmed");
    }
    const raw = receipt.compressionTuple;
    const tuple = Array.isArray(raw) ? raw.map(value => Number(unwrapLong(value))) : [];
    const tupleValid = tuple.length === 6 && tuple.every(value => Number.isSafeInteger(value) && value > 0) &&
      tuple[0] === action.itemID && tuple[1] === action.typeID && tuple[2] === action.quantity && tuple[4] === action.outputTypeID && tuple[5] === action.quantity;
    const outputID = tuple[3] ?? 0;
    const output = tupleValid ? after.find(row => row.itemID === outputID && row.typeID === action.outputTypeID) : undefined;
    const sourceRemainder = after.find(row => row.itemID === action.itemID);
    const proven = tupleValid && output && quantity(after, action.itemID, action.typeID) === 0 &&
      (!sourceRemainder || outputID === action.itemID && sourceRemainder.typeID === action.outputTypeID) &&
      output.quantity - quantity(pending.holdBefore, outputID, action.outputTypeID) === action.quantity &&
      unchanged(pending.holdBefore, after, [action.itemID, outputID]);
    if (proven && receipt.acknowledged) {
      memory = { ...memory, pending: null, stacks: memory.stacks.filter(stack => stack.itemID !== action.itemID) };
      return result("COMPRESSED");
    }
    if (!receipt.acknowledged && unchanged(pending.holdBefore, after, [])) {
      memory = { ...memory, pending: null, fault: receipt.reason ?? "collected-ore-compression-refused" }; return result("BLOCKED", memory.fault);
    }
    return result("PARTIAL", "compression-result-unconfirmed");
  }
  if (memory.fault) return result("BLOCKED", memory.fault);
  if (input.policy.mode === "TRACTOR_ONLY") return result("IDLE", "tractor-only");
  if (!input.mayWork) return result("WAIT", "support-work-preempted");
  const emit = (action: SupportCollectionAction, sourceBefore: readonly InventoryItemRow[] | null): SupportCollectionResult => {
    const holdBefore = bayRows(action.bay);
    if (holdBefore === null) return result("UNKNOWN", "destination-contents-unavailable");
    memory = { ...memory, pending: { action, sourceBefore: sourceBefore === null ? null : structuredClone(sourceBefore), holdBefore: structuredClone(holdBefore), receipt: null } };
    return result("WAIT", null, action);
  };
  if (input.policy.compressCollectedOre && input.ownActiveTypeListIDs.length > 0) {
    for (const stack of [...memory.stacks].sort((a, b) => a.itemID - b.itemID)) {
      const facts = input.compatibility?.find(row => row.typeID === stack.typeID);
      if (!facts || facts.availability === "unknown") return result("UNKNOWN", "compression-compatibility-unavailable");
      if (facts.compressedTypeID !== null && facts.matchingTypeListIDs?.some(id => input.ownActiveTypeListIDs.includes(id)))
        return emit({ kind: "compress", ...stack, outputTypeID: facts.compressedTypeID, facilityID: input.scope.shipID }, null);
    }
  }
  if (input.source === null || input.readyContainerID !== input.source.containerID) return result("WAIT", "claimed-container-not-settled");
  const source = input.source.rows;
  if (!validRows(source)) return result("UNKNOWN", "source-contents-unavailable");
  if (!source.length) return result("EMPTY", null, null, 0, true);
  const ore = source.filter(row => row.categoryID === 25 && !row.singleton).sort((a, b) => a.itemID - b.itemID);
  if (source.some(row => row.categoryID === null || row.categoryID === 25 && row.groupID === null)) return result("UNKNOWN", "source-classification-unavailable");
  if (!ore.length) return result("IDLE", "no-collectible-ore");
  let unknown = false;
  for (const row of ore) {
    const preferences = preferredBays(row);
    const candidates = preferences.map(key => input.bays!.find(bay => bay.key === key));
    if (candidates.some(bay => !bay || bay.present === null)) { unknown = true; continue; }
    const chain = candidates.some(bay => bay?.present === true) ? candidates.filter(bay => bay?.present === true) : [input.bays.find(bay => bay.key === "cargo")];
    if (!(typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume > 0) || chain.some(bay =>
      !bay || bay.present !== true || bay.error !== null || !validRows(bay.items) || bay.capacity === null ||
      ![bay.capacity.capacity, bay.capacity.used].every(value => Number.isFinite(value) && value >= 0))) { unknown = true; continue; }
    const transfers = planLootTransfers([row], input.bays, key => {
      const bay = input.bays!.find(bay => bay.key === (key ?? "cargo")); return Math.max(0, bay!.capacity!.capacity - bay!.capacity!.used);
    });
    const transfer = transfers[0];
    if (transfer) return emit({ kind: "transfer", containerID: input.source.containerID, itemID: row.itemID, typeID: row.typeID,
      quantity: transfer.qty ?? row.quantity, bay: transfer.bay ?? "cargo" }, source);
  }
  return result(unknown ? "UNKNOWN" : "FULL", unknown ? "capacity-or-unit-volume-unavailable" : "no-ore-fits");
}

export function recordSupportCollectionReceipt(memory: SupportCollectionMemory, receipt: SupportCollectionReceipt): SupportCollectionMemory {
  return memory.pending ? { ...memory, pending: { ...memory.pending, receipt } } : memory;
}
