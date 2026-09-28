// Where a picked-up stack should go on THIS hull — the bot's side of the
// "which bay?" question the inventory panel answers with a drag.
//
// ── THE RULE THIS FILE INHERITS ──────────────────────────────────────────────
//
// `holdFit.ts` states the operator's standing rule for holds: the SERVER judges
// validity (can this type go in this bay at all), and the browser only decides
// what to ASK for. This module keeps that rule. The table below is a
// PREFERENCE, never a verdict:
//
//   * a type the table does not know goes to the cargo hold;
//   * a bay the hull does not have goes to the next choice, then to cargo;
//   * a bay that REFUSES goes to the cargo hold (the caller retries there).
//
// So a wrong or incomplete row in `BAY_PREFERENCES` costs one refused call and
// a cargo-bound retry. It can never strand loot.
//
// ── WHY A PREFERENCE IS ALL IT CAN BE ────────────────────────────────────────
//
// The emulator does not enforce hold eligibility. `refusals.ts` pins the
// EXHAUSTIVE list of UserError codes reachable through every call this client
// is allowed to make — enumerated from eve.js's own throw sites, not guessed —
// and the only hold-related code in it is `NotEnoughCargoSpace`, which means
// "no room", not "wrong sort of thing". There is no CannotBeInHold, no
// InvalidHold, no wrong-type code at all. So as far as anything in this repo
// has ever observed, a bay refuses on CAPACITY and nothing else.
//
// That cuts both ways, and it is why the table is written as taste rather than
// law: the server will not stop the client putting ore in the ammo hold, so
// getting it right is entirely on this file — and getting it wrong is cheap.
//
// ── WHY NOT JUST PUT EVERYTHING IN CARGO ─────────────────────────────────────
//
// Because that is what caused the bug this module exists to fix. A mining or
// hauling hull's cargo hold is tiny next to its ore hold, so ore-bearing loot
// trickled in a few units at a time. Routing by bay is what makes a hauler's
// specialised space usable at all.

import type { InventoryItemRow, ShipBay } from "../store/types.ts";

/** One group of rows bound for one destination. `bay: null` is the cargo hold. */
export interface BayGroup {
  readonly bay: string | null;
  readonly itemIDs: readonly number[];
}

/**
 * Bays a bot may FILL with what it picks up, and EMPTY into the station hangar
 * when it gets home. One set, deliberately, because the two must never diverge:
 * a bay a bot can deposit into but not unload is a hold that fills up once and
 * then refuses every future pickup for the rest of the run. That is precisely
 * the trap that produced 227 straight refusals over twelve hours, one bay over.
 *
 * ⚠ THIS IS NOT "EVERY BAY". A ship's KIT lives in bays too — drones, jump
 * fuel, ammunition, fighters, subsystems, the hulls in a maintenance bay. An
 * unload that stripped those would turn a drop-off into a stranding, and a
 * pickup that filled them would spend the ship's own reserves on loot. So the
 * kit bays are absent from this set in both directions.
 *
 * The judgement call worth knowing about: the ammo hold and the fuel bay are
 * treated as kit, even though a Hoarder's 41,000 m³ ammo hold is plainly
 * freight to somebody hauling charges for a living. There is no way to tell
 * those two cases apart from the bay alone, and the safe default is the one
 * that cannot disarm a ship. A block argument to opt in belongs on the
 * unload/loot steps, not in a static set here.
 *
 * The cargo hold is not in the set because it is not addressed as a bay — it is
 * the `{kind:"cargo"}` place, always both the fallback and always swept.
 */
export const FREIGHT_BAYS: ReadonlySet<string> = new Set([
  "ore",
  "gas",
  "ice",
  "asteroid",
  "mineral",
  "salvage",
  "planetary",
  "commandCenter",
  "expedition",
  // Kit on a combat hull, freight on a Hoarder, and there is no way to tell the
  // two apart from the bay alone. They are here because the operator asked for
  // them to be supported, and because a bay a bot may FILL must be one it can
  // also EMPTY — the alternative is a hold that fills once and then turns down
  // every later pickup for the rest of the run.
  //
  // A ship that must keep its own charges or jump fuel says so with the
  // `exceptBays` argument on the unload block, which keeps a named bay out of
  // BOTH directions.
  "ammo",
  "fuel",
]);

