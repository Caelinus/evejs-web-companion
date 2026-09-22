// Effort without progress — the arithmetic behind §13 of docs/drone-boat-block-spec.md.
//
// The loop this module exists to close: the bot warps into a den it cannot beat,
// fights until a watch pulls it home, repairs PERFECTLY, comes back to the same
// den, and does it again until somebody notices. `MAX_RECOVER_TRIPS` looks like
// the cap that should catch it and cannot: `releaseRecoverTrips` drops the whole
// tally the moment the watched condition reads not-met, which is right for the
// case it was written for ("a trip that DOES help puts the cap back") and
// exactly wrong here. Every trip helps. The ship really is repaired each time.
// The thing that is broken is not the ship, it is the site — and a cap that
// watches the ship can only ever see a repair that FAILS.
//
// So this module keeps a different ledger. "Too hard" is not measurable —
// nothing on the wire rates a site's difficulty and a bot that guessed one would
// be inventing a number to obey — but SPENDING WITHOUT EARNING is, and it has
// two readable shapes:
//
//   1. Nothing is dying. The primary's health is not going down and no hostile
//      has left the grid, tick after tick, WHILE WE ARE APPLYING DAMAGE.
//   2. The same scan label keeps sending us home. Break off, recover, return,
//      break off again — counted per SITE, which is the count nobody keeps
//      today and the reason this module has to exist at all rather than being
//      a watch expression.
//
// ─── ⚠ THE STALL COUNTER MAY ONLY TICK WHILE DAMAGE IS ACTUALLY BEING APPLIED ─
//
// This is the single most important rule in the module and everything else here
// is arranged around it. The dangerous version of this feature blames the SITE
// for faults at OUR end: drones out of control range, drones never engaged,
// guns with nothing loaded, a hold at a distance the drones cannot work in.
// Every one of those produces "no damage" and NOT ONE of them means the site is
// unwinnable. The honest response to each is to fix the position or the fit.
//
// A stall counter that ticks through them does two kinds of damage at once: it
// throws away good anomalies the bot could have cleared, and it HIDES THE REAL
// BUG behind a plausible verdict — a pilot told "this den is too hard" never
// goes looking for the drones that were sitting 40 km out doing nothing. That is
// why `applying` is an input this module refuses to compute for itself: only the
// block knows whether its drones are engaged on the primary and whether the
// primary is inside drone control range, and a module that guessed would be
// guessing about the one thing that must not be guessed.
//
// ─── PROGRESS IS "HEALTH WENT DOWN AT ALL", NEVER "IT DIED" ──────────────────
//
// The test is not "is the primary dead yet" — a battlecruiser rat under a flight
// of light drones takes minutes, and a block that called that a stall would
// abandon every site that was merely slow. It is "did the health bar move down
// at all", measured against the LOWEST reading ever seen for that primary.
//
// The lowest, not the last, and the difference is a real rat behaviour: one that
// repairs itself pushes its health back UP between ticks, and comparing against
// the last reading would let it erase progress already made and then hand it
// back again, so a rat that out-repairs the drones forever would read as
// "progressing" forever. Against the lowest-ever reading it reads as exactly
// what it is — we are not getting anywhere — which is the verdict the free
// diagnostic in §13 then gets to EXPLAIN ("that one repairs itself faster than
// your drones hurt it") rather than contradict.
//
// A hostile leaving the grid is progress too, and it is the only progress
// available on a grid whose health rows will not read.
//
// ─── AN UNREADABLE READING IS NOT PROGRESS AND IS NOT A STALL ────────────────
//
// The tri-state rule of this codebase: unreadable never decides. A null health
// ratio is NO EVIDENCE — it must not reset the counter (that would make an
// unreadable grid look like a winning one) and it must not tick it (that would
// abandon a perfectly good den because the server stopped filling a field in).
// The counter simply does not move. Same for a null hostile count, and same for
// a null primary: with nothing identified there is nothing to have hurt.
//
// ─── WHERE THE LEDGER LIVES ──────────────────────────────────────────────────
//
// On the RUN BOARD, not in step memory. Step memory is wiped every time the step
// is left, so a per-visit budget hands every failing site a fresh allowance on
// every lap — this codebase has already paid for that lesson once (see the note
// above `MacroMemory`: 227 consecutive refusals in repeating bursts of five, for
// precisely that reason). "This site has been beating me" is the same shape as
// "this object has been refusing me" and belongs in the same place.
//
// The board is `Readonly<Record<string, number | string | null>>` — numbers and
// strings, nothing richer — so the ledger is encoded into flat keys by
// `encodeLedger` and read back by `decodeLedger`, with the per-site counts
// packed into one comma-joined string exactly the way `anomsVisited` already
// packs its label list. That precedent is followed rather than improved on: two
// different encodings of "a list of scan labels" on the same board is a thing
// somebody has to notice before they can read either one.
//
// This module is PURE. No store, no bridge, no loop, no clock — plain data in,
// plain data out, testable as arithmetic, which is what siteProgress.test.ts
// does. In particular there is no `Date.now()`: elapsed time is counted in TICKS
// the caller handed us, because a wall clock would keep running while the ship
// was docked and would make a repair trip look like an hour of failing to kill
// anything.

