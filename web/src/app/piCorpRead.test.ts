// Reading corporation hangars for the PI board (R108 slice 5): through a pilot
// of that corporation who is online here, one office at a time, and with every
// refusal kept against the pilot it happened to.

import test from "node:test";
import assert from "node:assert/strict";

import type { ApiOptions, ResolveNamesResult } from "./api.ts";
import type { NameRef } from "../store/names.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { readCorpStock, type OnlinePilot, type PiCorpReadDeps } from "./piCorpRead.ts";

// The corpmgr wire shape: a CachedMethodCallResult around a CRowset of
// packedrows, as bridge/corpAssets.test.ts captured it.
function cachedCrowset(columns: readonly (readonly [string, number])[], rows: readonly Record<string, JsonValue>[]): JsonValue {
  const descriptor = { type: "objectex1", header: [{ type: "token", value: "blue.DBRowDescriptor" }, [[columns]]], list: [], dict: [] };
  return {
    type: "object",
    name: { type: "rawstr", value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
    args: [
      { type: "dict", entries: [] },
      {
        type: "substream",
        value: {
          type: "objectex2",
          header: [[{ type: "token", value: "carbon.common.script.sys.crowset.CRowset" }], { type: "dict", entries: [["header", descriptor]] }],
          list: rows.map((fields) => ({ type: "packedrow", header: descriptor, columns, fields })),
          dict: [],
        },
      },
      { type: "list", items: [{ type: "long", value: "134291934883450000" }, 0] },
    ],
  } as unknown as JsonValue;
}

const LOCATION_COLUMNS = [["locationID", 20], ["solarsystemID", 20], ["typeID", 3]] as const;
const ITEM_COLUMNS = [
  ["itemID", 20], ["typeID", 3], ["ownerID", 3], ["locationID", 20], ["flagID", 2], ["quantity", 3],
  ["groupID", 3], ["categoryID", 3], ["customInfo", 129], ["stacksize", 3], ["singleton", 3],
] as const;

// ESI's documented example ids, and obviously synthetic ones for the rest.
const CORP = 98000001;
const OTHER_CORP = 98000002;
const NPC_CORP = 1000044;
const PILOT_A = 90000001;
const PILOT_B = 90000002;
const STATION = 60000004;
const WATER = 3645;
const CHIRAL = 2401;

function item(itemID: number, typeID: number, quantity: number, flagID: number, categoryID: number): Record<string, JsonValue> {
  return { itemID, typeID, ownerID: CORP, locationID: 1030000000001, flagID, quantity, groupID: 1042, categoryID, customInfo: "", stacksize: quantity, singleton: 0 };
}

const OFFICES = { ok: true, inventory: cachedCrowset(LOCATION_COLUMNS, [{ locationID: STATION, solarsystemID: 30000001, typeID: 1529 }]), errors: { inventory: null } };
const OFFICE_ITEMS = {
  ok: true,
  inventory: OFFICES.inventory,
  locationInventory: cachedCrowset(ITEM_COLUMNS, [
    item(1, WATER, 300, 117, 43), // division 3
    item(2, WATER, 200, 117, 43), // same division: summed
    item(3, CHIRAL, 50, 115, 43), // division 1
    item(4, 34, 9000, 115, 4), // Tritanium: not planetary
  ]),
  errors: { inventory: null, locationInventory: null },
};

function pilot(characterID: number, corporationID: number | null): OnlinePilot {
  return { characterID, corporationID, options: { token: `token-${characterID}` } };
}

function deps(behaviour: (options: ApiOptions, locationID: number | null) => Record<string, JsonValue> | Error) {
  const calls: { token: string | null | undefined; locationID: number | null }[] = [];
  const named: NameRef[][] = [];
  const value: PiCorpReadDeps = {
    async loadCorpAssets(locationID, options) {
      calls.push({ token: options.token, locationID });
      const answer = behaviour(options, locationID);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async resolveNames(items): Promise<ResolveNamesResult> {
      named.push([...items]);
      return { names: { [`corporation:${CORP}`]: "Example Corp", [`station:${STATION}`]: "Alpha I - Moon 1 - Station" }, unresolved: [] };
    },
    now: () => 1_800_000_000_000,
  };
  return { value, calls, named };
}

const answersEverything = (_options: ApiOptions, locationID: number | null) =>
  (locationID === null ? OFFICES : OFFICE_ITEMS) as unknown as Record<string, JsonValue>;

test("a corp's planetary goods are read through its online pilot, office by office, with division and names", async () => {
  const { value, calls } = deps(answersEverything);
  const read = (await readCorpStock([CORP], [pilot(PILOT_A, CORP)], value))[0]!;
  assert.equal(read.state, "read");
  assert.equal(read.viaCharacterID, PILOT_A);
  assert.equal(read.corporationName, "Example Corp");
  assert.equal(read.readAtMs, 1_800_000_000_000);
  assert.deepEqual(
    [...read.items].sort((left, right) => left.typeID - right.typeID),
    [
      { typeID: CHIRAL, quantity: 50, locationID: STATION, locationName: "Alpha I - Moon 1 - Station", division: 1 },
      { typeID: WATER, quantity: 500, locationID: STATION, locationName: "Alpha I - Moon 1 - Station", division: 3 },
    ],
  );
  // Every call rode the pilot's OWN session: the office list, then the office.
  assert.deepEqual(calls, [
    { token: `token-${PILOT_A}`, locationID: null },
    { token: `token-${PILOT_A}`, locationID: STATION },
  ]);
});

test("⚠ a corp with none of its pilots online here is 'unreachable', and nothing is asked", async () => {
  const { value, calls } = deps(answersEverything);
  const reads = await readCorpStock([CORP], [pilot(PILOT_B, OTHER_CORP)], value);
  assert.deepEqual(reads.map((read) => read.state), ["unreachable"]);
  assert.equal(calls.length, 0);
});

test("a refused pilot is recorded against itself, and the next pilot of the corp is tried", async () => {
  const { value } = deps((options, locationID) =>
    options.token === `token-${PILOT_A}`
      ? new Error("No character is online; select a character first.")
      : answersEverything(options, locationID));
  const read = (await readCorpStock([CORP], [pilot(PILOT_A, CORP), pilot(PILOT_B, CORP)], value))[0]!;
  assert.equal(read.state, "read");
  assert.equal(read.viaCharacterID, PILOT_B);
  assert.deepEqual(read.refusals, [
    { characterID: PILOT_A, reason: "No character is online; select a character first." },
  ]);
});

test("a read the server refuses inside the answer counts as a refusal too", async () => {
  const { value } = deps(() => ({ ok: true, inventory: null, errors: { inventory: "READ_FAILED" } }) as unknown as Record<string, JsonValue>);
  const read = (await readCorpStock([CORP], [pilot(PILOT_A, CORP)], value))[0]!;
  assert.equal(read.state, "failed");
  assert.deepEqual(read.refusals, [
    { characterID: PILOT_A, reason: "the server refused the corporation asset read (READ_FAILED)" },
  ]);
});

test("NPC corporations and repeats are never read", async () => {
  const { value, calls } = deps(answersEverything);
  const reads = await readCorpStock([NPC_CORP, CORP, CORP], [pilot(PILOT_A, CORP), pilot(PILOT_B, NPC_CORP)], value);
  assert.deepEqual(reads.map((read) => read.corporationID), [CORP]);
  assert.equal(calls.filter((call) => call.locationID === null).length, 1);
});

test("names that do not come back leave the goods counted, unnamed", async () => {
  const { value } = deps(answersEverything);
  value.resolveNames = async () => {
    throw new Error("names unavailable");
  };
  const read = (await readCorpStock([CORP], [pilot(PILOT_A, CORP)], value))[0]!;
  assert.equal(read.corporationName, null);
  assert.ok(read.items.every((entry) => entry.locationName === null));
  assert.equal(read.items.reduce((total, entry) => total + entry.quantity, 0), 550);
});
