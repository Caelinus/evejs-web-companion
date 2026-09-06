// A3 — every sentence a player reads about a VALID program, in one place.
//
// ⚠ THIS IS THE R9a REGISTER FOR THE PROGRAM VIEW. The codec owns the sentences
// for a REJECTED file (scriptCodec's SAY); this owns the sentences for a good
// one — a step, a condition, a repeat, an interrupt — so the editor and the run
// readout speak with one voice and a test can sweep them all.
//
// ⚠ R7d LIVES HERE TOO. Nothing in this file renders a numeric id. A world slot
// shows the NAME the reference carries, and when it has none it says "a station
// you pick" — never the number. The exhaustiveness switches carry no `default`,
// so a new macro or condition that arrives without a sentence fails to compile
// rather than reaching a player as a raw kind slug.

import type {
  BeltArg,
  BoardSlot,
  BranchBlock,
  Condition,
  InterruptResponse,
  InterruptRow,
  MacroID,
  MacroStep,
  Repeat,
  WorldRef,
} from "./botScript.ts";

/** A percentage a player reads — always with its unit, never a bare number. */
function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * An ISK amount a player reads — grouped with its unit. Grouping is pinned to
 * en-US so a big amount always breaks into runs of three digits (never a bare
 * 5+-digit run, which R7d treats as a leaked id), whatever the runtime locale.
 */
function isk(amount: number): string {
  return `${amount.toLocaleString("en-US")} ISK`;
}

/** A world reference as words — its name, or a "you pick" phrase; never its id (R7d). */
function worldRefPhrase(ref: WorldRef | null, pickNoun: string): string {
  if (ref !== null && ref.slot !== undefined) {
    return boardSlotPhrase(ref.slot);
  }
  if (ref !== null && ref.starting === true) {
    return "your starting station";
  }
  if (ref !== null && ref.name !== null && ref.name.length > 0) {
    return ref.name;
  }
  return `a ${pickNoun} you pick`;
}

function beltPhrase(belt: BeltArg): string {
  if (belt.mode === "nearest") {
    return "the nearest belt";
  }
  return worldRefPhrase(belt.ref, "belt");
}

/** The palette/menu name of a macro. */
export function macroName(macro: MacroID): string {
  switch (macro) {
    case "undock":
      return "Leave the station";
    case "travel-to-station":
      return "Fly to a station and dock";
    case "travel-to-belt":
      return "Fly to a belt";
    case "mine-at-belt":
      return "Mine at a belt";
    case "deliver-ore":
      return "Haul the ore home";
    case "defend-with-drones":
      return "Fight off rats with drones";
    case "find-distribution-agent":
      return "Find a delivery agent";
    case "request-mission":
      return "Ask the agent for work";
    case "accept-mission":
      return "Accept the mission";
    case "load-mission-cargo":
      return "Load the mission cargo";
    case "travel-to-dropoff":
      return "Fly the delivery";
    case "turn-in-mission":
      return "Turn the mission in";
    case "return-to-agent":
      return "Fly back to the agent";
    case "wait":
      return "Wait a while";
    case "unload-cargo":
      return "Empty the ship";
    case "salvage-wrecks":
      return "Salvage the wrecks";
    case "loot-wrecks":
      return "Loot your wrecks";
    case "loot-containers":
      return "Loot the containers";
    case "refine-ore":
      return "Refine the ore";
    case "hardeners-on":
      return "Hardeners on";
    case "fight-the-rats":
      return "Fight the rats";
    case "warp-to-anomaly":
      return "Fly to a pirate den";
    case "refit-ship":
      return "Refit from a saved fitting";
    case "move-items":
      return "Move items";
    case "warp-to-bookmark":
      return "Fly to a saved spot";
    case "find-combat-agent":
      return "Find a combat agent";
    case "fly-to-mission-site":
      return "Fly to the mission site";
    case "restart-extractors":
      return "Restart the planet extractors";
    case "repair-ship":
      return "Repair the ship";
    case "buy-item":
      return "Buy from the market";
    case "sell-item":
      return "Sell to the market";
    case "remote-rep":
      return "Remote-repair the fleet";
    case "orbit-and-boost":
      return "Orbit and boost a fleet-mate";
    case "create-fleet":
      return "Form a fleet";
    case "invite-to-fleet":
      return "Invite a pilot to your fleet";
    case "join-fleet":
      return "Join a fleet";
    case "set-destination":
      return "Set the destination and fly";
    case "dock-at-nearest":
      return "Dock at the nearest station";
    case "remote-cap":
      return "Feed a fleet-mate's capacitor";
    case "jettison-cargo":
      return "Jettison the cargo into space";
    case "jettison-ore":
      return "Jettison the ore hold into space";
    case "tidy-hangar":
      return "Tidy the hangar";
    case "compress-ore":
      return "Compress the ore on grid";
    case "launch-scan-probes":
      return "Launch scan probes";
    case "analyze-signatures":
      return "Analyze signatures";
    case "recover-scan-probes":
      return "Recover scan probes";
  }
}

