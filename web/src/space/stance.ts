// STANCE (iteration 5 of the overview tabs) — FRIENDLY / NEUTRAL / HOSTILE, the
// single answer to "WHOSE IS THAT?" that hiding reads, alongside
// `bracketRole`'s "WHAT KIND IS THAT?".
//
// Why it exists: the retail overview splits the same object types by stance —
// "Ships: red" and "Ships: Friendly" are the same group, different state. Our
// recipes hide by role only, and hiding "ships" on a PVP tab used to drag the
// player's own logi and their own drones with it. The stance is the axis the
// player actually meant, and the menu now names it: "Ships (Friendly)",
// "Drones (Neutral)", "Hostiles".
//
// ⚠ THE IDENTITY READ HAPPENS HERE AND NOWHERE ELSE IN THE PANEL. The
// overview panel's contract is that no tab classifies an object on its own:
// the stance context (who the player is: character, corporation, alliance) is
// built once from the character list the client already holds, and
// `stanceOf` answers it as a three-word summary of the grid. The list and the
// radar both read through this module, so the picture cannot disagree with the
// list about whose ship is whose.
//
// ⚠ THE NPC QUESTION IS ASKED FIRST, THE SAME WAY `isHostile` ASKS IT. A belt
// rat and a player's parked hauler are otherwise the same row, and an NPC that
// happened to carry one of the player's ids must still read as the kind of
// thing the runtime says it is. `stanceOf` answers "hostile" in exactly the
// rows `isHostile` flags, by construction.
//
// ⚠ NEVER GUESS. A context the client does not hold yet, or an identity it
// cannot read, reads as "neutral": neither the side a player would hide by
// accident, nor the side they would unsee.

import type { CharacterSummary, SpaceEntity } from "../store/types.ts";

/** The three answers "whose is that" has. */
export type Stance = "friendly" | "neutral" | "hostile";

/** Who the player is — the only identity the stance read ever uses. */
export interface StanceContext {
  readonly characterID: number;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
}

/**
 * The player's stance context from the character list the client already
 * holds. null when there is no selected character or the list has not loaded —
 * and "no context" must read as "nothing friendly", never as a guess.
 */
export function stanceContextFrom(
  characters: readonly CharacterSummary[],
  selectedCharacterID: number | null,
): StanceContext | null {
  if (selectedCharacterID === null) {
    return null;
  }
  const found = characters.find((row) => row.characterID === selectedCharacterID);
  if (!found) {
    return null;
  }
  return {
    characterID: found.characterID,
    corporationID: found.corporationID,
    allianceID: found.allianceID,
  };
}

/**
 * Whose is this?
 *
 * ⚠ NPC FIRST, IN THE SAME ORDER `isHostile` READS IT. Law enforcement is the
 * one NPC that is not a threat, and it is the one that reads as "neutral"
 * rather than friendly — Concord is nobody's side. Everything else the runtime
 * says is an NPC reads as "hostile", exactly as `isHostile` would, including
 * an NPC whose kind we could not read.
 *
 * ⚠ THE FRIENDLY TEST IS THE CONTEXT'S OWN. Own character, own hulls flying a
 * drone (multi-box), own corporation, own alliance — in that order, and each
 * one only when it is actually set.
 */
export function stanceOf(entity: SpaceEntity, context: StanceContext | null): Stance {
  if (entity.isNpc) {
    return entity.npcEntityType === "concord" ? "neutral" : "hostile";
  }
  if (context !== null) {
    if (entity.characterID === context.characterID) {
      return "friendly";
    }
    if (entity.ownerID === context.characterID) {
      return "friendly";
    }
    if (context.corporationID !== null && entity.corporationID === context.corporationID) {
      return "friendly";
    }
    if (context.allianceID !== null && entity.allianceID === context.allianceID) {
      return "friendly";
    }
  }
  return "neutral";
}

// --- the words the menu uses -------------------------------------------------

const ROLE_WORDS: Readonly<Record<string, string>> = {
  ship: "Ships",
  drone: "Drones",
  wreck: "Wrecks",
  station: "Structures",
  police: "Police",
  gate: "Gates",
  celestial: "Celestials",
  asteroid: "Rocks",
  hostile: "Hostiles",
  self: "Your ship",
};

/** The role's own word in the menu, never a number (R7d). */
export function roleWord(role: string): string {
  return ROLE_WORDS[role] ?? role;
}

/**
 * The roles that can wear a stance entry: the ones whose grid rows come in
 * more than one stance ("Ships (Friendly)" next to "Ships (Neutral)"), plus
 * "hostile" itself, which IS a stance and earns its own "Hostiles" row.
 *
 * ⚠ THE OTHER ROLES DO NOT QUALIFY. Police are always the one neutral NPC
 * family, and rocks, gates and celestials carry no side at all — a stance row
 * for them would hide nothing that a plain group hide does not already hide.
 */
export const STANCED_ROLES: ReadonlySet<string> = new Set([
  "ship",
  "drone",
  "wreck",
  "station",
  "hostile",
]);

/**
 * The menu label for a stance entry: "Ships (Friendly)", "Drones (Neutral)" —
 * and "Hostiles", bare, because every row the hostile role holds is hostile
 * and the word would be said twice.
 */
export function stanceRowLabel(role: string, stance: Stance): string {
  if (role === "hostile") {
    return roleWord("hostile");
  }
  const word = stance === "friendly" ? "Friendly" : stance === "neutral" ? "Neutral" : "Hostile";
  return `${roleWord(role)} (${word})`;
}