/**
 * How long the block's caller waits between ticks, in seconds.
 *
 * NAMED, NOT RELIED ON. The only thing this number does is convert `STALL_TICKS`
 * into the seconds the spec talks about and the sentence the player reads; no
 * decision in this module is made from it. If the runner's cadence ever changes,
 * the stall budget changes in wall-clock terms and nothing here breaks — which
 * is the right way round, because the counter is really counting ATTEMPTS TO
 * HURT SOMETHING and seconds are just how a human describes them.
 */
export const ASSUMED_TICK_SECONDS = 2;

/** The spec's budget in the units the spec states it in: about 40 s of applying
 *  damage without anything going down. */
const STALL_SECONDS = 40;

/**
 * How many APPLYING ticks without progress before the site is called a stall.
 *
 * ~40 s of drones actually on a target inside their control range. Long enough
 * that a cruiser rat's health bar moving slowly is never mistaken for a stall —
 * the test is "not going down AT ALL", not "not dead yet", so a slow kill resets
 * this on its very first tick of damage. Short enough to matter: the
 * `MAX_SILENT_STEP_TICKS` backstop is an hour and a half of a block emitting
 * NOTHING, which never fires for a fight that is issuing calls and getting
 * nowhere, and is not a verdict about the site in any case.
 *
 * ⚠ THESE ARE APPLYING TICKS, NOT ELAPSED TICKS. Forty seconds of a ship sitting
 * out of drone control range contributes ZERO to this number. See the header.
 */
export const STALL_TICKS = Math.round(STALL_SECONDS / ASSUMED_TICK_SECONDS);

/**
 * How many RETURNS to the same scan label before the site is abandoned: 2.
 *
 * Counted as visits, so the third arrival at a label is the second return and is
 * the one that gives up. Two returns rather than one because the first break-off
 * has a hundred innocent explanations — a wave that landed badly, a drone flight
 * lost, a watch that fired on a threshold the pilot set tight — and abandoning a
 * den over one of those throws away sites the bot can clear. By the third visit
 * the innocent explanations have stopped being likely.
 *
 * A constant and not a player setting, deliberately: a knob here asks the player
 * a question they have no way to answer, and every value they could pick is
 * worse than the block simply behaving.
 */
export const MAX_SITE_RETURNS = 2;

/**
 * How many labels the per-site count will carry on the board at once.
 *
 * The board string has to stay a sane length for a run that tours a region all
 * night. When the list is over the cap the OLDEST entries are dropped — but only
 * ones below the abandon threshold, because §13's other load-bearing warning is
 * that an abandoned label the run forgets is the same loop closing again with
 * extra steps. A site the bot has given up on is never evicted to make room.
 */
export const MAX_TRACKED_SITES = 32;

/**
 * How far the total health has to move before it counts as movement.
 *
 * Health here is three ratios added together, so it lives in [0, 3] and arrives
 * as floats off the wire. Without a dead band, ordinary shield regen jitter in
 * the seventh decimal reads as "health went down" on some tick or other and
 * resets the stall counter forever — the stall would then never fire and the
 * module would look like it worked. A thousandth of a layer is far below
 * anything a drone volley does and far above float noise.
 */
export const PROGRESS_EPSILON = 0.001;

/**
 * What the board looks like to this module.
 *
 * Structurally the `ScriptBoard` of nav/scriptDecide.ts, written out here rather
 * than imported so this module keeps no dependencies at all (kiteBand.ts has the
 * same property and for the same reason: a pure module that imports the runner
 * is a pure module somebody will eventually put a store in). If `ScriptBoard`
 * ever stops being "numbers and strings", `encodeLedger`'s return type stops
 * compiling at the call site, which is where the mismatch should be noticed.
 */
export type ProgressBoard = Readonly<Record<string, number | string | null>>;

