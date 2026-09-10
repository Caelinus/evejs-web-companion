// The fleet companion panel as it actually RENDERS — third instance of the
// MiningBot.svelte / MissionBot.svelte pattern.
//
// What this panel can get wrong is narrow but expensive, same shape as its
// siblings:
//
//   1. GATING ON THE WRONG THING. "In a fleet" is the one requirement the
//      ladder cannot resolve for itself, so it must actually block Start.
//      "Docked" is the companion's own first move, so it must NEVER block
//      Start — an advisory requirement that blocks is a launcher narrower
//      than the bot it launches.
//   2. GUESSING A DEFENSIVE MODULE. `defenseModuleIDs` must be the player's
//      OWN pick — nothing may start ticked, unlike the mining bot's
//      "suggested" equipment.
//   3. Never showing internal vocabulary ("blocking", "cannot-tell") to the
//      player — it must always be translated into plain words.
//   4. The standing invariants — R7d (no visible numeric IDs), R9a (plain
//      player language), R8 (data-label on every cell of a reflow table).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { decodeFleetCenter } = await import("../bridge/fleetCenter.ts");
const FleetCompanion = (await import("./FleetCompanion.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "FleetCompanion.svelte"), "utf8");

// Obviously synthetic ids throughout — nothing here was captured from a real
// account. 90000001-and-up mirrors ESI's own documented example CharacterID.
const CHARACTER_ID = 90000001;
const FLEET_ID = 90000010;
const SHIP_ID = 90000020;
const STATION_ID = 90000030;
const DEFENSE_MODULE_A_ITEM_ID = 90000101;
const DEFENSE_MODULE_A_TYPE_ID = 90000201;
const DEFENSE_MODULE_B_ITEM_ID = 90000102;
const DEFENSE_MODULE_B_TYPE_ID = 90000202;
const CHAT_SENDER_ID = 90000301;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function renderPanel(store: ReturnType<typeof createClientStore>): string {
  return render(FleetCompanion as never, { props: { store, flow: fakeFlow() } } as never).body;
}

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

const FLEET_READ_NAMES = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

/** A fleet snapshot the pilot is genuinely a member of. */
function readyFleetSnapshot() {
  return decodeFleetCenter({
    ok: true,
    characterID: CHARACTER_ID,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", ""],
          ["fleetID", FLEET_ID],
          ["members", { type: "dict", entries: [] }],
          ["squads", { type: "dict", entries: [] }],
          ["wings", { type: "dict", entries: [] }],
        ]),
      },
      GetWings: { result: { type: "dict", entries: [] } },
      GetMotd: { result: "" },
      GetJoinRequests: { result: { type: "dict", entries: [] } },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  } as never);
}

