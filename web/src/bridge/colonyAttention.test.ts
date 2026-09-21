// The colony monitor's judgement: which of the emulator's numbers deserve a
// sentence, and in what order.
//
// What is checked, and why each matters:
//
//   1. SILENCE IS THE DEFAULT. A quiet colony raises nothing, and an UNKNOWN
//      raises nothing either. Half of these tests exist to prove the monitor
//      stays quiet, because a panel that cries wolf is worse than no panel.
//
//   2. null, false AND 0 ARE THREE DIFFERENT THINGS. A factory flag of null is
//      "not a factory"; false is a real alarm. A used volume of 0 is an empty
//      pin; null is an unreadable one.
//
//   3. THE SHIPPED SENTENCE SURVIVES. The expired-extractor line in the table
//      has read the same since R41 and must keep reading the same.

import test from "node:test";
import assert from "node:assert/strict";

import {
  attentionByColony,
  attentionSummaryWords,
  colonyAttentionWords,
  colonyFindings,
  pinFill,
} from "./colonyAttention.ts";
import type { Colony, ColonyPin } from "../store/types.ts";

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);
const HOUR = 3_600_000;

function pin(overrides: Partial<ColonyPin> & Pick<ColonyPin, "pinID" | "kind">): ColonyPin {
  return {
    typeID: 2562,
    typeName: "Temperate Storage Facility",
    contents: [],
    usedM3: 0,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: NOW - 60_000,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

function colony(pins: readonly ColonyPin[], overrides: Partial<Colony> = {}): Colony {
  return {
    planetID: 40000002,
    planetName: "Tanoo I",
    solarSystemID: 30000001,
    solarSystemName: "Tanoo",
    planetTypeID: 11,
    planetTypeName: "Planet (Temperate)",
    commandCenterLevel: 3,
    lastSimulatedAtMs: NOW - 60_000,
    pins,
    linkCount: pins.length,
    links: [],
    routes: [],
    ...overrides,
  };
}

function extractor(pinID: number, expiresAtMs: number | null, resource = "Aqueous Liquids") {
  return pin({
    pinID,
    kind: "extractor-control",
    typeID: 3068,
    typeName: "Temperate Extractor Control Unit",
    program: expiresAtMs === null ? null : {
      resourceTypeID: 2268,
      resourceTypeName: resource,
      cycleTimeSeconds: 3600,
      quantityPerCycle: 2841,
      installedAtMs: NOW - 24 * HOUR,
      expiresAtMs,
      headCount: 3,
    },
  });
}

test("a working colony says nothing at all", () => {
  const quiet = colony([
    extractor(2, NOW + 48 * HOUR),
    pin({ pinID: 5, kind: "launchpad", usedM3: 855, capacityM3: 10000 }),
    pin({ pinID: 4, kind: "factory", receivedInputsLastCycle: true, hasReceivedInputs: true }),
    pin({ pinID: 1, kind: "command", usedM3: 0, capacityM3: 500 }),
  ]);

  assert.deepEqual(colonyFindings(quiet, NOW), []);
  assert.equal(colonyAttentionWords(colonyFindings(quiet, NOW)), null);
  assert.equal(attentionSummaryWords(attentionByColony([quiet], NOW)), null);
});

test("an extractor that has stopped is the loudest thing on a planet", () => {
  const findings = colonyFindings(colony([extractor(2, NOW - HOUR)]), NOW);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "extractor-expired");
  assert.equal(findings[0]!.urgency, "now");
  assert.equal(findings[0]!.dueAtMs, NOW - HOUR);
  assert.equal(findings[0]!.pinID, 2);
  assert.match(findings[0]!.words, /finished pulling Aqueous Liquids/);
});

test("a program ending inside the window is \"soon\", and one beyond it is silence", () => {
  const soon = colonyFindings(colony([extractor(2, NOW + 2 * HOUR)]), NOW);
  assert.equal(soon.length, 1);
  assert.equal(soon[0]!.kind, "extractor-expiring");
  assert.equal(soon[0]!.urgency, "soon");

  // Just past the default six-hour window: not yet worth a word.
  assert.deepEqual(colonyFindings(colony([extractor(2, NOW + 7 * HOUR)]), NOW), []);

  // The window is a setting, not a constant of nature.
  const widened = colonyFindings(colony([extractor(2, NOW + 7 * HOUR)]), NOW, {
    expiringWithinMs: 12 * HOUR,
    fullAtFraction: 0.9,
  });
  assert.equal(widened.length, 1);
  assert.equal(widened[0]!.kind, "extractor-expiring");
});

test("an extractor with no program is idle, and says so without a deadline", () => {
  const findings = colonyFindings(colony([extractor(2, null)]), NOW);

  assert.equal(findings[0]!.kind, "extractor-idle");
  assert.equal(findings[0]!.urgency, "now");
  assert.equal(findings[0]!.dueAtMs, null);
});

test("a hold is full at the mark, quiet below it, and quiet when unreadable", () => {
  const full = colonyFindings(
    colony([pin({ pinID: 6, kind: "storage", usedM3: 10800, capacityM3: 12000 })]),
    NOW,
  );
  assert.equal(full[0]!.kind, "pin-full");
  assert.match(full[0]!.words, /Temperate Storage Facility is 90% full/);

  // A shade under the mark is not an alarm.
  assert.deepEqual(
    colonyFindings(
      colony([pin({ pinID: 6, kind: "storage", usedM3: 10700, capacityM3: 12000 })]),
      NOW,
    ),
    [],
  );

  // ⚠ UNKNOWN RAISES NOTHING. One unreadable commodity nulls the whole pin's
  // used volume; an extractor control unit has no capacity at all. Neither may
  // become a finding, and neither may divide.
  assert.deepEqual(
    colonyFindings(
      colony([pin({ pinID: 6, kind: "storage", usedM3: null, capacityM3: 12000 })]),
      NOW,
    ),
    [],
  );
  assert.deepEqual(
    colonyFindings(
      colony([pin({ pinID: 6, kind: "storage", usedM3: 900, capacityM3: null })]),
      NOW,
    ),
    [],
  );
  assert.equal(pinFill(pin({ pinID: 6, kind: "storage", usedM3: 900, capacityM3: 0 })), null);
});

test("a starved factory is an alarm ONLY when the server said false", () => {
  const starved = colonyFindings(
    colony([pin({
      pinID: 4,
      kind: "factory",
      typeName: "Temperate Basic Industry Facility",
      schematicName: "Superconductors",
      hasReceivedInputs: true,
      receivedInputsLastCycle: false,
    })]),
    NOW,
  );
  assert.equal(starved[0]!.kind, "factory-starved");
  assert.match(starved[0]!.words, /making Superconductors was fed nothing/);

  // null is "this pin has no such state" — every extractor and every hold
  // answers it, and it must never be read as starvation.
  assert.deepEqual(
    colonyFindings(
      colony([pin({ pinID: 4, kind: "factory", receivedInputsLastCycle: null })]),
      NOW,
    ),
    [],
  );
  assert.deepEqual(
    colonyFindings(
      colony([pin({ pinID: 2, kind: "extractor-control", receivedInputsLastCycle: false })]),
      NOW,
    ).filter((finding) => finding.kind === "factory-starved"),
    [],
  );
});

test("a command centre holding goods is the launch trigger, once", () => {
  const holding = colonyFindings(
    colony([pin({
      pinID: 1,
      kind: "command",
      typeName: "Temperate Command Center",
      usedM3: 120,
      capacityM3: 500,
    })]),
    NOW,
  );
  assert.equal(holding.length, 1);
  assert.equal(holding[0]!.kind, "cc-holds-cargo");
  assert.equal(holding[0]!.urgency, "soon");

  // ⚠ NOT BOTH. A command centre past the full mark is reported as a full
  // hold, which is the more urgent reading of the same fact — never as two
  // findings about one structure.
  const brimming = colonyFindings(
    colony([pin({
      pinID: 1,
      kind: "command",
      typeName: "Temperate Command Center",
      usedM3: 480,
      capacityM3: 500,
    })]),
    NOW,
  );
  assert.deepEqual(brimming.map((finding) => finding.kind), ["pin-full"]);
});

test("findings sort by what is already waiting, then by severity, then by time", () => {
  const busy = colony([
    extractor(2, NOW + 3 * HOUR),
    extractor(3, NOW - 2 * HOUR),
    extractor(7, NOW - 5 * HOUR),
    pin({ pinID: 6, kind: "storage", usedM3: 11900, capacityM3: 12000 }),
    pin({ pinID: 4, kind: "factory", receivedInputsLastCycle: false }),
  ]);

  assert.deepEqual(
    colonyFindings(busy, NOW).map((finding) => [finding.kind, finding.pinID]),
    [
      // The two stopped extractors first, longest-stopped of them first.
      ["extractor-expired", 7],
      ["extractor-expired", 3],
      ["factory-starved", 4],
      ["pin-full", 6],
      // Only then the thing that has not happened yet.
      ["extractor-expiring", 2],
    ],
  );
});

test("the table's expired-extractor line reads exactly as it always has", () => {
  // ⚠ WORD FOR WORD. This sentence has been on the Planets table since R41 and
  // this module now produces it; a reworded string here is a silently reworded
  // screen.
  assert.equal(
    colonyAttentionWords(colonyFindings(colony([extractor(2, NOW - HOUR)]), NOW)),
    "1 extractor has finished its program",
  );
  assert.equal(
    colonyAttentionWords(
      colonyFindings(colony([extractor(2, NOW - HOUR), extractor(3, NOW - 2 * HOUR)]), NOW),
    ),
    "2 extractors have finished their programs",
  );
});

test("a colony line names the worst kind and admits there is more", () => {
  const mixed = colony([
    pin({ pinID: 6, kind: "storage", usedM3: 11900, capacityM3: 12000 }),
    pin({ pinID: 4, kind: "factory", receivedInputsLastCycle: false }),
  ]);
  assert.equal(
    colonyAttentionWords(colonyFindings(mixed, NOW)),
    "1 factory was fed nothing last cycle, and more needs you here",
  );

  // Two of the SAME kind is a count, not a "and more".
  const twoHolds = colony([
    pin({ pinID: 6, kind: "storage", usedM3: 11900, capacityM3: 12000 }),
    pin({ pinID: 5, kind: "launchpad", usedM3: 9900, capacityM3: 10000 }),
  ]);
  assert.equal(colonyAttentionWords(colonyFindings(twoHolds, NOW)), "2 holds are full");

  // Something merely coming up does not put a line on the table at all — the
  // panel's own "Extracting, next program ends in..." is the better sentence.
  assert.equal(
    colonyAttentionWords(colonyFindings(colony([extractor(2, NOW + 2 * HOUR)]), NOW)),
    null,
  );
});

test("quiet colonies are left out of the summary, and the loudest planet leads", () => {
  const quiet = colony([extractor(2, NOW + 48 * HOUR)], {
    planetID: 40000001,
    planetName: "Tanoo II",
  });
  const comingUp = colony([extractor(2, NOW + 2 * HOUR)], {
    planetID: 40000003,
    planetName: "Tanoo III",
  });
  const stopped = colony([extractor(2, NOW - HOUR)], {
    planetID: 40000004,
    planetName: "Tanoo IV",
  });

  const attention = attentionByColony([quiet, comingUp, stopped], NOW);
  assert.deepEqual(
    attention.map((entry) => [entry.colony.planetName, entry.needsYouNow]),
    [["Tanoo IV", true], ["Tanoo III", false]],
  );
  assert.equal(
    attentionSummaryWords(attention),
    "One planet needs you now. One more has something coming up.",
  );

  assert.equal(
    attentionSummaryWords(attentionByColony([comingUp], NOW)),
    "One planet has something coming up.",
  );
  assert.equal(
    attentionSummaryWords(attentionByColony([stopped, colony([extractor(2, NOW - HOUR)], {
      planetID: 40000005,
      planetName: "Tanoo V",
    })], NOW)),
    "2 planets need you now.",
  );
});
