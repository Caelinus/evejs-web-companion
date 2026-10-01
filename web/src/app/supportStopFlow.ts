import type { FlightStatus, SpaceSnapshot } from "../store/types.ts";

/** A module can finish between the scene read and Deactivate. Refusal itself
 * proves nothing; only the next own-ship scene can settle the full set. */
export async function settleParkingMiningModules(deps: {
  shipID: number; characterID: number; miningModuleIDs: readonly number[];
  readScene(): Promise<SpaceSnapshot>; deactivate(moduleID: number): Promise<void>;
}): Promise<void> {
  const active = (scene: SpaceSnapshot) => {
    if (scene.shipID !== deps.shipID || scene.ship?.itemID !== deps.shipID ||
        scene.ship.characterID !== deps.characterID || scene.ship.activeModuleIDs === null)
      throw new Error("Active own module state is unreadable; parking settlement is blocked.");
    return scene.ship.activeModuleIDs;
  };
  const before = active(await deps.readScene());
  let refusal: unknown, refused = false;
  for (const moduleID of deps.miningModuleIDs.filter(id => before.includes(id))) {
    try { await deps.deactivate(moduleID); }
    catch (error) { refusal = error; refused = true; break; }
  }
  const after = active(await deps.readScene());
  if (deps.miningModuleIDs.some(id => after.includes(id))) {
    if (refused) throw refusal;
    throw new Error("Mining modules have not confirmed stopped; pilot control is retained for retry.");
  }
}

/** The host retains ownership until local support settlement is proved. A
 * fresh docked read uses the same docked safety boundary as hosted drone Stop. */
export async function settleHostedMiningSupport(deps: {
  readFlight(): Promise<FlightStatus>; unresolvedCustody(): boolean;
  tick(): Promise<void>; ready(): boolean; reason(): string | null;
  releaseAnchor(): Promise<void>; now(): number; sleep(ms: number): Promise<void>; deadlineMs: number;
}): Promise<void> {
  const flight = await deps.readFlight();
  const docked = flight.docked === true && flight.shipID !== null;
  if (docked && deps.unresolvedCustody()) throw new Error("SUPPORT_CLEANUP_UNCONFIRMED: docked with unresolved container custody.");
  if (!docked) {
    let proved = false;
    while (deps.now() < deps.deadlineMs) {
      await deps.tick();
      if (deps.ready() && !deps.unresolvedCustody()) { proved = true; break; }
      await deps.sleep(2000);
    }
    if (!proved) throw new Error(`SUPPORT_CLEANUP_UNCONFIRMED: ${deps.reason()}`);
  }
  await deps.releaseAnchor();
}
