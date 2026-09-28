// The R36 distribution-mission bot, driven against SYNTHETIC state exactly as
// `autopilotLoop.test.ts` and `miningBotLoop.test.ts` drive their ladders: each
// case hands the decision one reading of the world and asserts which single
// atomic action comes back, at the right rung and in the right order.
//
// ⚠ THE CONVERSATION FIXTURES ARE REAL CAPTURED BYTES, NOT INVENTED SHAPES.
// `refusedCompleteResult()` below is the exact marshaled payload the live server
// returned in R35 when Complete was pressed at the wrong station — copied from
// the capture in `app/agentsFlow.test.ts` and decoded through the REAL
// `decodeConversation`. That practice is what caught the `null`-vs-`false`
// divergence in the first place, and a hand-written `{missionCompleted: false}`
// would have hidden it, because `!== false` passes on a false and fails on a
// null. See "the whole reason this file exists" test.
//
// Four things are asserted over and over, because they are what makes a bot
// safe to walk away from:
//
//   1. A 200 IS NOT PROOF. `doAgentAction` answers success on every branch, so
//      every rung is confirmed against the authority that owns the fact — and
//      each test can make that authority disagree with the call.
//   2. NO ACTION TOKEN IS EVER CACHED. The server re-mints them across a move,
//      so the loop must re-read and use THIS tick's id.
//   3. NO BRANCH REPEATS UNBOUNDEDLY. Every rung gets a world in which it can
//      never make progress, and every one must stop with a readable reason.
//   4. THE GATES RUN BEFORE ACCEPT, and unknown never passes them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_JUMPS,
  MAX_ACCEPT_ATTEMPTS,
  MAX_COMPLETE_ATTEMPTS,
  MAX_LOAD_ATTEMPTS,
  MAX_REQUEST_ATTEMPTS,
  MAX_DECLINE_ATTEMPTS,
  MAX_STUCK_WAIT_TICKS,
  MAX_TRAVEL_RESTARTS,
  MAX_UNLOAD_ATTEMPTS,
  agentActionID,
  cargoRoom,
  completeActionID,
  completed,
  createMissionBot,
  decideMissionAction,
  findPackageStack,
  gateOffer,
  missionAccepted,
  packageAboard,
  subtractAmounts,
  type CargoReading,
  type MissionBotAction,
  type MissionBotDeps,
  type MissionBotProgress,
  type MissionDecisionMemory,
  type MissionObservation,
  type MissionPlan,
  type TravelReading,
} from "./missionBotLoop.ts";
import { AGENT_BUTTON, decodeConversation } from "../bridge/agents.ts";
import type {
  AgentConversation,
  CourierBriefing,
  FlightStatus,
  InventoryItemRow,
  JournalState,
} from "../store/types.ts";

// --- The live R35 run, as the numbers actually were --------------------------

const AGENT = 3008416;
const AGENT_STATION = 60000004; // Muvolailen — where the agent is, and the pickup
const AGENT_SYSTEM = 30002780;
const DROPOFF = 60000256; // Elonaya — the corp's lowest-solarSystemID station
const DROPOFF_SYSTEM = 30001399;
const REPORTS = 3814; // ordinary tradeable goods, which is the whole problem
const PACKAGE_ITEM = 1005001;

const PLAN: MissionPlan = {
  agentID: AGENT,
  agentName: "Antaken Kamola",
  agentStationID: AGENT_STATION,
  agentStationName: "Muvolailen X - Moon 3",
  maxJumps: DEFAULT_MAX_JUMPS,
  maxMissions: 0,
};

/** The live briefing, as R35 decoded it. 0.1 m³, 6 jumps away. */
const BRIEFING: CourierBriefing = {
  missionTitleID: 58607,
  cargoTypeID: REPORTS,
  cargoQuantity: 1,
  cargoVolume: 0.1,
  pickupLocationID: AGENT_STATION,
  pickupSystemID: AGENT_SYSTEM,
  destinationLocationID: DROPOFF,
  destinationSystemID: DROPOFF_SYSTEM,
  rewardISK: "102000",
  bonusISK: null,
  loyaltyPoints: 213,
  expirationTime: null,
  acceptTimestamp: null,
};

// --- synthetic world builders ------------------------------------------------

function status(overrides: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: false,
    docked: true,
    solarSystemID: AGENT_SYSTEM,
    stationID: AGENT_STATION,
    structureID: null,
    shipID: 9001,
    shipTypeID: null,
    shipIsCapsule: null,
    shipMode: "STOP",
    shipSpeedFraction: 0,
    ...overrides,
  };
}

function row(overrides: Partial<InventoryItemRow> & { itemID: number }): InventoryItemRow {
  return {
    typeID: REPORTS,
    groupID: null,
    categoryID: null,
    flagID: null,
    quantity: 1,
    singleton: false,
    ...overrides,
  };
}

function cargo(rows: readonly InventoryItemRow[], capacity = 4095, used = 0): CargoReading {
  return { rows, capacity: { capacity, used } };
}

/** A journal with the mission ACCEPTED against our agent. */
function journalAccepted(): JournalState {
  return {
    active: [
      {
        missionState: 2,
        missionTypeLabel: "Courier",
        missionTitleID: 58607,
        agentID: AGENT,
        missionID: 1,
        expirationTime: null,
      },
    ],
    offered: [],
  };
}

/** A journal with NO mission against our agent. */
function journalEmpty(): JournalState {
  return { active: [], offered: [] };
}

// --- REAL captured conversation bytes (R35) ----------------------------------

/**
 * The REFUSED Complete, exactly as the live server answered it when the button
 * was pressed docked at the PICKUP station instead of the dropoff. Copied
 * verbatim from the R35 capture in `app/agentsFlow.test.ts`:
 *
 *   * HTTP 200, ok:true — a refusal is indistinguishable from success by status
 *   * missionCompleted is `null`, NOT `false`
 *   * the available-actions list is EMPTY (no Complete, no Quit)
 */
