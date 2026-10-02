import type { ScriptObservation } from "./scriptConditions.ts";
import type { ScriptBoard } from "./scriptDecide.ts";
import type { MiningHold } from "../store/types.ts";

/** Run-local proof from bounded, consecutive empty observations on the OLD grid. */
export const OPERATION_DRAIN_CLEAR_BOARD_KEY = "miningDrainGridClear";

export function confirmedDrain(obs: ScriptObservation, board: ScriptBoard): boolean {
  const op = obs.miningOperation;
  const tail = op?.role === "HAULER" ? op.logisticsTarget : null;
  return !!tail && !op?.stopRequested && tail.state === "DRAINING" &&
    tail.claimedByOperationID === op?.operationID &&
    board[OPERATION_DRAIN_CLEAR_BOARD_KEY] === tail.targetKey &&
    !(op?.currentTarget?.targetKey === tail.targetKey && op.rendezvous?.kind === "MINER_CLEARANCE");
}

/** A failed contents read is never evidence that a final load is ashore. */
export function freightReadable(holds: readonly MiningHold[] | null | undefined): holds is readonly (MiningHold & { items: NonNullable<MiningHold["items"]> })[] {
  return holds != null && holds.every(hold => hold.error == null && hold.items != null);
}
