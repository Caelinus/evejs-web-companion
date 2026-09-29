// One observation, one order. Launch quantities remain Farmer's wholeStackLaunch
// concern; this controller only chooses role-matched bay stacks and waits for
// authoritative in-space confirmation before changing flights.
import type { DroneBayStack, DroneInSpace } from "../store/types.ts";
import type { DroneRole } from "./droneRoles.ts";

export interface MiningDroneState {
  readonly bay: readonly DroneBayStack[] | null;
  readonly out: readonly DroneInSpace[] | null;
  readonly maxActive: number | null;
  readonly roles: Readonly<Record<number, DroneRole | null>>;
}

export interface MiningDroneMemory {
  readonly combat: boolean;
  readonly clearTicks: number;
  readonly returning: readonly number[];
  readonly recallTicks: number;
  readonly orderKey: string;
  readonly orderAttempts: number;
  readonly orderCooldown: number;
  readonly blockedLaunchKey: string | null;
  /** Classic miner terminal cleanup bound, separate from flight-switch retries. */
  readonly terminalTicks?: number;
}

export const freshDroneMemory = (): MiningDroneMemory => ({
  combat: false, clearTicks: 0, returning: [], recallTicks: 0,
  orderKey: "", orderAttempts: 0, orderCooldown: 0, blockedLaunchKey: null,
});

export type MiningDroneAction =
  | { readonly kind: "launch"; readonly droneItemIDs: readonly number[] }
  | { readonly kind: "recallDrones"; readonly droneIDs: readonly number[] }
  | { readonly kind: "mineDrones" | "engageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  | { readonly kind: "wait"; readonly reason: string };

const CLEAR_OBSERVATIONS = 3;
const RECALL_RETRY_OBSERVATIONS = 15;
const MAX_RECALL_OBSERVATIONS = 90;
const MAX_ORDER_ATTEMPTS = 3;

/** Pure policy shared by the classic miner and the scripted belt/site miner. */
export function decideMiningDroneFlight(
  state: MiningDroneState | null,
  previous: MiningDroneMemory,
  hostileID: number | null,
  rockID: number | null,
  leaving: boolean,
): { readonly action: MiningDroneAction | null; readonly memory: MiningDroneMemory } {
  const memory = { ...previous };
  const wait = (reason: string) => ({ action: { kind: "wait", reason } as const, memory });
  // Neither an unreadable flight nor an unreadable grid confirms a return or
  // supplies a clear observation. Callers pass null state for either failure.
  if (state?.out === null || state === null) {
    memory.clearTicks = 0;
    return wait("Reading controlled drone state before another order.");
  }
  if (hostileID !== null) {
    memory.combat = true;
    memory.clearTicks = 0;
  } else if (memory.combat && ++memory.clearTicks >= CLEAR_OBSERVATIONS) {
    memory.combat = false;
  }
  if (memory.combat !== previous.combat) memory.blockedLaunchKey = null;

  const role = memory.combat ? "combat" : "mining";
  const roleOf = (typeID: number | null): DroneRole | null =>
    typeID === null ? null : state.roles[typeID] ?? null;
  const controlled = state.out.filter((drone) => drone.controlled);
  // Known salvage/logistic flights belong to their own blocks. Unknown roles
  // cannot be trusted as unrelated, so they stay in the recall safety set.
  const out = controlled.filter((drone) => {
    const known = roleOf(drone.typeID);
    return known === null || known === "mining" || known === "combat";
  });
  const wrong = out.filter((drone) => leaving || drone.activity === "returning" || roleOf(drone.typeID) !== role);
  const returning = [...new Set([...out.filter((drone) => memory.returning.includes(drone.itemID)), ...wrong]
    .map((drone) => drone.itemID))];
  if (returning.length > 0) {
    memory.recallTicks += 1;
    const newlyRecalled = returning.some((id) => !memory.returning.includes(id));
    memory.returning = returning;
    if (memory.recallTicks > MAX_RECALL_OBSERVATIONS) {
      return wait("Controlled drones did not confirm return; movement and flight switching remain blocked.");
    }
    if ((newlyRecalled && !wrong.every((drone) => drone.activity === "returning")) ||
        memory.recallTicks % RECALL_RETRY_OBSERVATIONS === 0) {
      return { action: { kind: "recallDrones", droneIDs: returning }, memory };
    }
    return wait("Waiting for controlled drones to return.");
  }
  memory.returning = [];
  memory.recallTicks = 0;
  if (leaving) return { action: null, memory };
  const targetID = memory.combat ? hostileID : rockID;
  if (targetID === null) return { action: null, memory };

  const idle = out.filter((drone) => drone.targetID !== targetID ||
    !(memory.combat ? ["fighting", "chasing", "approaching"] : ["mining", "approaching"]).includes(drone.activity ?? ""));
  const maxActive = state.maxActive;
  const mayLaunch = Number.isSafeInteger(maxActive) && maxActive !== null && maxActive > controlled.length && state.bay !== null;
  const stacks = mayLaunch ? state.bay!.filter((stack) => roleOf(stack.typeID) === role &&
    Number.isSafeInteger(stack.itemID) && stack.itemID > 0 && Number.isSafeInteger(stack.quantity) &&
    // EveJS returns a repackaged stack as a positive quantity but an
    // assembled single drone as -1 after recall. Farmer's wholeStackLaunch
    // already maps that singleton to one; the controller must still choose it.
    (stack.quantity > 0 || stack.quantity === -1)) : [];
  const launchKey = JSON.stringify([role, stacks.map((stack) => stack.itemID), out.map((drone) => drone.itemID)]);
  const candidate: MiningDroneAction | null = stacks.length > 0 && memory.blockedLaunchKey !== launchKey
    ? { kind: "launch", droneItemIDs: stacks.map((stack) => stack.itemID) }
    : idle.length > 0 ? { kind: memory.combat ? "engageDrones" : "mineDrones", droneIDs: idle.map((drone) => drone.itemID), targetID } : null;
  if (candidate === null) {
    memory.orderKey = "";
    memory.orderAttempts = 0;
    memory.orderCooldown = 0;
    if (memory.combat && out.length === 0) return wait("No authoritative compatible combat flight is available.");
    return { action: null, memory };
  }
  const key = JSON.stringify([candidate, out.map((drone) => drone.itemID)]);
  if (key !== memory.orderKey) {
    memory.orderKey = key;
    memory.orderAttempts = 0;
    memory.orderCooldown = 0;
  }
  if (memory.orderCooldown > 0) {
    memory.orderCooldown -= 1;
    return wait("Waiting for the drone order to appear in authoritative state.");
  }
  if (memory.orderAttempts >= MAX_ORDER_ATTEMPTS) {
    if (candidate.kind === "launch") memory.blockedLaunchKey = launchKey;
    // Keep the runner's authority while an issued flight may still be out;
    // Batch 6B owns terminal cleanup. No further order is sent for this state.
    return wait("Drone order did not confirm within the bounded attempts.");
  }
  memory.orderAttempts += 1;
  memory.orderCooldown = 3;
  return { action: candidate, memory };
}
