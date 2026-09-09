// The MINING SURVEYOR, run by the bot instead of by a player pressing the
// button — and the rules that decide WHEN it may run.
//
// ─── WHY A BOT SHOULD SCAN AT ALL ────────────────────────────────────────────
//
// `miningScanMgr.perform_scan()` answers `[[itemID, yieldTypeID, quantity], …]`
// for the rocks around the ship. Without it a rock's `remainingQuantity` is
// whatever the scene's mining state already happened to know — often nothing —
// so every rock reads as "unknown", and every rock-choosing decision the bot
// makes (biggest first, ore priority, "is this belt worth staying at") degrades
// to "the nearest one". Running the scanner is what turns those choices back on.
//
// ─── HOW THE REAL CLIENT KNOWS THE SCAN IS "STILL ACTIVE" ────────────────────
//
// It does not use a timeout, because there is none: scan data has no expiry
// anywhere in the client. What it has instead is (all from the game client's
// own `packages/mining/client/`):
//
//   • A BUSY WINDOW. `MiningOverlayController.perform_scan` returns early while
//     `effect_orchestrator.is_playing_effect` — the scan wave, which takes
//     `SCAN_EFFECT_DURATION = 8` seconds to travel `SCAN_EFFECT_DISTANCE =
//     250 km`. Pressing the button again during those 8 s does nothing. THIS is
//     the "if it is still active, do not execute it" rule.
//   • A HARD RATE LIMIT. `AsteroidScanningService._perform_tier2_scan` — the
//     one that actually calls the server — is decorated `@ThrottlePerMinute(10)`.
//   • A WARP REFUSAL. `perform_scan` refuses outright while the ship is in warp.
//   • EVENT-DRIVEN FORGETTING, not time-driven. `clear_scan_data()` runs on warp
//     start, on session change (dock / jump) and on ballpark reset; a single
//     rock is dropped (`_remove_scan`) when its ball leaves the grid. Between
//     scans the numbers are kept honest by SUBTRACTION (`on_ore_mined`), never
//     by re-scanning.
//   • A SCANNED-BUT-UNKNOWN SENTINEL. A rock the scan covered without an answer
//     is stored as `QUANTITY_UNKNOWN`, not dropped — so the client does not keep
//     re-asking about it. (That is the shape of a hull with no mining scanner
//     upgrade: the server call answers nothing and every rock in range is marked
//     unknown instead.)
//
// This module is those rules, and nothing else. It is pure: `decideSurveyScan`
// says whether a scan is due, `rememberSurveyScan` folds an answer in,
// `forgetSurvey` is the client's `clear_scan_data`, and `surveyedSnapshot`
// merges what was learned into the rock rows the deciders already read — so no
// decider had to learn a new field to benefit.
//
// ⚠ WHAT IT WILL NOT DO: invent a number. A rock the scanner did not answer for
// keeps its `null` ("unknown"), never a 0 — a fabricated zero reads as a
// mined-out rock and would send a bot straight past a full belt. That is the
// same rule the snapshot decoder holds, for the same reason.

import { measureSpace } from "./autopilotLoop.ts";
import { isMineableRock } from "./miningBotLoop.ts";
import type { SpaceEntity, SpaceSnapshot, SurveyResult } from "../store/types.ts";

/** The scan wave's own duration — the client's `SCAN_EFFECT_DURATION` (8 s). */
export const SCAN_EFFECT_MS = 8000;

/** The wave's reach — the client's `SCAN_EFFECT_DISTANCE` (250 km). */
export const SCAN_RANGE_M = 250_000;

/** The server call's ceiling — the client's `@ThrottlePerMinute(10)`. */
export const SCAN_BUDGET_PER_MINUTE = 10;

/** The window that budget is counted over. */
export const SCAN_BUDGET_WINDOW_MS = 60_000;

/**
 * How many scans may answer NOTHING before this ship stops asking. There is no
 * such counter in the client — a player simply sees an empty overlay and stops
 * pressing — but a bot presses forever, and a hull with no mining scanner
 * upgrade fitted is exactly the case where the call keeps costing a round trip
 * and keeps answering nothing.
 */
export const MAX_BLANK_SCANS = 2;

/**
 * What this ship has learned about the rocks around it.
 *
 * `quantities` maps a rock's itemID to what the scanner said: a number when it
 * answered, and `null` for a rock a scan COVERED without answering — the
 * client's `QUANTITY_UNKNOWN` sentinel, and the reason a bot does not re-scan
 * every two seconds for a rock nothing will ever report on.
 */