/**
 * A routing rule: rows matching `groupIDs` (checked first) or `categoryIDs`
 * prefer `bays`, in order, and take the first one the hull actually has.
 */
export interface BayPreference {
  /** Destinations, most specific first. Every entry must be in FREIGHT_BAYS. */
  readonly bays: readonly string[];
  readonly categoryIDs?: readonly number[];
  readonly groupIDs?: readonly number[];
}

// The game's own classification numbers, named once so the table below reads as
// intent rather than as magic. These are the ids the SERVER stamps on the row —
// nothing here re-derives them.
const CATEGORY_ASTEROID = 25; // every mineable ore, ice and harvestable gas
const CATEGORY_MATERIAL = 4; // refined minerals, salvage, components
// ⚠ 465 IS RAW ICE; 423 IS "ICE PRODUCT". Checked against the live static data,
// because this file had them the wrong way round: Clear Icicle and Blue Ice are
// group 465 in category 25 (Asteroid), while group 423 in category 4 (Material)
// is the REFINED output — isotopes, Heavy Water, Liquid Ozone, Strontium. Ice
// was therefore falling through to the ore hold and isotopes were being sent to
// the ice hold, which is the opposite of both.
const GROUP_ICE = 465;
const GROUP_ICE_PRODUCT = 423;
const GROUP_FUEL_BLOCK = 1136;
const CATEGORY_CHARGE = 8;
const GROUP_HARVESTABLE_CLOUD = 711;
const GROUP_MINERAL = 18;
const GROUP_SALVAGED_MATERIAL = 754;
const GROUP_COMMAND_CENTER = 1027;
const CATEGORY_PLANETARY = 43;

/**
 * Which bay each sort of cargo wants, most specific destination first.
 *
 * ORDER WITHIN THE LIST MATTERS: group rules are asked before category rules,
 * so a refinement (ice, which is category 25 like ore) can claim its own hold
 * before the category-wide rule sends it to the general one.
 *
 * ⚠ THE ORE HOLD IS A MINING HOLD. CCP renamed and widened flag 134 in patch
 * 19.11 (Dec 2021): "The 'Ore Hold' has been renamed to the 'Mining Hold'. This
 * hold is a generic hold that allows for all harvestable resources to be held
 * inside it (Asteroid & Moon ore, Gas, and Ice)." That is why ice and gas name
 * "ore" as their SECOND choice — a Retriever has no ice hold, and ice belongs
 * in its mining hold rather than trickling into a 350 m³ cargo bay.
 * https://www.eveonline.com/news/view/patch-notes-version-19-11
 *
 * Compression does not change an item's category, so compressed ore and ice
 * route exactly as their uncompressed form does.
 */
export const BAY_PREFERENCES: readonly BayPreference[] = Object.freeze([
  // Raw ice → the ice hold (Kryos), else the mining hold that also takes it.
  { bays: ["ice", "ore"], groupIDs: [GROUP_ICE] },
  // Jump fuel and the rest of the ice products. Isotopes are the load-bearing
  // case; Heavy Water, Liquid Ozone and Strontium share their group and are
  // fuel-class consumables too, so they ride along rather than being split out
  // on a guess. Fuel blocks are their own group and go the same way.
  { bays: ["fuel"], groupIDs: [GROUP_ICE_PRODUCT, GROUP_FUEL_BLOCK] },
  // Every charge: ammunition, missiles, capacitor boosters, scripts, crystals.
  { bays: ["ammo"], categoryIDs: [CATEGORY_CHARGE] },
  // Harvested gas → the gas hold (Hoarder), else the mining hold.
  { bays: ["gas", "ore"], groupIDs: [GROUP_HARVESTABLE_CLOUD] },
  // Refined minerals → the mineral hold (Kryos). NOT the mining hold: 134 takes
  // harvestable resources, and Tritanium is a refined product, not one.
  { bays: ["mineral"], groupIDs: [GROUP_MINERAL] },
  // Salvaged materials → the salvage hold where a hull has one. Flag 137 may be
  // legacy — no current hull was found documented as exposing it — which costs
  // nothing: with no such bay present the rule simply never fires.
  { bays: ["salvage"], groupIDs: [GROUP_SALVAGED_MATERIAL] },
  // Command centers → their own Epithal hold before the general PI one.
  { bays: ["commandCenter", "planetary"], groupIDs: [GROUP_COMMAND_CENTER] },
  // Planetary commodities → the Epithal's PI hold.
  { bays: ["planetary"], categoryIDs: [CATEGORY_PLANETARY] },
  // Everything else mineable → the mining hold, then the legacy asteroid hold.
  { bays: ["ore", "asteroid"], categoryIDs: [CATEGORY_ASTEROID] },
]);

