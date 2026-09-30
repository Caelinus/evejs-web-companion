// Login recovery for one nearby lost flight. Discovery is a fresh BFF scene
// projection; EveJS CmdReconnectToDrones remains the final ownership, scene,
// bandwidth and active-flight authority.
import { confirmControlledDronesHome } from "./controlledDroneStop.ts";

export type DroneRecoveryState =
  | { readonly phase: "checking" | "recovering" | "ready"; readonly reason: null }
  | { readonly phase: "blocked"; readonly reason: string };

export interface RecoveryDrone {
  readonly itemID: number;
  readonly controlled: boolean;
  readonly reconnectCandidate: boolean;
  readonly activity: string | null;
}

export function readRecoveryDrones(raw: unknown): readonly RecoveryDrone[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const drones: RecoveryDrone[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.itemID) || (row.itemID as number) <= 0 ||
        seen.has(row.itemID as number) || typeof row.controlled !== "boolean" ||
        typeof row.reconnectCandidate !== "boolean" ||
        (row.controlled && row.reconnectCandidate)) return null;
    seen.add(row.itemID as number);
    drones.push({
      itemID: row.itemID as number,
      controlled: row.controlled,
      reconnectCandidate: row.reconnectCandidate,
      activity: typeof row.activity === "string" ? row.activity : null,
    });
  }
  return drones;
}

export async function recoverLostDroneFlight(deps: {
  /** true=in space; false=authoritatively docked; null=unreadable. */
  inSpace(): Promise<boolean | null>;
  read(): Promise<readonly RecoveryDrone[] | null>;
  reconnect(ids: readonly number[]): Promise<void>;
  recall(ids: readonly number[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** IDs retained only across Retry within this browser session. */
  pendingIDs: Set<number>;
  /** IDs whose reconnect was already authoritatively confirmed. */
  confirmedIDs: Set<number>;
  report(state: DroneRecoveryState): void;
}): Promise<void> {
  deps.report({ phase: "checking", reason: null });
  const inSpace = await deps.inSpace();
  if (inSpace === false) {
    deps.pendingIDs.clear();
    deps.confirmedIDs.clear();
    deps.report({ phase: "ready", reason: null });
    return;
  }
  if (inSpace !== true) throw new Error("The pilot's location could not be confirmed.");
  const first = await deps.read();
  if (first === null) throw new Error("Nearby drone control state could not be read.");
  const candidates = first.filter(drone => drone.reconnectCandidate);
  if (new Set([...deps.pendingIDs, ...candidates.map(drone => drone.itemID)]).size > 10) {
    throw new Error("More than 10 owned lost drones are nearby; recover them manually.");
  }
  for (const drone of candidates) deps.pendingIDs.add(drone.itemID);
  if (deps.pendingIDs.size === 0) {
    deps.report({ phase: "ready", reason: null });
    return;
  }
  deps.report({ phase: "recovering", reason: null });
  const pending = () => [...deps.pendingIDs];
  if (pending().some(id => !first.some(drone => drone.itemID === id) && !deps.confirmedIDs.has(id))) {
    throw new Error("A lost drone disappeared before reconnect could be confirmed.");
  }
  const notControlled = first.filter(drone => deps.pendingIDs.has(drone.itemID) && !drone.controlled);
  if (notControlled.some(drone => !drone.reconnectCandidate)) {
    throw new Error("A lost drone is no longer eligible for reconnect; recover it manually.");
  }
  for (const drone of notControlled) deps.confirmedIDs.delete(drone.itemID);
  if (notControlled.length > 0) await deps.reconnect(notControlled.map(drone => drone.itemID));

  // CmdReconnectToDrones can silently skip individual IDs (including when
  // bandwidth or private-scene scope refuses them). Confirm every ID from a
  // fresh authoritative read before any recall order.
  let confirmed: readonly RecoveryDrone[] | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    confirmed = await deps.read();
    if (confirmed === null) throw new Error("Drone reconnect could not be confirmed.");
    for (const drone of confirmed) if (drone.controlled && deps.pendingIDs.has(drone.itemID)) {
      deps.confirmedIDs.add(drone.itemID);
    }
    if (pending().every(id => deps.confirmedIDs.has(id))) break;
    if (attempt < 2) await deps.sleep(2000);
  }
  if (pending().some(id => !deps.confirmedIDs.has(id))) {
    throw new Error("Some lost drones did not reconnect; automation remains blocked.");
  }

  // Present ONLY this recovered flight to the established bounded recall gate;
  // an unrelated already-connected flight must never be recalled by login.
  await confirmControlledDronesHome({
    read: async () => {
      const drones = await deps.read();
      // A recovered drone still visible but no longer controlled is not a
      // confirmed return. The generic stop helper considers an uncontrolled
      // flight empty, so refuse that interpretation for our tracked IDs.
      if (drones === null || drones.some(drone => deps.pendingIDs.has(drone.itemID) && !drone.controlled)) return null;
      return drones.filter(drone => deps.pendingIDs.has(drone.itemID));
    },
    recall: deps.recall,
    sleep: deps.sleep,
    now: Date.now,
    deadlineMs: Date.now() + 3 * 60_000,
  });
  deps.pendingIDs.clear();
  deps.confirmedIDs.clear();
  deps.report({ phase: "ready", reason: null });
}
