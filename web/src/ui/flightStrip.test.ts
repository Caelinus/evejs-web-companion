// The R30 slice C flight strip as it actually RENDERS.
//
// The strip answers three questions the player previously had to leave this tab
// to ask — where am I, what is happening, what went wrong — plus the one control
// that matters right now. Two of its rules are the kind that rot silently, so
// they are checked here against real rendered output rather than trusted:
//
//   1. NARRATION IS NEVER SYNTHESIZED. Hand-flying shows no "doing" line at all.
//      A convincing invented sentence is worse than no sentence, because it
//      makes a browser guess indistinguishable from something the autopilot
//      actually reported.
//   2. STOP IS NEVER DISABLED. Not by a shared busy flag, not by its own. It is
//      the control you reach for when things are going wrong, which is exactly
//      when other requests are in flight.
//
// It also re-proves the standing invariants on the new markup: R7d (no visible
// numeric IDs) and R9a (plain player language).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Flight = (await import("./Flight.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Flight.svelte"), "utf8");
const NARRATION = readFileSync(path.join(UI_DIR, "flightNarration.ts"), "utf8");

const SHIP_ID = 9001;
const SHIP_TYPE_ID = 622;
const STATION_ID = 60000358;
const SYSTEM_ID = 30000142;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/** Everything visible to a player, with markup and image sources stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function dockedStore() {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: SYSTEM_ID,
      stationID: STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: STATION_ID,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    structureName: null,
  });
  return store;
}

function inSpaceStore() {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: SYSTEM_ID,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: null,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: null,
    structureName: null,
  });
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1_700_000_000_000,
      entities: [],
      ship: {
        itemID: SHIP_ID,
        typeID: SHIP_TYPE_ID,
        name: null,
        mode: "STOP",
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 400,
        armorCapacity: 300,
        hullCapacity: 600,
        radius: 100,
        maxVelocity: 300,
        activeModuleIDs: [],
    overloadedModuleIDs: [],
    moduleDamage: {},
    weaponBanks: {},
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
    },
  });
  store.apply({
    type: "names/resolved",
    entries: { [`type:${SHIP_TYPE_ID}`]: "Venture" },
  });
  return store;
}

function renderWith(store: unknown): string {
  return render(Flight as never, { props: { store, flow: fakeFlow() } } as never).body;
}

// --- where ------------------------------------------------------------------

test("docked, the strip says WHERE — by station name, never an id", () => {
  const body = renderWith(dockedStore());
  const text = visibleText(body);

  assert.match(text, /Docked at Jita IV - Moon 4 - Caldari Navy Assembly Plant/);
  // R7d — the station and system ids are never rendered.
  assert.equal(body.includes(String(STATION_ID)), false);
  assert.equal(body.includes(String(SYSTEM_ID)), false);
  assert.equal(body.includes(String(SHIP_ID)), false);
});

test("in space, the strip names the system AND the ship, by name", () => {
  const body = renderWith(inSpaceStore());
  const text = visibleText(body);

  assert.match(text, /In space · Jita/);
  assert.match(text, /Venture/, "the active ship is named by its type");
  assert.equal(body.includes(String(SHIP_TYPE_ID)), false, "R7d — never the typeID");
});

test("before any flight read the strip says it does not know yet, and guesses nothing", () => {
  const text = visibleText(renderWith(createClientStore()));
  assert.match(text, /Finding out where you are/);
  // It must not claim a location it has not been told.
  assert.equal(/In space ·/.test(text), false);
  assert.equal(/Docked at/.test(text), false);
});

// --- doing: the rule that must not rot --------------------------------------

test("HAND-FLYING PRODUCES NO NARRATION — nothing is synthesized", () => {
  // A ship in space, nothing driving it. There is no authority to quote, so the
  // strip says nothing about what is happening rather than inventing a phrase.
  const body = renderWith(inSpaceStore());
  assert.equal(
    body.includes("strip-doing"),
    false,
    "manual play must render no 'doing' line at all",
  );
});

test("a running bot's OWN words are passed through, unaltered", () => {
  const store = inSpaceStore();
  store.apply({
    type: "bot/progress",
    status: "running",
    phase: "Mining",
    action: "Running the lasers",
    why: "The hold still has room",
    // R44 — the readout carries which rung fired. The strip does not show it.
    rung: null,
    step: null,
    rockName: "Veldspar",
    cyclesCompleted: 2,
    oreUnitsMined: 400,
    holdUsed: 200,
    holdCapacity: 5000,
    failureReason: null,
  });
  const text = visibleText(renderWith(store));

  // Each of the three fields the loop reported, verbatim.
  assert.match(text, /Mining/);
  assert.match(text, /Running the lasers/);
  assert.match(text, /The hold still has room/);
});

test("a paused bot is still driving the ship, and still gets to speak", () => {
  const store = inSpaceStore();
  store.apply({
    type: "bot/progress",
    status: "paused",
    phase: "Mining",
    action: "Holding",
    why: "You paused it",
    rung: null,
    step: null,
    rockName: null,
    cyclesCompleted: 0,
    oreUnitsMined: 0,
    holdUsed: null,
    holdCapacity: null,
    failureReason: null,
  });
  assert.match(visibleText(renderWith(store)), /You paused it/);
});

test("a bot that has STOPPED says nothing — a finished loop is not narration", () => {
  const store = inSpaceStore();
  store.apply({
    type: "bot/progress",
    status: "stopped",
    phase: "Mining",
    action: "Running the lasers",
    why: "The hold still has room",
    rung: null,
    step: null,
    rockName: null,
    cyclesCompleted: 1,
    oreUnitsMined: 100,
    holdUsed: null,
    holdCapacity: null,
    failureReason: null,
  });
  assert.equal(
    renderWith(store).includes("strip-doing"),
    false,
    "stale words from a loop that is no longer running are not what is happening",
  );
});

// --- wrong ------------------------------------------------------------------

test("a refusal from anywhere reaches the cockpit", () => {
  const store = inSpaceStore();
  store.apply({ type: "flight/action-error", message: "Warp refused: You are warp scrambled." });
  assert.match(visibleText(renderWith(store)), /You are warp scrambled/);
});

test("the strip shows ONE reason, the first, rather than a pile", () => {
  const store = inSpaceStore();
  store.apply({ type: "flight/action-error", message: "Warp refused: scrambled." });
  store.apply({ type: "targeting/action-error", message: "Lock refused: too far." });
  const body = renderWith(store);
  assert.equal(
    (body.match(/strip-wrong/g) ?? []).length,
    1,
    "the strip carries a single 'what went wrong' line",
  );
  // ...and it is the FIRST source in the documented order, not the last written.
  assert.match(visibleText(body), /scrambled/);
});

// --- the control ------------------------------------------------------------

test("docked, the primary control is Undock — and it is HERE, not on another tab", () => {
  const text = visibleText(renderWith(dockedStore()));
  assert.match(text, /Undock/);
  assert.equal(/Stop the ship/.test(text), false, "a docked ship has no engines to cut");
});

test("in space, the strip no longer carries Stop — the HUD does", () => {
  // ⚠ THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED, AND DELIBERATELY.
  //
  // Stop used to be the strip's in-space control. It moved to the HUD footer,
  // which is always on screen in space, because this window is one a player has
  // to OPEN — and the control you reach for when things are going wrong must
  // not be behind that. The rule that travels with it ("never disabled, never
  // guarded") is now asserted in `chromeRender.test.ts` against `HudBar`; both
  // halves of it, so nothing was dropped in the move.
  //
  // What is checked here is only that it did not end up in BOTH places: two
  // Stops on screen means two places a refusal could be reported and one of
  // them will be the one the player is not looking at.
  const body = renderWith(inSpaceStore());
  const from = body.indexOf("flight-strip");
  assert.ok(from > 0, "the flight strip is rendered at all");
  // The strip's OWN markup, bounded at its closing tag — not a fixed window,
  // which would quietly stop covering the strip the moment it grew.
  const strip = body.slice(from, body.indexOf("</section>", from));
  assert.ok(strip.length > 0, "the strip section is not closed");
  assert.equal(
    strip.includes("Stop the ship"),
    false,
    "the strip drew Stop again — it belongs to the HUD footer now",
  );
  // Non-vacuous: the slice really is the strip, and really does still hold the
  // strip's own content. Without this the assertion above passes on an empty
  // string.
  assert.match(strip, /strip-where/, "the slice is not the flight strip");
});

// --- the structural claims --------------------------------------------------

test("the busy state is a per-concern SET, not one flag", () => {
  // ⚠ THE CLAIM MOVED WITH THE PANEL THAT HAS VERBS. The cockpit is gone; the
  // component that now dispatches flight verbs against a picked row is
  // `SpaceOverview`, and this is the rule that stops one in-flight request
  // greying out every other control — including, historically, Stop, mid-fight,
  // because a lock happened to be pending.
  const overview = readFileSync(path.join(UI_DIR, "SpaceOverview.svelte"), "utf8");
  assert.match(overview, /let busy = \$state<ReadonlySet<ActionConcern>>/);
  assert.match(overview, /busy\.has\(/, "controls must be disabled by their OWN concern");
  // And the exemption is written down so a later cleanup does not undo it.
  assert.match(overview, /A SET, NOT A FLAG/);
});

test("the app no longer tells the player to go to the Flight tab to undock", () => {
  // Deleting this sentence IS the acceptance test for this slice: Undock is on
  // the cockpit now, so the instruction to leave it is false.
  assert.equal(
    SOURCE.includes("Undock on the Flight tab"),
    false,
    "the tab-switch instruction must be gone, not reworded",
  );
  const dockedText = visibleText(renderWith(dockedStore()));
  assert.equal(/Flight tab/.test(dockedText), false);
});

test("R9a — the strip speaks plain player language", () => {
  const store = inSpaceStore();
  store.apply({ type: "flight/action-error", message: "Warp refused: You are warp scrambled." });
  const text = visibleText(renderWith(store));
  // No runtime/entity jargon leaking into the readout.
  for (const jargon of ["solarSystemID", "stationID", "itemID", "typeID", "inSpace", "KeyVal"]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" must not reach the player`);
  }
});
