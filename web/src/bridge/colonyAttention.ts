// What on a planet needs the player, and how soon (the colony monitor).
//
// ---------------------------------------------------------------------------
// NOTHING HERE SIMULATES A COLONY.
//
// Every number this module reads was produced by the emulator running the
// colony forward: what a pin holds, what it can hold, when a program expires,
// whether a factory was fed. This module only DECIDES WHICH OF THEM DESERVE A
// SENTENCE, and sorts those sentences by how soon they matter. It computes no
// yield, no cycle, no throughput.
//
// ---------------------------------------------------------------------------
// SILENCE IS THE DEFAULT. AN ABSENCE IS NEVER A FINDING.
//
// Every input here is nullable, and null always means "the server did not say".
// A pin with no readable used volume raises nothing; a factory whose feed flag
// is null (which is every pin that is not a factory) raises nothing. Only a
// fact the server actually stated may become a line on screen, because the
// whole value of this panel is that a quiet colony is genuinely quiet — a
// monitor that cries wolf about unknowns is worse than no monitor.
//
// ---------------------------------------------------------------------------
// TIME IS THE SERVER'S.
//
// `serverNowMs` is what the SERVER would call now (bridge/planets.ts
// `serverNow`), never `Date.now()`. Deciding whether an expiry has passed is
// the only judgement about time made here, and it is made on that clock.

import type { Colony, ColonyPin } from "../store/types.ts";
import { formatDuration, summarizeColony } from "./planets.ts";
import { factoryStarvationWords } from "./colonySupply.ts";
import { extractorShortfall, isRoutedInto, routedFrom } from "./colonyRoutes.ts";
import type { PiRecipeBook } from "./piRecipes.ts";

export type ColonyFindingKind =
  /** A program whose expiry has passed: this extractor has stopped. */
  | "extractor-expired"
  /** A program still running, but ending inside the warning window. */
  | "extractor-expiring"
  /** An extractor with no program installed at all. */
  | "extractor-idle"
  /** A hold at or past the full mark — production backs up behind it. */
  | "pin-full"
  /** A factory the last simulated cycle fed nothing. */
  | "factory-starved"
  /** A factory with no recipe set (retail ProcessPin.IsNeedingAttention). */
  | "factory-no-recipe"
  /** A recipe input no route brings in (retail IsSomeConsumableUnfulfilled). */
  | "factory-input-unrouted"
  /** A factory whose output no route carries away in full (IsSomeProductUnrouted). */
  | "factory-output-unrouted"
  /**
   * An extractor whose routes reserve less than its maximum cycle
   * (IsSomeProductUnrouted) - typically routes still sized for the program
   * before a restart.
   */
  | "extractor-unrouted"
  /** The command centre is holding goods: they can be launched. */
  | "cc-holds-cargo";

/**
 * "now" is already true and waiting on the player; "soon" is a deadline ahead
 * of them. The split is what lets the summary say how many planets need a visit
 * TODAY without burying it among things that are merely coming.
 */
export type ColonyFindingUrgency = "now" | "soon";

export interface ColonyFinding {
  readonly kind: ColonyFindingKind;
  readonly urgency: ColonyFindingUrgency;
  readonly planetID: number;
  /** The structure this is about. Null when it is about the colony itself. */
  readonly pinID: number | null;
  /** When it came due, or will. Null when there is no instant behind it. */
  readonly dueAtMs: number | null;
  /** Plain words for a player. Never an id, never a bare number (R7d/R9a). */
  readonly words: string;
}

export interface AttentionThresholds {
  /** A program ending within this is worth mentioning. Default 6 hours. */
  readonly expiringWithinMs: number;
  /** At or above this fraction of capacity, a hold counts as full. Default 0.9. */
  readonly fullAtFraction: number;
}

export const DEFAULT_ATTENTION_THRESHOLDS: AttentionThresholds = Object.freeze({
  expiringWithinMs: 6 * 60 * 60 * 1000,
  fullAtFraction: 0.9,
});

