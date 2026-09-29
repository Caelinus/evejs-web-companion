// Private route contract over upstream inventory reads, transfers and bay routing.
// The manifest owns quantities, including a split merged into an existing stack.
import type { MacroStep } from "../bots/botScript.ts";
import type { InventoryItemRow, InventoryPlace } from "../store/types.ts";
import { planLootTransfers } from "../bridge/bayRouting.ts";
import { pickedRows, type KeepRule } from "../bridge/keepAboard.ts";
import type { MacroDecider, MacroTick, ScriptAction } from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";

type Place = Extract<InventoryPlace, { kind: "corp" | "cargo" | "shipBay" }>;
interface Leg { source: number; destination: number; pickup: number; delivery: number; rules: readonly KeepRule[] }
interface Owned { itemID: number; typeID: number; quantity: number; bay: string | null }
interface Pending {
  from: Place; to: Place; itemID: number; typeID: number; quantity: number;
  source: readonly InventoryItemRow[]; destination: readonly InventoryItemRow[];
  bay: string | null;
}
interface State {
  reverse: boolean; delivering: boolean; manifest: readonly Owned[];
  pending?: Pending; blind?: number; fault?: string;
}
const fresh = (): State => ({ reverse: false, delivering: false, manifest: [] });
const station = (s: MacroStep, key: string) => { const a = s.args[key]; return a?.kind === "station" ? a.ref.id : null; };
const division = (s: MacroStep, key: string) => { const a = s.args[key]; return a?.kind === "corpDivision" ? a.division : null; };
const validID = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n > 0;
const validDivision = (n: number | null): n is number => validID(n) && n <= 7;
function rules(s: MacroStep, key: string): readonly KeepRule[] | null {
  const a = s.args[key];
  // An omitted filter intentionally means all eligible items. A present but
  // unresolved pick must never be widened to that same empty rule list.
  if (a === undefined) return [];
  if (a.kind === "itemType") return validID(a.typeID) ? [{ match: "type", typeID: a.typeID }] : null;
  if (a.kind !== "itemList" || a.items.length === 0) return null;
  return a.items.every((item) =>
    item.match === "type" ? validID(item.typeID) :
    item.match === "group" ? validID(item.groupID) :
    item.match === "name" && item.pattern.trim().length > 0) ? a.items : null;
}
export function haulingLeg(step: MacroStep, reverse = false): Leg | null {
  const all = step.macro === "haul-all";
  const source = station(step, all ? "pickupStation" : reverse ? "stationB" : "stationA");
  const destination = station(step, all ? "deliveryStation" : reverse ? "stationA" : "stationB");
  const pickup = division(step, all ? "pickupCorpDivision" : reverse ? "pickupDivisionB" : "pickupDivisionA");
  const delivery = division(step, all ? "deliveryCorpDivision" : reverse ? "deliveryDivisionA" : "deliveryDivisionB");
  const filter = rules(step, all ? "item" : reverse ? "itemsBToA" : "itemsAToB");
  if (!validID(source) || !validID(destination) || !validDivision(pickup) || !validDivision(delivery) ||
      (source === destination && pickup === delivery) || filter === null) return null;
  return { source, destination, pickup, delivery, rules: filter };
}
function rowsAt(o: ScriptObservation, p: Place): readonly InventoryItemRow[] | null {
  if (p.kind === "corp") return o.haulDivisions?.[p.division] ?? null;
  if (p.kind === "cargo") return o.cargo?.rows ?? null;
  const bay = o.shipBays?.find(b => b.key === p.bay);
  return bay?.present === true ? bay.items : null;
}
const shipPlace = (bay: string | null): Place => bay === null ? { kind: "cargo" } : { kind: "shipBay", bay };
const total = (rows: readonly InventoryItemRow[], typeID: number) => rows.filter(r => r.typeID === typeID).reduce((n, r) => n + r.quantity, 0);

