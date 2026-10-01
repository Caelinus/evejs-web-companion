import test from "node:test";
import assert from "node:assert/strict";
import { decideSupportCollection, freshSupportCollectionMemory, recordSupportCollectionReceipt, type SupportCollectionInput } from "./miningSupportCollection.ts";
import { decodeInventoryRowsChecked } from "../bridge/inventoryShip.ts";
import { decodeShipBaysChecked } from "../bridge/shipBays.ts";
import type { InventoryItemRow, ShipBay } from "../store/types.ts";

const ore = (quantity = 100, itemID = 101): InventoryItemRow => ({ itemID, typeID: 1230, categoryID: 25, groupID: 462, flagID: null, quantity, singleton: false, volume: 0.1 });
const fuel: InventoryItemRow = { ...ore(20, 102), typeID: 16272, groupID: 423, categoryID: 4 };
const ammo: InventoryItemRow = { ...ore(30, 103), typeID: 42830, categoryID: 8 };
const bay = (key: string, present: boolean, items: readonly InventoryItemRow[] = [], free = 100): ShipBay => ({ key, label: key, present, items,
  capacity: { capacity: 100, used: 100 - free }, error: null });
const input = (): SupportCollectionInput => ({ scope: { characterID: 1, sessionEpoch: "run", shipID: 10, fleetID: "fleet", solarSystemID: 3001, fittingSignature: "fit" },
  runID: "collection", policy: { mode: "TRACTOR_AND_COLLECT", compressCollectedOre: false }, source: { containerID: 201, rows: [ore(), fuel, ammo] },
  bays: [bay("ore", true), bay("asteroid", false), bay("ice", false), bay("gas", false), bay("cargo", true, [fuel, ammo])],
  readyContainerID: 201, receivedAtMs: 1000, nowMs: 1000, mayWork: true, ownActiveTypeListIDs: [], compatibility: null });
