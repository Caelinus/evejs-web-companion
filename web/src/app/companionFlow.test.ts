// The fleet companion's LIFECYCLE, driven through the real flow over a faked BFF.
//
// The unit tests beside `nav/fleetCompanionLoop.ts` prove the ladder. This file
// proves the things only the flow can answer: that the preflight refuses a start
// the companion cannot honour, and that the companion holds the ship on exactly
// the same terms as every other loop — it stops them, and they stop it.
//
// ⚠ THE EXCLUSION CASES ARE THE POINT. `createShipClaim` gives them by
// construction, but "by construction" is a claim about types, and two loops
// steering one ship is a runtime disaster. These drive it for real.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { DEFAULT_FLEET_COMPANION_REQUEST } from "../nav/fleetCompanionLoop.ts";
import {
  STRIP_MINER_ITEM_IDS,
  fittingBody,
  flightBody,
  holdsBody,
  namesBody,
  spaceBody,
} from "./botFixtures.ts";

const BELT = 40000123;
const STATION = 60003760;

const MINING_REQUEST = {
  beltID: BELT,
  beltName: "Asteroid Belt 1",
  stationID: STATION,
  stationName: "Jita IV - Moon 4",
  miningModuleIDs: [7001],
  healthFloor: 0.5,
  useDrones: false,
};

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

/** A fleet the companion can legitimately obey. Ids are synthetic on purpose. */
function readyFleet() {
  const emptyDict = { type: "dict", entries: [] };
  return {
    ok: true,
    characterID: 90000001,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", "Ready up."],
          ["fleetID", 90000002],
          ["members", emptyDict],
          ["squads", emptyDict],
          ["wings", emptyDict],
        ]),
      },
      GetWings: { result: emptyDict },
      GetMotd: { result: "Ready up." },
      GetJoinRequests: { result: emptyDict },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  };
}

/** The authoritative "you are in no fleet" answer: every read refused. */
function noFleet() {
  const refused = { error: "CALL_REFUSED", message: "FleetNotFound" };
  return {
    ok: true,
    characterID: 90000001,
    fleetID: null,
    reads: {
      GetInitState: refused,
      GetWings: refused,
      GetMotd: refused,
      GetJoinRequests: refused,
      GetFleetComposition: refused,
    },
  };
}

function harness(options: { readonly docked?: boolean; readonly inFleet?: boolean } = {}) {
  const docked = options.docked ?? false;
  const inFleet = options.inFleet ?? true;

  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    return {
      ok: true,
      status: 200,
      async json() {
        return respond(path, body as Record<string, unknown>);
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string, body: Record<string, unknown>): unknown {
    if (path === "/api/bridge/flight/status") return flightBody(docked);
    if (path === "/api/bridge/space/snapshot") return spaceBody();
    if (path === "/api/bridge/fitting") return fittingBody({});
    if (path === "/api/bridge/ship/ore-hold") return holdsBody(0, []);
    if (path === "/api/names") return namesBody(body);
    if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
    if (path === "/api/bridge/bound-fleet") return inFleet ? readyFleet() : noFleet();
    return { ok: true };
  }

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }) };
}

// --- the preflight ----------------------------------------------------------

test("a companion refuses to start outside a fleet, and says why in plain language", async () => {
  // ⚠ THIS IS THE ONE BLOCKING REQUIREMENT, and it is blocking because the
  // ladder cannot resolve it for itself. Every companion behaviour is addressed
  // to a fleet; started without one it is not a bot that will get going shortly,
  // it is a bot with nothing to obey.
  const { store, flow } = harness({ inFleet: false });

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().companion.status, "idle", "it must not be running");
  const message = store.get().companion.startError;
  assert.ok(message !== null, "a refused start must say something");
  assert.match(message, /fleet/i);
  assert.doesNotMatch(message ?? "", /[0-9]{5,}/, "no raw ids in player-facing text");
  flow.stopFleetCompanion();
});

test("a companion in a fleet starts", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");
  assert.equal(store.get().companion.role, DEFAULT_FLEET_COMPANION_REQUEST.role);
  flow.stopFleetCompanion();
});

test("an UNREADABLE fleet refuses the start too — unknown is never permission", async () => {
  // The roster read failing is not the roster saying no, but it is equally not
  // grounds to start an unattended loop nobody could check the fleet of.
  const fakeFetch = (async (input: unknown) => {
    const path = String(input);
    if (path === "/api/bridge/bound-fleet") {
      throw new Error("gateway unreachable");
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return path === "/api/bridge/flight/status" ? flightBody(false) : { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fakeFetch });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "idle");
  assert.ok(store.get().companion.startError !== null);
  flow.stopFleetCompanion();
});

// --- one ship, one loop -----------------------------------------------------

test("starting the companion stops a running mining bot", async () => {
  const { store, flow } = harness({ docked: false, inFleet: true });
  await flow.startMiningBot(MINING_REQUEST);
  assert.equal(store.get().bot.status, "running", "the mining bot is up");

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().bot.status, "stopped", "the mining bot must give up the ship");
  assert.equal(store.get().companion.status, "running");
  flow.stopFleetCompanion();
  flow.stopMiningBot();
});

