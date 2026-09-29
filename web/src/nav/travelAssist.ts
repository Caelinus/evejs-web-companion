import { decidePropulsionModule, type PropulsionModule } from "./propulsion.ts";
import { measureSpace } from "./autopilotLoop.ts";
import type { SpaceSnapshot } from "../store/types.ts";

export function fittedTravelPropulsion(rows: readonly { itemID: number; typeID: number; online: boolean; effect: string | null }[]): PropulsionModule[] {
  return rows.filter(row => row.online && ["moduleBonusAfterburner", "moduleBonusMicrowarpdrive"].includes(row.effect ?? ""))
    .map(row => ({ itemID: row.itemID, typeID: row.typeID, kind: row.effect === "moduleBonusAfterburner" ? "afterburner" as const : "microwarpdrive" as const }));
}

/** Dogma dispatch chooses its propulsion path BEFORE generic default-effect
 * resolution. An empty effect can cycle without applying speed/mass bonuses. */
export function travelPropulsionActivation(module: PropulsionModule): { effect: string; repeat: -1 } {
  if (module.kind === null) throw new Error("Unknown propulsion effect");
  return { effect: module.kind === "afterburner" ? "moduleBonusAfterburner" : "moduleBonusMicrowarpdrive", repeat: -1 };
}

export interface TravelAssistInput {
  enabled: boolean;
  scope: string | null;
  action: { kind: string; targetID?: number | null; range?: number };
  snapshot: SpaceSnapshot | null;
  inWarp: boolean | null;
  docked: boolean | null;
  modules: readonly PropulsionModule[];
  scrammed: boolean | null;
}
export interface TravelAssistDeps {
  /** Explicit propulsion effect, continuous until owned approach cleanup.
   * Result confirms cycling/off, NOT physical acceleration. */
  change(module: PropulsionModule, on: boolean): Promise<boolean>;
  log(message: string): void;
}

/** Optional shared movement decorator. No MCC/profile selector and no reads or
 * polling of its own. Only a confirmed subwarp approach can create intent. */
