// Pilot Hangar — the view model for the landing screen.
//
// The screen this replaces was one flat list of every pilot plus a login panel.
// That is fine at three pilots and unusable at fifty: the player scrolls past
// four accounts to find the one hauler they wanted, and nothing on screen says
// which pilots belong to the same operation. So the hangar groups pilots by the
// ACCOUNT they sign in through (the one grouping the server actually knows) and
// lets the player lay a second, cross-account grouping over the top — squads,
// which live in app/hangarPrefs.ts.
//
// This module is pure. It takes the roster (app/knownCharacters.ts), the
// arrangement (app/hangarPrefs.ts) and the set of pilots already in the client,
// and answers with rows, counts and the exact strings the screen prints. No
// fetching, no storage, no Svelte — so the filtering, the sort and every piece of
// number formatting are testable without a DOM or a server.

import type { KnownCharacter } from "./knownCharacters.ts";
import type { HangarPrefs, Squad } from "./hangarPrefs.ts";
import { squadsForPilot } from "./hangarPrefs.ts";
import { formatDuration, romanLevel } from "../bridge/skills.ts";

/**
 * How many characters one EveJS account can hold. The emulator reports this as
 * `characterSlots` in the character-selection tuple and it is 3 there; the
 * hangar pads every account out to that many rows so an account with room in it
 * says so, rather than looking finished.
 */
export const MAX_SLOTS = 3;

/** One pilot as the hangar shows it: the roster row plus the screen's own state. */
export interface HangarPilot {
  readonly characterID: number;
  readonly name: string;
  readonly accountName: string;
  readonly shipName: string | null;
  readonly locationName: string | null;
  readonly skillPoints: number | null;
  readonly balance: number | null;
  /** What this pilot is training, already worded — null when the queue is empty. */
  readonly training: string | null;
  /** Already in the client, in this tab. */
  readonly online: boolean;
  /** Pinned to the top of its account. */
  readonly pinned: boolean;
  readonly squads: readonly Squad[];
}

/** Which pilots the screen is showing. Composes with the search box. */
export type HangarScope =
  | { readonly kind: "all" }
  | { readonly kind: "squad"; readonly value: string }
  | { readonly kind: "idle" }
  | { readonly kind: "online" };

/** One account's section: its pilots in display order, plus its empty slots. */
export interface HangarAccount {
  readonly name: string;
  readonly pilots: readonly HangarPilot[];
  /** How many "+ Add character" slots to pad this account out with. */
  readonly emptySlots: number;
}

// --- building the rows ------------------------------------------------------

/**
 * Turn the persisted roster into hangar rows. `onlineIDs` is the live truth from
 * App's session list, not something the roster remembers — a pilot is "in the
 * client" only while a session for it is actually up.
 */
export function toHangarPilots(
  known: readonly KnownCharacter[],
  prefs: HangarPrefs,
  onlineIDs: ReadonlySet<number>,
  now: number = Date.now(),
): HangarPilot[] {
  const pinned = new Set(prefs.pinnedPilots);
  return known.map((row) => ({
    characterID: row.characterID,
    name: row.characterName,
    accountName: row.accountName,
    shipName: row.shipName,
    locationName: row.locationName ?? null,
    skillPoints: row.skillPoints,
    balance: row.balance,
    training: trainingLabel(
      row.trainingSkillName ?? null,
      row.trainingToLevel ?? null,
      row.trainingEndsAtMs ?? null,
      now,
    ),
    online: onlineIDs.has(row.characterID),
    pinned: pinned.has(row.characterID),
    squads: squadsForPilot(prefs, row.characterID),
  }));
}

/**
 * "Mining Barge V · 4d 6h", or null for an empty queue.
 *
 * A queue whose end time has already passed is finished, not training: the
 * roster row is a snapshot from the last refresh and the skill kept ticking
 * without us, so treating a stale entry as live would tell the player a pilot is
 * busy when it has been idle for a day. Null is the honest answer, and the IDLE
 * badge that follows from it is the one the player can act on.
 */
export function trainingLabel(
  skillName: string | null,
  toLevel: number | null,
  endsAtMs: number | null,
  now: number = Date.now(),
): string | null {
  if (skillName === null || skillName.length === 0) {
    return null;
  }
  const level = toLevel === null ? "" : romanLevel(toLevel);
  const named = level ? `${skillName} ${level}` : skillName;
  if (endsAtMs === null) {
    return named;
  }
  if (endsAtMs <= now) {
    return null;
  }
  return `${named} · ${formatDuration(endsAtMs - now)}`;
}

