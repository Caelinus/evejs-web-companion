// The in-space ship readout: EVE's capacitor + shield/armor/hull. Pure model so
// the segment maths + the gauge list are unit-testable. The capacitor is EVE's
// discrete wheel — a count of filled segments, not a smooth bar; shield/armor/
// hull stay proportional bars. Ratios come straight from the live snapshot; null
// (no reading yet) is preserved, never coerced to a value.

export interface ResourceGauge {
  readonly key: "shield" | "armor" | "hull";
  readonly label: string;
  readonly ratio: number | null;
}

/** Shield / armor / hull, in EVE's outer-to-inner order. */
export function resourceGauges(
  ship: { shieldRatio: number | null; armorRatio: number | null; hullRatio: number | null } | null,
): readonly ResourceGauge[] {
  return [
    { key: "shield", label: "Shield", ratio: ship?.shieldRatio ?? null },
    { key: "armor", label: "Armor", ratio: ship?.armorRatio ?? null },
    { key: "hull", label: "Hull", ratio: ship?.hullRatio ?? null },
  ];
}

/**
 * How many of `count` capacitor segments are filled at this charge. A null ratio
 * (no reading) is zero filled; a ratio is clamped to [0,1] then rounded to the
 * nearest segment, so a nearly-empty cap never shows a stray lit segment and a
 * full one lights them all.
 */
export function capacitorSegments(ratio: number | null, count: number): number {
  if (ratio == null || count <= 0) return 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * count);
}

/**
 * The one sentence the HUD footer says about what the ship is DOING — the
 * companion to the gauges, which say what condition it is in.
 *
 * ⚠ "NOT KNOWN" IS A REAL ANSWER HERE. Before the first space poll lands there
 * is no ship object at all, and a footer that said "Engines stopped." in that
 * gap would be inventing the calmest possible lie about a ship that might be in
 * warp. The sentence for "we have not been told" is its own sentence.
 *
 * ⚠ AND AN UNRECOGNISED MODE IS NOT A BUG TO HIDE. The server's vocabulary is
 * its own and can grow; a mode this table has never seen falls back to what the
 * VELOCITY says, which is a fact we hold independently, rather than to silence.
 */
export function shipStateSentence(
  ship: {
    readonly mode: string | null;
    readonly velocity: { readonly x: number; readonly y: number; readonly z: number } | null;
  } | null,
): string {
  if (!ship) {
    return "Your ship's state is not known yet.";
  }
  const key = (ship.mode ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const known: Readonly<Record<string, string>> = {
    stop: "Engines stopped.",
    stopped: "Engines stopped.",
    warp: "In warp.",
    warping: "In warp.",
    orbit: "Orbiting.",
    orbiting: "Orbiting.",
    approach: "Approaching.",
    approaching: "Approaching.",
    align: "Aligning.",
    aligning: "Aligning.",
    keepatrange: "Holding range.",
    dock: "Docking.",
    docking: "Docking.",
    jump: "Jumping.",
    jumping: "Jumping.",
  };
  if (key in known) {
    return known[key] as string;
  }
  const velocity = ship.velocity;
  if (!velocity) {
    return "Your ship's state is not known yet.";
  }
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (!Number.isFinite(speed)) {
    return "Your ship's state is not known yet.";
  }
  return speed > 0 ? "Under way." : "Holding position.";
}
