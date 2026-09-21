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

/** Severity order, worst first. Ties inside a kind are broken by time. */
const KIND_ORDER: Readonly<Record<ColonyFindingKind, number>> = Object.freeze({
  "extractor-expired": 0,
  "factory-starved": 1,
  "pin-full": 2,
  "extractor-idle": 3,
  "extractor-expiring": 4,
  "cc-holds-cargo": 5,
});

function bySeverityThenTime(left: ColonyFinding, right: ColonyFinding): number {
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

/** Everything on ONE planet that wants the player, worst first. */
export function colonyFindings(
  colony: Colony,
  serverNowMs: number,
  thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS,
): readonly ColonyFinding[] {
  const findings: ColonyFinding[] = [];
  for (const pin of colony.pins) {
    if (pin.kind === "extractor-control") {
      const finding = extractorFindings(colony, pin, serverNowMs, thresholds);
      if (finding !== null) {
        findings.push(finding);
      }
    }
    // ⚠ ONLY AN EXPLICIT false. null is "this pin has no such state", which is
    // what every non-factory pin answers; reading it as starvation would put
    // an alarm on every extractor on every planet.
    if (pin.kind === "factory" && pin.receivedInputsLastCycle === false) {
      findings.push({
        planetID: colony.planetID,
        pinID: pin.pinID,
        kind: "factory-starved",
        urgency: "now",
        dueAtMs: null,
        words: pin.schematicName
          ? `The factory making ${pin.schematicName} was fed nothing last cycle`
          : "A factory was fed nothing last cycle",
      });
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
): readonly ColonyAttention[] {
  return colonies
    .map((colony) => {
      const findings = colonyFindings(colony, serverNowMs, thresholds);
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
      return `${countWords(sameKind, "1 factory", "factories")} ${sameKind === 1 ? "was" : "were"} fed nothing last cycle${tail}`;
    case "pin-full":
      return `${countWords(sameKind, "1 hold is full", "holds are full")}${tail}`;
    case "extractor-idle":
      return `${countWords(sameKind, "1 extractor has no program", "extractors have no program")}${tail}`;
    default:
      return `${worst.words}${tail}`;
  }
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
