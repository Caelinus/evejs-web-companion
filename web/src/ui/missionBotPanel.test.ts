// The R36 mission-bot panel as it actually RENDERS.
//
// The panel is a pure reader, so what it can get wrong is narrow but expensive:
//
//   1. THE AGENT'S STATION. Jobs must be taken on in person, so the plan the
//      panel builds has to name the AGENT'S station — not whichever one the
//      player happens to be standing in when they press Start. Getting this
//      wrong sends the bot to ask for work from someone who is not there, and
//      it is invisible until the bot has flown somewhere pointless.
//   2. NOT BEING NARROWER THAN THE BOT. A station with no distribution agent is
//      the ordinary case (the live R36 run started at one). The ladder can fly
//      to a remote agent, so the picker must be able to offer one.
//   3. The standing invariants — R7d (no visible numeric IDs), R9a (plain player
//      language), R8 (data-label on every cell of a reflow table).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const MissionBot = (await import("./MissionBot.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "MissionBot.svelte"), "utf8");

// The live R36 run's own numbers.
const HERE_STATION = 60000256; // Elonaya — no distribution agent
const AGENT = 3008416; // Antaken Kamola
const AGENT_STATION = 60000004; // Muvolailen
const MINING_AGENT = 3016072; // at Elonaya, and NOT a distribution agent

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

/** A store docked at Elonaya, whose only local agent deals in mining. */
function dockedStore(options: { withFinder?: boolean } = {}) {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: 30001399,
      stationID: HERE_STATION,
      structureID: null,
      shipID: 9988400091900,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "agents/list",
    stationID: HERE_STATION,
    agents: [
      {
        agentID: MINING_AGENT,
        agentTypeID: 2,
        divisionID: 23,
        level: 2,
        stationID: HERE_STATION,
        corporationID: 1000002,
        missionKind: "mining",
        missionTypeLabel: "UI/Agents/MissionTypes/Mining",
      },
    ],
  });
  if (options.withFinder) {
    store.apply({
      type: "finder/results",
      kind: "courier",
      level: null,
      originSystemID: 30001399,
      agents: [
        {
          agentID: AGENT,
          name: "Antaken Kamola",
          level: 1,
          missionKind: "courier",
          missionTypeLabel: "UI/Agents/MissionTypes/Courier",
          corporationID: 1000002,
          factionID: null,
          stationID: AGENT_STATION,
          stationName: "Muvolailen X - Moon 3 - CBD Corporation Storage",
          solarSystemID: 30002780,
          solarSystemName: "Muvolailen",
          jumps: 6,
        },
      ],
      total: 1,
      capped: false,
    });
  }
  return store;
}

function renderPanel(store: ReturnType<typeof createClientStore>): string {
  return render(MissionBot, { props: { store, flow: fakeFlow() } }).body;
}

test("a station with no distribution agent still offers one found elsewhere", () => {
  const body = renderPanel(dockedStore({ withFinder: true }));
  const text = visibleText(body);
  assert.match(
    text,
    /Antaken Kamola/,
    "the picker must offer a remote agent — the ladder can fly to one, so the control must not be narrower than the bot",
  );
  assert.match(text, /6 jumps/, "the player must see how far they are committing the ship");
});

test("a mining agent at this station is NOT offered as a delivery agent", () => {
  const body = renderPanel(dockedStore({ withFinder: true }));
  // The only local agent deals in mining; it must not appear in a delivery picker.
  assert.doesNotMatch(
    visibleText(body),
    /Mining/,
    "the picker filters on what the SERVER said the agent deals in",
  );
});

test("with nothing found yet, the panel says what to do rather than showing an empty picker", () => {
  // The copy wraps in the source, so match across whitespace rather than
  // pinning the panel's line breaks.
  const text = visibleText(renderPanel(dockedStore()));
  assert.match(text, /Agent\s+Finder/, "it must point at the thing that fills the list");
});