/** One scan label and how many times the run has arrived at it. */
export interface SiteVisits {
  /** The scanner's label for the site, e.g. "QEE-288". */
  readonly label: string;
  /** Arrivals, not returns: the first visit is 1. Returns are `visits - 1`. */
  readonly visits: number;
}

/**
 * The record the caller carries from tick to tick and keeps on the run board.
 *
 * Small on purpose — six board keys — and every field is either a number, a
 * string or null so that `encodeLedger` is a flattening and not a serialisation
 * format with its own bugs.
 */
export interface SiteLedger {
  /** The label the live tracking below is about; null when the ship is not at a
   *  scanned site at all (rats on a belt, a gate camp, a mission pocket). */
  readonly siteLabel: string | null;
  /** The primary the health baseline belongs to. A different id means a
   *  different health bar and the baseline is worthless. */
  readonly primaryID: number | null;
  /** The LOWEST total health seen for `primaryID` — the thing progress is
   *  measured against. Null until a readable row arrives. */
  readonly bestHealth: number | null;
  /** Applying-without-progress ticks accumulated against the current primary. */
  readonly stallTicks: number;
  /** The last READABLE hostile count, so a hostile leaving the grid can be
   *  seen. Null until one arrives; an unreadable count never overwrites it with
   *  a guess. */
  readonly hostiles: number | null;
  /** Per-site arrival counts, in first-seen order. Survives everything: a new
   *  primary, a new site, a repair trip, a lap restart. */
  readonly sites: readonly SiteVisits[];
}

/** What the block saw this tick. Every field may be unreadable except the two
 *  the block itself decides. */
export interface ProgressEvidence {
  /**
   * ⚠ IS THE BLOCK APPLYING DAMAGE RIGHT NOW? Drones engaged on the primary AND
   * the primary inside drone control range (or, for a gun boat, guns loaded and
   * the target in range). The block computes this; this module will not, and a
   * caller that passes `true` here out of optimism has re-armed the bug this
   * whole file exists to fix. When in doubt the answer is `false`: a stall that
   * never fires costs an hour of the player's evening, and a stall that fires on
   * our own bad positioning costs them the anomaly AND the diagnosis.
   */
  readonly applying: boolean;
  /** The primary's item id, or null when nothing is targeted or the row would
   *  not read. */
  readonly primaryID: number | null;
  /** Shield / armour / hull as ratios in [0, 1]; any of them may be null. */
  readonly primaryShieldRatio: number | null;
  readonly primaryArmorRatio: number | null;
  readonly primaryHullRatio: number | null;
  /** Hostiles on grid, or null when the grid would not read. */
  readonly hostileCount: number | null;
  /** The site's scan label, or null when the ship is not at a scanned site. */
  readonly siteLabel: string | null;
}

/**
 * What the block should do about the site, in one closed set.
 *
 * `"stalled"` and `"give-up"` are BOTH "leave this den and mark the label" —
 * `abandon` is true for both — and they are deliberately two words because they
 * are two different sentences to the player. "Nothing here was dying and I had
 * been at it a minute" and "that is the third time this den has sent me home"
 * are things a player can act on differently, and a generic "site too hard"
 * teaches them nothing.
 *
 * `"watching"` is the ordinary fighting tick: we are applying, nothing has gone
 * down yet, the budget is not spent. `"no-evidence"` is every tick this module
 * refuses to draw a conclusion from — not applying, or nothing readable.
 */
export type SiteVerdictState =
  | "progressing"
  | "watching"
  | "no-evidence"
  | "stalled"
  | "give-up";

/** Every state, for callers that want to switch exhaustively and for the fuzz
 *  test's "is this a verdict anybody can act on?" check. */
export const SITE_VERDICT_STATES: readonly SiteVerdictState[] = Object.freeze([
  "progressing",
  "watching",
  "no-evidence",
  "stalled",
  "give-up",
]);

/**
 * Which piece of evidence decided the state — the thing §13 insists the readout
 * must be able to name.
 *
 * `"hurt-it"` / `"killed-one"` are the two ways progress is seen, and they are
 * separate because the second one is the only evidence available on a grid whose
 * health rows do not read.
 */
export type SiteVerdictCause =
  | "hurt-it"
  | "killed-one"
  | "new-primary"
  | "not-applying"
  | "unreadable"
  | "applying"
  | "nothing-dying"
  | "keeps-sending-me-home";