export interface SurveyMemory {
  readonly quantities: ReadonlyMap<number, number | null>;
  /** The hull this was learned in — a different one is a different scanner. */
  readonly shipID: number | null;
  /** When the last scan was FIRED (the busy window is measured from here). */
  readonly lastScanAtMs: number | null;
  /** Recent scan times, for the rolling per-minute budget. */
  readonly scanTimesMs: readonly number[];
  /** Consecutive scans that answered nothing at all. */
  readonly blankStreak: number;
}

export const EMPTY_SURVEY_MEMORY: SurveyMemory = Object.freeze({
  quantities: new Map<number, number | null>(),
  shipID: null,
  lastScanAtMs: null,
  scanTimesMs: Object.freeze([]) as readonly number[],
  blankStreak: 0,
});

/** Why a scan was, or was not, due — for the bot log and for tests. */
export interface SurveyVerdict {
  readonly scan: boolean;
  readonly why: string;
}

function shipIsWarping(snapshot: SpaceSnapshot): boolean {
  const mode = snapshot.ship?.mode ?? snapshot.entities.find((entity) => entity.isSelf)?.mode ?? null;
  return mode !== null && /warp/i.test(mode);
}

/** The mineable rocks the wave could reach from where the ship is sitting. */
function rocksInRange(snapshot: SpaceSnapshot): readonly SpaceEntity[] {
  const measurement = measureSpace(snapshot);
  return snapshot.entities.filter((entity) => {
    if (!isMineableRock(entity)) {
      return false;
    }
    const distance = measurement?.distances.get(entity.itemID) ?? null;
    // An unmeasurable rock is not ruled OUT: the wave either reaches it or it
    // does not, and guessing "too far" would be the one way to never scan.
    return distance === null || distance <= SCAN_RANGE_M;
  });
}

/** True when the rock has no quantity from the snapshot AND none from a scan. */
function isUnknown(rock: SpaceEntity, memory: SurveyMemory): boolean {
  if (rock.remainingQuantity !== null) {
    return false;
  }
  // `has`, not `get`: a rock stored as null was already asked about.
  return !memory.quantities.has(rock.itemID);
}

/**
 * Is a scan due right now? The order of these tests is the client's own order:
 * warp first (it refuses outright), then the busy window, then the throttle,
 * and only then the question of whether anything would be learned.
 */
export function decideSurveyScan(
  snapshot: SpaceSnapshot | null,
  memory: SurveyMemory,
  nowMs: number,
): SurveyVerdict {
  if (snapshot === null || !snapshot.inSpace) {
    return { scan: false, why: "not in space" };
  }
  if (shipIsWarping(snapshot)) {
    // The client's own refusal: "MiningScannerDisabledWhileWarping".
    return { scan: false, why: "in warp" };
  }
  if (memory.blankStreak >= MAX_BLANK_SCANS) {
    return { scan: false, why: "the scanner answered nothing twice — this hull cannot survey" };
  }
  if (memory.lastScanAtMs !== null && nowMs - memory.lastScanAtMs < SCAN_EFFECT_MS) {
    // THE "STILL ACTIVE" RULE. The wave is still travelling; the client's button
    // does nothing here, and neither does this.
    return { scan: false, why: "a scan is still running" };
  }
  const recent = memory.scanTimesMs.filter((at) => nowMs - at < SCAN_BUDGET_WINDOW_MS);
  if (recent.length >= SCAN_BUDGET_PER_MINUTE) {
    return { scan: false, why: "the scanner's ten-per-minute budget is spent" };
  }
  const rocks = rocksInRange(snapshot);
  if (rocks.length === 0) {
    return { scan: false, why: "no rocks in range to survey" };
  }
  if (!rocks.some((rock) => isUnknown(rock, memory))) {
    // Everything in reach is either answered or already asked about. The client
    // does not re-scan here either — it keeps its numbers current by subtracting
    // what gets mined, and drops a rock only when the rock itself goes away.
    return { scan: false, why: "every rock in range is already surveyed" };
  }
  return { scan: true, why: "there are unsurveyed rocks in range" };
}

/**
 * Fold a scan's answer in. Rocks that have left the grid are dropped (the
 * client's `_remove_scan`), every rock the wave covered is recorded — with its
 * quantity when the scanner gave one and `null` when it did not — and a scan
 * that answered nothing at all counts towards giving up on this hull.
 */
