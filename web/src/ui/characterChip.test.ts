// R107 — the character-bar chip. Its label must be a SHORT, uniform state word
// ("Docked" / "In space"), never the docked station name (which can be
// "Jita IV - Moon 4 - Caldari Navy Assembly Plant" and blew every tab to a
// different width). The full location stays available on the hover title.
//
// Rendered with Svelte's server generator, like panelFirstMount.test.ts — no DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const CharacterChip = (await import("./CharacterChip.svelte")).default;

const STATION_NAME = "Jita IV - Moon 4 - Caldari Navy Assembly Plant";

function sessionFor(store: ReturnType<typeof createClientStore>): unknown {
  // CharacterChip only reads session.store; flow is never touched in a render.
  return { id: "s1", store, flow: {} };
}

function renderChip(store: ReturnType<typeof createClientStore>): string {
  return render(CharacterChip as never, {
    props: { session: sessionFor(store), active: false, onSelect: () => {} },
  } as never).body;
}

function dockedStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 2, username: "test2" });
  store.apply({
    type: "character/online",
    character: {
      characterID: 140000002,
      characterName: "Test Two",
      stationID: 60003760,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: {
      stationID: 60003760,
      stationName: STATION_NAME,
      solarSystemName: "Jita",
      regionName: "The Forge",
      stationTypeID: null,
      stationTypeName: null,
      operationID: null,
      security: null,
    },
  });
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: 30000142,
      stationID: 60003760,
      structureID: null,
      shipID: null,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  return store;
}

function inSpaceStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "test" });
  store.apply({
    type: "character/online",
    character: {
      characterID: 140000001,
      characterName: "Test Pilot",
      stationID: null,
      structureID: null,
      solarSystemID: 30005239,
      corporationID: 1000001,
    },
    station: null,
  });
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: 30005239,
      stationID: null,
      structureID: null,
      shipID: 9001,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: "orbit",
      shipSpeedFraction: 1,
    },
  });
  return store;
}

test("a docked chip labels 'Docked', never the long station name", () => {
  const body = renderChip(dockedStore());
  // The visible label is the short state word.
  assert.match(body, /class="char-chip-where">Docked</);
  // The station name never appears in the chip BODY (it would blow the width).
  // Strip the title attribute first — the full location is allowed there.
  const withoutTitle = body.replace(/title="[^"]*"/g, "");
  assert.doesNotMatch(withoutTitle, /Caldari Navy Assembly Plant/, "station name leaked into the visible chip");
  // …and the full location is preserved on the hover title.
  assert.match(body, /title="[^"]*Jita IV - Moon 4 - Caldari Navy Assembly Plant/);
  assert.match(body, /Test Two/);
});

test("an in-space chip labels 'In space'", () => {
  const body = renderChip(inSpaceStore());
  assert.match(body, /class="char-chip-where">In space</);
  assert.match(body, /Test Pilot/);
});