export interface SiteVerdict {
  /** Carry this to the next tick and write it to the board. */
  readonly ledger: SiteLedger;
  readonly state: SiteVerdictState;
  readonly cause: SiteVerdictCause;
  /** True for `"stalled"` and `"give-up"`: stop working this label. */
  readonly abandon: boolean;
  /** The stall counter as it now stands — for the readout, and so a block can
   *  show "I have been at this for 20 s" before the verdict lands. */
  readonly appliedTicks: number;
  /** The label this verdict is about, null when there is no scanned site. */
  readonly siteLabel: string | null;
  /** Arrivals at `siteLabel` including this one; 0 when there is no label. */
  readonly visits: number;
}

// ─── READING UNTRUSTED NUMBERS ───────────────────────────────────────────────
//
// Everything below arrives either off a live snapshot (where a missing attribute
// can be undefined, a string, or a negative left over from a signed field) or
// off a board that was persisted by an older build. Nothing is trusted to be the
// type it is declared as, because the one output that must never happen is a NaN
// counter: NaN compares false against every threshold, so a NaN stall counter is
// a stall that can never fire and a bot that loops forever with the fix
// installed and silent.

/** A ratio we are willing to do arithmetic on, or null. Out-of-range values are
 *  clamped rather than dropped: a server row reading 1.02 is a full shield, not
 *  an unreadable one. */
function ratio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** A counter read back off the board: a finite, non-negative integer or 0. */
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

/** A grid population, or null when it would not read. Unlike `count` this one
 *  keeps the difference between "zero hostiles" and "we could not tell". */
function population(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  return Math.floor(value);
}

/** A total-health reading read back off the board: the sum of three ratios, so
 *  it lives in [0, 3]. Anything else is null — an unreadable baseline is simply
 *  a baseline the next readable tick will set. */
function health(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 3) return 3;
  return value;
}

/** An item id, or null. Ids are compared for identity only, never ordered, so
 *  any finite number will do. */
function identity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * A scan label this module is willing to remember.
 *
 * ⚠ THE SEPARATORS ARE NOT ALLOWED INSIDE A LABEL. The per-site counts are
 * packed as `label:visits` joined with commas, so a label carrying a comma or a
 * colon would decode as two entries and put one site's count on another site's
 * name — and a wrong count is worse than no count, because it abandons a den
 * nobody has fought at. A label we cannot encode is therefore a label we do not
 * track: the site keeps today's behaviour (no per-site cap, the stall counter
 * still works normally) instead of getting somebody else's verdict. Real scanner
 * labels are of the shape "QEE-288" and this has never been seen to fire; it is
 * here because the alternative failure is silent.
 */
function usableLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length === 0) return null;
  if (label.includes(",") || label.includes(":")) return null;
  return label;
}

/**
 * The primary's total health as one number, or null if ANY layer is unreadable.
 *
 * ⚠ ALL THREE OR NOTHING, and the reason is a false progress reading rather than
 * fussiness. Summing whichever layers happen to be readable means the quantity
 * being compared changes shape between ticks: a tick that reports 1.0 + 1.0 +
 * 1.0 followed by one that reports 1.0 + 1.0 (shield row missing) is a full-
 * health rat that appears to have lost a third of itself, and the stall counter
 * resets on damage nobody did. Refusing the mixed reading costs nothing, because
 * an unreadable tick is no evidence in either direction and the counter simply
 * waits.
 */
function totalHealth(evidence: ProgressEvidence): number | null {
  const shield = ratio(evidence?.primaryShieldRatio);
  const armor = ratio(evidence?.primaryArmorRatio);
  const hull = ratio(evidence?.primaryHullRatio);
  if (shield === null || armor === null || hull === null) return null;
  return shield + armor + hull;
}

// ─── THE LEDGER ──────────────────────────────────────────────────────────────

/** A ledger that has seen nothing — the first tick of a run. */
export function emptyLedger(): SiteLedger {
  return {
    siteLabel: null,
    primaryID: null,
    bestHealth: null,
    stallTicks: 0,
    hostiles: null,
    sites: [],
  };
}

/** Arrivals at `label` so far; 0 for a label never visited or not trackable. */
export function visitsTo(ledger: SiteLedger, label: string | null): number {
  const wanted = usableLabel(label);
  if (wanted === null) return 0;
  for (const row of ledger?.sites ?? []) {
    if (row?.label === wanted) return count(row.visits);
  }
  return 0;
}

/** Has this label spent its budget of returns? The question `warp-to-anomaly`
 *  will be asking, once a later parcel wires it up. */
export function isAbandoned(ledger: SiteLedger, label: string | null): boolean {
  const visits = visitsTo(ledger, label);
  return visits > 0 && visits - 1 >= MAX_SITE_RETURNS;
}

