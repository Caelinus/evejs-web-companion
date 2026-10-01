/** A settled self-mining handoff must remain visible to the operation owner.
 * Emergency Stop starts only after all local service/custody settlement. */
export function latchSupportEmergency(previous: boolean, stopReason: string | null, health: number | null): boolean {
  return previous || stopReason === "emergency-health-floor" || health !== null && Number.isFinite(health) && health < 0.25;
}
export function supportHandoff(stopReason: string | null, selfSettled: boolean, localSettled: boolean): {
  phase: "BLOCKED" | "DEGRADED"; reason: string; requestEmergencyStop: boolean;
} | null {
  if (!stopReason) return null;
  const emergency = stopReason === "emergency-health-floor";
  return { phase: emergency ? "BLOCKED" : "DEGRADED", reason: `Support self-mining handoff: ${stopReason}`,
    requestEmergencyStop: emergency && selfSettled && localSettled };
}
