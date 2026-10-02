import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID, STATION_ID } from "./botFixtures.ts";

const AGENT = 3008416;
const TYPE = 3814;
const ITEM = 44;
const dict = (entries: unknown[][]) => ({ type: "dict", entries });
const list = (items: unknown[]) => ({ type: "list", items });
const tuple = (items: unknown[]) => ({ type: "tuple", items });
const keyVal = (entries: unknown[][]) => ({ type: "object", name: "util.KeyVal", args: dict(entries) });
const cargoStack = (itemID: number, quantity: number) => ({ type: "packedrow", fields: {
  itemID, typeID: TYPE, quantity, singleton: false, groupID: 314, categoryID: 4, flagID: 5,
} });

test("custom courier turn-in forwards exactly the required split to the BFF and leaves surplus cargo", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let accepted = false;
  let completed = false;
  let aboard = 1010;
  let ashore = 0;
  const transfers: Record<string, unknown>[] = [];
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 4001, username: "pilot", accountCreated: false });
  store.apply({ type: "character/online", character: {
    characterID: 42, characterName: "Pilot", stationID: STATION_ID, structureID: null,
    solarSystemID: SOLAR_SYSTEM_ID, corporationID: 1000002,
  }, station: null });
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/flight/status") result = flightBody(true);
    if (path === "/api/bridge/fitting") result = fittingBody();
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/bridge/call") result = { ok: true, service: body.service, method: body.method,
      result: body.method === "GetStationItemBits" ? [1, STATION_ID, 26, 1529] : body.method === "GetGuests" ? list([]) : null };
    if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
    if (path === "/api/bridge/ship/ore-hold") result = { ok: true, activeShipID: SHIP_ID, holds: [] };
    if (path === "/api/bridge/script/observation") result = { ok: true, bay: [], inSpace: [],
      space: { inSpace: false, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID, ship: null, entities: [] } };
    if (path === "/api/map/graph") result = { ok: true, systems: { [SOLAR_SYSTEM_ID]: "Perimeter" }, edges: [] };
    if (path.startsWith("/api/agents/find")) result = { ok: true, kind: "courier", level: 1, total: 1, capped: false, agents: [{
      agentID: AGENT, name: "Courier Agent", agentTypeID: 2, divisionID: 22, level: 1,
      corporationID: 1000002, stationID: STATION_ID, stationName: "Destination", solarSystemID: SOLAR_SYSTEM_ID,
    }] };
    if (path === "/api/bridge/journal") result = { ok: true, result: tuple([
      list(accepted && !completed ? [tuple([2, 0, "Courier", 1, AGENT, null, list([]), 0, 0, 7])] : []), list([]),
    ]) };
    if (path === `/api/bridge/agents/${AGENT}/action`) {
      if (body.actionID === 816) accepted = true;
      if (body.actionID === 821) completed = true;
      result = { ok: true, result: tuple([
        tuple([tuple([127958, 7]), list([tuple(accepted ? [821, 7] : [816, 3])])]),
        dict([["missionCompleted", completed]]),
      ]) };
    }
    if (path === `/api/bridge/agents/${AGENT}/briefing`) {
      const location = dict([["locationID", STATION_ID], ["solarsystemID", SOLAR_SYSTEM_ID]]);
      result = { ok: true, briefing: dict([["Mission Title ID", 1]]), objective: dict([
        ["objectives", list([tuple(["transport", tuple([1000002, location, 1000002, location,
          dict([["typeID", TYPE], ["quantity", 10], ["volume", 1]])])])])],
      ]) };
    }
    if (path === "/api/bridge/inventory") result = { ok: true, stationID: STATION_ID, activeShipID: SHIP_ID,
      cargo: { shipID: SHIP_ID, list: list([cargoStack(ITEM, aboard)]), capacity: keyVal([["capacity", 1000], ["used", 101]]) },
      hangar: { list: list(ashore ? [cargoStack(45, ashore)] : []) }, volumes: { [TYPE]: 0.1 },
    };
    if (path === "/api/bridge/inventory/transfer") {
      transfers.push(body);
      const moved = typeof body.qty === "number" ? body.qty : aboard;
      aboard -= moved;
      ashore += moved;
    }
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } });
  const doc: BotScript = { format: "evejs-bot-script", version: 1, name: "Courier split", notes: "",
    home: { entity: "station", id: STATION_ID, name: "Destination", systemName: null }, interrupts: [], program: [
      { id: "find", kind: "macro", macro: "find-distribution-agent", args: { level: { kind: "count", value: 1 } } },
      { id: "accept", kind: "macro", macro: "accept-mission", args: {} },
      { id: "deliver", kind: "macro", macro: "turn-in-mission", args: {} },
    ] };
  try {
    await flow.startCustomBot(doc);
    for (let i = 0; i < 40 && !completed; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      t.mock.timers.tick(2000);
    }
    assert.equal(completed, true, JSON.stringify(store.customBot.get()));
    assert.deepEqual(transfers, [{ itemIDs: [ITEM], from: { kind: "cargo" }, to: { kind: "hangar" }, qty: 10 }]);
    assert.equal(aboard, 1000);
    assert.equal(ashore, 10);
  } finally {
    flow.stopCustomBot();
    t.mock.timers.reset();
  }
});