function refusedCompleteResult() {
  return {
    type: "tuple",
    items: [
      {
        type: "tuple",
        items: [
          { type: "tuple", items: [127958, 1382] },
          { type: "list", items: [] },
        ],
      },
      {
        type: "dict",
        entries: [
          ["missionCompleted", null],
          ["missionQuit", null],
          ["missionCantReplay", null],
          ["loyaltyPoints", 0],
          ["missionDeclined", null],
        ],
      },
    ],
  };
}

/** A real SUCCESSFUL Complete: missionCompleted true, and LP that reads 0. */
function completedResult() {
  return {
    type: "tuple",
    items: [
      {
        type: "tuple",
        items: [
          { type: "tuple", items: [127959, 1383] },
          { type: "list", items: [] },
        ],
      },
      {
        type: "dict",
        entries: [
          ["missionCompleted", true],
          ["missionQuit", null],
          ["loyaltyPoints", 0],
          ["missionDeclined", null],
        ],
      },
    ],
  };
}

/** A conversation offering the given buttons with the given tokens. */
function conversationWith(pairs: ReadonlyArray<readonly [number, number]>): AgentConversation {
  return decodeConversation({
    type: "tuple",
    items: [
      {
        type: "tuple",
        items: [
          { type: "tuple", items: [127950, 1380] },
          { type: "list", items: pairs.map(([id, button]) => ({ type: "tuple", items: [id, button] })) },
        ],
      },
      { type: "dict", entries: [["missionCompleted", null], ["loyaltyPoints", 0]] },
    ],
  } as never);
}

const OFFERED = conversationWith([
  [815, AGENT_BUTTON.ACCEPT],
  [816, AGENT_BUTTON.DECLINE],
]);
const NO_MISSION = conversationWith([[810, AGENT_BUTTON.REQUEST_MISSION]]);
const AT_DROPOFF = conversationWith([
  [821, AGENT_BUTTON.COMPLETE],
  [822, AGENT_BUTTON.QUIT],
]);

function observation(overrides: Partial<MissionObservation> = {}): MissionObservation {
  return {
    status: status(),
    conversation: null,
    briefing: null,
    journal: journalEmpty(),
    cargo: cargo([]),
    hangar: [],
    travel: null,
    jumpsToDropoff: null,
    ...overrides,
  };
}

const NO_MEMORY: MissionDecisionMemory = {
  travellingTo: null,
  travellingToLabel: null,
  missionsCompleted: 0,
};

// =============================================================================
// 1. THE WHOLE REASON THIS FILE EXISTS: null is not false
// =============================================================================

test("a refused Complete decodes to missionCompleted null — and `=== true` is the only test that catches it", () => {
  const refused = decodeConversation(refusedCompleteResult() as never);

  // The captured fact, asserted directly so a decoder change cannot quietly
  // turn this fixture into something the bot handles by accident.
  assert.equal(
    refused.lastActionInfo.missionCompleted,
    null,
    "R35 measured null on a refusal, not false — if this is false the fixture has drifted",
  );
  assert.equal(refused.actions.length, 0, "a refusal comes back with an EMPTY actions list");

  // The bot's test says no.
  assert.equal(completed(refused), false, "a refusal must never read as completed");

  // And the shorthand this project was bitten by says YES. This assertion is
  // the point: it proves the two tests genuinely disagree on the real bytes, so
  // `completed()` is doing work rather than agreeing with everything.
  assert.equal(
    refused.lastActionInfo.missionCompleted !== false,
    true,
    "`!== false` reports this REFUSAL as a success — which is exactly why completed() is `=== true`",
  );
});

test("a real successful Complete reads as completed", () => {
  assert.equal(completed(decodeConversation(completedResult() as never)), true);
});

test("no conversation at all is not a completion", () => {
  assert.equal(completed(null), false);
});

// =============================================================================
// 2. THE LADDER — each rung fires at the right state
// =============================================================================

