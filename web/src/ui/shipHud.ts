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

/**
 * The SHORT state word for the HUD header — ORBIT, WARP, STOP.
 *
 * ⚠ IT IS THE SERVER'S OWN WORD, UPPERCASED, and unknown modes pass straight
 * through rather than being mapped to something friendlier. The header is a
 * glance, and a mode this client has never seen is still a real thing the ship
 * is doing: printing it verbatim is worse-looking and more truthful than
 * printing "—" over a hull that is clearly moving.
 *
 * `null` is the only case with nothing to say.
 */
export function shipModeLabel(mode: string | null | undefined): string | null {
  const trimmed = (mode ?? "").trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

/** True when the ship is stopped — the header word goes quiet rather than blue. */
export function shipIsStopped(mode: string | null | undefined): boolean {
  return /^stop(ped)?$/i.test((mode ?? "").trim());
}

/**
 * The footer sentence, with the thing it is doing it TO when the server says so.
 *
 * ⚠ THE TARGET HALF IS CONDITIONAL BECAUSE THE READING IS. The design asks for
 * "Orbiting Caldari Sentry Gun I at 5 km"; the ship's own row carries
 * `targetEntityID`, and on this server it is null — so there is nothing to name.
 *
 * ⚠ AND IT IS NOT GUESSED FROM WHAT THIS CLIENT LAST ORDERED. The panel knows
 * which row it sent an orbit to, and using that would be wrong the moment a bot,
 * another client or a previous session set the course — which is most of the
 * time this app is running. A sentence assembled from a stale local memory is
 * indistinguishable, to a player, from one the ship reported.
 */
/**
 * How each state names the thing it is acting ON, by the same key
 * `shipStateSentence` switches on.
 *
 * ⚠ A STATE THAT IS ABSENT HERE TAKES NO OBJECT, AND THAT IS THE POINT.
 *
 * FOUND ON SCREEN. This used to strip the full stop off whatever
 * `shipStateSentence` returned and staple the target onto the end of it,
 * whatever the sentence was. A stopped ship still has a `targetEntityID` from
 * whatever it was last doing, so the header read
 *
 *     "Engines stopped Caldari Sentry Gun II at 1.3 km"
 *
 * which is not a sentence, and worse, reads as though the ship had stopped the
 * gun. "In warp" had the same shape. Only the states that genuinely act on
 * something name it, and each names it with the preposition that state actually
 * takes -- "Holding range on X", not "Holding range X".
 */
const OBJECT_PHRASE: Readonly<Record<string, string>> = {
  orbit: "Orbiting",
  orbiting: "Orbiting",
  approach: "Approaching",
  approaching: "Approaching",
  align: "Aligning to",
  aligning: "Aligning to",
  keepatrange: "Holding range on",
  dock: "Docking at",
  docking: "Docking at",
  jump: "Jumping to",
  jumping: "Jumping to",
  warp: "In warp to",
  warping: "In warp to",
};

export function shipStateSentenceFor(
  ship: {
    readonly mode: string | null;
    readonly velocity: { readonly x: number; readonly y: number; readonly z: number } | null;
  } | null,
  /** What the ship is acting on, already NAMED by the caller, or null. */
  targetName: string | null,
  /** Metres to it, or null when it cannot be measured. */
  targetMetres: number | null,
  formatDistance: (metres: number) => string,
): string {
  const base = shipStateSentence(ship);
  if (targetName === null) {
    return base;
  }
  const key = (ship?.mode ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const phrase = OBJECT_PHRASE[key];
  if (phrase === undefined) {
    // Stopped, drifting, or a mode this build has never heard of. The target is
    // real but this state does not act on it, so the sentence says only what it
    // knows -- which is the same rule the rest of this file follows.
    return base;
  }
  const at = targetMetres === null ? "" : ` at ${formatDistance(targetMetres)}`;
  // "Orbiting." -> "Orbiting Caldari Sentry Gun I at 5 km"
  return `${phrase} ${targetName}${at}`;
}