/**
 * How full a hold is, 0 to 1 — or null when either half is unreadable.
 *
 * ⚠ THE DIVISION GUARD. `capacityM3` is null for every pin that is not a hold
 * (an extractor control unit and an industry facility carry capacity 0 in the
 * static table, and the BFF answers null rather than 0 precisely so this cannot
 * divide by zero). A null on either side means no fill can be stated, so no
 * finding is raised.
 */
export function pinFill(pin: ColonyPin): number | null {
  const { usedM3, capacityM3 } = pin;
  // ⚠ TYPE-CHECKED, NOT null-CHECKED. State reaches this panel from more than
  // the decoder — a hand-built scene, an older persisted shape — and `undefined
  // <= 0` is false, so a bare `=== null` guard lets undefined through and
  // returns NaN, which compares false against every threshold and silently
  // never fires. An unreadable fill must be null, whatever shape it arrived in.
  if (typeof usedM3 !== "number" || typeof capacityM3 !== "number") {
    return null;
  }
  if (!Number.isFinite(usedM3) || !Number.isFinite(capacityM3) || capacityM3 <= 0) {
    return null;
  }
  return usedM3 / capacityM3;
}

/** "84% full" — rounded down, so it never claims a hold is fuller than it is. */
function fillWords(fill: number): string {
  return `${Math.min(100, Math.floor(fill * 100))}% full`;
}

/** The structure, in a player's words. Mirrors the panel's own vocabulary. */
function pinWords(pin: ColonyPin): string {
  return pin.typeName.length > 0 ? pin.typeName : "a structure";
}

function extractorFindings(
  colony: Colony,
  pin: ColonyPin,
  serverNowMs: number,
  thresholds: AttentionThresholds,
): ColonyFinding | null {
  const base = { planetID: colony.planetID, pinID: pin.pinID } as const;
  const program = pin.program;
  // No program, or one the server gave no expiry for: this extractor is not
  // working. Said once, without a deadline, because there is none.
  if (program === null || program.expiresAtMs === null) {
    return {
      ...base,
      kind: "extractor-idle",
      urgency: "now",
      dueAtMs: null,
      words: "An extractor has no program installed",
    };
  }
  if (program.expiresAtMs <= serverNowMs) {
    return {
      ...base,
      kind: "extractor-expired",
      urgency: "now",
      dueAtMs: program.expiresAtMs,
      words: program.resourceTypeName
        ? `An extractor has finished pulling ${program.resourceTypeName}`
        : "An extractor has finished its program",
    };
  }
  if (program.expiresAtMs - serverNowMs <= thresholds.expiringWithinMs) {
    return {
      ...base,
      kind: "extractor-expiring",
      urgency: "soon",
      dueAtMs: program.expiresAtMs,
      words: program.resourceTypeName
        ? `An extractor stops pulling ${program.resourceTypeName} soon`
        : "An extractor stops soon",
    };
  }
  return null;
}

