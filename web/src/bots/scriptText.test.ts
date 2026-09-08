// A3 — the sentence register. Two guarantees are pinned: EVERY macro and EVERY
// condition has a plain sentence (the exhaustiveness the compiler enforces, made
// visible), and NO sentence ever renders a world id (R7d).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONDITION_KINDS,
  INTERRUPT_RESPONSES,
  MACRO_IDS,
  type Condition,
  type ConditionKind,
  type MacroStep,
} from "./botScript.ts";
import {
  conditionSentence,
  interruptSentence,
  macroName,
  repeatSentence,
  responseSentence,
  stepSentence,
} from "./scriptText.ts";

function sampleCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "ore-hold-at-least":
      return { kind, fraction: 0.9 };
    case "shield-below":
    case "armor-below":
    case "hull-below":
    case "health-below":
    case "capacitor-below":
      return { kind, fraction: 0.3 };
    case "wallet-below":
    case "wallet-above":
      return { kind, isk: 100_000_000 };
    case "cargo-full":
      return { kind, fraction: 0.9 };
    case "drone-health-below":
      return { kind, fraction: 0.4 };
    case "hold-empty":
    case "hostile-on-grid":
    case "targeted-by-player":
      return { kind };
  }
}

// A run of five or more digits is almost certainly a rendered id — the thing R7d
// forbids. Percentages (30%) and small counts (50) never trip this.
const LOOKS_LIKE_ID = /\d{5,}/;

test("every macro has a plain name with no numbers in it", () => {
  for (const macro of MACRO_IDS) {
    const name = macroName(macro);
    assert.ok(name.length > 0, `${macro} has no name`);
    assert.doesNotMatch(name, /\d/, `${macro} name should not carry a number`);
  }
});

test("every condition has a non-empty sentence and never renders an id", () => {
  for (const kind of CONDITION_KINDS) {
    const sentence = conditionSentence(sampleCondition(kind));
    assert.ok(sentence.length > 0, `${kind} has no sentence`);
    assert.doesNotMatch(sentence, LOOKS_LIKE_ID);
  }
});

test("every interrupt response has a non-empty sentence", () => {
  for (const response of INTERRUPT_RESPONSES) {
    assert.ok(responseSentence(response).length > 0, `${response} has no sentence`);
  }
});

test("percentages read with their unit", () => {
  assert.match(conditionSentence({ kind: "shield-below", fraction: 0.3 }), /30%/);
  assert.match(conditionSentence({ kind: "ore-hold-at-least", fraction: 0.9 }), /90%/);
});

test("a repeat reads as forever, once, or a bounded count", () => {
  assert.equal(repeatSentence({ kind: "forever" }), "Repeat forever");
  assert.equal(repeatSentence({ kind: "times", count: 1 }), "Repeat once");
  assert.match(repeatSentence({ kind: "times", count: 50 }), /up to 50 times/);
});

test("an interrupt row reads as a whole sentence", () => {
  const sentence = interruptSentence({
    id: "i1",
    when: { kind: "shield-below", fraction: 0.3 },
    respond: "dock-and-pause",
  });
  assert.match(sentence, /shields drop below 30%/);
  assert.match(sentence, /dock at home and stop/);
});

test("a mining step reads with its belt and its until", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      equipment: { kind: "equipment", equipment: { groupID: 17482, label: "Strip Miners" } },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Mine at the nearest belt/);
  assert.match(sentence, /until the ore hold is 90% full/);
});

test("a mining step with an ore priority list names it, in order", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      ores: {
        kind: "oreList",
        ores: [
          { groupID: 462, name: "Veldspar" },
          { groupID: 465, name: "Kernite" },
        ],
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Mine at the nearest belt, Veldspar then Kernite first/);
});

test("a mining step with no ore priority list (or an empty one) says nothing about ore order", () => {
  const withoutOres: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  assert.doesNotMatch(stepSentence(withoutOres), /first/);

  const withEmptyOres: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      ores: { kind: "oreList", ores: [] },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  assert.doesNotMatch(stepSentence(withEmptyOres), /first/);
});

test("a chosen world slot shows its name, never its id (R7d)", () => {
  const named: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "deliver-ore",
    args: {
      station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" } },
    },
  };
  assert.match(stepSentence(named), /Home Station/);
  assert.doesNotMatch(stepSentence(named), LOOKS_LIKE_ID);

  // A reference with an id but no resolved name must fall back to words, not the number.
  const unnamed: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "deliver-ore",
    args: {
      station: { kind: "station", ref: { entity: "station", id: 60000004, name: null, systemName: null } },
    },
  };
  assert.doesNotMatch(stepSentence(unnamed), LOOKS_LIKE_ID);
  assert.match(stepSentence(unnamed), /a station you pick/);
});

test("a combat step with a target priority names it, in order and in play words", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["tackle", "ewar"] } },
  };
  assert.match(stepSentence(step), /Fight the rats until the grid is clear, tacklers then jammers first/);
  const hunt: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "hunt-player",
    args: { targets: { kind: "targetList", classes: ["logi"] } },
  };
  assert.match(stepSentence(hunt), /logistics first/);
});

test("a combat step at the default ladder says nothing about order", () => {
  const bare: MacroStep = { id: "s1", kind: "macro", macro: "fight-the-rats", args: {} };
  assert.doesNotMatch(stepSentence(bare), /first/);
  const emptied: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "attack-player",
    args: { targets: { kind: "targetList", classes: [] } },
  };
  assert.doesNotMatch(stepSentence(emptied), /first/);
});

test("a combat step flying with the fleet says which part it plays", () => {
  const calling: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "fight-the-rats",
    args: { squad: { kind: "squadRole", role: "call" } },
  };
  assert.match(stepSentence(calling), /calling the primary for the fleet/);

  const following: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "attack-player",
    args: { squad: { kind: "squadRole", role: "follow" } },
  };
  assert.match(stepSentence(following), /on the fleet's primary/);

  const alone: MacroStep = {
    id: "s3",
    kind: "macro",
    macro: "hunt-player",
    args: { squad: { kind: "squadRole", role: "off" } },
  };
  assert.doesNotMatch(stepSentence(alone), /fleet/, "flying alone is the default and says nothing");
});