test("starting the mining bot stops a running companion — the claim is symmetric", async () => {
  const { store, flow } = harness({ docked: false, inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running", "the companion is up");

  await flow.startMiningBot(MINING_REQUEST);

  assert.equal(
    store.get().companion.status,
    "stopped",
    "the companion must be stopped by the mining bot's claim, with nobody having written that pairing",
  );
  flow.stopFleetCompanion();
  flow.stopMiningBot();
});

test("a REFUSED companion start still takes the ship off whatever was flying it", async () => {
  // The player said which loop they want. A start whose own preflight then
  // refuses must not leave the previous loop flying — that is how a click ends
  // up doing nothing visible while a bot keeps issuing orders.
  const { store, flow } = harness({ docked: false, inFleet: false });
  await flow.startMiningBot(MINING_REQUEST);
  assert.equal(store.get().bot.status, "running");

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().companion.status, "idle", "the companion was refused");
  assert.equal(store.get().bot.status, "stopped", "and the mining bot still gave up the ship");
  flow.stopMiningBot();
});

// --- pause / resume / stop --------------------------------------------------

test("pause, resume and stop move the companion through its states", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");

  flow.pauseFleetCompanion();
  assert.equal(store.get().companion.status, "paused", "a pause must reach the store");

  flow.resumeFleetCompanion();
  assert.equal(store.get().companion.status, "running");

  flow.stopFleetCompanion();
  // ⚠ THIS ASSERTION IS THE ONE THAT CAUGHT A REAL BUG. The loop reported
  // nothing on stop at first, so the store went on believing the companion held
  // the ship — which would have made the next bot's claim look like it stopped
  // nothing, and left the readout stuck on "running" forever.
  assert.equal(store.get().companion.status, "stopped", "a stop must reach the store too");
});

test("clearing the character drops the companion readout", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");

  store.apply({ type: "character/offline" });

  assert.equal(store.get().companion.status, "idle");
  assert.equal(store.get().companion.role, null);
  flow.stopFleetCompanion();
});

// --- the drain is the only push a headless companion ever gets ---------------

/** Poll until `ready()`, or give up. The flow's ticks are async and untimed. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One pushed notification, shaped exactly as the BFF drains it onto a response. */
function inviteNotification() {
  return {
    kind: "client",
    service: null,
    method: "OnFleetInvite",
    idType: "charid",
    args: [90000050, 90000001, "AskJoinFleet", {}],
    kwargs: null,
  };
}

test("a notification DRAINED onto a bridge response reaches the push dispatch", async () => {
  // ⚠ THIS IS THE WHOLE REASON A HEADLESS COMPANION CAN HEAR ITS FLEET.
  // `applyPushedNotification` has one other caller, the SSE branch, and
  // `src/botHost.js` gives every headless bot `stubEventSource()` — a channel
  // that is never live. So on the bot host the live path never runs, and
  // anything that arrives ONLY as a push is simply never seen.
  //
  // The BFF already drains notifications onto every response for exactly this
  // case; nothing on this side consumed them until now. The event driven here
  // is a fleet INVITE because it is the push consumer that already existed —
  // and, not incidentally, the one decision 5's rejoin gate reads.
  // The bot host's `stubEventSource()`, in miniature: a channel that never
  // delivers anything, which is the whole condition under test.
  const eventSource = () => ({
    close() {},
    addEventListener() {},
    removeEventListener() {},
    onmessage: null,
    onerror: null,
    onopen: null,
  });

  const fakeFetch = (async (input: unknown, init?: { body?: string }) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") {
          // The drain rides along with an ordinary read. No extra route, no
          // poll of our own — this response was going to be made anyway.
          return {
            ...(flightBody(false) as Record<string, unknown>),
            notifications: [inviteNotification()],
          };
        }
        if (path === "/api/bridge/space/snapshot") return spaceBody();
        if (path === "/api/bridge/fitting") return fittingBody({});
        if (path === "/api/names") return namesBody(body as Record<string, unknown>);
        if (path === "/api/bridge/bound-fleet") return readyFleet();
        if (path === "/api/bots/active") return { ok: true, characterIDs: [], bots: [] };
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fakeFetch, eventSource, livePush: false });

  assert.equal(store.get().fleet.pendingInvite, null, "nothing has been pushed yet");
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitFor(
    () => store.get().fleet.pendingInvite !== null,
    "the drained OnFleetInvite to reach the store",
  );
  assert.equal(store.get().fleet.pendingInvite?.fleetID, 90000050);
  flow.stopFleetCompanion();
});

test("a drained response with no notifications changes nothing", async () => {
  // The empty case has to stay free: this runs on every read of every tick.
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().fleet.pendingInvite, null);
  flow.stopFleetCompanion();
});
