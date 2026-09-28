// What KIND of thing a scanned site is — ore, gas, relic, data, combat, or a
// wormhole. The Probe Scanner's own "Group" column, computed from the same
// field the client computes it from, so a bot can tell an asteroid cluster from
// a pirate den before it warps.
//
// ── Where the numbers come from ──────────────────────────────────────────────
// Every anomaly row the signal tracker sends carries `scanStrengthAttribute` —
// the dogma attribute id the site is scanned WITH. The client maps exactly that
// field to the group label it prints (probescanning/explorationSites.py):
//
//   211  gravimetric   → Ore Site
//   209  ladar         → Gas Site
//   210  magnetometric → Relic Site
//   208  radar         → Data Site
//   1136 all           → Combat Site
//   1908 wormhole      → Wormhole
//
// so this module is a re-implementation of the client's own grouping and not a
// guess about what a site "looks like". A site's NAME is never consulted: the
// name is a localization id the server picks from a fixed table, and several
// families deliberately reuse each other's names.
//
// ⚠ THE ATTRIBUTE CAN BE ABSENT. A site whose family the server's exploration
// authority does not know resolves the attribute to 0, which reaches the wire
// as null — a real, observed case (it is what the moon-ore anomaly mod exists
// to patch around). So `unknown` is a first-class answer here and callers must
// decide what to do with it; treating a null as "combat" would fly a mining bot
// into a den, and treating it as "ore" would fly a ratter into a rock field.
//
// `archetypeID` is a SECOND, independent hint the same row carries, used only
// when the attribute is missing: the ore/ice/gas archetypes are unambiguous
// (eve/common/lib/appConst.py), so a row that lost its attribute can still be
// classified rather than being written off as unknown.

/** The scan-strength dogma attribute each exploration family is scanned with. */
export const SCAN_STRENGTH_ORE = 211;
export const SCAN_STRENGTH_GAS = 209;
export const SCAN_STRENGTH_RELIC = 210;
export const SCAN_STRENGTH_DATA = 208;
export const SCAN_STRENGTH_COMBAT = 1136;
export const SCAN_STRENGTH_WORMHOLE = 1908;

/** Dungeon archetypes that name a site's kind on their own. */
const ARCHETYPE_ORE_ANOMALY = 27;
const ARCHETYPE_ICE_BELT = 28;
const ARCHETYPE_GAS_CLOUDS = 30;
const ARCHETYPE_COMBAT_SITES = 24;
const ARCHETYPE_WORMHOLE = 38;
const ARCHETYPE_RELIC_SITES = 44;
const ARCHETYPE_DATA_SITES = 45;

/**
 * A site's group. `unknown` means the row said nothing this module trusts — not
 * that the site is uninteresting.
 */
export type ExplorationSiteKind =
  | "ore"
  | "gas"
  | "relic"
  | "data"
  | "combat"
  | "wormhole"
  | "unknown";

/** Every kind, for exhaustive iteration in menus and tests. */
export const EXPLORATION_SITE_KINDS: readonly ExplorationSiteKind[] = Object.freeze<
  ExplorationSiteKind[]
>(["ore", "gas", "relic", "data", "combat", "wormhole", "unknown"]);

/** Play-language names — what the block catalog and the scanner panel print. */
export const SITE_KIND_LABELS: Readonly<Record<ExplorationSiteKind, string>> = Object.freeze({
  ore: "Ore site",
  gas: "Gas site",
  relic: "Relic site",
  data: "Data site",
  combat: "Combat site",
  wormhole: "Wormhole",
  unknown: "Unknown site",
});

const BY_SCAN_STRENGTH: Readonly<Record<number, ExplorationSiteKind>> = Object.freeze({
  [SCAN_STRENGTH_ORE]: "ore",
  [SCAN_STRENGTH_GAS]: "gas",
  [SCAN_STRENGTH_RELIC]: "relic",
  [SCAN_STRENGTH_DATA]: "data",
  [SCAN_STRENGTH_COMBAT]: "combat",
  [SCAN_STRENGTH_WORMHOLE]: "wormhole",
});

const BY_ARCHETYPE: Readonly<Record<number, ExplorationSiteKind>> = Object.freeze({
  // Ice is mined with the same lasers out of the same kind of field, so it
  // answers "ore" here exactly as the client's own bracket icon does.
  [ARCHETYPE_ORE_ANOMALY]: "ore",
  [ARCHETYPE_ICE_BELT]: "ore",
  [ARCHETYPE_GAS_CLOUDS]: "gas",
  [ARCHETYPE_COMBAT_SITES]: "combat",
  [ARCHETYPE_WORMHOLE]: "wormhole",
  [ARCHETYPE_RELIC_SITES]: "relic",
  [ARCHETYPE_DATA_SITES]: "data",
});

function id(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Classify one site from the two fields its row carries. The attribute wins —
 * it is what the client groups by — and the archetype is consulted only when
 * the attribute is missing or is a number this build has never heard of.
 */
export function siteKind(
  scanStrengthAttribute: unknown,
  archetypeID?: unknown,
): ExplorationSiteKind {
  const attribute = id(scanStrengthAttribute);
  if (attribute !== null) {
    const byAttribute = BY_SCAN_STRENGTH[attribute];
    if (byAttribute !== undefined) {
      return byAttribute;
    }
  }
  const archetype = id(archetypeID);
  if (archetype !== null) {
    const byArchetype = BY_ARCHETYPE[archetype];
    if (byArchetype !== undefined) {
      return byArchetype;
    }
  }
  return "unknown";
}