function holdFinding(
  colony: Colony,
  pin: ColonyPin,
  thresholds: AttentionThresholds,
): ColonyFinding | null {
  const base = { planetID: colony.planetID, pinID: pin.pinID } as const;
  const fill = pinFill(pin);
  if (fill !== null && fill >= thresholds.fullAtFraction) {
    return {
      ...base,
      kind: "pin-full",
      urgency: "now",
      dueAtMs: null,
      words: `${pinWords(pin)} is ${fillWords(fill)}`,
    };
  }
  // A command centre with anything in it is the launch trigger: goods reach
  // orbit ONLY from a command centre (the emulator refuses every other pin
  // with CanOnlyLaunchFromCommandCenters), so what sits here is what can go.
  if (pin.kind === "command" && typeof pin.usedM3 === "number" && pin.usedM3 > 0) {
    return {
      ...base,
      kind: "cc-holds-cargo",
      urgency: "soon",
      dueAtMs: null,
      words: "The command centre is holding goods ready to launch",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE GAME'S OWN ATTENTION RULES (colonyData.IsPinNeedingAttention).
//
// The retail client flags a pin when it has no recipe, when a recipe input has
// no route in, or when what it produces is not routed away in full. These are
// wiring facts, read straight off the routes, so unlike the feed flag above
// they do not flicker cycle to cycle. Its fourth rule (a full store with a
// route in) is already covered by the fuller pin-full rule.

function extractorUnroutedFinding(colony: Colony, pin: ColonyPin): ColonyFinding | null {
  const shortfall = extractorShortfall(colony, pin);
  if (shortfall === null) return null;
  const what = pin.program?.resourceTypeName ?? "what it pulls";
  return {
    planetID: colony.planetID,
    pinID: pin.pinID,
    kind: "extractor-unrouted",
    urgency: "now",
    dueAtMs: null,
    words: shortfall.routed === 0
      ? `No route carries ${what} away from an extractor`
      : `An extractor's routes carry ${shortfall.routed.toLocaleString("en-US")} of the ${shortfall.maxOutput.toLocaleString("en-US")} ${what} a cycle can yield`,
  };
}

/** Everything wrong with one factory's wiring, root cause first. */
function factoryWiringFindings(
  colony: Colony,
  pin: ColonyPin,
  serverNowMs: number,
  recipes: PiRecipeBook | null,
): ColonyFinding[] {
  const base = { planetID: colony.planetID, pinID: pin.pinID, urgency: "now", dueAtMs: null } as const;
  if (pin.schematicID === null) {
    return [{ ...base, kind: "factory-no-recipe", words: `${pinWords(pin)} has no recipe set` }];
  }
  const found: ColonyFinding[] = [];
  // ⚠ ONLY AN EXPLICIT false, AND ONLY WHEN NOTHING IS COMING. null is "this
  // pin has no such state", which every non-factory pin answers. And false
  // alone is not a fault: on a colony whose extraction is the bottleneck most
  // factories go unfed on most cycles. colonySupply.ts follows the routes and
  // speaks only when an input has no live source at all. It comes first
  // because its sentence says the most (it also covers a missing route).
  if (pin.receivedInputsLastCycle === false) {
    const words = factoryStarvationWords(colony, pin, serverNowMs, recipes);
    if (words !== null) {
      found.push({ ...base, kind: "factory-starved", words });
    }
  }
  // Without the recipe table there is no telling what it needs or makes, and
  // an unknown raises nothing.
  const recipe = recipes !== null && recipes.readable
    ? recipes.bySchematicID.get(pin.schematicID) ?? null
    : null;
  if (recipe === null) return found;
  const making = pin.schematicName ?? recipe.output.typeName ?? null;
  const target = making ? `the factory making ${making}` : "a factory";
  const missing = recipe.inputs.find((input) => !isRoutedInto(colony, pin.pinID, input.typeID));
  if (missing !== undefined) {
    found.push({
      ...base,
      kind: "factory-input-unrouted",
      words: `No route brings ${missing.typeName ?? "what it needs"} to ${target}`,
    });
  }
  if (routedFrom(colony, pin.pinID, recipe.output.typeID) < recipe.output.quantity) {
    found.push({
      ...base,
      kind: "factory-output-unrouted",
      words: `Nothing takes all of ${making ?? "its output"} away from ${target}`,
    });
  }
  return found;
}

/** Severity order, worst first. Ties inside a kind are broken by time. */
const KIND_ORDER: Readonly<Record<ColonyFindingKind, number>> = Object.freeze({
  "extractor-expired": 0,
  "factory-no-recipe": 1,
  "factory-input-unrouted": 2,
  "factory-starved": 3,
  "pin-full": 4,
  "extractor-idle": 5,
  "extractor-unrouted": 6,
  "factory-output-unrouted": 7,
  "extractor-expiring": 8,
  "cc-holds-cargo": 9,
});

/**
 * Worst first. Exported so a board spanning several pilots orders their colonies
 * by exactly the rule one colony's own list uses.
 */
export function bySeverityThenTime(left: ColonyFinding, right: ColonyFinding): number {
  if (left.urgency !== right.urgency) {
    return left.urgency === "now" ? -1 : 1;
  }
  if (KIND_ORDER[left.kind] !== KIND_ORDER[right.kind]) {
    return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  }
  // A finding with a deadline comes before one without: it is the one that can
  // be acted on in an order.
  if (left.dueAtMs !== right.dueAtMs) {
    if (left.dueAtMs === null) {
      return 1;
    }
    if (right.dueAtMs === null) {
      return -1;
    }
    return left.dueAtMs - right.dueAtMs;
  }
  return (left.pinID ?? 0) - (right.pinID ?? 0);
}

/**
 * Everything on ONE planet that wants the player, worst first.
 *
 * `recipes` lets a starved factory be judged against what its recipe needs;
 * without it, a factory's inputs are what its routes bring in.
 */
export function colonyFindings(
  colony: Colony,
  serverNowMs: number,
  thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS,
  recipes: PiRecipeBook | null = null,
): readonly ColonyFinding[] {
  const findings: ColonyFinding[] = [];
  for (const pin of colony.pins) {
    if (pin.kind === "extractor-control") {
      const finding = extractorFindings(colony, pin, serverNowMs, thresholds);
      if (finding !== null) {
        findings.push(finding);
      }
      // A stopped extractor already has its sentence; its routes are moot
      // until it runs again.
      const stopped = finding !== null && finding.urgency === "now";
      const unrouted = stopped ? null : extractorUnroutedFinding(colony, pin);
      if (unrouted !== null) {
        findings.push(unrouted);
      }
    }
    if (pin.kind === "factory") {
      // ⚠ ONE SENTENCE PER FACTORY, THE ROOT CAUSE. The game lights a factory
      // for each of these at once, but a factory with no recipe has no inputs
      // to route, and one with nothing coming in has no output to route yet:
      // the first that applies is the one worth saying.
      const [first] = factoryWiringFindings(colony, pin, serverNowMs, recipes);
      if (first !== undefined) {
        findings.push(first);
      }
    }
    const hold = holdFinding(colony, pin, thresholds);
    if (hold !== null) {
      findings.push(hold);
    }
  }
  return findings.sort(bySeverityThenTime);
}

/** One planet's findings, kept with the colony they came from. */
export interface ColonyAttention {
  readonly colony: Colony;
  readonly findings: readonly ColonyFinding[];
  /** True when at least one finding is already waiting on the player. */
  readonly needsYouNow: boolean;
}

/**
 * Every colony that has anything to say, the loudest planet first.
 *
 * Colonies with nothing to say are LEFT OUT rather than listed as quiet: the
 * table below already lists every colony, and this is the part a player reads
 * to find out where to go.
 */
export function attentionByColony(
  colonies: readonly Colony[],
  serverNowMs: number,
  thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS,
  recipes: PiRecipeBook | null = null,
): readonly ColonyAttention[] {
  return colonies
    .map((colony) => {
      const findings = colonyFindings(colony, serverNowMs, thresholds, recipes);
      return {
        colony,
        findings,
        needsYouNow: findings.some((finding) => finding.urgency === "now"),
      };
    })
    .filter((entry) => entry.findings.length > 0)
    .sort((left, right) => {
      if (left.needsYouNow !== right.needsYouNow) {
        return left.needsYouNow ? -1 : 1;
      }
      const worst = bySeverityThenTime(left.findings[0]!, right.findings[0]!);
      return worst !== 0 ? worst : left.colony.planetID - right.colony.planetID;
    });
}

function countWords(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

/**
 * A colony's state in one line, from its findings — or NULL when nothing is
 * waiting, which leaves the caller's own wording in place.
 *
 * ⚠ THE EXPIRED-EXTRACTOR SENTENCE IS WORD-FOR-WORD WHAT THE PANEL HAS SAID
 * SINCE R41. This line replaces that one in the table, so changing its wording
 * would be a silent rewording of a shipped screen; the other kinds are new
 * sentences for cases the old line could not describe at all (a colony with a
 * full launchpad and a healthy extractor read as simply "Extracting").
 */
export function colonyAttentionWords(findings: readonly ColonyFinding[]): string | null {
  const now = findings.filter((finding) => finding.urgency === "now");
  if (now.length === 0) {
    return null;
  }
  const worst = now[0]!;
  const sameKind = now.filter((finding) => finding.kind === worst.kind).length;
  const others = now.length - sameKind;
  const tail = others > 0 ? ", and more needs you here" : "";

  switch (worst.kind) {
    case "extractor-expired":
      return `${countWords(sameKind, "1 extractor has finished its program", "extractors have finished their programs")}${tail}`;
    case "factory-starved":
      return `${countWords(sameKind, "1 factory has", "factories have")} nothing coming in${tail}`;
    case "pin-full":
      return `${countWords(sameKind, "1 hold is full", "holds are full")}${tail}`;
    case "extractor-idle":
      return `${countWords(sameKind, "1 extractor has no program", "extractors have no program")}${tail}`;
    case "extractor-unrouted":
      return `${countWords(sameKind, "1 extractor yields more than its routes carry", "extractors yield more than their routes carry")}${tail}`;
    case "factory-no-recipe":
      return `${countWords(sameKind, "1 factory has", "factories have")} no recipe set${tail}`;
    default:
      return `${worst.words}${tail}`;
  }
}

/**
 * The one-line state of a colony in a list.
 *
 * What NEEDS the player wins the line when there is any: the older sentences
 * below can only describe extractors, so a colony with a full launchpad and a
 * healthy extractor used to read as simply "Extracting". When nothing is
 * waiting, those sentences are still the better ones and are kept word for
 * word from Planets, which printed them first.
 *
 * ⚠ ONE PLACE FOR BOTH LISTS. The Planets panel and the PI Manager's board both
 * print this line for the same colony; two copies would drift, and a player who
 * sees one colony described two ways believes neither.
 */
export function colonyLineWords(
  colony: Colony,
  findings: readonly ColonyFinding[],
  serverNowMs: number,
): string {
  const waiting = colonyAttentionWords(findings);
  if (waiting !== null) {
    return waiting;
  }
  const summary = summarizeColony(colony, serverNowMs);
  if (summary.expiredProgramCount > 0) {
    return summary.expiredProgramCount === 1
      ? "1 extractor has finished its program"
      : `${summary.expiredProgramCount} extractors have finished their programs`;
  }
  if (summary.nextExpiryMs !== null) {
    return `Extracting — next program ends in ${formatDuration(summary.nextExpiryMs - serverNowMs)}`;
  }
  if (summary.extractorCount === 0) {
    return "No extractors here yet";
  }
  return "No programs running";
}

/**
 * The line above the table: how many planets want the player, and how soon.
 * Null when every colony is quiet — then the panel says nothing at all, which
 * is the answer a player most wants to be able to trust.
 */
export function attentionSummaryWords(
  attention: readonly ColonyAttention[],
): string | null {
  if (attention.length === 0) {
    return null;
  }
  const nowCount = attention.filter((entry) => entry.needsYouNow).length;
  const soonCount = attention.length - nowCount;
  if (nowCount === 0) {
    return `${countWords(soonCount, "One planet has", "planets have")} something coming up.`;
  }
  const head = `${countWords(nowCount, "One planet needs", "planets need")} you now.`;
  return soonCount === 0
    ? head
    : `${head} ${countWords(soonCount, "One more has", "more have")} something coming up.`;
}
