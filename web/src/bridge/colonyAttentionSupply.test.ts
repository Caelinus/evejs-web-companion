// A starved factory is judged against its SUPPLY, not against one cycle.
//
// ⚠ WHY THE OLD RULE WAS WRONG. "Fed nothing last cycle" is true of almost
// every factory on a colony whose extraction is the bottleneck, which is most
// colonies: four Water factories want 24,000 Aqueous Liquids an hour and two
// extractors deliver a few thousand, so on any given cycle most of them wait.
// The live board said "needs you now" for every one of those, on every planet,
// and a board that cries wolf is worse than no board.
//
// The rule now: a factory that was fed nothing is only worth a word when one of
// its inputs has NO LIVE SOURCE — nothing routes it in, or everything that does
// leads back to nothing. Slower than it could use is how the colony was built,
// and says nothing. And when the dead source is an extractor that ran out, the
// extractor's own finding names the cause; the factories are not listed again.
//
// The topology in `waterColony` is the captured live colony's own: two
// extractors into a storage facility, the storage routing Aqueous Liquids to
// four Water factories chained to a launchpad.

import test from "node:test";
import assert from "node:assert/strict";

import { attentionByColony, colonyAttentionWords, colonyFindings } from "./colonyAttention.ts";
import { decodeRecipeBook, type PiRecipeBook } from "./piRecipes.ts";
import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";
import type { JsonValue } from "./wire.ts";

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const HOUR = 3_600_000;

const AQUEOUS = 2268;
const WATER = 3645;
const BACTERIA = 2393;
const MICROORGANISMS = 2073;
const WATER_RECIPE = 121;
const BACTERIA_RECIPE = 131;

// Two rows as the route serves them. Water is the real row (3000 in, 20 out,
// 30 minutes); Bacteria's real row takes 3000 Microorganisms.
const BOOK: PiRecipeBook = decodeRecipeBook({
  schematics: [
    {
      schematicID: WATER_RECIPE,
      name: "Water",
      cycleTimeSeconds: 1800,
      factoryTypeIDs: [2473],
      inputs: [{ typeID: AQUEOUS, quantity: 3000, typeName: "Aqueous Liquids" }],
      output: { typeID: WATER, quantity: 20, typeName: "Water" },
    },
    {
      schematicID: BACTERIA_RECIPE,
      name: "Bacteria",
      cycleTimeSeconds: 1800,
      factoryTypeIDs: [2473],
      inputs: [{ typeID: MICROORGANISMS, quantity: 3000, typeName: "Microorganisms" }],
      output: { typeID: BACTERIA, quantity: 20, typeName: "Bacteria" },
    },
  ],
} as unknown as JsonValue);

