import type { BotScript } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { createScriptRunner, type ScriptRunnerController, type ScriptRunnerDeps } from "./scriptRunner.ts";
import { freightHoldItemIDs } from "./miningBotLoop.ts";
import { dockedAt, type DockableLocation } from "./dockableLocation.ts";

type ParkingDestination = { readonly stationID: number; readonly stationName: string; readonly systemName: string; readonly kind?: "station" } | DockableLocation;

function locationOf(destination: ParkingDestination): Pick<DockableLocation, "kind" | "id" | "name" | "solarSystemName"> {
  return "kind" in destination && destination.kind === "structure"
    ? destination
    : { kind: "station", id: (destination as { stationID: number }).stationID,
        name: (destination as { stationName: string }).stationName,
        solarSystemName: (destination as { systemName: string }).systemName };
}

export interface FleetParkingPolicy {
  readonly mode: "RETURN_HOME_DOCK" | "RETURN_HOME_UNLOAD_DOCK";
  readonly destination: ParkingDestination;
  readonly corporationDivision: number | null;
}

export function parkingScript(policy: FleetParkingPolicy): BotScript {
  const location = policy.destination && locationOf(policy.destination);
  if (!["RETURN_HOME_DOCK", "RETURN_HOME_UNLOAD_DOCK"].includes(policy.mode) ||
      !location || !Number.isSafeInteger(location.id) || location.id <= 0) {
    throw new Error("Parking requires an explicit dockable destination; starting station is not a fallback.");
  }
  const home = { entity: location.kind, id: location.id, name: location.name, systemName: location.solarSystemName ?? "" };
  return { format: "evejs-bot-script", version: 1, name: "Fleet Parking", notes: "Finite operation stop, not a mining routine.",
    home, interrupts: [], program: [{ id: "park", kind: "macro",
      macro: policy.mode === "RETURN_HOME_UNLOAD_DOCK" ? "deliver-ore" : "travel-to-station",
      args: { station: { kind: "station", ref: home },
        ...(policy.corporationDivision === null ? {} : { into: { kind: "corpDivision" as const, division: policy.corporationDivision, name: null } }) },
    }],
  };
}

function readableFreight(obs: ScriptObservation): boolean {
  return obs.holds != null && obs.holds.some(hold => hold.present) &&
    obs.holds.every(hold => !hold.present || (Array.isArray(hold.items) && !hold.error));
}

// A finite use of the EXISTING runner and delivery/travel macros. It replaces
// the paused routine; it does not run another independent observation loop.
export async function runFleetParking(deps: ScriptRunnerDeps, policy: FleetParkingPolicy, deadlineMs: number,
  install: (runner: ScriptRunnerController) => void, now = Date.now): Promise<void> {
  const doc = parkingScript(policy);
  const location = locationOf(policy.destination);
  let last: ScriptObservation | null = null;
  let fatal: Error | null = null;
  let lastReadError: unknown = null;
  const deadline = () => {
    if (!Number.isFinite(deadlineMs) || now() >= deadlineMs) {
      fatal = new Error("Parking did not complete before the approved run deadline; pilot control is retained. Start a fresh approved run to recover.");
      throw fatal;
    }
  };
  const runner = createScriptRunner({ ...deps,
    observe: async hint => {
      deadline();
      let observed: ScriptObservation;
      try { observed = await deps.observe(hint); }
      catch (error) { lastReadError = error; throw error; }
      deadline();
      // Parking is a trusted, fixed finite program with no resource selectors.
      // Target assignment remains mandatory for the normal operation runner.
      last = { ...observed, miningOperation: null, miningOperationRequired: false,
        strictCorpDelivery: policy.corporationDivision !== null };
      if (policy.mode === "RETURN_HOME_UNLOAD_DOCK" && last.flightStatus?.docked && !readableFreight(last)) {
        lastReadError = new Error("Parking freight holds are unreadable; unload completion cannot be confirmed.");
        throw lastReadError;
      }
      lastReadError = null;
      return last;
    },
    issue: async action => {
      deadline();
      if (!["startRoute", "warp", "dock", "undock", "align", "approach", "stopShip", "recallDrones", "unloadOre"].includes(action.kind) ||
          (action.kind === "startRoute" && action.stationID !== location.id) ||
          (action.kind === "dock" && action.stationID !== location.id)) {
        throw new Error(`Parking refused an out-of-scope action: ${action.kind}`);
      }
      return deps.issue(action.kind === "unloadOre" && policy.corporationDivision !== null
        ? { ...action, strictCorp: true } : action);
    },
    isSessionLost: error => error === fatal || deps.isSessionLost(error),
    travelHome: () => ({ action: { kind: "wait" }, why: "Parking failed; no alternate destination is authorized.",
      phase: "Parking failed", armed: false, nextMem: {}, outcome: { kind: "blocked", reason: "Parking could not complete. Pilot control is retained." } }),
  });
  install(runner);
  runner.start(doc);
  await runner.run();
  const result = runner.snapshot();
  const observed = last as ScriptObservation | null;
  if (fatal) throw fatal;
  if (lastReadError) throw lastReadError;
  if (result.status !== "stopped" || result.pauseReason || !dockedAt(observed?.flightStatus, location) ||
      (policy.mode === "RETURN_HOME_UNLOAD_DOCK" && (observed === null || !readableFreight(observed) || freightHoldItemIDs(observed.holds ?? null).length > 0))) {
    throw new Error(result.pauseReason || `Parking arrival / freight delivery was not authoritatively confirmed (${result.status}: ${result.why}); pilot control is retained.`);
  }
}