// Deliberately unmapped, and each for a reason:
//
//   drone, fighter, subsystem, shipMaintenance, ship*, booster, corpse,
//   quafe, fleet, mobileDepot — not cargo in any hull's case.
//
// CATEGORY_MATERIAL is named above but intentionally has no category-wide rule:
// it covers minerals, salvage and components alike, and only the two GROUPS
// above have a bay that wants them. A category-wide rule would sweep components
// into the mineral hold on nothing but a shared parent.
void CATEGORY_MATERIAL;

/** True when the hull is known to HAVE this bay. `null` (unread) is not "yes". */
function bayIsPresent(bays: readonly ShipBay[], key: string): boolean {
  return bays.some((bay) => bay.key === key && bay.present === true);
}

/**
 * The bays a row prefers, most specific first — empty when nothing claims it.
 *
 * A row whose `categoryID` AND `groupID` are both unreadable prefers nothing,
 * and so lands in cargo: "we could not tell" is never read as a specialised
 * bay, the same rule `refine-ore` applies when it refuses to refine a row it
 * cannot classify.
 */
export function preferredBays(
  row: Pick<InventoryItemRow, "categoryID" | "groupID">,
  preferences: readonly BayPreference[] = BAY_PREFERENCES,
): readonly string[] {
  for (const preference of preferences) {
    if (row.groupID !== null && (preference.groupIDs ?? []).includes(row.groupID)) {
      return preference.bays;
    }
  }
  for (const preference of preferences) {
    if (row.categoryID !== null && (preference.categoryIDs ?? []).includes(row.categoryID)) {
      return preference.bays;
    }
  }
  return [];
}

/**
 * One transfer to issue: some rows to one destination. `qty` is set only for a
 * SPLIT, which the bridge allows on a single stack alone.
 */
export interface BayTransfer {
  readonly bay: string | null;
  readonly itemIDs: readonly number[];
  readonly qty: number | null;
}

/**
 * Everything the ship can take from a can, allocated across its bays.
 *
 * A row walks its chain of SPECIALISED bays in order — an ice hold before the
 * mining hold that also takes ice — taking room wherever there is some and
 * splitting when only part of a stack fits. The cargo hold is the chain only for
 * a row that has no specialised bay on this hull at all; see the note in the
 * body on why a full bay must not fall through to it.
 *
 * Room is tracked as it is allocated, so two stacks bound for the same bay
 * cannot both be promised the same cubic metre.
 *
 * `freeFor` returning null means that destination's room could not be READ. A
 * row that reaches such a destination is handed over whole and the server judges
 * it — holdFit's standing rule — and the chain stops there, because there is no
 * arithmetic left to do.
 */