/** Does this pilot match the search box? Name, account, ship and system. */
export function matchesQuery(pilot: HangarPilot, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [pilot.name, pilot.accountName, pilot.shipName ?? "", pilot.locationName ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/** Does this pilot fall inside the current scope chip? */
export function matchesScope(pilot: HangarPilot, scope: HangarScope): boolean {
  switch (scope.kind) {
    case "squad":
      return pilot.squads.some((s) => s.id === scope.value);
    case "idle":
      return pilot.training === null;
    case "online":
      return pilot.online;
    default:
      return true;
  }
}

/** The pilots on screen: scope and search compose, both must pass. */
export function visiblePilots(
  pilots: readonly HangarPilot[],
  scope: HangarScope,
  query: string,
): HangarPilot[] {
  return pilots.filter((p) => matchesScope(p, scope) && matchesQuery(p, query));
}

/**
 * Group the visible pilots into account sections, accounts in roster order and
 * pilots pinned-first then by skill points descending — so the pilot a player
 * pinned is where they left it and, failing that, the most developed pilot in an
 * account leads.
 *
 * Empty slots are padded ONLY on the unfiltered view: an account showing two of
 * its three pilots because of a search has not got a free slot to offer, and a
 * dashed "+ Add character" under a filtered list reads as a missing result.
 */
export function groupByAccount(
  visible: readonly HangarPilot[],
  { padSlots }: { padSlots: boolean },
): HangarAccount[] {
  const order: string[] = [];
  const byAccount = new Map<string, HangarPilot[]>();
  for (const pilot of visible) {
    let bucket = byAccount.get(pilot.accountName);
    if (!bucket) {
      bucket = [];
      byAccount.set(pilot.accountName, bucket);
      order.push(pilot.accountName);
    }
    bucket.push(pilot);
  }
  return order.map((name) => {
    const pilots = [...(byAccount.get(name) ?? [])].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || (b.skillPoints ?? 0) - (a.skillPoints ?? 0),
    );
    return {
      name,
      pilots,
      emptySlots: padSlots ? Math.max(0, MAX_SLOTS - pilots.length) : 0,
    };
  });
}

// --- the strings the screen prints -----------------------------------------

/**
 * A compact ISK amount: "4.82b", "134.9m", "86k". Deliberately NOT ui/isk.ts —
 * that one groups an exact bigint-safe balance for a wallet, and a wallet's
 * "4,821,004,113.20 ISK" is unreadable eighteen times over in a dense grid. This
 * is a magnitude at a glance; the exact figure lives in the pilot's wallet.
 */
export function formatIskCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${Math.round(value / 1e3)}k`;
  return `${Math.round(value)}`;
}

/** A compact skill-point total: "134.9m SP", "412k SP". */
export function formatSpCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "— SP";
  }
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m SP`;
  return `${Math.round(value / 1e3)}k SP`;
}

/** What the scope chip currently in force is showing, in words. */
export function scopeLabel(scope: HangarScope, squads: readonly Squad[]): string {
  switch (scope.kind) {
    case "idle":
      return "Pilots with an empty skill queue";
    case "online":
      return "Pilots already in the client";
    case "squad": {
      const squad = squads.find((s) => s.id === scope.value);
      return squad ? `${squad.name} — pilots across accounts` : "Squad";
    }
    default:
      return "All pilots, grouped by account";
  }
}

/** "17 shown · 4.82b ISK · 8 not training" — the summary line's right half. */
export function totalsLabel(
  visible: readonly HangarPilot[],
  all: readonly HangarPilot[],
): string {
  const isk = visible.reduce((sum, p) => sum + (p.balance ?? 0), 0);
  const idle = all.filter((p) => p.training === null).length;
  return `${visible.length} shown · ${formatIskCompact(isk)} ISK · ${idle} not training`;
}

/** "6 pilots selected" / "1 pilot selected". */
export function selectionLabel(count: number): string {
  return `${count} ${count === 1 ? "pilot" : "pilots"} selected`;
}

/** "4 accounts · 6.1b ISK" — what the selection adds up to. */
export function selectionDetail(selected: readonly HangarPilot[]): string {
  const accounts = new Set(selected.map((p) => p.accountName)).size;
  const isk = selected.reduce((sum, p) => sum + (p.balance ?? 0), 0);
  return `${accounts} ${accounts === 1 ? "account" : "accounts"} · ${formatIskCompact(isk)} ISK`;
}

/** "3 pilots" / "1 pilot" — an account header's count. */
export function pilotCountLabel(count: number): string {
  return `${count} ${count === 1 ? "pilot" : "pilots"}`;
}