/** Every label the run has given up on, for the readout and for the tour. */
export function abandonedLabels(ledger: SiteLedger): readonly string[] {
  const out: string[] = [];
  for (const row of ledger?.sites ?? []) {
    const label = usableLabel(row?.label);
    if (label !== null && count(row.visits) - 1 >= MAX_SITE_RETURNS) out.push(label);
  }
  return out;
}

/**
 * Trim the per-site list to `MAX_TRACKED_SITES`, oldest first — but NEVER an
 * abandoned one. See `MAX_TRACKED_SITES`: forgetting a site the bot has given up
 * on re-opens the loop this module closes, so the cap gives way before the
 * verdict does and a run that somehow tours 32 abandoned dens carries all 32.
 */
function trimSites(sites: readonly SiteVisits[]): readonly SiteVisits[] {
  if (sites.length <= MAX_TRACKED_SITES) return sites;
  const keep: SiteVisits[] = [];
  let droppable = sites.length - MAX_TRACKED_SITES;
  for (const row of sites) {
    if (droppable > 0 && row.visits - 1 < MAX_SITE_RETURNS) {
      droppable -= 1;
      continue;
    }
    keep.push(row);
  }
  return keep;
}

/**
 * Count one arrival at a site and start the per-primary tracking over.
 *
 * ⚠ CALL THIS ONCE PER VISIT, from the first tick of the combat step — step
 * memory is exactly the right place to keep the "already counted" flag, because
 * it is wiped when the step is left and a fresh step IS a fresh visit. It is a
 * separate call rather than something `observeTick` infers from the label
 * changing, because a tick stream genuinely cannot tell "we flew home, repaired
 * and came back" from "the same site, one tick later": the block stops ticking
 * while the recover watch has the ship, so the label never changes underneath us
 * and an inferring version would count zero returns for the exact loop it was
 * written to catch.
 *
 * Counting an arrival resets the stall counter and the health baseline (a new
 * visit is a new fight against a new wave) and leaves every per-site count
 * alone, including this site's own.
 */
export function enterSite(ledger: SiteLedger, label: string | null): SiteLedger {
  const base = ledger ?? emptyLedger();
  const wanted = usableLabel(label);
  const fresh: SiteLedger = {
    ...base,
    siteLabel: wanted,
    primaryID: null,
    bestHealth: null,
    stallTicks: 0,
    hostiles: null,
    sites: base.sites ?? [],
  };
  if (wanted === null) return fresh;
  let seen = false;
  const sites = (base.sites ?? []).map((row) => {
    if (row?.label !== wanted) return { label: row.label, visits: count(row.visits) };
    seen = true;
    return { label: wanted, visits: count(row.visits) + 1 };
  });
  if (!seen) sites.push({ label: wanted, visits: 1 });
  return { ...fresh, sites: trimSites(sites) };
}

/**
 * A visit that ENDED IN SUCCESS: drop everything the ledger was holding against
 * this label.
 *
 * ⚠ THE COUNT IS CONSECUTIVE BAD VISITS, NOT ARRIVALS, AND THE DIFFERENCE IS THE
 * WHOLE FEATURE. §13's words for what is being counted are "the same site keeps
 * SENDING US HOME" — and arrivals and send-homes differ in exactly one case,
 * which happens to be the case a working bot spends all of its time in: a visit
 * that ended with the den CLEARED. Counting arrivals retires a den the bot is
 * successfully farming after two clears, which is a bot that stops working for
 * the mirror image of the reason the unfixed bug makes a bot never stop.
 *
 * Arriving somewhere for the third time is not evidence of anything. Being
 * driven off it for the third time IN A ROW is. So a clear zeroes the tally and
 * the next visit starts from one. `enterSite` above is the other half of the
 * pair: one counts the arrival, this one forgives it.
 *
 * ⚠ DO NOT REST THIS ON "a cleared anomaly despawns and comes back under a new
 * label". That is retail behaviour; this is an emulator whose anomaly respawn is
 * its own code and nobody in this tree has verified it. The correctness of a
 * ratting bot not quietly retiring the only den in its system must not depend on
 * a respawn detail — so the ledger is made to say the right thing directly.
 *
 * The per-primary tracking goes with it (baseline, stall counter, grid count): a
 * cleared grid ends the visit clean, and carrying a spent stall counter out of a
 * fight that was WON is how the next fight — a belt spawn with no scan label to
 * reset it, say — would inherit a verdict it never earned.
 *
 * ⚠ IT IS A RULE, AND A SECOND COPY OF A RULE IS A SECOND ANSWER. This lived
 * twice — private to `fight-the-rats` in `nav/scriptMacros.ts`, and copied into
 * `nav/droneBoatLadder.ts` — and those two blocks fight the same rats over the
 * same ledger. One of them counting arrivals while the other counted send-homes
 * gives the player two bots that disagree about which dens are worth flying to,
 * with nothing in either readout admitting it. It lives here because it is one
 * row leaving a `SiteLedger`, and `SiteLedger` is this module's.
 */