test("undocked, it says to dock — jobs are taken on in person", () => {
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: 30001399,
      stationID: null,
      structureID: null,
      shipID: 9988400091900,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  });
  assert.match(visibleText(renderPanel(store)), /Dock first/i);
});

test("the AGENT's station is what reaches the plan, never the one we are standing in", () => {
  // A render cannot press Start, so this asserts the wiring in the source: the
  // station handed to startMissionBot must come from the CHOSEN ROW.
  assert.match(
    SOURCE,
    /agentStationID:\s*stationID/,
    "the plan's agent station is the `stationID` derived value",
  );
  assert.match(
    SOURCE,
    /const stationID = \$derived\(chosen\?\.stationID \?\? 0\)/,
    "and that value must read the CHOSEN AGENT's station, not $agents.stationID or the docked station",
  );
  assert.doesNotMatch(
    SOURCE,
    /agentStationID:\s*\$agents\.stationID/,
    "reading the current station here would send the bot to an agent who is not there",
  );
});

test("R7d — no numeric id is ever rendered", () => {
  const text = visibleText(renderPanel(dockedStore({ withFinder: true })));
  // 1000002 is the corporation behind the Corporation filter's option — its
  // label must be a name (or a placeholder while it loads), never the corp id.
  for (const id of [AGENT, AGENT_STATION, HERE_STATION, MINING_AGENT, 1000002]) {
    assert.doesNotMatch(text, new RegExp(String(id)), `id ${id} must not reach the player`);
  }
});

test("the picker carries its filters, and they narrow what Start can use", () => {
  const text = visibleText(renderPanel(dockedStore({ withFinder: true })));
  // The filter row renders alongside the picker (Agent Finder style).
  assert.match(text, /Search \(name \/ station\)/);
  assert.match(text, /Level/);
  assert.match(text, /Corporation/);
  // A render cannot type into the search box, so the wiring is asserted in the
  // source: the options AND the chosen row must both come from the FILTERED
  // list — filtering the options while `chosen` still read the full list would
  // let Start fly to an agent the player had filtered out of sight.
  assert.match(
    SOURCE,
    /#each filteredChoices as choice/,
    "the picker's options are the filtered choices",
  );
  assert.match(
    SOURCE,
    /filteredChoices\.find\(\(row\) => row\.id === Number\(agentChoice\)\) \?\? filteredChoices\[0\]/,
    "`chosen` — what Start uses — falls inside the same filtered list",
  );
});

test("R9a — no jargon reaches the player", () => {
  const text = visibleText(renderPanel(dockedStore({ withFinder: true })));
  for (const word of [
    "agentID",
    "stationID",
    "typeID",
    "missionCompleted",
    "lastActionInfo",
    "CALL_REFUSED",
    "doAgentAction",
    "actionID",
  ]) {
    assert.doesNotMatch(text, new RegExp(word), `"${word}" is not player language`);
  }
});

test("R8 — every cell of the readout table carries a data-label for the reflow", () => {
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "mission-bot/started",
    agentName: "Antaken Kamola",
    stationName: "Muvolailen X - Moon 3 - CBD Corporation Storage",
    startedAt: Date.now(),
  });
  const body = renderPanel(store);
  const cells = body.match(/<td[^>]*>/g) ?? [];
  assert.ok(cells.length > 0, "the running readout must render its table");
  for (const cell of cells) {
    assert.match(cell, /data-label=/, `every <td> needs a data-label: ${cell}`);
  }
});

test("the readout shows the WHY, which is the whole point of the panel", () => {
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "mission-bot/started",
    agentName: "Antaken Kamola",
    stationName: "Muvolailen X - Moon 3 - CBD Corporation Storage",
    startedAt: Date.now(),
  });
  store.apply({
    type: "mission-bot/progress",
    status: "running",
    phase: "Flying",
    action: "Fly to the delivery point",
    why: "The cargo is aboard, so it goes to the delivery point.",
    agentName: "Antaken Kamola",
    missionName: null,
    cargoText: "1 units, 0.1 m³",
    destinationName: "Fly to the delivery point",
    jumpsRemaining: 4,
    missionsCompleted: 0,
    iskEarned: null,
    lpEarned: null,
    caution: null,
    failureReason: null,
  });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Why:/);
  assert.match(text, /The cargo is aboard/);
});

