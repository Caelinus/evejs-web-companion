// The blueprints the player's pilots own, as the Industry Manager's picker and
// resolver need them (goal R109 slice 2). Pure; the panel hands in what each
// signed-in pilot's own industry read already holds.
//
// ---------------------------------------------------------------------------
// ONE PILOT'S READ IS ONE PILOT'S.
//
// The industry read answers for the session that made it, so every row here
// says whose it is. Nothing here signs anyone in: a pilot with no session in
// this tab simply contributes no blueprints, and the picker says so.
//
// ---------------------------------------------------------------------------
// THE BEST COPY WINS, PER BLUEPRINT TYPE.
//
// The resolver takes one set of terms per blueprint type. When pilots hold
// several of the same blueprint, the plan is worked at the best of them
// (highest material efficiency, then time efficiency, an original before a
// copy): that is the one a player would install. Which pilot holds it is kept
// for the row that names it.

import type { IndustryBlueprintRow, IndustryDefinition } from "../store/types.ts";
import type { BlueprintTerms } from "./industryChain.ts";

/** One pilot's industry read, as the panel passes it in. */
export interface PilotBlueprintRead {
  readonly characterID: number;
  readonly characterName: string;
  readonly blueprints: readonly IndustryBlueprintRow[];
  /** Static recipes keyed by blueprint type, as that pilot's read cached them. */
  readonly definitions: Readonly<Record<number, IndustryDefinition | null>>;
}

/** One blueprint a pilot holds that makes something a tree can use. */
export interface OwnedBlueprint {
  readonly characterID: number;
  readonly characterName: string;
  readonly itemID: number;
  readonly blueprintTypeID: number;
  readonly blueprintName: string | null;
  readonly productTypeID: number;
  readonly original: boolean;
  /** Runs left on a copy; null for an original, which never runs out. */
  readonly runs: number | null;
  readonly materialEfficiency: number;
  readonly timeEfficiency: number;
  /** In a job right now. Still owned, still plannable. */
  readonly busy: boolean;
  /**
   * The industry facility it sits in, or null when it is somewhere no job can
   * start from (a ship, a container, a station without industry). The server
   * installs a job only in the blueprint's own facility.
   */
  readonly facilityID: number | null;
  /** The system it sits in, as the server states it, or null. */
  readonly solarSystemID: number | null;
}

/**
 * What a blueprint makes: the definition's product, or, for a reaction formula
 * (whose row says product 0), the reaction's own product.
 */
export function productOf(definition: IndustryDefinition | null | undefined): number | null {
  if (!definition) {
    return null;
  }
  if (definition.productTypeID !== null) {
    return definition.productTypeID;
  }
  for (const recipe of definition.recipes) {
    if (recipe.activity === "manufacturing" || recipe.activity === "reaction") {
      const product = recipe.products[0];
      if (product && product.typeID > 0) {
        return product.typeID;
      }
    }
  }
  return null;
}

function better(a: OwnedBlueprint, b: OwnedBlueprint): boolean {
  if (a.materialEfficiency !== b.materialEfficiency) {
    return a.materialEfficiency > b.materialEfficiency;
  }
  if (a.timeEfficiency !== b.timeEfficiency) {
    return a.timeEfficiency > b.timeEfficiency;
  }
  return a.original && !b.original;
}

/**
 * Every owned blueprint whose product is known, best first within a type and
 * types in name order. A blueprint whose definition has not arrived yet is
 * left out rather than listed as a nameless row.
 */