export function forgetSite(ledger: SiteLedger, label: string | null): SiteLedger {
  const sites = label === null ? ledger.sites : ledger.sites.filter((row) => row.label !== label);
  return {
    ...ledger,
    primaryID: null,
    bestHealth: null,
    stallTicks: 0,
    hostiles: null,
    sites,
  };
}

/**
 * One tick of evidence in, a verdict and the next ledger out.
 *
 * The order of the tests below is the whole module, so it is worth reading as
 * prose:
 *
 *   1. A DIFFERENT SITE than the ledger is tracking wipes the per-primary
 *      tracking (its baseline belongs to another grid) and adopts the new label.
 *      It does NOT count an arrival — that is `enterSite`'s job and doing it in
 *      both places would double every count.
 *   2. A DIFFERENT PRIMARY resets the stall counter: we are hurting something
 *      else now and the old count says nothing about the new one. It does NOT
 *      touch the per-site counts, which are about the site and outlive every
 *      target switch, every wave and every trip home.
 *   3. PROGRESS — health below the lowest ever seen, or a hostile gone from the
 *      grid — resets the counter, whether or not we were applying. Progress is
 *      progress no matter who caused it.
 *   4. NOT APPLYING leaves the counter exactly where it is. The one rule.
 *   5. AN UNREADABLE HEALTH ROW leaves it where it is too: no evidence.
 *   6. Otherwise the counter ticks, and at `STALL_TICKS` the site is called.
 *
 * The per-site cap is checked last and overrides everything: a label that has
 * already spent its returns is a "give-up" on every tick, however well the
 * current fight happens to be going, because the verdict is about the tour and
 * not about this minute.
 */