test("a CAUTION renders as its own note — neither a success nor a failure", () => {
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "mission-bot/started",
    agentName: "Antaken Kamola",
    stationName: null,
    startedAt: Date.now(),
  });
  store.apply({
    type: "mission-bot/progress",
    status: "running",
    phase: "Loading",
    action: "Load the cargo",
    why: "The cargo is in the hangar here, so it goes into the ship.",
    agentName: "Antaken Kamola",
    missionName: null,
    cargoText: null,
    destinationName: null,
    jumpsRemaining: null,
    missionsCompleted: 0,
    iskEarned: null,
    lpEarned: null,
    caution:
      "There is more than one stack here that matches this job's cargo, so the bot cannot be certain it loaded the right one.",
    failureReason: null,
  });
  const body = renderPanel(store);
  assert.match(visibleText(body), /cannot be certain/);
  // Svelte appends its own scoped class, so match the token, not the whole
  // attribute — the assertion is that it is `warn` and specifically NOT `error`.
  assert.match(body, /class="warn[ "]/, "a caution must render as its own kind of note");
  const cautionLine = body.match(/<p class="warn[^"]*">[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.doesNotMatch(
    cautionLine,
    /error/,
    "a caution is not a failure and must never be dressed as one",
  );
});

test("earnings render as bigint-safe amounts, and unknown reads as unknown", () => {
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "mission-bot/started",
    agentName: "Antaken Kamola",
    stationName: null,
    startedAt: Date.now(),
  });
  store.apply({
    type: "mission-bot/progress",
    status: "running",
    phase: "Working",
    action: "Working",
    why: "Working.",
    agentName: "Antaken Kamola",
    missionName: null,
    cargoText: null,
    destinationName: null,
    jumpsRemaining: null,
    missionsCompleted: 1,
    iskEarned: "140250",
    lpEarned: null,
    caution: null,
    failureReason: null,
  });
  const body = renderPanel(store);
  assert.match(visibleText(body), /140,250/, "ISK is formatted without going through Number");
  // ⚠ ASSERT ON THE CELL, NOT THE PAGE. A bare `/—/` over the whole panel passes
  // even when this value renders as 0, because Job / Cargo / Heading for are all
  // em-dashes too — a mutation run caught exactly that and it is the "green test
  // asserting nothing" shape this repo has been bitten by four times.
  const lpCell = body.match(/<td[^>]*data-label="LP earned"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";
  assert.equal(lpCell.trim(), "—", "an unmeasured payout reads as unknown, never as 0");
});

test("a FRACTIONAL payout formats with its grouping and its fraction intact", () => {
  // Wallets are not whole numbers (one insurance payout is "129271601.6"), so
  // the formatter must group the whole part without Number OR BigInt choking on
  // the point — the old amount() threw on the fraction and fell back to the raw
  // ungrouped string.
  const store = dockedStore({ withFinder: true });
  store.apply({
    type: "mission-bot/started",
    agentName: "Antaken Kamola",
    stationName: null,
    startedAt: Date.now(),
  });
  store.apply({
    type: "mission-bot/progress",
    status: "running",
    phase: "Working",
    action: "Working",
    why: "Working.",
    agentName: "Antaken Kamola",
    missionName: null,
    cargoText: null,
    destinationName: null,
    jumpsRemaining: null,
    missionsCompleted: 1,
    iskEarned: "129271601.6",
    lpEarned: null,
    caution: null,
    failureReason: null,
  });
  const body = renderPanel(store);
  const iskCell = body.match(/<td[^>]*data-label="ISK earned"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";
  assert.equal(iskCell.trim(), "129,271,601.6");
});