export function ownedBlueprints(reads: readonly PilotBlueprintRead[]): OwnedBlueprint[] {
  const owned: OwnedBlueprint[] = [];
  const seen = new Set<number>();
  for (const read of reads) {
    for (const row of read.blueprints) {
      // The same item can only be read twice if two sessions share a pilot.
      if (seen.has(row.itemID)) {
        continue;
      }
      const definition = read.definitions[row.typeID];
      const productTypeID = productOf(definition);
      if (productTypeID === null) {
        continue;
      }
      seen.add(row.itemID);
      owned.push({
        characterID: read.characterID,
        characterName: read.characterName,
        itemID: row.itemID,
        blueprintTypeID: row.typeID,
        blueprintName: definition?.blueprintName ?? null,
        productTypeID,
        original: row.original,
        runs: row.original ? null : row.runs,
        materialEfficiency: row.materialEfficiency,
        timeEfficiency: row.timeEfficiency,
        busy: row.jobID !== null,
        facilityID: row.facilityID,
        solarSystemID: row.solarSystemID,
      });
    }
  }
  return owned.sort((a, b) =>
    (a.blueprintName ?? "").localeCompare(b.blueprintName ?? "") ||
    (better(a, b) ? -1 : better(b, a) ? 1 : 0) ||
    a.characterName.localeCompare(b.characterName) ||
    a.itemID - b.itemID);
}

/** The best owned terms per blueprint type, for the resolver. */
export function ownedTerms(owned: readonly OwnedBlueprint[]): Map<number, BlueprintTerms> {
  const best = new Map<number, OwnedBlueprint>();
  for (const blueprint of owned) {
    const known = best.get(blueprint.blueprintTypeID);
    if (!known || better(blueprint, known)) {
      best.set(blueprint.blueprintTypeID, blueprint);
    }
  }
  const terms = new Map<number, BlueprintTerms>();
  for (const [blueprintTypeID, blueprint] of best) {
    terms.set(blueprintTypeID, {
      materialEfficiency: blueprint.materialEfficiency,
      timeEfficiency: blueprint.timeEfficiency,
      owned: true,
    });
  }
  return terms;
}

/** "Original" or "Copy, 7 runs", plus efficiencies, in plain words. */
export function ownedWords(blueprint: OwnedBlueprint): string {
  const kind = blueprint.original
    ? "Original"
    : `Copy, ${blueprint.runs ?? 0} ${blueprint.runs === 1 ? "run" : "runs"}`;
  return `${kind} - material ${blueprint.materialEfficiency}%, time ${blueprint.timeEfficiency}%`;
}

/** Every owned copy of one blueprint, for one row in the list. */
export interface OwnedGroup {
  readonly blueprintTypeID: number;
  readonly blueprintName: string | null;
  readonly productTypeID: number;
  /** Best first, in `owned`'s order. Never empty. */
  readonly copies: readonly OwnedBlueprint[];
}

/**
 * One group per blueprint type, in `owned`'s order (by name). A player with
 * hundreds of copies of a few dozen blueprints sees a few dozen rows, not
 * hundreds of near-identical ones (seen live: 648 rows).
 */
export function groupOwned(owned: readonly OwnedBlueprint[]): OwnedGroup[] {
  const groups = new Map<number, OwnedBlueprint[]>();
  for (const blueprint of owned) {
    const list = groups.get(blueprint.blueprintTypeID) ?? [];
    list.push(blueprint);
    groups.set(blueprint.blueprintTypeID, list);
  }
  return [...groups.values()].map((copies) => {
    const first = copies[0] as OwnedBlueprint;
    return {
      blueprintTypeID: first.blueprintTypeID,
      blueprintName: first.blueprintName,
      productTypeID: first.productTypeID,
      copies,
    };
  });
}

/**
 * A group's line under its name: how many copies, then the copy it is planned
 * with (`shown`) - kind, efficiencies as material/time, and who holds it.
 */
export function groupWords(group: OwnedGroup, shown: OwnedBlueprint): string {
  const kind = shown.original
    ? "Original"
    : `Copy, ${shown.runs ?? 0} ${shown.runs === 1 ? "run" : "runs"}`;
  const copy = `${kind} ${shown.materialEfficiency}/${shown.timeEfficiency} - ${shown.characterName}${shown.busy ? " - in a job" : ""}`;
  return group.copies.length > 1 ? `${group.copies.length} copies - ${copy}` : copy;
}