export function observeTick(
  ledger: SiteLedger,
  evidence: ProgressEvidence,
): SiteVerdict {
  const base = ledger ?? emptyLedger();
  const sites = base.sites ?? [];
  const label = usableLabel(evidence?.siteLabel);
  const sameSite = label === usableLabel(base.siteLabel);

  // (1) A different grid — nothing carried about the primary means anything.
  // The evidence's label is authoritative for this tick, INCLUDING when it is
  // null: a block ratting a belt passes null every tick and tracks perfectly
  // well, and a block whose label read fails once loses its stall counter. That
  // is the safe direction to be wrong in and the module's standing bias — a
  // stall that fires late costs the player some minutes, a stall that fires on
  // evidence belonging to a different grid costs them the anomaly and hides
  // whatever really went wrong.
  const carried: SiteLedger = sameSite
    ? { ...base, sites }
    : { ...base, siteLabel: label, primaryID: null, bestHealth: null, stallTicks: 0, hostiles: null, sites };

  const primaryID = identity(evidence?.primaryID);
  const health = primaryID === null ? null : totalHealth(evidence);
  const hostiles = population(evidence?.hostileCount);

  // (2) A different primary. Note the null case is NOT a primary change: a tick
  // with nothing targeted is a gap in the evidence (the rat died, the lock
  // dropped, the row did not read), and wiping the baseline on it would let a
  // single blank tick between two readings of the same rat launder a repaired
  // health bar into a fresh "best". The baseline is kept and the tick simply
  // provides nothing.
  const newPrimary = primaryID !== null && carried.primaryID !== null && primaryID !== carried.primaryID;
  const trackingID = primaryID ?? carried.primaryID;
  const baseline = newPrimary ? null : carried.bestHealth;
  let stallTicks = newPrimary ? 0 : count(carried.stallTicks);

  // (3) Progress, in its two shapes.
  const hurtIt = health !== null && baseline !== null && health < baseline - PROGRESS_EPSILON;
  // A hostile LEAVING is progress; a fresh wave landing is not a stall, it just
  // moves the baseline. Both are handled by taking the new count either way.
  const killedOne = hostiles !== null && carried.hostiles !== null && hostiles < carried.hostiles;
  const progress = hurtIt || killedOne;

  // The best (lowest) health ever seen for this primary. ⚠ LOWEST, NOT LAST: a
  // rat that repairs itself must not be able to hand back progress it already
  // gave up, or it reads as a winnable fight forever. Kept even across ticks
  // where we are not applying, because the reading is a fact about the rat and
  // not a claim about us.
  const bestHealth =
    health === null ? baseline : baseline === null ? health : Math.min(baseline, health);

  const applying = evidence?.applying === true;
  let state: SiteVerdictState;
  let cause: SiteVerdictCause;
  if (progress) {
    stallTicks = 0;
    state = "progressing";
    cause = hurtIt ? "hurt-it" : "killed-one";
  } else if (newPrimary) {
    // Already reset above; say so rather than reporting it as a stall-free tick,
    // because "I switched targets" is a different sentence from "I am winning".
    state = "watching";
    cause = "new-primary";
  } else if (!applying) {
    // ⚠ (4) THE RULE. Drones out of range, drones never launched, guns empty, a
    // hold the drones cannot work from — all of it lands here, and none of it is
    // evidence about the site. The counter does not move.
    state = "no-evidence";
    cause = "not-applying";
  } else if (health === null) {
    // (5) Applying, but the health row will not read. Not progress, not a stall.
    state = "no-evidence";
    cause = "unreadable";
  } else {
    // (6) Applying, readable, and nothing went down. Capped at the budget rather
    // than counted forever: past the verdict the number has no further meaning,
    // the block is leaving, and an uncapped counter is one that reads "I have
    // been at this for 4000 seconds" in the readout if a caller keeps ticking
    // after the answer arrived.
    stallTicks = Math.min(stallTicks + 1, STALL_TICKS);
    state = "watching";
    cause = "applying";
  }

  // ⚠ ONCE THE BUDGET IS SPENT THE VERDICT STICKS until something actually goes
  // down. Deciding it only on the tick that spent the last one would make the
  // answer depend on which tick the caller happened to ask on: the very next
  // tick with the drones off target reports "no evidence", `abandon` goes false,
  // and a block that polls this every tick flip-flops between leaving and
  // staying — which is a bot that neither fights nor leaves. Progress is the
  // only thing that clears it, because progress is the only thing that means
  // the site is winnable after all.
  if (!progress && stallTicks >= STALL_TICKS) {
    state = "stalled";
    cause = "nothing-dying";
  }

  const next: SiteLedger = {
    siteLabel: carried.siteLabel,
    primaryID: trackingID,
    bestHealth,
    stallTicks,
    // An unreadable population never overwrites the last readable one: the next
    // readable tick should be compared against the last real count, not against
    // a gap.
    hostiles: hostiles ?? carried.hostiles,
    sites: carried.sites,
  };

  const visits = visitsTo(next, label);
  // The tour's verdict outranks this minute's. A site that has already sent the
  // bot home its allowance of times is finished even if the current wave is
  // dying nicely — the whole point is not coming back, and "it is going well
  // right now" is what it looked like the previous two times as well.
  if (visits > 0 && visits - 1 >= MAX_SITE_RETURNS) {
    return {
      ledger: next,
      state: "give-up",
      cause: "keeps-sending-me-home",
      abandon: true,
      appliedTicks: stallTicks,
      siteLabel: label,
      visits,
    };
  }

  return {
    ledger: next,
    state,
    cause,
    abandon: state === "stalled",
    appliedTicks: stallTicks,
    siteLabel: label,
    visits,
  };
}

// ─── THE BOARD ───────────────────────────────────────────────────────────────

/**
 * The board keys this module owns.
 *
 * Flat camelCase like everything else on the board (`anomsVisited`, `agentID`),
 * one shared prefix so every key is greppable from any of them, and exported so
 * a caller never spells one by hand — a typo in a board key is a ledger that
 * resets itself every tick and a bug that looks exactly like "the feature does
 * not work".
 */
export const LEDGER_KEYS = Object.freeze({
  label: "siteProgressLabel",
  primary: "siteProgressPrimary",
  best: "siteProgressBest",
  stall: "siteProgressStall",
  hostiles: "siteProgressHostiles",
  sites: "siteProgressSites",
});

/**
 * Flatten the ledger into board values.
 *
 * The per-site counts are packed as `label:visits` pairs joined with commas —
 * "QEE-288:3,ABC-123:1" — which is the `anomsVisited` encoding with a count
 * bolted on, chosen because it is the one a reader of this board already knows.
 * Everything else is a number or a string already and is stored as itself.
 *
 * The result is a PATCH, carrying every key this module owns on every call,
 * including the nulls: a partial patch would leave last site's primary id on the
 * board next to this site's baseline, and a stale id that happens to match is
 * the kind of bug that reproduces once a week.
 */
