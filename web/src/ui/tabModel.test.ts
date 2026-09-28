// The nav tab model (goal R50 items 1 + 4): visibility driven by docked/in-space
// as data, and the selected tab derived from the same authoritative flag. These
// are the rules the login-default bug violated (page was hardcoded "station").

import test from "node:test";
import assert from "node:assert/strict";

import {
  TABS,
  deriveDocked,
  visibleTabsFor,
  defaultTabFor,
  resolvePage,
  type TabID,
} from "./tabs.ts";
import type { FlightStatus, OnlineCharacterState } from "../store/types.ts";

function flightStatus(over: Partial<FlightStatus>): FlightStatus {
  return {
    inSpace: false,
    docked: false,
    solarSystemID: null,
    stationID: null,
    structureID: null,
    shipID: null,
    shipTypeID: null,
    shipIsCapsule: null,
    shipMode: null,
    shipSpeedFraction: null,
    ...over,
  };
}

function online(over: Partial<OnlineCharacterState>): OnlineCharacterState {
  return {
    characterID: 1,
    characterName: "Farmer",
    stationID: null,
    structureID: null,
    solarSystemID: 30000142,
    corporationID: 1000001,
    ...over,
  };
}

const idsOf = (isDocked: boolean): TabID[] => visibleTabsFor(isDocked).map((t) => t.id);

// --- the login-default bug: the default follows the state, not a constant -----

test("the IN-SPACE default is NOT station (the login-default bug)", () => {
  // The exact regression: a hardcoded "station" default while in space.
  assert.notEqual(defaultTabFor(false), "station");
  // ⚠ IT WAS "overview" UNTIL THAT TAB STOPPED EXISTING. "Around Your Ship" was
  // a window while the old cockpit was being taken apart; the overview is fixed
  // chrome now — the dock panel on the right, the whole screen on mobile — so
  // it is never something to LAND on, because it is already there.
  assert.equal(defaultTabFor(false), "flight");
  assert.equal(
    TABS.some((tab) => tab.id === ("overview" as TabID)),
    false,
    "the cockpit tab came back",
  );
});

test("the DOCKED default is the inventory dock content (station services live inside it)", () => {
  assert.equal(defaultTabFor(true), "inventory");
});

// --- the visible set matches the state (item 1) ------------------------------

test("docked shows fitting + travel + bots and hides the in-space-only tabs", () => {
  const docked = idsOf(true);
  // fitting and now travel + bots are docked-only. (Station services are not a
  // Neocom tab at all — they are a tab inside the Inventory & Ship dock panel.)
  for (const shown of ["fitting", "travel", "bots"] as const) {
    assert.ok(docked.includes(shown), `${shown} must be visible while docked`);
  }
  for (const hidden of ["flight", "mining", "scanner"] as const) {
    assert.equal(docked.includes(hidden), false, `${hidden} must be hidden while docked`);
  }
});

test("in space shows the flight tabs and hides fitting + travel", () => {
  const space = idsOf(false);
  for (const shown of ["flight", "mining", "scanner", "drones", "shots", "equipment"] as const) {
    assert.ok(space.includes(shown), `${shown} must be visible in space`);
  }
  for (const hidden of ["fitting"] as const) {
    assert.equal(space.includes(hidden), false, `${hidden} must be hidden in space`);
  }
  // ⚠ TRAVEL IS NOT HIDDEN ANY MORE. It reads no docked state at all, and when
  // the old cockpit went it took the only in-space way to route yourself
  // somewhere off this grid with it — the "Somewhere else…" row at the bottom
  // of its list. Travel is that capability's real home.
  assert.ok(space.includes("travel"), "a flying pilot must be able to set a destination");
  // Bots and the Bot Builder are "both" tabs: a running bot has to stay
  // reachable in space, which is where it does its work.
  for (const shown of ["bots", "botBuilder"] as const) {
    assert.ok(space.includes(shown), `${shown} must stay reachable in space`);
  }
});

test("the 'both' tabs (including Activity, Fleet and both wallets) show in either state", () => {
  const both = ["inventory", "market", "activity", "fleet", "wallet", "corpWallet", "chat"] as const;
  for (const id of both) {
    assert.ok(idsOf(true).includes(id), `${id} visible docked`);
    assert.ok(idsOf(false).includes(id), `${id} visible in space`);
  }
});

// --- selection falls back when its tab is hidden by a state change (item 4) ---

test("a now-hidden selected tab falls back to the state default", () => {
  // Was on Flight (in-space only), then docked -> falls back to the dock default.
  assert.equal(resolvePage("flight", true), "inventory");
  // Was on Fitting (docked only), then undocked -> falls back to the in-space
  // default, which is Flight now that the overview is fixed chrome.
  assert.equal(resolvePage("fitting", false), "flight");
});

test("a still-visible selection is kept across a state change", () => {
  assert.equal(resolvePage("market", true), "market");
  assert.equal(resolvePage("market", false), "market");
  assert.equal(resolvePage("corpWallet", false), "corpWallet");
});

test("no explicit selection follows the state default", () => {
  assert.equal(resolvePage(null, true), "inventory");
  assert.equal(resolvePage(null, false), "flight");
});

// --- deriveDocked reads the authoritative flag, not stale data ---------------

test("deriveDocked trusts flight.status when it is loaded", () => {
  assert.equal(deriveDocked(flightStatus({ docked: true, inSpace: false }), null), true);
  assert.equal(deriveDocked(flightStatus({ docked: false, inSpace: true }), null), false);
  // Even if the online context still carries a stale station, the loaded flight
  // flag wins (undocked but station.online not yet cleared).
  assert.equal(
    deriveDocked(flightStatus({ docked: false, inSpace: true }), online({ stationID: 60003760 })),
    false,
  );
});

test("deriveDocked falls back to the station context before the first flight read", () => {
  assert.equal(deriveDocked(null, online({ stationID: 60003760 })), true);
  assert.equal(deriveDocked(null, online({ stationID: null })), false);
  assert.equal(deriveDocked(null, null), false);
});

// --- tab-table sweep + companion matcher proof -------------------------------

test("every tab id is unique and every 'where' is valid", () => {
  const ids = TABS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "tab ids must be unique");
  for (const tab of TABS) {
    assert.ok(["docked", "in-space", "both"].includes(tab.where), `${tab.id} has a valid where`);
    assert.ok(tab.label.trim().length > 0, `${tab.id} has a label`);
  }
});

// COMPANION MATCHER PROOF. The sweep above would pass over an EMPTY table or one
// where the filter matched nothing. These pin that TABS is non-empty and that
// each `where` bucket actually has members the filter selects â€” so the sweep is
// asserting against real data, not vacuously.
test("the sweep is not vacuous: each where-bucket has members the filter selects", () => {
  assert.ok(TABS.length >= 20, "the table has all the tabs");
  const dockedOnly = TABS.filter((t) => t.where === "docked");
  const spaceOnly = TABS.filter((t) => t.where === "in-space");
  const both = TABS.filter((t) => t.where === "both");
  assert.ok(dockedOnly.length > 0 && dockedOnly.some((t) => t.id === "fitting"));
  assert.ok(spaceOnly.length > 0 && spaceOnly.some((t) => t.id === "flight"));
  assert.ok(both.length > 0 && both.some((t) => t.id === "wallet"));
  // And the derived visible sets differ by exactly the state-specific tabs.
  assert.equal(visibleTabsFor(true).length, dockedOnly.length + both.length);
  assert.equal(visibleTabsFor(false).length, spaceOnly.length + both.length);
});