/** A named board slot, as a player reads it — never a key, never an id. */
export function boardSlotPhrase(slot: BoardSlot): string {
  switch (slot) {
    case "agent-station":
      return "the agent's station";
    case "pickup-station":
      return "the mission's pickup station";
    case "dropoff-station":
      return "the mission's drop-off station";
  }
}

/** A place, as a player reads it. */
/**
 * What a player reads for a bay key. The keys are the bridge's vocabulary, not
 * words anybody chose to show — R9a says the screen gets language, so a key with
 * no entry here falls back to itself rather than having a name invented for it.
 */
const BAY_LABELS: Readonly<Record<string, string>> = {
  cargo: "cargo hold",
  ore: "ore hold",
  gas: "gas hold",
  ice: "ice hold",
  asteroid: "asteroid hold",
  mineral: "mineral hold",
  salvage: "salvage hold",
  ammo: "ammo hold",
  fuel: "fuel bay",
  planetary: "planetary hold",
  commandCenter: "command centre hold",
  fleet: "fleet hangar",
  drone: "drone bay",
};

export function placePhrase(place: string): string {
  switch (place) {
    case "hangar":
      return "the station hangar";
    case "cargo":
      return "the cargo hold";
    case "ore-hold":
      return "the ore hold";
    default:
      return "somewhere";
  }
}

/** A condition as a clause that reads after "until" or "if". */
export function conditionSentence(condition: Condition): string {
  switch (condition.kind) {
    case "ore-hold-at-least":
      return `the ore hold is ${pct(condition.fraction)} full`;
    case "hold-empty":
      return "the hold is empty";
    case "shield-below":
      return `shields drop below ${pct(condition.fraction)}`;
    case "armor-below":
      return `armor drops below ${pct(condition.fraction)}`;
    case "hull-below":
      return `the hull drops below ${pct(condition.fraction)}`;
    case "health-below":
      return `ship health drops below ${pct(condition.fraction)}`;
    case "capacitor-below":
      return `the capacitor drops below ${pct(condition.fraction)}`;
    case "wallet-below":
      return `your wallet drops below ${isk(condition.isk)}`;
    case "wallet-above":
      return `your wallet rises above ${isk(condition.isk)}`;
    case "hostile-on-grid":
      return "a pirate shows up";
    case "cargo-full":
      return `the cargo hold is ${pct(condition.fraction)} full`;
    case "targeted-by-player":
      return "another player locks onto your ship";
    case "drone-health-below":
      return `one of your drones drops below ${pct(condition.fraction)} health`;
  }
}

/**
 * A "run another saved bot" row, in plain words. Deliberately not possessive:
 * the library is platform-wide, so the bot this points at may well have been
 * saved by someone else.
 */
export function subBotSentence(node: { readonly name: string | null }): string {
  return node.name !== null && node.name.length > 0
    ? `Run the saved bot "${node.name}"`
    : "Run a saved bot you pick";
}

/** A branch's header line: the fork it makes, in plain words. */
export function branchSentence(branch: BranchBlock): string {
  const thenPart = branch.then.length === 0 ? "do nothing" : "do the first steps";
  const elsePart = branch.else.length === 0 ? "do nothing" : "do the other steps";
  return `If ${conditionSentence(branch.when)}, ${thenPart}; otherwise ${elsePart}`;
}

/** How a loop's repeat reads on its header row. */
export function repeatSentence(repeat: Repeat): string {
  if (repeat.kind === "forever") {
    return "Repeat forever";
  }
  return repeat.count === 1 ? "Repeat once" : `Repeat up to ${repeat.count} times`;
}

/** What a fired interrupt does, as a clause that reads after the condition. */
export function responseSentence(response: InterruptResponse): string {
  switch (response) {
    case "pause":
      return "get to a station and stop";
    case "dock-and-pause":
      return "dock at home and stop";
    case "launch-drones":
      return "send out drones and keep going";
    case "fight-back":
      return "harden up, fight back, and stand down when it is over";
    case "repair":
      return "run the repairers until it recovers";
    case "alert":
      return "let me know and keep going";
  }
}