function moved(existing: readonly InventoryItemRow[] = []) {
  const base = input(), read = { ...base, bays: base.bays!.map(row => row.key === "ore" ? bay("ore", true, existing) : row) };
  const planned = decideSupportCollection(read, freshSupportCollectionMemory());
  assert.equal(planned.action?.kind, "transfer");
  const destination = ore(existing.length ? existing[0]!.quantity + 100 : 100, existing[0]?.itemID ?? 301);
  const after = { ...read, source: { containerID: 201, rows: [fuel, ammo] }, bays: read.bays!.map(row => row.key === "ore" ? bay("ore", true, [destination]) : row) };
  const result = decideSupportCollection(after, recordSupportCollectionReceipt(planned.memory, { acknowledged: true }));
  return { result, after, planned };
}
test("ore-only one transfer, proven source loss + specialised hold gain, fuel/ammo preserved", () => {
  const { planned, result, after } = moved();
  assert.deepEqual(planned.action, { kind: "transfer", containerID: 201, itemID: 101, typeID: 1230, quantity: 100, bay: "ore" });
  assert.equal(result.state, "MOVED"); assert.equal(result.movedQuantity, 100); assert.equal(result.sourceEmpty, false); assert.equal(result.retainClaim, true);
  assert.deepEqual(result.memory.stacks, [{ bay: "ore", itemID: 301, typeID: 1230, quantity: 100 }]);
  assert.equal(decideSupportCollection(after, result.memory).reason, "no-collectible-ore");
});
test("readable no-fit is FULL; unknown capacity, volume or hold presence is UNKNOWN; no cargo overflow", () => {
  const base = input(), full = { ...base, bays: base.bays!.map(row => row.key === "ore" ? bay("ore", true, [], 0) : row) };
  assert.equal(decideSupportCollection(full, freshSupportCollectionMemory()).state, "FULL");
  for (const read of [
    { ...input(), bays: input().bays!.map(row => row.key === "ore" ? { ...row, capacity: null } : row) },
    { ...input(), bays: input().bays!.filter(row => row.key !== "asteroid") },
    { ...input(), source: { containerID: 201, rows: [{ ...ore(), volume: null }] } },
    { ...input(), source: { containerID: 201, rows: [{ ...ore(), categoryID: null }] } },
  ]) { const result = decideSupportCollection(read, freshSupportCollectionMemory()); assert.equal(result.state, "UNKNOWN"); assert.equal(result.action, null); }
});
test("known capacity splits only the measured quantity", () => {
  const base = input(), read = { ...base, bays: base.bays!.map(row => row.key === "ore" ? bay("ore", true, [], 2) : row) };
  const result = decideSupportCollection(read, freshSupportCollectionMemory());
  assert.equal(result.action?.kind === "transfer" && result.action.quantity, 20);
});
test("ACK without deltas and partial/redirected transfer retain pending claim and never retry", () => {
  const planned = decideSupportCollection(input(), freshSupportCollectionMemory());
  for (const read of [input(), { ...input(), source: { containerID: 201, rows: [ore(90), fuel, ammo] },
    bays: input().bays!.map(row => row.key === "ore" ? bay("ore", true, [ore(5, 301)]) : row) }]) {
    let result = decideSupportCollection(read, recordSupportCollectionReceipt(planned.memory, { acknowledged: true }));
    assert.equal(result.state, "PARTIAL"); assert.ok(result.memory.pending); assert.equal(result.retainClaim, true); assert.equal(result.action, null);
    result = decideSupportCollection(read, result.memory); assert.equal(result.action, null);
  }
});
test("observed refusal remains structured and latched, with no blind next transfer", () => {
  const planned = decideSupportCollection(input(), freshSupportCollectionMemory());
  const result = decideSupportCollection(input(), recordSupportCollectionReceipt(planned.memory, { acknowledged: false, reason: "refused" }));
  assert.equal(result.state, "BLOCKED"); assert.equal(result.memory.pending, null); assert.equal(result.retainClaim, true);
  assert.equal(decideSupportCollection(input(), result.memory).action, null);
});
test("merged preexisting ore never acquires full-stack collected provenance", () => {
  const { result, after } = moved([ore(50, 301)]);
  assert.equal(result.state, "MOVED"); assert.equal(result.reason, "compression-provenance-unavailable"); assert.deepEqual(result.memory.stacks, []);
  assert.equal(decideSupportCollection({ ...after, policy: { mode: "TRACTOR_AND_COLLECT", compressCollectedOre: true }, ownActiveTypeListIDs: [334],
    compatibility: [{ typeID: 1230, compressedTypeID: 62516, availability: "available", matchingTypeListIDs: [334] }] }, result.memory).action, null);
});
test("only compatible own collected whole stack compresses; raw tuple and hold transformation prove success", () => {
  const { result, after } = moved();
  const read = { ...after, policy: { mode: "TRACTOR_AND_COLLECT" as const, compressCollectedOre: true }, ownActiveTypeListIDs: [334],
    compatibility: [{ typeID: 1230, compressedTypeID: 62516, availability: "available" as const, matchingTypeListIDs: [334] }] };
  const planned = decideSupportCollection(read, result.memory);
  assert.deepEqual(planned.action, { kind: "compress", itemID: 301, typeID: 1230, quantity: 100, bay: "ore", outputTypeID: 62516, facilityID: 10 });
  // Runtime may replace the type on the SAME item ID.
  const compressed = { ...read, bays: read.bays!.map(row => row.key === "ore" ? bay("ore", true, [{ ...ore(100, 301), typeID: 62516 }]) : row) };
  const done = decideSupportCollection(compressed, recordSupportCollectionReceipt(planned.memory, { acknowledged: true, compressionTuple: [301, 1230, 100, 301, 62516, 100] }));
  assert.equal(done.state, "COMPRESSED"); assert.equal(done.memory.pending, null); assert.deepEqual(done.memory.stacks, []);
  const falseAck = decideSupportCollection(read, recordSupportCollectionReceipt(planned.memory, { acknowledged: true, compressionTuple: [301, 1230, 100, 301, 62516, 100] }));
  assert.equal(falseAck.state, "PARTIAL"); assert.ok(falseAck.memory.pending);
});
test("stale or changed stacks lose compression provenance; unknown/excluded compatibility emits none", () => {
  const { result, after } = moved();
  const common = { ...after, policy: { mode: "TRACTOR_AND_COLLECT" as const, compressCollectedOre: true }, ownActiveTypeListIDs: [334] };
  assert.equal(decideSupportCollection(common, result.memory).state, "UNKNOWN");
  const changed = { ...common, bays: common.bays!.map(row => row.key === "ore" ? bay("ore", true, [ore(101, 301)]) : row) };
  assert.deepEqual(decideSupportCollection(changed, result.memory).memory.stacks, []);
  assert.equal(decideSupportCollection({ ...common, compatibility: [{ typeID: 1230, compressedTypeID: 62516, availability: "available", matchingTypeListIDs: [] }] }, result.memory).action, null);
});
test("Stop, tractor-only, unsettled target and scope changes cannot dispatch collection", () => {
  for (const read of [{ ...input(), mayWork: false }, { ...input(), readyContainerID: null },
    { ...input(), policy: { mode: "TRACTOR_ONLY" as const, compressCollectedOre: true } }, { ...input(), nowMs: 11000 }])
    assert.equal(decideSupportCollection(read, freshSupportCollectionMemory()).action, null);
  const pending = decideSupportCollection(input(), freshSupportCollectionMemory()).memory;
  const result = decideSupportCollection({ ...input(), scope: { ...input().scope, shipID: 11 } }, pending);
  assert.equal(result.state, "BLOCKED"); assert.deepEqual(result.memory, pending); assert.ok(result.retainClaim);
});
test("only strict valid empty source proves EMPTY; malformed/dropped/duplicate rows stay unknown", () => {
  assert.deepEqual(decodeInventoryRowsChecked({ type: "list", items: [] }), []);
  assert.equal(decodeInventoryRowsChecked(null), null);
  assert.equal(decodeInventoryRowsChecked({ type: "list", items: [null] }), null);
  const rawRow = { itemID: 101, typeID: 1230, quantity: 100 };
  assert.equal(decodeInventoryRowsChecked({ type: "list", items: [rawRow, rawRow] }), null);
  assert.equal(decodeInventoryRowsChecked({ type: "objectex1", header: [{ type: "token", value: "__builtin__.set" }, []] }), null);
  assert.equal(decodeShipBaysChecked([{ key: "ore", present: true, capacity: { capacity: 100 }, items: [] }]), null);
  assert.equal(decodeShipBaysChecked([{ key: "ore", present: true, capacity: { capacity: 100, used: 0 }, items: [null] }]), null);
  const result = decideSupportCollection({ ...input(), source: { containerID: 201, rows: [] } }, freshSupportCollectionMemory());
  assert.equal(result.state, "EMPTY"); assert.equal(result.sourceEmpty, true); assert.equal(result.retainClaim, false);
});
