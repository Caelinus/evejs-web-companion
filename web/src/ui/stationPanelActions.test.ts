// The Station Services tab inside Inventory & Ship (the docked dock-panel
// content). A docked character must be offered the tab with "Board your
// corvette" and "Leave ship", the guest list lives there too, and a refused
// action's words (which land in inventory.actionError via the shared mutation
// path) surface on this panel. In space the tab must NOT be offered — station
// services mean nothing without a station.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");

/** No panel may call the flow during a server render — reads back no-ops. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function onlineStore(stationID: number | null) {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" });
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Farmer",
      stationID,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: null,
  });
  return store;
}

async function renderInventory(store: unknown): Promise<string> {
  const { default: InventoryShip } = (await import("./InventoryShip.svelte")) as { default: unknown };
  return render(InventoryShip as never, { props: { store, flow: fakeFlow(), dock: true } } as never).body;
}

test("docked, the Station Services tab offers the corvette and leave-ship actions and the guests", async () => {
  const body = await renderInventory(onlineStore(60003760));

  assert.match(body, /Station Services/, "the Station Services tab is missing");
  assert.match(body, /Board your corvette/, "the corvette action is missing");
  assert.match(body, /Leave ship/, "the leave-ship action is missing");
  assert.match(body, /Repair ship/, "the repair-shop action is missing");
  assert.match(body, /Guests/, "the guest list is missing");
});

test("the repair shop is not charged until it has been asked for a quote", async () => {
  const body = await renderInventory(onlineStore(60003760));

  // "Repair ship" only raises the quote; the priced press appears with it.
  assert.doesNotMatch(body, /and pay/, "the paying press must not be offered before a quote");
});

test("in space the Station Services tab is not offered", async () => {
  const body = await renderInventory(onlineStore(null));

  assert.doesNotMatch(body, /id="inv-tab-station"/, "the station tab leaked into space");
  assert.doesNotMatch(body, /Board your corvette/, "the corvette action leaked into space");
  assert.doesNotMatch(body, /Repair ship/, "the repair action leaked into space");
});

test("a refused ship action's words surface on the panel", async () => {
  const store = onlineStore(60003760);
  store.apply({
    type: "inventory/action-error",
    message: "You are already in your corvette.",
  });
  const body = await renderInventory(store);

  assert.match(body, /You are already in your corvette\./, "the refusal words are not shown");
});