/** Every bound read explicitly answering FleetNotFound. */
function notInFleetSnapshot() {
  return decodeFleetCenter({
    ok: true,
    characterID: CHARACTER_ID,
    fleetID: null,
    reads: Object.fromEntries(
      FLEET_READ_NAMES.map((name) => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
    ),
  } as never);
}

function applyFleet(
  store: ReturnType<typeof createClientStore>,
  snapshot: ReturnType<typeof decodeFleetCenter>,
): void {
  store.apply({
    type: "fleet/loaded",
    ...snapshot,
    readError: snapshot.availability === "unavailable" ? "Fleet membership could not be read just now." : null,
    refreshedAtMs: 100,
  });
}

function applyFlight(
  store: ReturnType<typeof createClientStore>,
  options: { docked: boolean; inSpace: boolean },
): void {
  store.apply({
    type: "flight/status",
    status: {
      inSpace: options.inSpace,
      docked: options.docked,
      solarSystemID: 30000001,
      stationID: options.docked ? STATION_ID : null,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
}

/** A fit with two online, non-mining modules — nothing here should suggest itself. */
function applyDefensiveFitting(store: ReturnType<typeof createClientStore>): void {
  store.apply({
    type: "fitting/loaded",
    activeShipID: SHIP_ID,
    slots: [
      {
        family: "mid",
        index: 0,
        module: {
          itemID: DEFENSE_MODULE_A_ITEM_ID,
          typeID: DEFENSE_MODULE_A_TYPE_ID,
          groupID: null,
          online: true,
          charge: null,
        },
      },
      {
        family: "low",
        index: 0,
        module: {
          itemID: DEFENSE_MODULE_B_ITEM_ID,
          typeID: DEFENSE_MODULE_B_TYPE_ID,
          groupID: null,
          online: true,
          charge: null,
        },
      },
    ],
    resources: createClientStore().get().fitting.resources,
    stats: createClientStore().get().fitting.stats,
    slotsError: null,
    resourcesError: null,
  });
  store.apply({
    type: "names/resolved",
    entries: {
      [`type:${DEFENSE_MODULE_A_TYPE_ID}`]: "Test Shield Booster",
      [`type:${DEFENSE_MODULE_B_TYPE_ID}`]: "Test Armour Repairer",
    },
  });
}

/** In a real fleet, in space, with two defensive modules powered up. */
function readyStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  applyFleet(store, readyFleetSnapshot());
  applyFlight(store, { docked: false, inSpace: true });
  applyDefensiveFitting(store);
  return store;
}

// --- 1. blocking vs advisory, and the gate that actually gates --------------

test("R18 — the panel renders against a completely empty store", () => {
  const body = renderPanel(createClientStore());
  assert.equal(typeof body, "string");
  assert.match(visibleText(body), /Fleet companion/);
});

test("not in a fleet: the blocking requirement says so, and Start is disabled", () => {
  const store = createClientStore();
  applyFleet(store, notInFleetSnapshot());
  applyFlight(store, { docked: false, inSpace: true });
  const body = renderPanel(store);
  const text = visibleText(body);
  assert.match(text, /Join a fleet first/i);
  assert.match(text, /\(required\)/);
  // The Start button itself must carry the disabled attribute.
  const startButton = body.match(/<button[^>]*class="primary"[^>]*>\s*Start\s*<\/button>/)?.[0] ?? "";
  assert.match(startButton, /disabled/, "Start must be disabled while the blocking requirement fails");
});

test("a fleet that could not be read is UNKNOWN, never reported as 'not in a fleet'", () => {
  // Nothing has loaded the fleet slice at all — its own default is "unknown",
  // not "not-in-fleet". Reporting the wrong one sends a player to fix a
  // problem they do not have.
  const store = createClientStore();
  applyFlight(store, { docked: false, inSpace: true });
  const text = visibleText(renderPanel(store));
  assert.match(text, /could not be read/i);
  assert.doesNotMatch(text, /Join a fleet first/i);
});

test("in a fleet and docked: the advisory requirement describes what will happen, and never blocks Start", () => {
  const store = createClientStore();
  applyFleet(store, readyFleetSnapshot());
  applyFlight(store, { docked: true, inSpace: false });
  const body = renderPanel(store);
  const text = visibleText(body);
  assert.match(text, /it will undock/i);
  assert.match(text, /\(worth knowing\)/);
  assert.doesNotMatch(text, /\(required\)/, "an advisory line must not read as required");
  const startButton = body.match(/<button[^>]*class="primary"[^>]*>\s*Start\s*<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(
    startButton,
    /disabled/,
    "docked is the companion's own first move — it must never block Start",
  );
});

test("in a fleet and already out in space: both requirements read Ready", () => {
  const text = visibleText(renderPanel(readyStore()));
  assert.match(text, /Ready.*You are in a fleet/);
  assert.match(text, /Ready.*Your ship is out in space/);
});

// --- 2. nothing is guessed for the player -----------------------------------

test("defensive equipment starts with NOTHING ticked — unlike the mining bot's suggestion", () => {
  const body = renderPanel(readyStore());
  const checkboxBlocks = [...body.matchAll(/<label class="check[^"]*">[\s\S]*?<\/label>/g)].map((m) => m[0]);
  const equipmentBoxes = checkboxBlocks.filter(
    (block) => block.includes("Test Shield Booster") || block.includes("Test Armour Repairer"),
  );
  assert.equal(equipmentBoxes.length, 2, "both online modules must be offered");
  for (const block of equipmentBoxes) {
    assert.doesNotMatch(block, /checked/, "no defensive module may be pre-ticked");
  }
});

test("with nothing powered up, the panel says so rather than showing an empty list", () => {
  const store = createClientStore();
  applyFleet(store, readyFleetSnapshot());
  applyFlight(store, { docked: false, inSpace: true });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Nothing powered up/i);
});

test("the source never invents defenseModuleIDs — Start always sends exactly `picked`", () => {
  assert.match(SOURCE, /defenseModuleIDs:\s*picked/);
  assert.doesNotMatch(SOURCE, /suggested/i, "there must be no mining-style suggested default here");
});

// --- 3. tagging's own warning, and chat senders are player-typed, not chat-derived --

test("the tagging checkbox carries the one-pilot-per-squad warning", () => {
  const text = visibleText(renderPanel(readyStore()));
  assert.match(text, /Only one pilot per squad should turn this on/i);
});

test("chat command senders are typed by the player, and preview by NAME once resolved", () => {
  const store = readyStore();
  store.apply({
    type: "names/resolved",
    entries: { [`character:${CHAT_SENDER_ID}`]: "Test Wingmate" },
  });
  // The component starts its own text field empty (no interactivity in an SSR
  // render), so this pins the WIRING instead: the parsed ids feed both the
  // preview and the request, and never come from chat text.
  assert.match(SOURCE, /chatCommandSenders:\s*chatCommandSenderIDs/);
  assert.match(SOURCE, /NEVER POPULATED FROM CHAT TEXT/);
  void store;
});

// --- 4. the readout, once running -------------------------------------------

function startedStore(): ReturnType<typeof createClientStore> {
  const store = readyStore();
  store.apply({ type: "companion/started", role: "logi", startedAt: Date.now() });
  store.apply({
    type: "companion/progress",
    status: "running",
    phase: "Holding formation",
    action: "Wait",
    why: "Nothing has asked for anything yet.",
    role: "logi",
    inFleet: true,
    followingOrderFrom: "broadcast",
    lastOrderHeard: "Orbit the fleet commander",
    canTag: false,
    failureReason: null,
  });
  return store;
}

test("the readout shows the WHY, which is the whole point of the panel", () => {
  const text = visibleText(renderPanel(startedStore()));
  assert.match(text, /Why:/);
  assert.match(text, /Nothing has asked for anything yet/);
});

test("the readout translates role, order source and the three-state canTag into player words", () => {
  const text = visibleText(renderPanel(startedStore()));
  assert.match(text, /Logistics/);
  assert.match(text, /a fleet broadcast/);
  assert.match(text, /Orbit the fleet commander/);
  assert.match(text, /no - not a fleet commander/);
});

test("canTag is three-state: null reads as 'not known', never as a settled no", () => {
  const store = startedStore();
  store.apply({
    type: "companion/progress",
    status: "running",
    phase: "Holding formation",
    action: "Wait",
    why: "Nothing has asked for anything yet.",
    role: "logi",
    inFleet: true,
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
    failureReason: null,
  });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Can tag.*not known/);
  assert.doesNotMatch(text, /Can tag.*no - not a fleet commander/);
});

test("a start error is surfaced", () => {
  const store = readyStore();
  store.apply({ type: "companion/start-error", message: "Join a fleet first - a companion takes its orders from one." });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Join a fleet first/);
});

test("a PAUSED companion still reads as holding the ship, with the standard paused note", () => {
  const store = startedStore();
  store.apply({
    type: "companion/progress",
    status: "paused",
    phase: "Holding formation",
    action: null,
    why: "You paused it.",
    role: "logi",
    inFleet: true,
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
    failureReason: null,
  });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Paused/);
  assert.match(text, /press Carry\s*on/i);
});

test("a failure reason is shown while running", () => {
  const store = readyStore();
  store.apply({ type: "companion/started", role: "dps", startedAt: Date.now() });
  store.apply({
    type: "companion/progress",
    status: "error",
    phase: null,
    action: null,
    why: null,
    role: "dps",
    inFleet: null,
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
    failureReason: "The fleet roster could not be read.",
  });
  // status "error" is not active, so this renders the SET-UP view's own
  // "last time it stopped" line.
  const text = visibleText(renderPanel(store));
  assert.match(text, /Last time it stopped/);
  assert.match(text, /fleet roster could not be read/);
});

// --- 5. the standing invariants ---------------------------------------------

test("R7d — no numeric id reaches the player, running or not", () => {
  for (const store of [readyStore(), startedStore()]) {
    const text = visibleText(renderPanel(store));
    for (const id of [
      CHARACTER_ID,
      FLEET_ID,
      SHIP_ID,
      STATION_ID,
      DEFENSE_MODULE_A_ITEM_ID,
      DEFENSE_MODULE_A_TYPE_ID,
      DEFENSE_MODULE_B_ITEM_ID,
      DEFENSE_MODULE_B_TYPE_ID,
    ]) {
      assert.equal(text.includes(String(id)), false, `numeric id leaked: ${id}`);
    }
  }
});

test("R9a — no raw vocabulary reaches the player", () => {
  const text = visibleText(renderPanel(readyStore()));
  for (const raw of [
    "blocking",
    "advisory",
    "cannot-tell",
    "not-met",
    "FleetCompanionRunState",
    "followingOrderFrom",
    "defenseModuleIDs",
  ]) {
    assert.equal(text.includes(raw), false, `raw vocabulary leaked: ${raw}`);
  }
  const running = visibleText(renderPanel(startedStore()));
  for (const raw of ["own-ladder", "squad-board", "CALL_REFUSED"]) {
    assert.equal(running.includes(raw), false, `raw vocabulary leaked: ${raw}`);
  }
});

test("R8 — every cell of the readout table carries a data-label", () => {
  const body = renderPanel(startedStore());
  const cells = body.match(/<td[^>]*>/g) ?? [];
  assert.ok(cells.length > 0, "the running readout must render its table");
  for (const cell of cells) {
    assert.match(cell, /data-label=/, `every <td> needs a data-label: ${cell}`);
  }
});

test("plain ASCII only — no decorative non-ASCII character reaches the player", () => {
  for (const store of [createClientStore(), readyStore(), startedStore()]) {
    const text = visibleText(renderPanel(store));
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      assert.ok(
        code < 128,
        `non-ASCII character in player-facing text: ${JSON.stringify(ch)} (U+${code.toString(16)})`,
      );
    }
  }
});

test("R43 — the launcher's checklist and this panel's checklist both come from FLEET_COMPANION_REQUIREMENTS", () => {
  assert.match(SOURCE, /FLEET_COMPANION_REQUIREMENTS/);
  assert.match(SOURCE, /evaluateRequirements/);
});