function pin(overrides: Partial<ColonyPin> & Pick<ColonyPin, "pinID" | "kind">): ColonyPin {
  return {
    typeID: 0,
    typeName: "",
    contents: [],
    usedM3: null,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: null,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

function extractor(pinID: number, expiresAtMs: number | null, resourceTypeID = AQUEOUS): ColonyPin {
  return pin({
    pinID,
    kind: "extractor-control",
    program: expiresAtMs === null ? null : {
      resourceTypeID,
      resourceTypeName: "Aqueous Liquids",
      cycleTimeSeconds: 7200,
      quantityPerCycle: 4591,
      installedAtMs: NOW - 48 * HOUR,
      expiresAtMs,
      headCount: 7,
    },
  });
}

function factory(
  pinID: number,
  fedLastCycle: boolean | null,
  overrides: Partial<ColonyPin> = {},
): ColonyPin {
  return pin({
    pinID,
    kind: "factory",
    schematicID: WATER_RECIPE,
    schematicName: "Water",
    hasReceivedInputs: fedLastCycle === null ? null : true,
    receivedInputsLastCycle: fedLastCycle,
    ...overrides,
  });
}

let nextRouteID = 1;
function route(path: readonly number[], commodityTypeID = AQUEOUS): ColonyRoute {
  return {
    routeID: nextRouteID++,
    path,
    commodityTypeID,
    commodityTypeName: null,
    commodityQuantity: 3000,
  };
}

function colony(pins: readonly ColonyPin[], routes: readonly ColonyRoute[]): Colony {
  return {
    planetID: 40000002,
    planetName: "Alpha I",
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: NOW - 60_000,
    pins,
    linkCount: 0,
    links: [],
    routes,
  };
}

const STORAGE = 2;
const PAD = 7;

/** The live colony's shape: two extractors -> storage -> four factories. */
function waterColony(
  extractors: readonly ColonyPin[] = [extractor(10, NOW + 30 * HOUR), extractor(11, NOW + 30 * HOUR)],
): Colony {
  return colony(
    [
      ...extractors,
      pin({ pinID: STORAGE, kind: "storage" }),
      factory(3, false),
      factory(4, true, { contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 2635 }] }),
      factory(5, false),
      factory(6, false),
      pin({ pinID: PAD, kind: "launchpad" }),
    ],
    [
      ...extractors.map((ecu) => route([ecu.pinID, STORAGE])),
      route([STORAGE, 4]),
      route([STORAGE, 4, 5]),
      route([STORAGE, 4, 5, 6]),
      route([STORAGE, 4, 5, 6, 3]),
      // Every factory sends its Water on: the game flags one whose output
      // goes nowhere (colonyData.IsSomeProductUnrouted).
      ...[3, 4, 5, 6].map((factoryPinID) => route([factoryPinID, PAD], WATER)),
    ],
  );
}

function starved(subject: Colony, recipes: PiRecipeBook | null = BOOK) {
  return colonyFindings(subject, NOW, undefined, recipes).filter(
    (finding) => finding.kind === "factory-starved",
  );
}

test("⚠ the live colony's shape says nothing: supply is running, just slower than demand", () => {
  assert.deepEqual(starved(waterColony()), []);
  // Nor without the recipe table: the routes alone show the supply is live.
  assert.deepEqual(starved(waterColony(), null), []);
  assert.deepEqual(attentionByColony([waterColony()], NOW, undefined, BOOK), []);
});

test("an extractor that ran out is the finding; its factories are not listed again", () => {
  const stopped = waterColony([extractor(10, NOW - HOUR), extractor(11, NOW - HOUR)]);
  const findings = colonyFindings(stopped, NOW, undefined, BOOK);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.kind))],
    ["extractor-expired"],
  );
  // One still running is live supply: no factory finding either.
  assert.deepEqual(starved(waterColony([extractor(10, NOW - HOUR), extractor(11, NOW + HOUR)])), []);
});

test("an extractor with no program is the finding too, not its factories", () => {
  const idle = waterColony([extractor(10, null)]);
  assert.deepEqual(starved(idle), []);
  assert.equal(colonyFindings(idle, NOW, undefined, BOOK)[0]!.kind, "extractor-idle");
});

test("⚠ no route bringing an input is a real fault, and names the input", () => {
  const unrouted = colony(
    [extractor(10, NOW + 30 * HOUR), pin({ pinID: STORAGE, kind: "storage" }), factory(3, false)],
    [route([10, STORAGE])],
  );
  const [finding] = starved(unrouted);
  assert.equal(finding!.words, "No route brings Aqueous Liquids to the factory making Water");
  assert.equal(finding!.urgency, "now");
  assert.equal(finding!.pinID, 3);
});

test("no recipe table and no inbound route: said without naming what is missing", () => {
  const unrouted = colony([factory(3, false)], []);
  assert.equal(
    starved(unrouted, null)[0]!.words,
    "No route brings anything to the factory making Water",
  );
});

test("a route from a source with nothing behind it is dead supply", () => {
  const empty = colony(
    [pin({ pinID: STORAGE, kind: "storage" }), factory(3, false)],
    [route([STORAGE, 3])],
  );
  assert.equal(
    starved(empty)[0]!.words,
    "Nothing is sending Aqueous Liquids to the factory making Water",
  );
});