export function rememberSurveyScan(
  memory: SurveyMemory,
  snapshot: SpaceSnapshot,
  results: readonly SurveyResult[],
  nowMs: number,
): SurveyMemory {
  const covered = rocksInRange(snapshot);
  const onGrid = new Set(covered.map((rock) => rock.itemID));
  const quantities = new Map<number, number | null>();
  for (const [itemID, quantity] of memory.quantities) {
    // A rock still in view keeps what we knew; one that is gone is forgotten
    // rather than remembered as a rock with no ore.
    if (onGrid.has(itemID)) {
      quantities.set(itemID, quantity);
    }
  }
  for (const rock of covered) {
    if (!quantities.has(rock.itemID)) {
      quantities.set(rock.itemID, null);
    }
  }
  let answered = 0;
  for (const result of results) {
    if (result.remainingQuantity === null) {
      continue;
    }
    quantities.set(result.itemID, result.remainingQuantity);
    answered += 1;
  }
  const scanTimesMs = [...memory.scanTimesMs, nowMs].filter(
    (at) => nowMs - at < SCAN_BUDGET_WINDOW_MS,
  );
  return {
    quantities,
    shipID: memory.shipID,
    lastScanAtMs: nowMs,
    scanTimesMs,
    blankStreak: answered > 0 ? 0 : memory.blankStreak + 1,
  };
}

/**
 * A scan that could not be made at all — the call threw, or the server refused.
 *
 * It costs a throttle slot and counts towards giving up (a hull that cannot
 * survey refuses the same way every time), but it records NO coverage: the
 * rocks keep their "never asked" state, so one bad round trip does not blind
 * this grid for the rest of the run.
 */
export function rememberSurveyFailure(memory: SurveyMemory, nowMs: number): SurveyMemory {
  return {
    quantities: memory.quantities,
    shipID: memory.shipID,
    lastScanAtMs: nowMs,
    scanTimesMs: [...memory.scanTimesMs, nowMs].filter((at) => nowMs - at < SCAN_BUDGET_WINDOW_MS),
    blankStreak: memory.blankStreak + 1,
  };
}

/**
 * Re-key the memory to the hull that is flying it.
 *
 * A different ship is a different scanner: what the old hull could not survey
 * says nothing about this one, so the blank-scan retirement is lifted here and
 * ONLY here. Docking to refit a mining scanner upgrade and undocking is exactly
 * that case, and without this the pilot would spend the rest of the session
 * never scanning again.
 *
 * The per-minute budget is deliberately carried across: it protects the server
 * from this client, and swapping hulls does not make the client any quieter.
 */
export function surveyForShip(memory: SurveyMemory, shipID: number | null): SurveyMemory {
  if (memory.shipID === shipID) {
    return memory;
  }
  return {
    quantities: new Map<number, number | null>(),
    shipID,
    lastScanAtMs: memory.lastScanAtMs,
    scanTimesMs: memory.scanTimesMs,
    blankStreak: 0,
  };
}

/**
 * The client's `clear_scan_data()` — what happens on warp start, on a session
 * change and on a ballpark reset. The rocks are forgotten; the THROTTLE and the
 * blank-scan streak are not, because they describe the scanner and the ship
 * rather than the grid, and a bot that re-armed them at every warp would go
 * straight back to scanning ten times a minute on a hull that cannot survey.
 */
export function forgetSurvey(memory: SurveyMemory): SurveyMemory {
  return {
    quantities: new Map<number, number | null>(),
    shipID: memory.shipID,
    lastScanAtMs: memory.lastScanAtMs,
    scanTimesMs: memory.scanTimesMs,
    blankStreak: memory.blankStreak,
  };
}

/**
 * Merge what the scanner learned into the snapshot's rock rows, so every
 * decider that already reads `remainingQuantity` benefits without knowing this
 * module exists.
 *
 * ⚠ IT ONLY FILLS BLANKS. A row the server answered for is left exactly as it
 * came: the server's number is live, ours is as old as the last scan.
 */
export function surveyedSnapshot(
  snapshot: SpaceSnapshot,
  memory: SurveyMemory,
): SpaceSnapshot {
  if (memory.quantities.size === 0) {
    return snapshot;
  }
  let changed = false;
  const entities = snapshot.entities.map((entity) => {
    if (entity.remainingQuantity !== null) {
      return entity;
    }
    const known = memory.quantities.get(entity.itemID);
    if (known === undefined || known === null) {
      return entity;
    }
    changed = true;
    return { ...entity, remainingQuantity: known };
  });
  return changed ? { ...snapshot, entities } : snapshot;
}