/** The words an "alert me" watch shows when it fires — a whole sentence a player
 * reads on a phone notification, so it names the check, not the row. */
export function alertSentence(row: InterruptRow): string {
  return `Your bot noticed: ${conditionSentence(row.when)}.`;
}

/** A whole "always watching" row: "If shields drop below 30%, dock at home and stop". */
export function interruptSentence(row: InterruptRow): string {
  return `If ${conditionSentence(row.when)}, ${responseSentence(row.respond)}`;
}

/** A whole step: its macro, its bound slots, and its "until" when it carries one. */
export function stepSentence(step: MacroStep): string {
  const base = macroPhrase(step);
  if (step.until !== undefined) {
    return `${base} until ${conditionSentence(step.until)}`;
  }
  return base;
}

function macroPhrase(step: MacroStep): string {
  switch (step.macro) {
    case "undock":
      return "Leave the station";
    case "mine-at-belt": {
      const belt = step.args["belt"];
      const where = belt !== undefined && belt.kind === "belt" ? beltPhrase(belt.belt) : "a belt you pick";
      const pick = step.args["pick"];
      const order = pick !== undefined && pick.kind === "rockPick" && pick.pick === "biggest" ? ", biggest rocks first" : "";
      const ores = step.args["ores"];
      const oreNames = ores !== undefined && ores.kind === "oreList" ? ores.ores.map((ore) => ore.name).filter((name) => name.length > 0) : [];
      const oreWord = oreNames.length > 0 ? `, ${oreNames.join(" then ")} first` : "";
      return `Mine at ${where}${order}${oreWord}`;
    }
    case "travel-to-station": {
      const station = step.args["station"];
      const where =
        station !== undefined && station.kind === "station"
          ? worldRefPhrase(station.ref, "station")
          : "a station you pick";
      return `Fly to ${where} and dock`;
    }
    case "travel-to-belt": {
      const belt = step.args["belt"];
      const where = belt !== undefined && belt.kind === "belt" ? beltPhrase(belt.belt) : "a belt you pick";
      return `Fly to ${where}`;
    }
    case "deliver-ore": {
      const station = step.args["station"];
      const where =
        station !== undefined && station.kind === "station"
          ? worldRefPhrase(station.ref, "station")
          : "a station you pick";
      return `Haul the ore to ${where}`;
    }
    case "defend-with-drones":
      return "Fight off rats with your combat drones";
    case "find-distribution-agent": {
      const level = step.args["level"];
      const levelWord = level !== undefined && level.kind === "count" ? ` (level ${level.value})` : "";
      const corp = step.args["corporation"];
      const corpWord =
        corp !== undefined && corp.kind === "corp" && corp.name !== null && corp.name.length > 0
          ? ` working for ${corp.name}`
          : "";
      return `Find a delivery agent${levelWord}${corpWord}`;
    }
    case "request-mission": {
      const agent = step.args["agent"];
      const who =
        agent !== undefined && agent.kind === "agent"
          ? worldRefPhrase(agent.ref, "agent")
          : "the agent you found";
      return `Ask ${who} for work`;
    }
    case "accept-mission": {
      const jumps = step.args["maxJumps"];
      const cap =
        jumps !== undefined && jumps.kind === "count"
          ? ` if it is ${jumps.value} ${jumps.value === 1 ? "jump" : "jumps"} or fewer`
          : "";
      return `Accept the mission${cap}`;
    }
    case "load-mission-cargo":
      return "Load the mission cargo into your ship";
    case "travel-to-dropoff":
      return "Fly the delivery to the drop-off station";
    case "turn-in-mission":
      return "Hand the cargo over and turn the mission in";
    case "return-to-agent":
      return "Fly back to the agent's station";
    case "wait": {
      const seconds = step.args["seconds"];
      const n = seconds !== undefined && seconds.kind === "count" ? seconds.value : 10;
      return `Wait ${n} ${n === 1 ? "second" : "seconds"}`;
    }
    case "unload-cargo": {
      const except = step.args["exceptBays"];
      const names =
        except !== undefined && except.kind === "bayList"
          ? except.bays.map((key) => BAY_LABELS[key] ?? key)
          : [];
      return names.length === 0
        ? "Empty the ship into the hangar"
        : `Empty the ship into the hangar, but leave the ${names.join(" and ")} alone`;
    }
    case "hardeners-on":
      return "Switch every hardener and damage control on";
    case "fight-the-rats":
      return "Fight the rats until the grid is clear";
    case "warp-to-anomaly":
      return "Warp to the next pirate den the scanner shows";
    case "refit-ship": {
      const fit = step.args["fitting"];
      const name =
        fit !== undefined && fit.kind === "fitting" && fit.name !== null && fit.name.length > 0
          ? fit.name
          : "a fitting you pick";
      return `Refit the ship from ${name}`;
    }
    case "move-items": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const amount = step.args["amount"];
      const howMany = amount !== undefined && amount.kind === "count" ? `${amount.value} ` : "all the ";
      const from = step.args["from"];
      const to = step.args["to"];
      const fromWord = from !== undefined && from.kind === "place" ? placePhrase(from.place) : "somewhere";
      const toWord = to !== undefined && to.kind === "place" ? placePhrase(to.place) : "somewhere";
      return `Move ${howMany}${what} from ${fromWord} to ${toWord}`;
    }
    case "warp-to-bookmark": {
      const bm = step.args["bookmark"];
      const name =
        bm !== undefined && bm.kind === "bookmark" && bm.name !== null && bm.name.length > 0
          ? bm.name
          : "a spot you pick";
      return `Warp to ${name}`;
    }
    case "find-combat-agent": {
      const level = step.args["level"];
      const levelWord = level !== undefined && level.kind === "count" ? ` (level ${level.value})` : "";
      return `Find a combat agent${levelWord}`;
    }
    case "fly-to-mission-site":
      return "Warp to the mission's own site";
    case "restart-extractors":
      return "Restart every expired extractor on your planets";
    case "repair-ship":
      return "Repair the ship at the station";
    case "salvage-wrecks":
      return "Salvage the wrecks on this grid";
    case "loot-wrecks":
      return "Loot your own wrecks on this grid";
    case "loot-containers":
      return "Loot every container on this grid";
    case "refine-ore":
      return "Refine the ore in the hangar";
    case "buy-item": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const qty = step.args["quantity"];
      const howMany = qty !== undefined && qty.kind === "qty" ? qty.value.toLocaleString() : "some";
      const price = step.args["price"];
      const cap = price !== undefined && price.kind === "isk" ? ` at up to ${isk(price.value)} each` : "";
      return `Buy ${howMany} ${what}${cap}`;
    }
    case "sell-item": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const price = step.args["price"];
      const floor = price !== undefined && price.kind === "isk" ? ` at ${isk(price.value)} or more each` : "";
      return `Sell all your ${what}${floor}`;
    }
    case "remote-rep":
      return "Remote-repair the most hurt fleet-mate on grid";
    case "orbit-and-boost":
      return "Orbit a fleet-mate and keep the remote reps running";
    case "create-fleet":
      return "Form a fleet with you as the boss";
    case "invite-to-fleet": {
      const who = step.args["who"];
      const name =
        who !== undefined && who.kind === "character" && who.name !== null && who.name.length > 0
          ? who.name
          : "a pilot you pick";
      return `Invite ${name} to your fleet`;
    }
    case "join-fleet":
      return "Accept a fleet invitation when one arrives";
    case "set-destination": {
      const dest = step.args["destination"];
      const where =
        dest !== undefined && dest.kind === "destination"
          ? worldRefPhrase(dest.ref, dest.ref.entity === "system" ? "system" : "station")
          : "a place you pick";
      return `Set the destination to ${where} and start flying`;
    }
    case "dock-at-nearest":
      return "Dock at the nearest station";
    case "remote-cap":
      return "Feed the emptiest fleet-mate's capacitor";
    case "jettison-cargo": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? `all your ${item.name}`
          : "everything in the cargo hold";
      return `Jettison ${what} into space`;
    }
    case "jettison-ore": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? `all your ${item.name}`
          : "everything in the ore hold";
      return `Jettison ${what} into space`;
    }
    case "tidy-hangar":
      return "Stack everything in the hangar into neat piles";
    case "compress-ore":
      return "Compress the ore in your hold at the support ship on grid";
    case "launch-scan-probes":
      return "Launch the scan probes from your current ship";
    case "analyze-signatures":
      return "Analyze signatures with the current probe formation";
    case "recover-scan-probes":
      return "Recover every active scan probe to the ship";
  }
}
