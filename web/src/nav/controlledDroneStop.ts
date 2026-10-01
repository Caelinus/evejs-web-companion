/** A hosted Stop owns only the currently controlled flight. Lost drones are
 * handled by a separate recovery workflow, never guessed from flight memory. */
export interface ControlledDroneStopRow {
  readonly itemID: number;
  readonly controlled: boolean;
  readonly activity: string | null;
}

export interface ControlledDroneStopDeps {
  /** null means the authoritative in-space state could not be read. */
  read(): Promise<readonly ControlledDroneStopRow[] | null>;
  recall(ids: readonly number[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  deadlineMs: number;
}

export const CONTROLLED_DRONE_STOP_CADENCE_MS = 1_500;
// The host allocates three minutes before Farmer's separate dock grace. Keep
// a defensive count bound even if a test clock or timer is broken.
export const CONTROLLED_DRONE_STOP_OBSERVATIONS = Math.ceil(3 * 60_000 / CONTROLLED_DRONE_STOP_CADENCE_MS) + 1;

/** Raw authority must distinguish a disconnected drone from unknown control. */
export function controlledFlightSettled(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const seen = new Set<number>();
  return raw.every(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.itemID) || (row.itemID as number) <= 0 || seen.has(row.itemID as number) ||
        row.controlled !== false) return false;
    seen.add(row.itemID as number);
    return true;
  });
}

/** Bounded, fail-closed confirmation. A successful recall order is not a return. */
export async function confirmControlledDronesHome(deps: ControlledDroneStopDeps): Promise<void> {
  const ordered = new Set<number>();
  let lastFailure: unknown = null;
  for (let observation = 0; observation < CONTROLLED_DRONE_STOP_OBSERVATIONS && deps.now() < deps.deadlineMs; observation += 1) {
    let rows: readonly ControlledDroneStopRow[] | null = null;
    try {
      rows = await deps.read();
    } catch (error) {
      lastFailure = error;
    }
    if (rows !== null) {
      const controlled = rows.filter((row) => row.controlled);
      if (controlled.length === 0) return;
      const toRecall = controlled.filter((row) => row.activity !== "returning" && !ordered.has(row.itemID));
      if (toRecall.length > 0 && deps.now() < deps.deadlineMs) {
        try {
          await deps.recall(toRecall.map((row) => row.itemID));
          for (const row of toRecall) ordered.add(row.itemID);
        } catch (error) {
          lastFailure = error;
        }
      }
    }
    if (observation + 1 < CONTROLLED_DRONE_STOP_OBSERVATIONS && deps.now() < deps.deadlineMs) {
      await deps.sleep(Math.min(CONTROLLED_DRONE_STOP_CADENCE_MS, deps.deadlineMs - deps.now()));
    }
  }
  throw new Error(lastFailure === null
    ? "Controlled drones have not been confirmed back in the bay; Stop is paused."
    : "Drone state or recall could not be confirmed; Stop is paused.");
}