test("stock is supply: a storage holding the input, or a factory holding a full batch", () => {
  const stocked = colony(
    [
      pin({ pinID: STORAGE, kind: "storage", contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 9000 }] }),
      factory(3, false),
    ],
    [route([STORAGE, 3])],
  );
  assert.deepEqual(starved(stocked), []);

  const fullBatch = colony(
    [factory(3, false, { contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 3000 }] })],
    [],
  );
  assert.deepEqual(starved(fullBatch), []);

  // Less than a batch with nothing coming is still stuck.
  const partial = colony(
    [factory(3, false, { contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 2999 }] })],
    [],
  );
  assert.equal(starved(partial).length, 1);
});

test("supply is followed through factories: a chain is live only if its start is", () => {
  const bacteriaFrom = (upstream: ColonyPin) =>
    colony(
      [
        upstream,
        factory(20, true, { schematicID: BACTERIA_RECIPE, schematicName: "Bacteria" }),
        factory(21, false, { schematicID: WATER_RECIPE, schematicName: "Water" }),
      ],
      [
        route([upstream.pinID, 20], MICROORGANISMS),
        // Contrived on purpose: Water does not take Bacteria, but the walk must
        // follow a factory's OUTPUT, so this names the factory as the source.
        route([20, 21], BACTERIA),
      ],
    );
  // Book knows Water takes Aqueous, which nothing routes in: a real fault. The
  // Bacteria route into it is not an Aqueous route, whatever it carries.
  const [fault] = starved(bacteriaFrom(extractor(9, NOW + HOUR, MICROORGANISMS)));
  assert.equal(fault!.pinID, 21);
  assert.equal(fault!.words, "No route brings Aqueous Liquids to the factory making Water");

  // Without the table, the inputs are what the routes bring: Bacteria, from a
  // factory whose own supply is a running extractor. Live.
  assert.deepEqual(starved(bacteriaFrom(extractor(9, NOW + HOUR, MICROORGANISMS)), null), []);
  // ...and when that extractor has run out, it is the finding, not the chain.
  const chainDead = bacteriaFrom(extractor(9, NOW - HOUR, MICROORGANISMS));
  assert.deepEqual(starved(chainDead, null), []);
  assert.equal(colonyFindings(chainDead, NOW, undefined, null)[0]!.kind, "extractor-expired");
});

test("one live source is enough, whatever else routes in empty", () => {
  const twoSources = colony(
    [
      pin({ pinID: 30, kind: "storage" }),
      pin({ pinID: 31, kind: "storage", contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 500 }] }),
      factory(3, false),
    ],
    [route([30, 3]), route([31, 3])],
  );
  assert.deepEqual(starved(twoSources), []);
});

test("a loop of routes with nothing in it ends, and is dead supply", () => {
  const loop = colony(
    [pin({ pinID: 30, kind: "storage" }), pin({ pinID: 31, kind: "storage" }), factory(3, false)],
    [route([30, 31]), route([31, 30]), route([30, 3])],
  );
  assert.equal(starved(loop).length, 1);
});

test("a factory the server said WAS fed, or said nothing about, is never judged", () => {
  const fed = colony([factory(3, true)], []);
  const unknown = colony([factory(3, null)], []);
  assert.deepEqual(starved(fed), []);
  assert.deepEqual(starved(unknown), []);
});

test("a source factory whose recipe is unknown is not called dead: unknown raises nothing", () => {
  const mystery = colony(
    [
      factory(20, true, { schematicID: 999, schematicName: null }),
      factory(3, false),
    ],
    [route([20, 3], AQUEOUS)],
  );
  assert.deepEqual(starved(mystery), []);
});

test("the colony's one line counts factories with nothing coming in", () => {
  const two = colony(
    [factory(3, false), factory(5, false)],
    [],
  );
  assert.equal(
    colonyAttentionWords(colonyFindings(two, NOW, undefined, BOOK)),
    "2 factories have nothing coming in",
  );
  assert.equal(
    colonyAttentionWords(colonyFindings(colony([factory(3, false)], []), NOW, undefined, BOOK)),
    "1 factory has nothing coming in",
  );
});