export function planLootTransfers(
  rows: readonly InventoryItemRow[],
  bays: readonly ShipBay[],
  freeFor: (bay: string | null) => number | null,
  preferences: readonly BayPreference[] = BAY_PREFERENCES,
): readonly BayTransfer[] {
  const room = new Map<string | null, number | null>();
  const roomFor = (bay: string | null): number | null => {
    if (!room.has(bay)) {
      room.set(bay, freeFor(bay));
    }
    return room.get(bay) ?? null;
  };

  // Whole-stack moves per destination merge into one call; a split needs its own.
  const whole = new Map<string | null, number[]>();
  const splits: BayTransfer[] = [];
  const order: (string | null)[] = [];
  const noteWhole = (bay: string | null, itemID: number): void => {
    const bucket = whole.get(bay);
    if (bucket === undefined) {
      whole.set(bay, [itemID]);
      order.push(bay);
    } else {
      bucket.push(itemID);
    }
  };

  for (const row of rows) {
    // ⚠ THE CARGO HOLD IS NOT A BACKSTOP FOR A FULL SPECIALISED BAY. The
    // operator's rule, and it is not a preference: "if the ore bay exists, no
    // ore in ship cargo." So cargo ends the chain only for a row that has NO
    // specialised bay on this hull — never for one whose bay is merely full.
    //
    // It is also the safe reading. `deliver-ore` empties the specialised holds
    // and falls back to cargo only on a hull that has none, so ore pushed into
    // the cargo hold of a barge is ore nothing will ever unload: it would sit
    // there taking room until the hold jammed, which is the dead end this whole
    // line of work started from.
    //
    // What does not fit the right bay stays in the can and waits for a trip
    // with room.
    const preferred = preferredBays(row, preferences).filter((key) => bayIsPresent(bays, key));
    const chain: (string | null)[] = preferred.length > 0 ? preferred : [null];
    let left = row.quantity;
    const unit = row.volume ?? null;
    for (const bay of chain) {
      if (left <= 0) {
        break;
      }
      const free = roomFor(bay);
      if (free === null || unit === null || !(unit > 0)) {
        // Nothing measurable here. Hand over what is left and let the server
        // rule on it; there is no point walking further down the chain on a
        // guess.
        splits.push({ bay, itemIDs: [row.itemID], qty: left === row.quantity ? null : left });
        left = 0;
        break;
      }
      const fits = Math.min(left, Math.floor(free / unit));
      if (fits <= 0) {
        continue;
      }
      if (fits === row.quantity) {
        noteWhole(bay, row.itemID);
      } else {
        splits.push({ bay, itemIDs: [row.itemID], qty: fits });
      }
      room.set(bay, free - fits * unit);
      left -= fits;
    }
    // Whatever is still left fits nowhere on this hull. It stays in the can.
  }

  const out: BayTransfer[] = [];
  for (const bay of order) {
    if (bay === null) {
      continue;
    }
    out.push({ bay, itemIDs: whole.get(bay) ?? [], qty: null });
  }
  out.push(...splits.filter((transfer) => transfer.bay !== null));
  // Cargo last, so the fallback is spent on what genuinely had nowhere else.
  const cargoWhole = whole.get(null);
  if (cargoWhole !== undefined && cargoWhole.length > 0) {
    out.push({ bay: null, itemIDs: cargoWhole, qty: null });
  }
  out.push(...splits.filter((transfer) => transfer.bay === null));
  return out.filter((transfer) => transfer.itemIDs.length > 0);
}

/**
 * Split `rows` into one group per destination, given what the hull actually has.
 *
 * Groups come back in a STABLE order — specialised bays in the order
 * `BAY_PREFERENCES` names them, cargo last. Cargo goes last on purpose: it is
 * the fallback, so letting the specialised bays take their share first means
 * cargo space is spent on the rows that genuinely had nowhere better to go,
 * rather than on whichever rows happened to be listed earliest.
 *
 * An empty `rows` yields no groups. A row is never in two groups.
 */
export function planBayTransfers(
  rows: readonly InventoryItemRow[],
  bays: readonly ShipBay[],
  preferences: readonly BayPreference[] = BAY_PREFERENCES,
): readonly BayGroup[] {
  const byBay = new Map<string, number[]>();
  const toCargo: number[] = [];
  for (const row of rows) {
    // The first CHOICE the hull can actually honour. A bay we could not read is
    // skipped exactly like an absent one: an unknown bay is not somewhere to
    // send a stack speculatively when the cargo hold is known to exist.
    const wanted = preferredBays(row, preferences).find((key) => bayIsPresent(bays, key));
    if (wanted === undefined) {
      toCargo.push(row.itemID);
      continue;
    }
    const bucket = byBay.get(wanted);
    if (bucket === undefined) {
      byBay.set(wanted, [row.itemID]);
    } else {
      bucket.push(row.itemID);
    }
  }
  const groups: BayGroup[] = [];
  for (const preference of preferences) {
    for (const key of preference.bays) {
      const itemIDs = byBay.get(key);
      if (itemIDs !== undefined && itemIDs.length > 0) {
        groups.push({ bay: key, itemIDs });
        byBay.delete(key);
      }
    }
  }
  if (toCargo.length > 0) {
    groups.push({ bay: null, itemIDs: toCargo });
  }
  return groups;
}