test("rung 1: docked at the agent with no mission asks for work", () => {
  const decision = decideMissionAction(
    observation({ conversation: NO_MISSION }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "request");
  assert.equal(
    (decision.action as Extract<MissionBotAction, { kind: "request" }>).actionID,
    810,
    "it must send the token THIS conversation carried",
  );
});

test("rung 2: an offer that passes both gates is accepted", () => {
  const decision = decideMissionAction(
    observation({ conversation: OFFERED, briefing: BRIEFING, jumpsToDropoff: 6 }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "accept");
  assert.equal((decision.action as Extract<MissionBotAction, { kind: "accept" }>).actionID, 815);
});

test("rung 3: accepted with the package still in the hangar loads it", () => {
  const decision = decideMissionAction(
    observation({
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([]),
      hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "loadPackage");
});

test("rung 4: the package aboard and the ship not at the dropoff flies there", () => {
  const decision = decideMissionAction(
    observation({
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([row({ itemID: PACKAGE_ITEM, quantity: 1 })]),
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "travel");
  assert.equal(
    (decision.action as Extract<MissionBotAction, { kind: "travel" }>).stationID,
    DROPOFF,
  );
});

test("rung 5: docked AT the dropoff with the package aboard unloads it", () => {
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([row({ itemID: PACKAGE_ITEM, quantity: 1 })]),
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "unloadPackage");
  assert.deepEqual(
    (decision.action as Extract<MissionBotAction, { kind: "unloadPackage" }>).itemIDs,
    [PACKAGE_ITEM],
  );
});

test("rung 5: the cargo delivered and Complete offered hands the job in", () => {
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      conversation: AT_DROPOFF,
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([]),
      hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "complete");
  assert.equal(
    (decision.action as Extract<MissionBotAction, { kind: "complete" }>).actionID,
    821,
    "the Complete token must come from the conversation read at the DROPOFF",
  );
});

test("an empty actions list at the dropoff WAITS — R35 proved it is not terminal", () => {
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      conversation: conversationWith([]),
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([]),
      hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(
    decision.action.kind,
    "wait",
    "no actions is 'not here, not now' — the same agent offered nothing at the pickup and Complete at the dropoff",
  );
});

test("accept must be in person: away from the agent it flies there rather than accepting", () => {
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      conversation: OFFERED,
      briefing: BRIEFING,
      jumpsToDropoff: 6,
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(
    decision.action.kind,
    "travel",
    "remote accept is silently refused for couriers, so the bot must go to the agent",
  );
  assert.equal(
    (decision.action as Extract<MissionBotAction, { kind: "travel" }>).stationID,
    AGENT_STATION,
  );
});

test("a flight of ours that is running is waited on — the bot steers nothing", () => {
  const travel: TravelReading = {
    status: "running",
    destinationStationID: DROPOFF,
    remainingJumps: 4,
    failureReason: null,
  };
  const decision = decideMissionAction(
    observation({ status: status({ docked: false, inSpace: true, stationID: null }), travel }),
    PLAN,
    { ...NO_MEMORY, travellingTo: DROPOFF },
  );
  assert.equal(decision.action.kind, "wait");
  assert.match(decision.why, /4 jumps/, "the readout must say how far there is left to go");
});

test("a flight that PAUSED surfaces the autopilot's own reason rather than a summary of it", () => {
  const travel: TravelReading = {
    status: "paused",
    destinationStationID: DROPOFF,
    remainingJumps: 2,
    failureReason: "The warp did not start and the ship has not moved.",
  };
  const decision = decideMissionAction(
    observation({ status: status({ docked: false, inSpace: true, stationID: null }), travel }),
    PLAN,
    { ...NO_MEMORY, travellingTo: DROPOFF },
  );
  assert.equal(decision.action.kind, "pause");
  assert.equal(
    (decision.action as Extract<MissionBotAction, { kind: "pause" }>).reason,
    "The warp did not start and the ship has not moved.",
  );
});

// =============================================================================
// 3. THE GATES — before Accept, never after, and unknown never passes
// =============================================================================

test("the volume gate refuses a load the ship cannot carry, and says both numbers", () => {
  const big = { ...BRIEFING, cargoVolume: 5000 };
  const refusal = gateOffer(big, cargo([], 4095, 0), 6, PLAN);
  assert.ok(refusal, "5000 m³ into a 4,095 m³ hold must be refused");
  assert.match(refusal!, /5,000/);
  assert.match(refusal!, /4,095/);
});

test("the volume gate counts USED space, not just capacity", () => {
  // 4,095 m³ hold with 4,090 m³ already in it: 10 m³ does not fit.
  const refusal = gateOffer({ ...BRIEFING, cargoVolume: 10 }, cargo([], 4095, 4090), 6, PLAN);
  assert.ok(refusal, "the gate must measure FREE room, not total capacity");
});

test("the jump gate refuses a route longer than the player allowed", () => {
  const refusal = gateOffer(BRIEFING, cargo([]), 14, { ...PLAN, maxJumps: 10 });
  assert.ok(refusal);
  assert.match(refusal!, /14 jumps/);
  assert.match(refusal!, /10/);
});

test("the live R35 mission passes both gates (6 jumps, 0.1 m³, a Badger)", () => {
  assert.equal(gateOffer(BRIEFING, cargo([], 4095, 0), 6, PLAN), null);
});

test("an UNKNOWN volume never passes the gate", () => {
  assert.ok(gateOffer({ ...BRIEFING, cargoVolume: null }, cargo([]), 6, PLAN));
});

test("an UNKNOWN cargo capacity never passes the gate", () => {
  assert.ok(gateOffer(BRIEFING, { rows: [], capacity: null }, 6, PLAN));
});

test("an UNCOMPUTABLE route never passes the gate", () => {
  assert.ok(
    gateOffer(BRIEFING, cargo([]), null, PLAN),
    "a route the solver could not work out must be refused, not assumed short",
  );
});

test("a gated offer is DECLINED, with the gate's reason carried to the player", () => {
  const decision = decideMissionAction(
    observation({
      conversation: OFFERED,
      briefing: { ...BRIEFING, cargoVolume: 5000 },
      jumpsToDropoff: 6,
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "decline");
  const declined = decision.action as Extract<MissionBotAction, { kind: "decline" }>;
  assert.equal(declined.actionID, 816);
  assert.match(declined.reason, /5,000/, "the decline must carry the reason it failed the gate");
});

test("a gated offer with NO decline button pauses rather than accepting anyway", () => {
  const decision = decideMissionAction(
    observation({
      conversation: conversationWith([[815, AGENT_BUTTON.ACCEPT]]),
      briefing: { ...BRIEFING, cargoVolume: 5000 },
      jumpsToDropoff: 6,
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "pause");
});

// =============================================================================
// 4. THE PACKAGE — known bad ground, handled and declared
// =============================================================================

test("the exact-quantity stack is preferred over a bigger one", () => {
  const found = findPackageStack(
    [row({ itemID: 1, quantity: 50 }), row({ itemID: 2, quantity: 1 })],
    REPORTS,
    1,
  );
  assert.equal(found.item?.itemID, 2);
});

test("a bigger stack is the fallback when there is no exact match", () => {
  const found = findPackageStack([row({ itemID: 1, quantity: 50 })], REPORTS, 1);
  assert.equal(found.item?.itemID, 1);
});

test("TWO identical stacks are genuinely ambiguous, and the bot says so", () => {
  const found = findPackageStack(
    [row({ itemID: 1, quantity: 1 }), row({ itemID: 2, quantity: 1 })],
    REPORTS,
    1,
  );
  assert.ok(found.item, "it still loads one — refusing to move would strand the mission");
  assert.equal(
    found.sure,
    false,
    "the package's itemID is not readable by any client, so identical type AND quantity is undecidable",
  );
});

test("a single matching stack IS sure", () => {
  assert.equal(findPackageStack([row({ itemID: 1, quantity: 1 })], REPORTS, 1).sure, true);
});

test("the load decision carries the caution when it cannot be certain", () => {
  const decision = decideMissionAction(
    observation({
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([]),
      hangar: [row({ itemID: 1, quantity: 1 }), row({ itemID: 2, quantity: 1 })],
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "loadPackage");
  assert.ok(decision.caution, "the player must be told the match could not be certain");
});

test("the load decision carries NO caution when the match is unambiguous", () => {
  const decision = decideMissionAction(
    observation({
      briefing: BRIEFING,
      journal: journalAccepted(),
      cargo: cargo([]),
      hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.caution, undefined);
});

test("no package in the hangar at the pickup PAUSES rather than flying an empty ship", () => {
  const decision = decideMissionAction(
    observation({ briefing: BRIEFING, journal: journalAccepted(), cargo: cargo([]), hangar: [] }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "pause");
});

// =============================================================================
// 5. THE AUTHORITIES — a read that failed is never a confident answer
// =============================================================================

test("an unread journal is not 'no mission'", () => {
  assert.equal(missionAccepted(null, AGENT), null);
  const decision = decideMissionAction(observation({ journal: null }), PLAN, NO_MEMORY);
  assert.equal(decision.action.kind, "wait", "nothing may be decided on an unread journal");
});

test("a MISSING journal row is 'no mission', never 'the mission completed'", () => {
  // Complete, quit, decline and expire all delete the row identically, so the
  // absence carries no information about which of them happened.
  assert.equal(missionAccepted(journalEmpty(), AGENT), false);
});

test("an unread cargo hold is not an empty one", () => {
  assert.equal(packageAboard(null, BRIEFING), null);
  const decision = decideMissionAction(
    observation({ briefing: BRIEFING, journal: journalAccepted(), cargo: null }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "wait");
});

test("an unread hangar does not read as 'the package is missing'", () => {
  const decision = decideMissionAction(
    observation({ briefing: BRIEFING, journal: journalAccepted(), cargo: cargo([]), hangar: null }),
    PLAN,
    NO_MEMORY,
  );
  assert.equal(decision.action.kind, "wait", "an unread hangar must not pause the run");
});

test("cargoRoom is null when the ship did not report a capacity", () => {
  assert.equal(cargoRoom({ rows: [], capacity: null }), null);
  assert.equal(cargoRoom(cargo([], 4095, 95)), 4000);
});

test("the package counts across stacks when deciding it is aboard", () => {
  const aboard = packageAboard(
    cargo([row({ itemID: 1, quantity: 3 }), row({ itemID: 2, quantity: 7 })]),
    { ...BRIEFING, cargoQuantity: 10 },
  );
  assert.equal(aboard, true);
});

test("agentActionID reads the button out of the conversation it is GIVEN", () => {
  assert.equal(agentActionID(OFFERED, AGENT_BUTTON.ACCEPT), 815);
  assert.equal(agentActionID(OFFERED, AGENT_BUTTON.COMPLETE), null);
  assert.equal(completeActionID(AT_DROPOFF), 821);
});

test("completeActionID takes the REMOTE complete when that is what is offered", () => {
  const remote = conversationWith([[901, AGENT_BUTTON.COMPLETE_REMOTELY]]);
  assert.equal(completeActionID(remote), 901);
});

test("earnings are bigint-safe (ISK exceeds 2^53)", () => {
  assert.equal(subtractAmounts("9007199254740993", "9007199254740991"), "2");
  assert.equal(subtractAmounts(null, "1"), null);
  assert.equal(subtractAmounts("nonsense", "1"), null);
});

test("earnings survive a FRACTIONAL wallet — the balance one insurance payout leaves", () => {
  // The live shape: Farmer's wallet reads "115789534766.84". BigInt() throws on
  // it, and the old code turned that throw into null — "ISK earned: —" for the
  // whole run, on every character whose balance was not a whole number.
  assert.equal(subtractAmounts("115789534766.84", "115789432766.84"), "102000");
  assert.equal(subtractAmounts("1000.5", "900"), "100.5");
  assert.equal(subtractAmounts("1000", "900.25"), "99.75");
  // Mixed scales, and a difference whose trailing zeros trim away.
  assert.equal(subtractAmounts("2.50", "1.5"), "1");
  assert.equal(subtractAmounts("0.6", "0.84"), "-0.24");
  // Still bigint-safe with a fraction riding along.
  assert.equal(subtractAmounts("9007199254740993.5", "9007199254740991"), "2.5");
});

// =============================================================================
// 6. THE CONTROLLER — bounds, confirmation, and never a cached token
// =============================================================================

interface Harness {
  readonly deps: MissionBotDeps;
  readonly calls: string[];
  readonly progress: MissionBotProgress[];
  world: {
    status: FlightStatus;
    conversation: AgentConversation | null;
    briefing: CourierBriefing | null;
    journal: JournalState | null;
    cargo: CargoReading | null;
    hangar: readonly InventoryItemRow[] | null;
    travel: TravelReading | null;
    jumps: number | null;
    /** What doAgentAction hands back — the ONLY place completion is read. */
    actionResult: AgentConversation | null;
    isk: string;
    lp: string;
  };
}

function harness(overrides: Partial<Harness["world"]> = {}): Harness {
  const calls: string[] = [];
  const progress: MissionBotProgress[] = [];
  const world: Harness["world"] = {
    status: status(),
    conversation: NO_MISSION,
    briefing: null,
    journal: journalEmpty(),
    cargo: cargo([]),
    hangar: [],
    travel: null,
    jumps: 6,
    actionResult: null,
    isk: "1000000",
    lp: "0",
    ...overrides,
  };
  const deps: MissionBotDeps = {
    getStatus: async () => world.status,
    openConversation: async (agentID) => {
      calls.push(`open:${agentID}`);
      return world.conversation;
    },
    doAgentAction: async (agentID, actionID) => {
      calls.push(`do:${agentID}:${actionID}`);
      return world.actionResult;
    },
    getBriefing: async () => world.briefing,
    getJournal: async () => world.journal,
    getCargo: async () => world.cargo,
    getHangar: async () => world.hangar,
    loadPackage: async (typeID, quantity) => {
      calls.push(`load:${typeID}:${quantity}`);
    },
    unloadPackage: async (itemIDs, quantity) => {
      calls.push(`unload:${itemIDs.join(",")}:${quantity}`);
    },
    startTravel: async (stationID) => {
      calls.push(`travel:${stationID}`);
    },
    getTravel: () => world.travel,
    stopTravel: () => {
      calls.push("stopTravel");
    },
    getJumps: async () => world.jumps,
    getBalances: async () => ({ isk: world.isk, lp: world.lp }),
    sleep: async () => {},
    onProgress: (p) => {
      progress.push(p);
    },
    isSessionLost: () => false,
    refusalReason: (error) => String(error),
  };
  return { deps, calls, progress, world };
}

/** Run n decision ticks, skipping the settle windows the way real time would. */
async function ticks(bot: ReturnType<typeof createMissionBot>, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await bot.tick();
  }
}

test("NO CACHED TOKEN: the conversation is re-opened each tick and THIS tick's id is sent", async () => {
  // R35 watched one agent's tokens go 815/816 -> 819/820 -> 821/822 across a
  // move, with the mission unchanged. A bot that remembered the first pair would
  // send a dead id forever.
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);

  await bot.tick(); // requests with token 810
  // The server re-mints. Nothing about the mission changed.
  h.world.conversation = conversationWith([[999, AGENT_BUTTON.REQUEST_MISSION]]);
  await ticks(bot, 3); // clear the settle window, then decide again

  const sent = h.calls.filter((call) => call.startsWith("do:"));
  assert.ok(sent.includes(`do:${AGENT}:810`), "the first request used the first token");
  assert.ok(
    sent.includes(`do:${AGENT}:999`),
    "after the re-mint it must send the NEW token — a cached 810 would be sent instead",
  );
  assert.ok(
    h.calls.filter((call) => call.startsWith("open:")).length >= 2,
    "the conversation must be re-opened, not remembered",
  );
});

test("A REFUSED COMPLETE DOES NOT ADVANCE — the real captured bytes, through the real loop", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: AT_DROPOFF,
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([]),
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    // The live refusal: 200, empty actions, missionCompleted null.
    actionResult: decodeConversation(refusedCompleteResult() as never),
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);

  await bot.tick();
  assert.ok(h.calls.some((call) => call.startsWith(`do:${AGENT}:821`)), "it pressed Complete");
  assert.equal(
    bot.snapshot().missionsCompleted,
    0,
    "a refusal must not be counted as a completed mission",
  );
  assert.equal(
    bot.snapshot().iskEarned,
    null,
    "a refusal must not report earnings — nothing was paid",
  );
});

test("a SUCCESSFUL Complete counts the mission and measures what it actually paid", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: AT_DROPOFF,
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([]),
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    actionResult: decodeConversation(completedResult() as never),
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await Promise.resolve(); // let the opening balance read settle

  h.world.isk = "1140250"; // +140,250 — the R35 live payout
  h.world.lp = "213";
  await bot.tick();

  assert.equal(bot.snapshot().missionsCompleted, 1);
  assert.equal(
    bot.snapshot().iskEarned,
    "140250",
    "earnings are a BALANCE DIFFERENCE — lastActionInfo.loyaltyPoints read 0 on this very payout",
  );
  assert.equal(bot.snapshot().lpEarned, "213");
});

/** The world in which a Complete lands on the first tick — shared by the balance-read tests. */
function completingHarness(): Harness {
  return harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: AT_DROPOFF,
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([]),
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    actionResult: decodeConversation(completedResult() as never),
  });
}

/** Let every pending microtask chain (the void-async baseline loop) run out. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the OPENING balance read is RETRIED — one dropped read no longer costs the run its readout", async () => {
  const h = completingHarness();
  // The first two baseline reads drop; the third lands. Single-shot, the run
  // would have no baseline and every payout would measure as unknown forever.
  let balanceReads = 0;
  h.deps.getBalances = async () => {
    balanceReads += 1;
    if (balanceReads <= 2) {
      throw new Error("transport dropped");
    }
    return { isk: h.world.isk, lp: h.world.lp };
  };
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await flushAsync();

  h.world.isk = "1140250";
  h.world.lp = "213";
  await bot.tick();

  assert.equal(bot.snapshot().iskEarned, "140250");
  assert.equal(bot.snapshot().lpEarned, "213");
});

test("the PAYOUT read is RETRIED — one dropped read after a Complete no longer leaves earnings stale", async () => {
  const h = completingHarness();
  // Read #1 is the opening baseline (lands). Read #2 is the payout read and
  // drops; the retry (#3) lands. Single-shot, a one-mission run would end with
  // Jobs done 1 and ISK earned unknown.
  let balanceReads = 0;
  h.deps.getBalances = async () => {
    balanceReads += 1;
    if (balanceReads === 2) {
      throw new Error("transport dropped");
    }
    return { isk: h.world.isk, lp: h.world.lp };
  };
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await flushAsync();

  h.world.isk = "1140250";
  h.world.lp = "213";
  await bot.tick();

  assert.equal(bot.snapshot().missionsCompleted, 1);
  assert.equal(bot.snapshot().iskEarned, "140250");
  assert.equal(bot.snapshot().lpEarned, "213");
});

test("a completion that OUTRUNS the baseline fills in the moment the baseline lands", async () => {
  const h = completingHarness();
  // The opening read is SLOW rather than failing: it answers — with the
  // pre-completion balance it actually read — only after the first Complete
  // has already landed and measured its payout.
  const opening: { answer: ((v: { isk: string | null; lp: string | null }) => void) | null } = {
    answer: null,
  };
  let balanceReads = 0;
  h.deps.getBalances = async () => {
    balanceReads += 1;
    if (balanceReads === 1) {
      return new Promise((resolve) => {
        opening.answer = resolve;
      });
    }
    return { isk: h.world.isk, lp: h.world.lp };
  };
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await flushAsync();

  h.world.isk = "1140250";
  h.world.lp = "213";
  await bot.tick();
  assert.equal(bot.snapshot().missionsCompleted, 1);
  assert.equal(bot.snapshot().iskEarned, null, "no baseline yet — unknown, never a confident 0");

  opening.answer?.({ isk: "1000000", lp: "0" });
  await flushAsync();
  assert.equal(bot.snapshot().iskEarned, "140250", "the late baseline fills the readout in");
  assert.equal(bot.snapshot().lpEarned, "213");
});

// --- No branch repeats unboundedly -------------------------------------------
//
// Each of these hands the loop a world in which the rung can NEVER make
// progress — the call answers 200 every time and the authority never changes —
// and asserts it stops with a reason rather than going round forever.

test("BOUNDED: an agent that offers nothing forever stops asking", async () => {
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_REQUEST_ATTEMPTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /offered nothing/i);
});

test("BOUNDED: an accept the journal never confirms stops", async () => {
  const h = harness({
    conversation: OFFERED,
    briefing: BRIEFING,
    journal: journalEmpty(), // never becomes accepted, whatever the call answers
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_ACCEPT_ATTEMPTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /journal still does not show it/i);
});

test("BOUNDED: a load that never reaches the cargo hold stops", async () => {
  const h = harness({
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([]), // the package never arrives
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_LOAD_ATTEMPTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /would not go into your ship/i);
});

test("BOUNDED: an unload that never reaches the hangar stops", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: AT_DROPOFF,
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([row({ itemID: PACKAGE_ITEM, quantity: 1 })]), // never leaves
    hangar: [],
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_UNLOAD_ATTEMPTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /would not come out of your ship/i);
});

test("BOUNDED: a Complete refused forever stops, and says the cargo IS delivered", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: AT_DROPOFF,
    briefing: BRIEFING,
    journal: journalAccepted(),
    cargo: cargo([]),
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    actionResult: decodeConversation(refusedCompleteResult() as never),
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_COMPLETE_ATTEMPTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.equal(bot.snapshot().missionsCompleted, 0);
  assert.match(
    bot.snapshot().failureReason!,
    /cargo is delivered/i,
    "the player must be told the haul is done and only the hand-in is outstanding",
  );
});

test("BOUNDED: a flight restarted forever without arriving stops", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    conversation: OFFERED,
    briefing: BRIEFING,
    // Travel is never 'running' and the ship never moves, so the ladder keeps
    // deciding "fly to the agent" and the restart counter is the only bound.
    travel: { status: "idle", destinationStationID: null, remainingJumps: 0, failureReason: null },
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, (MAX_TRAVEL_RESTARTS + 2) * 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /never got there/i);
});

test("the mission cap stops the bot WHERE IT IS — it does not fly home to stop", () => {
  // From the live R36 run. With the cap tested after the "fly to the agent"
  // rung, a bot that finished its last job at the DROPOFF flew the whole route
  // back — six jumps — purely to reach the place where it would then refuse to
  // work. Nothing is owed at this point, so stopping here is both correct and
  // kinder to the ship.
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      journal: journalEmpty(),
    }),
    { ...PLAN, maxMissions: 1 },
    { ...NO_MEMORY, missionsCompleted: 1 },
  );
  assert.equal(
    decision.action.kind,
    "pause",
    "the cap must be read BEFORE the flight, not after it",
  );
  assert.match((decision.action as Extract<MissionBotAction, { kind: "pause" }>).reason, /finished/);
});

test("under the cap, it still flies to the agent for the next job", () => {
  const decision = decideMissionAction(
    observation({
      status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
      journal: journalEmpty(),
    }),
    { ...PLAN, maxMissions: 3 },
    { ...NO_MEMORY, missionsCompleted: 1 },
  );
  assert.equal(decision.action.kind, "travel", "one job of three done is not a reason to stop");
});

test("the player's mission cap stops the bot with the ship docked at the agent", async () => {
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot(h.deps);
  bot.start({ ...PLAN, maxMissions: 1 });
  // Forge one completion, then let it come back round for the next job.
  h.world.status = status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM });
  h.world.conversation = AT_DROPOFF;
  h.world.briefing = BRIEFING;
  h.world.journal = journalAccepted();
  h.world.hangar = [row({ itemID: PACKAGE_ITEM, quantity: 1 })];
  h.world.actionResult = decodeConversation(completedResult() as never);
  await bot.tick();
  assert.equal(bot.snapshot().missionsCompleted, 1);

  // Back at the agent with no mission on: the cap is reached.
  h.world.status = status();
  h.world.journal = journalEmpty();
  h.world.briefing = null;
  h.world.conversation = NO_MISSION;
  await ticks(bot, 4);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(bot.snapshot().failureReason!, /finished the 1 job/i);
});

// --- Stopping is really stopping ---------------------------------------------

test("stopping the bot also stops the shared autopilot — nothing keeps flying", () => {
  const h = harness();
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  bot.stop();
  assert.ok(h.calls.includes("stopTravel"), "a stopped bot must not leave the ship under way");
});

test("a stopped bot issues nothing further", async () => {
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  bot.stop();
  const before = h.calls.length;
  await ticks(bot, 5);
  assert.equal(h.calls.length, before, "no bridge call may follow a stop");
});

test("AN OFFER THAT KEEPS FAILING A GATE BACKS OFF — decline is bounded", async () => {
  // ⚠ WATCHED LIVE (R39). With the player's jump cap below the route, the agent
  // re-offers the same job indefinitely and the ladder ran
  // request -> offer -> gate refuses -> decline -> request, one decline every
  // ~12 s, for as long as it was left alone. `bound()` had a counter for every
  // other rung and NONE for decline, so nothing ever stopped it — and each
  // decline costs real standing with the agent, so this is not a harmless spin.
  //
  // The live capture: 5 declines in 49 s, status still "running",
  // failureReason null; the in-process probe reached 100 declines in 300 ticks.
  const h = harness({
    conversation: OFFERED, // Accept 815 + Decline 816, both on the table
    briefing: BRIEFING, // the real R35 briefing: dropoff 6 jumps away
    jumps: 6,
  });
  const bot = createMissionBot(h.deps);
  // maxJumps 1 is a real value from the panel's own 1-30 range — the PLAYER's
  // cap, not a contrived number. Every offer this agent makes fails it.
  bot.start({ ...PLAN, maxJumps: 1 });

  await ticks(bot, 60);

  const declines = h.calls.filter((call) => call === `do:${AGENT}:816`).length;
  assert.ok(
    declines <= MAX_DECLINE_ATTEMPTS,
    `the bot must stop turning work down after ${MAX_DECLINE_ATTEMPTS} refusals; it issued ${declines}`,
  );
  assert.equal(bot.snapshot().status, "paused", "an offer it can never take must stop the bot");
  assert.match(
    String(bot.snapshot().failureReason),
    /outside the limits you set/,
    "the reason must tell the player which of their own limits is refusing the work",
  );
});

test("THE REQUEST BETWEEN TWO DECLINES DOES NOT RESET THE DECLINE COUNTER", async () => {
  // ⚠ THIS FIXTURE IS THE LIVE LOOP, NOT A STATIC CONVERSATION. Watched on the
  // running server: a Decline clears the offer (leaving only "ask for work"),
  // and the very next Request puts an identical one straight back — one full
  // cycle every ~12 s. That alternation is the whole difficulty, because
  // `bound()` clears every other counter on any non-wait action, so a decline
  // counter reset by the Request that follows it bounds nothing at all.
  const h = harness({ conversation: OFFERED, briefing: BRIEFING, jumps: 6 });
  const deps: MissionBotDeps = {
    ...h.deps,
    doAgentAction: async (agentID, actionID) => {
      const back = await h.deps.doAgentAction(agentID, actionID);
      if (actionID === 816) {
        h.world.conversation = NO_MISSION; // declined: the offer is gone
      } else if (actionID === 810) {
        h.world.conversation = OFFERED; // asked again: the same job is back
      }
      return back;
    },
  };
  const bot = createMissionBot(deps);
  bot.start({ ...PLAN, maxJumps: 1 });

  await ticks(bot, 90);

  const requests = h.calls.filter((call) => call === `do:${AGENT}:810`).length;
  const declines = h.calls.filter((call) => call === `do:${AGENT}:816`).length;
  assert.ok(requests > 0, "the fixture must actually alternate request/decline");
  assert.ok(
    declines <= MAX_DECLINE_ATTEMPTS,
    `a Request between declines must not clear the bound; the bot issued ${declines} refusals`,
  );
  assert.equal(bot.snapshot().status, "paused");
});

test("the readout always carries a WHY while running", async () => {
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, 3);
  for (const p of h.progress) {
    assert.ok(p.why, `every pushed readout must say why: ${JSON.stringify(p)}`);
  }
});

// --- Transient transport on PRESSES (the false "server took too long") -------
//
// A gateway timeout on an issued press says nothing about what the game
// decided — every rung already confirms its press against the authority that
// owns the fact, so the honest response is settle + re-observe + bounded
// retry, never a terminal "was refused" on the first unanswered call.

test("a transport timeout on a press is retried against the authority, not read as a refusal", async () => {
  const h = harness({ conversation: NO_MISSION });
  let failuresLeft = 2;
  const doAgentAction = h.deps.doAgentAction;
  const bot = createMissionBot({
    ...h.deps,
    doAgentAction: async (agentID, actionID) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error("EveJS gateway timed out.") as Error & { code?: string };
        error.code = "EVE_GATEWAY_TIMEOUT";
        throw error;
      }
      return doAgentAction(agentID, actionID);
    },
  });
  bot.start(PLAN);
  await ticks(bot, 8);

  assert.equal(bot.snapshot().status, "running", "two unanswered presses must not end the run");
  assert.equal(
    h.calls.filter((call) => call.startsWith("do:")).length,
    1,
    "the third press reached the agent",
  );
});

test("BOUNDED: a wire that never answers pauses the run with the transport truth", async () => {
  const h = harness({ conversation: NO_MISSION });
  const bot = createMissionBot({
    ...h.deps,
    doAgentAction: async () => {
      const error = new Error("EveJS gateway timed out.") as Error & { code?: string };
      error.code = "EVE_GATEWAY_TIMEOUT";
      throw error;
    },
  });
  bot.start(PLAN);
  await ticks(bot, 14);

  const snap = bot.snapshot();
  assert.equal(snap.status, "paused");
  assert.match(
    String(snap.failureReason),
    /no answer from the server/i,
    "the pause must say the wire did not answer — not that the game refused",
  );
  assert.doesNotMatch(
    String(snap.failureReason),
    /asked for work/i,
    "presses that never arrived must not be charged to the request bound",
  );
});

// --- The travel rung against a plan that never starts ------------------------
//
// startRoute reports plan failures through the travel slice for the Travel
// panel; the bot's startTravel dep THROWS them (RouteStartOutcome) because a
// flight the autopilot never received must not be booked as running.

test("a travel that never started pauses with the plan's own reason, not 'Flying'", async () => {
  const h = harness({ status: status({ docked: false, inSpace: true }), journal: journalEmpty() });
  const bot = createMissionBot({
    ...h.deps,
    startTravel: async () => {
      throw new Error("No gate route from Alpha to Omega.");
    },
  });
  bot.start(PLAN);
  await ticks(bot, 2);

  const snap = bot.snapshot();
  assert.equal(snap.status, "paused", "a plan failure must stop the run, not fake a flight");
  assert.match(String(snap.failureReason), /no gate route/i);
});

test("a transient travel start is retried and then flies (never booked before it started)", async () => {
  const h = harness({ status: status({ docked: false, inSpace: true }), journal: journalEmpty() });
  let failuresLeft = 1;
  const started: number[] = [];
  const bot = createMissionBot({
    ...h.deps,
    startTravel: async (stationID) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error("EveJS gateway timed out.") as Error & { code?: string };
        error.code = "EVE_GATEWAY_TIMEOUT";
        throw error;
      }
      started.push(stationID);
      h.world.travel = {
        status: "running",
        destinationStationID: stationID,
        remainingJumps: 2,
        failureReason: null,
      };
    },
  });
  bot.start(PLAN);
  await ticks(bot, 8);

  const snap = bot.snapshot();
  assert.equal(snap.status, "running");
  assert.deepEqual(started, [PLAN.agentStationID], "the retry reached the autopilot once");
});

test("a STALE 'arrived' from the previous leg cannot reset the travel bound", async () => {
  // Between legs the shared autopilot still says "arrived" — about the LAST
  // flight. If that stale word clears the restart counter, a travel that keeps
  // failing to start spins forever. The arrival must be OURS to clear anything.
  const h = harness({
    status: status({ docked: false, inSpace: true }),
    journal: journalEmpty(),
    travel: {
      status: "arrived",
      destinationStationID: 60009999, // the PREVIOUS leg's station, not ours
      remainingJumps: 0,
      failureReason: null,
    },
  });
  const bot = createMissionBot(h.deps); // harness startTravel records but starts nothing
  bot.start(PLAN);
  await ticks(bot, 20);

  const snap = bot.snapshot();
  assert.equal(snap.status, "paused", "the restart bound must eventually trip");
  assert.match(String(snap.failureReason), /three times/i);
});

test("a press turned back by a settling session change is waited out, not paused on", async () => {
  const h = harness({ conversation: NO_MISSION });
  let turnbacks = 0;
  const doAgentAction = h.deps.doAgentAction;
  const bot = createMissionBot({
    ...h.deps,
    doAgentAction: async (agentID, actionID) => {
      // The BFF's transition gate 409s agent presses while a dock settles.
      if (turnbacks < 5) {
        turnbacks += 1;
        const error = new Error("The dock transition is not ready for another command.") as Error & {
          code?: string;
        };
        error.code = "SESSION_CHANGE_IN_PROGRESS";
        throw error;
      }
      return doAgentAction(agentID, actionID);
    },
  });
  bot.start(PLAN);
  await ticks(bot, 18);

  assert.equal(bot.snapshot().status, "running", "five turn-backs are inside the settling bound");
  assert.equal(
    h.calls.filter((call) => call.startsWith("do:")).length,
    1,
    "the sixth press reached the agent",
  );
});

// --- The wait watchdog, resume, and the run() backstop -----------------------

test("WATCHDOG: a wait that never changes pauses after five minutes with the reason on screen", async () => {
  // A non-courier mission accepted from the same agent: the journal says
  // accepted, the briefing never carries cargo fields, so the courier ladder
  // waits on "reading the cargo" forever — no retry changes a combat
  // briefing. The watchdog is what ends it, and it says what it was stuck on.
  const h = harness({
    journal: journalAccepted(),
    briefing: { ...BRIEFING, cargoTypeID: null, cargoQuantity: null },
    cargo: cargo([]),
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, MAX_STUCK_WAIT_TICKS + 5);

  const snap = bot.snapshot();
  assert.equal(snap.status, "paused", "an unchanging wait must not run forever");
  assert.match(String(snap.failureReason), /five minutes/i);
});

test("RESUME WORKS: a bounded pause resumes into a fresh attempt, not an instant re-pause", async () => {
  const h = harness({
    status: status({ docked: false, inSpace: true }),
    journal: journalEmpty(),
    travel: {
      status: "arrived",
      destinationStationID: 60009999, // stale: the previous leg's station
      remainingJumps: 0,
      failureReason: null,
    },
  });
  const bot = createMissionBot(h.deps);
  bot.start(PLAN);
  await ticks(bot, 20);
  assert.equal(bot.snapshot().status, "paused", "the travel bound trips first");

  bot.resume();
  await ticks(bot, 3);
  assert.equal(
    bot.snapshot().status,
    "running",
    "a resume is consent to try again — the spent bound must not re-trip on the first tick",
  );
});

test("BACKSTOP: a subscriber that throws through emit stops the bot VISIBLY, not silently", async () => {
  const h = harness({ conversation: NO_MISSION });
  let emitted = 0;
  const bot = createMissionBot({
    ...h.deps,
    onProgress: () => {
      emitted += 1;
      if (emitted > 2) {
        throw new Error("view effect exploded");
      }
    },
  });
  bot.start(PLAN);
  await bot.run();

  const snap = bot.snapshot();
  assert.equal(snap.status, "error", "the loop must stop in a state the panel can render");
  assert.match(String(snap.failureReason), /unexpected error/i);
});

// --- The asynchronous settlement: an unanswered Complete that landed ---------

test("a Complete that timed out but LANDED is still counted, and the payout still measured", async () => {
  // Settlement is asynchronous server-side: the call aborts at its budget, the
  // payout lands moments later, and the journal row vanishes. Without the
  // journal resolution the bot would fly off to the next job with
  // missionsCompleted unchanged (maxMissions overshoots) and the ISK/LP
  // readout stuck at 0.
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    journal: journalAccepted(),
    briefing: BRIEFING,
    cargo: cargo([]), // the package is already delivered to the hangar
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    conversation: AT_DROPOFF,
  });
  const bot = createMissionBot({
    ...h.deps,
    doAgentAction: async () => {
      // The press reaches the server; the answer never arrives — and the
      // settlement lands anyway.
      h.world.journal = journalEmpty();
      h.world.conversation = NO_MISSION;
      h.world.isk = "1102000";
      h.world.lp = "213";
      const error = new Error("EveJS gateway timed out.") as Error & { code?: string };
      error.code = "EVE_GATEWAY_TIMEOUT";
      throw error;
    },
  });
  bot.start(PLAN);
  await ticks(bot, 8);

  const snap = bot.snapshot();
  assert.equal(snap.missionsCompleted, 1, "the landed completion must be counted");
  assert.equal(snap.iskEarned, "102000", "and what it paid must be measured");
  assert.equal(snap.lpEarned, "213");
  assert.notEqual(snap.status, "error");
});

test("a Complete that timed out and did NOT land is pressed again, never counted", async () => {
  const h = harness({
    status: status({ stationID: DROPOFF, solarSystemID: DROPOFF_SYSTEM }),
    journal: journalAccepted(),
    briefing: BRIEFING,
    cargo: cargo([]),
    hangar: [row({ itemID: PACKAGE_ITEM, quantity: 1 })],
    conversation: AT_DROPOFF,
  });
  let presses = 0;
  const doAgentAction = h.deps.doAgentAction;
  const bot = createMissionBot({
    ...h.deps,
    doAgentAction: async (agentID, actionID) => {
      presses += 1;
      if (presses === 1) {
        // Unanswered, and the journal row stays: the press never took.
        const error = new Error("EveJS gateway timed out.") as Error & { code?: string };
        error.code = "EVE_GATEWAY_TIMEOUT";
        throw error;
      }
      return doAgentAction(agentID, actionID);
    },
  });
  bot.start(PLAN);
  await ticks(bot, 8);

  assert.equal(bot.snapshot().missionsCompleted, 0, "an un-landed press must not be counted");
  assert.ok(presses >= 2, "the ladder pressed Complete again");
});
