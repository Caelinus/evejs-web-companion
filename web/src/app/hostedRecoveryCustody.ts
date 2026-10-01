import type { SpaceSnapshot } from "../store/types.ts";
import type { MiningSupportServiceSnapshot } from "../nav/miningSupportServices.ts";
import type { SupportSelfMiningMemory } from "../nav/miningSupportSelfMining.ts";
import { unwrapLong } from "../bridge/wire.ts";

/** After transport quiescence and recovery preflight, targeting intent may be
 * rebased from a fresh readable own target list. Absence does not prove that
 * an old pending lock completed or was cancelled; targeting carries no asset
 * custody. Fresh mining decisions still require an actually locked target. */
export function retireHostedSelfLock(memory: SupportSelfMiningMemory, targets: unknown): SupportSelfMiningMemory {
  if (memory.fault || memory.order?.action.kind !== "lock" || !Array.isArray(targets) || !targets.every(value => {
    const id = unwrapLong(value);
    return id !== null && id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER);
  })) return memory;
  return { ...memory, order: null };
}

/** Physical settlement permits retiring a superseded movement destination.
 * It proves neither arrival nor recipient coverage. */
export function hostedSupportMotionSettled(scene: SpaceSnapshot | null, services: MiningSupportServiceSnapshot): boolean {
  const own = scene?.ship;
  return scene?.inSpace === true && scene.shipID === services.capabilities.scope.shipID && own?.itemID === scene.shipID &&
    scene.sampledAtMs !== null && Number.isFinite(scene.sampledAtMs) && services.sampledAtMs === scene.sampledAtMs &&
    own?.motionAvailable === true && own.mode === "STOP" &&
    own.velocity !== null && [own.velocity.x, own.velocity.y, own.velocity.z].every(Number.isFinite) &&
    Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) <= 0.5 &&
    services.mobility.movement.verdict === "unrestricted" && services.mobility.warp.verdict === "unrestricted";
}