/** Both sides must agree EXACTLY. A source disappearance alone is not delivery. */
export function verifyHaulMovement(p: Pending, source: readonly InventoryItemRow[], destination: readonly InventoryItemRow[]): readonly Owned[] | null {
  const before = p.source.find(r => r.itemID === p.itemID);
  const after = source.find(r => r.itemID === p.itemID);
  if (!before || before.typeID !== p.typeID || (after && after.typeID !== p.typeID) ||
      before.quantity - (after?.quantity ?? 0) !== p.quantity ||
      total(p.source, p.typeID) - total(source, p.typeID) !== p.quantity ||
      total(destination, p.typeID) - total(p.destination, p.typeID) !== p.quantity) return null;
  const beforeByID = new Map(p.destination.filter(r => r.typeID === p.typeID).map(r => [r.itemID, r.quantity]));
  if ([...beforeByID].some(([id, qty]) => (destination.find(r => r.itemID === id)?.quantity ?? 0) < qty)) return null;
  const added = destination.filter(r => r.typeID === p.typeID).map(r => ({
    itemID: r.itemID, typeID: r.typeID, quantity: r.quantity - (beforeByID.get(r.itemID) ?? 0), bay: p.bay,
  })).filter(r => r.quantity > 0);
  return added.reduce((n, r) => n + r.quantity, 0) === p.quantity ? added : null;
}