export function createTravelAssist(deps: TravelAssistDeps) {
  let movement: { targetID: number; scope: string; range: number } | null = null;
  let owned: { module: PropulsionModule; targetID: number; scope: string; stopAttempts: number;
    baselineMax: number | null; baselineSpeed: number | null; observations: number; effectSeen: boolean; accelerationSeen: boolean } | null = null;
  let refused: string | null = null;
  let logged = "";
  const log = (message: string) => { if (message !== logged) { logged = message; deps.log(message); } };
  async function stop(): Promise<boolean> {
    if (!owned) return false;
    const current = owned;
    if (current.stopAttempts >= 3) return false; // retain custody: Stop/Parking cannot claim settlement
    current.stopAttempts++;
    try {
      if (!await deps.change(current.module, false)) throw new Error("authoritative off state not confirmed");
      log(`Travel assist deactivated ${current.module.itemID}: approach ended/authority changed.`);
      owned = null;
    } catch (error) {
      log(`Travel assist deactivation unconfirmed for ${current.module.itemID}: ${String(error)}; ownership retained for cleanup.`);
    }
    return true;
  }
  return {
    async beforeAction(input: TravelAssistInput): Promise<boolean> {
      const active = input.snapshot?.ship?.activeModuleIDs;
      const usable = input.enabled && input.scope !== null && input.inWarp === false && input.docked === false && active != null;
      if (owned && active != null && !active.includes(owned.module.itemID)) {
        log(`Travel assist off confirmed: ${owned.module.itemID}; no automatic restart on the same approach.`);
        refused = `${owned.scope}:${owned.targetID}`;
        owned = null;
      }
      if (owned && active?.includes(owned.module.itemID)) {
        const max = input.snapshot?.ship?.maxVelocity;
        const velocity = input.snapshot?.ship?.velocity;
        const speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : NaN;
        owned.observations++;
        if (!owned.effectSeen && owned.baselineMax !== null && max != null && max > owned.baselineMax * 1.01) {
          owned.effectSeen = true;
          log(`Travel assist propulsion effect observed ${owned.module.itemID}: authoritative max velocity ${owned.baselineMax} -> ${max} m/s.`);
        }
        if (owned.effectSeen && !owned.accelerationSeen && owned.baselineSpeed !== null && speed > owned.baselineSpeed + 1) {
          owned.accelerationSeen = true;
          log(`Travel assist acceleration observed ${owned.module.itemID}: speed ${speed.toFixed(1)} m/s.`);
        }
        if (!owned.effectSeen && owned.observations === 3) log(`Travel assist ${owned.module.itemID}: cycling, but physical speed bonus not confirmed by current snapshots.`);
      }
      if (usable && ["approach", "orbit"].includes(input.action.kind) && input.action.targetID != null) {
        movement = { targetID: input.action.targetID, scope: input.scope!, range: input.action.range ?? 0 };
      } else if (!usable || !["wait", "lock"].includes(input.action.kind) || movement?.scope !== input.scope) movement = null;
      const measured = movement && input.snapshot ? measureSpace(input.snapshot)?.distances.get(movement.targetID) : undefined;
      const distance = measured == null || !Number.isFinite(measured) ? undefined : measured - (movement?.range ?? 0);
      if (distance == null || distance <= 5_000) movement = null;
      if (owned && (!movement || owned.scope !== movement.scope || owned.targetID !== movement.targetID ||
          (input.scrammed === true && owned.module.kind === "microwarpdrive"))) return stop();
      if (!movement || owned || distance! <= 10_000 || input.action.kind === "lock") return false;
      const key = `${movement.scope}:${movement.targetID}`;
      if (refused === key) return false;
      // Respect externally active modules. AB first, then itemID; shared policy
      // still owns capacitor/scram rules. Never activate both AB and MWD.
      if (input.modules.some(module => active!.includes(module.itemID))) { log("Travel assist skipped: propulsion already externally active."); return false; }
      const modules = input.modules.filter(module => module.kind !== null)
        .sort((a, b) => Number(a.kind !== "afterburner") - Number(b.kind !== "afterburner") || a.itemID - b.itemID);
      const picked = decidePropulsionModule({ modules, activeModuleIDs: new Set(active!), capacitorRatio: input.snapshot?.ship?.capacitorRatio ?? null,
        wantBurn: true, capFloor: 0.3, scrammed: input.scrammed });
      if (picked.kind !== "light") {
        const reason = modules.length === 0 ? "no online fitted propulsion with known effect"
          : input.scrammed === true && modules.every(module => module.kind !== "afterburner") ? "MWD blocked by warp scrambler"
          : "capacitor below 30% floor";
        log(`Travel assist skipped: ${reason}.`); return false;
      }
      const baselineMax = input.snapshot?.ship?.maxVelocity;
      const velocity = input.snapshot?.ship?.velocity;
      const baselineSpeed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : NaN;
      owned = { module: picked.module, ...movement, stopAttempts: 0,
        baselineMax: baselineMax != null && Number.isFinite(baselineMax) ? baselineMax : null,
        baselineSpeed: Number.isFinite(baselineSpeed) ? baselineSpeed : null, observations: 0, effectSeen: false, accelerationSeen: false };
      try {
        if (!await deps.change(picked.module, true)) throw new Error("activation not confirmed");
        log(`Travel assist ${picked.module.kind} ${picked.module.itemID}: activation/cycling confirmed for approach ${movement.targetID}; awaiting physical effect observation.`);
      } catch (error) {
        refused = key;
        movement = null;
        // A definite already-active refusal is another controller's activation,
        // not an ambiguous write of ours. Never take shutdown custody of it.
        if (/MODULE_ALREADY_ACTIVE|ModuleAlreadyActive|already active/i.test(String(error))) owned = null;
        log(`Travel assist activation refused/unconfirmed: ${String(error)}; ordinary movement continues.`);
        // Keep custody of an ambiguous write until the next observation/off.
      }
      return true;
    },
    async requestStop(): Promise<void> { movement = null; await stop(); },
    pending(): boolean { return owned !== null; },
    confirmStopped(activeModuleIDs: readonly number[] | null): void {
      if (owned && activeModuleIDs !== null && !activeModuleIDs.includes(owned.module.itemID)) {
        log(`Travel assist off confirmed during cleanup: ${owned.module.itemID}.`);
        owned = null;
      }
    },
  };
}