export function encodeLedger(ledger: SiteLedger): Record<string, number | string | null> {
  const base = ledger ?? emptyLedger();
  const packed = (base.sites ?? [])
    .map((row) => {
      const label = usableLabel(row?.label);
      return label === null ? null : `${label}:${count(row.visits)}`;
    })
    .filter((row): row is string => row !== null)
    .join(",");
  return {
    [LEDGER_KEYS.label]: usableLabel(base.siteLabel),
    [LEDGER_KEYS.primary]: identity(base.primaryID),
    [LEDGER_KEYS.best]: health(base.bestHealth),
    [LEDGER_KEYS.stall]: count(base.stallTicks),
    [LEDGER_KEYS.hostiles]: population(base.hostiles),
    [LEDGER_KEYS.sites]: packed,
  };
}

/**
 * Read the ledger back off the board.
 *
 * ⚠ EVERY VALUE HERE IS UNTRUSTED. The board outlives the code: it is persisted
 * with the run, so a value written by an older build (or by a hand-edited saved
 * run) arrives as whatever it arrives as. A missing key, a string where a number
 * was, a `sites` entry with no colon — each of them yields the empty answer for
 * that field rather than a NaN that would quietly disable the stall counter for
 * the rest of the night. A board with nothing of ours on it decodes to
 * `emptyLedger()`, which is what the first tick of a run needs anyway.
 */
export function decodeLedger(board: ProgressBoard | null | undefined): SiteLedger {
  const row = board ?? {};
  const sites: SiteVisits[] = [];
  const packed = row[LEDGER_KEYS.sites];
  if (typeof packed === "string") {
    for (const entry of packed.split(",")) {
      if (entry.length === 0) continue;
      const cut = entry.lastIndexOf(":");
      if (cut <= 0) continue;
      const label = usableLabel(entry.slice(0, cut));
      const visits = count(Number(entry.slice(cut + 1)));
      // A zero or unparseable count is not a visit anybody made; dropping the
      // row is closer to the truth than recording an arrival that did not happen.
      if (label === null || visits <= 0) continue;
      if (sites.some((seen) => seen.label === label)) continue;
      sites.push({ label, visits });
    }
  }
  return {
    siteLabel: usableLabel(row[LEDGER_KEYS.label]),
    primaryID: identity(row[LEDGER_KEYS.primary]),
    bestHealth: health(row[LEDGER_KEYS.best]),
    stallTicks: count(row[LEDGER_KEYS.stall]),
    hostiles: population(row[LEDGER_KEYS.hostiles]),
    sites: trimSites(sites),
  };
}

// ─── WORDS ───────────────────────────────────────────────────────────────────

const ORDINALS: readonly string[] = ["", "first", "second", "third", "fourth", "fifth"];

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}

/**
 * The player's sentence for a verdict that ends the visit, or null for one that
 * does not.
 *
 * §13 is explicit that the readout must name WHICH evidence fired: "Nothing here
 * was dying and I had been at it a minute, so I am leaving this den" reads
 * differently from "that is the third time this den has sent me home", and the
 * player can act on the difference. A generic "site too hard" teaches them
 * nothing and — worse — reads as the bot's opinion rather than as something it
 * counted.
 *
 * The block is expected to APPEND to this, not replace it: the free diagnostic
 * of §13 (the primary's dogma says it repairs itself) explains a verdict already
 * reached here, and needs a dogma row this module deliberately does not take.
 */
export function describeVerdict(verdict: SiteVerdict, noun = "den"): string | null {
  if (verdict === null || verdict === undefined) return null;
  const where = verdict.siteLabel === null ? `this ${noun}` : verdict.siteLabel;
  if (verdict.state === "give-up") {
    return `That is the ${ordinal(verdict.visits)} time I have come back to ${where}, so I am giving up on it rather than touring it again.`;
  }
  if (verdict.state === "stalled") {
    // Seconds, not ticks, because ticks are our word and not the player's — and
    // it is the APPLYING time, which is the honest number: the visit may have
    // lasted far longer than this while the drones were flying back.
    const seconds = Math.round(verdict.appliedTicks * ASSUMED_TICK_SECONDS);
    return `Nothing here was dying and my drones had been on it for ${seconds} seconds, so I am leaving ${where}.`;
  }
  return null;
}