export function createCorporateHauler(ride: (o: ScriptObservation, stationID: number, phase: string) => MacroTick | null): MacroDecider {
  return (step, obs, mem) => {
    let state: State = (mem["haul"] as State | undefined) ?? fresh();
    const emit = (why: string, action: ScriptAction = { kind: "wait" }, outcome: MacroTick["outcome"] = { kind: "acting" }): MacroTick => ({
      action, why, phase: state.delivering ? "Delivering route cargo" : "Loading route cargo", armed: false,
      outcome, nextMem: { ...mem, haul: state },
    });
    const fail = (why: string) => { state = { ...state, fault: why }; return emit(why, { kind: "wait" }, { kind: "blocked", reason: why }); };
    if (state.fault) return fail(state.fault);
    const back = step.args["returnCargo"];
    const bidirectional = step.macro === "route-hauler" && back?.kind === "toggle" && back.enabled;
    const leg = haulingLeg(step, state.reverse);
    if (!leg || (bidirectional && !haulingLeg(step, true))) return fail("Pick valid corporation divisions and resolve any item filter before hauling.");
    const bayArg = step.args["transportBay"];
    if (bayArg && (bayArg.kind !== "place" || !["cargo", "ore-hold"].includes(bayArg.place))) return fail("Choose cargo, ore hold, or leave the hold choice unset for automatic routing.");
    const at = state.delivering ? leg.destination : leg.source;
    const trip = ride(obs, at, "Following the hauling route");
    if (trip) {
      if (state.pending) return fail("The ship changed station before its last transfer was verified. Check the route cargo before restarting.");
      return { ...trip, nextMem: { ...mem, haul: state } };
    }
    const corp: Place = { kind: "corp", division: state.delivering ? leg.delivery : leg.pickup };
    const corpRows = rowsAt(obs, corp);
    const bays = obs.shipBays;
    if (corpRows === null || bays == null || obs.cargo == null) {
      state = { ...state, blind: (state.blind ?? 0) + 1 };
      return (state.blind ?? 0) > 5 ? fail("The corporation division or ship holds could not be read; hauling stopped.") : emit("Reading corporation cargo and ship holds.");
    }
    state = { ...state, blind: 0 };
    if (state.pending) {
      const p = state.pending;
      const source = rowsAt(obs, p.from), destination = rowsAt(obs, p.to);
      if (source === null || destination === null) return fail("A transfer could not be verified. Check the cargo before restarting.");
      const added = verifyHaulMovement(p, source, destination);
      if (added === null) return fail("The transfer was partial, refused or ambiguous. Check the cargo before restarting; it has not counted as a delivery.");
      if (state.delivering) {
        state = { ...state, pending: undefined, manifest: state.manifest.filter(r => !(r.itemID === p.itemID && r.bay === p.bay)) };
      } else {
        const manifest = [...state.manifest];
        for (const entry of added) {
          const index = manifest.findIndex(r => r.itemID === entry.itemID && r.bay === entry.bay);
          if (index < 0) manifest.push(entry);
          else manifest[index] = { ...entry, quantity: entry.quantity + manifest[index]!.quantity };
        }
        state = { ...state, pending: undefined, manifest };
      }
      return emit("The route transfer is verified.");
    }
    const transfer = (row: InventoryItemRow, quantity: number, from: Place, to: Place, bay: string | null): MacroTick => {
      const source = rowsAt(obs, from), destination = rowsAt(obs, to);
      if (source === null || destination === null || !Number.isSafeInteger(quantity) || quantity <= 0 ||
          !validID(obs.myCorporationID ?? null)) return fail("Transfer quantities, corporation, or contents are unreadable.");
      state = { ...state, pending: { from, to, itemID: row.itemID, typeID: row.typeID, quantity, source, destination, bay } };
      return emit("Moving the route's cargo; both inventories will be checked.", { kind: "haulTransfer", itemID: row.itemID, quantity, from, to,
        stationID: at, corporationID: obs.myCorporationID as number, division: corp.division,
        typeID: row.typeID, sourceQuantity: row.quantity });
    };
    if (state.delivering) {
      const owned = state.manifest[0];
      if (owned) {
        const from = shipPlace(owned.bay);
        const row = rowsAt(obs, from)?.find(r => r.itemID === owned.itemID && r.typeID === owned.typeID);
        if (!row || row.quantity < owned.quantity) return fail("Manifest cargo is missing or changed. Nothing unrelated will be delivered.");
        return transfer(row, owned.quantity, from, corp, owned.bay);
      }
      state = { ...fresh(), reverse: bidirectional ? !state.reverse : false };
      return emit("Delivery verified; preparing the next route leg.");
    }
    const needsNames = leg.rules.some(r => r.match === "name");
    if (needsNames && corpRows.some(r => !obs.typeNames?.[r.typeID])) return fail("Item names could not be read; the route cannot safely select cargo.");
    const named = corpRows.map(r => ({ ...r, name: obs.typeNames?.[r.typeID] ?? null }));
    const wanted = leg.rules.length === 0 ? named : pickedRows(named, leg.rules, "skip");
    const freeFor = (key: string | null) => {
      const cap = key === null ? obs.cargo?.capacity : bays.find(b => b.key === key)?.capacity;
      return cap == null ? null : Math.max(0, cap.capacity - cap.used);
    };
    // Same planner as upstream load-cargo, with no duplicate bay preferences.
    const plans = planLootTransfers(wanted, bays, freeFor).filter(p => bayArg === undefined ||
      (bayArg.kind === "place" && (bayArg.place === "cargo" ? p.bay === null : p.bay === "ore")));
    const plan = plans[0];
    const row = plan && wanted.find(r => r.itemID === plan.itemIDs[0]);
    if (row && plan) return transfer(row, plan.qty ?? row.quantity, corp, shipPlace(plan.bay), plan.bay);
    if (state.manifest.length > 0) {
      state = { ...state, delivering: true };
      return emit("The shipload is ready for its corporation destination.");
    }
    if (wanted.length > 0) return fail("Selected cargo does not fit its intended hold. Free that hold or change the route's hold restriction.");
    if (step.macro === "haul-all") return emit("All selected cargo has been delivered.", { kind: "wait" }, { kind: "done" });
    if (bidirectional) state = { ...fresh(), reverse: !state.reverse };
    return emit("No selected cargo here; waiting for the next route load.");
  };
}
