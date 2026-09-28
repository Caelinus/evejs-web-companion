import test from "node:test";
import assert from "node:assert/strict";

import {
  decidePropulsionModule,
  type PropulsionInputs,
  type PropulsionModule,
} from "./propulsion.ts";

/**
 * Two obviously-synthetic prop mods, one of each kind, and one the SDE effect
 * read could not classify. The ids are the same shape the companion's own tests
 * use: nothing here is a real fitted module off a real hull.
 */
const AFTERBURNER: PropulsionModule = { itemID: 11300001, typeID: 90000910, kind: "afterburner" };
const MWD: PropulsionModule = { itemID: 11300002, typeID: 90000911, kind: "microwarpdrive" };
const UNKNOWN: PropulsionModule = { itemID: 11300003, typeID: 90000912, kind: null };

/** A complete, valid set of inputs with named overrides — never a partial. */
function inputs(overrides: Partial<PropulsionInputs> = {}): PropulsionInputs {
  return {
    modules: [MWD],
    activeModuleIDs: new Set<number>(),
    capacitorRatio: 0.9,
    scrammed: null,
    wantBurn: true,
    capFloor: 0.3,
    ...overrides,
  };
}

// --- rule 1: the burn happens only while there is distance to cover ---------

test("wantBurn lights an idle prop mod", () => {
  assert.deepEqual(decidePropulsionModule(inputs()), { kind: "light", module: MWD });
});

// ⚠ AN ORBIT IS NOT CLOSING — a ship holding station has arrived, and the
// caller says so by answering `wantBurn` false. What that costs the burner is
// this.
test("not wanting the burn stands a running prop mod down", () => {
  const decision = decidePropulsionModule(
    inputs({ wantBurn: false, activeModuleIDs: new Set([MWD.itemID]) }),
  );
  assert.deepEqual(decision, { kind: "stop", module: MWD });
});

// ⚠ THE WIRE QUIRK. A bare Deactivate returns success with the burner still
// cycling: the effect name is resolved from the typeID, so the decision has to
// carry the whole module and not just its itemID. A test that only checked the
// itemID would pass against the broken call.
test("the stop names the module's typeID, which is what makes a Deactivate land", () => {
  const decision = decidePropulsionModule(
    inputs({ wantBurn: false, activeModuleIDs: new Set([MWD.itemID]) }),
  );
  assert.equal(decision.kind === "stop" && decision.module.typeID, MWD.typeID);
});

// --- rule 3: the scram, and only the microwarpdrive ------------------------

test("an explicit scram stands a microwarpdrive down — no call spent to be refused", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ scrammed: true })), { kind: "none" });
});

test("a scram does NOT touch an afterburner — it is exactly what a tackled ship needs", () => {
  const decision = decidePropulsionModule(inputs({ modules: [AFTERBURNER], scrammed: true }));
  assert.deepEqual(decision, { kind: "light", module: AFTERBURNER });
});

test("a ship carrying BOTH keeps its afterburner under a scram — the MWD is skipped, not the rung", () => {
  const decision = decidePropulsionModule(inputs({ modules: [MWD, AFTERBURNER], scrammed: true }));
  assert.deepEqual(decision, { kind: "light", module: AFTERBURNER });
});

// ⚠ FAIL OPEN, EVERY TIME. A dropped jam frame must never be what takes the
// speed off a ship, so only an explicit `true` gates.
test("an unreadable scram reading does not gate — three-state, and null is not `scrammed`", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ scrammed: null })), {
    kind: "light",
    module: MWD,
  });
});

// --- rule 4: the cheap half of being wrong ---------------------------------

test("a prop mod whose kind could not be read is treated as an MWD under a scram", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ modules: [UNKNOWN], scrammed: true })), {
    kind: "none",
  });
});

test("an unclassified prop mod is still lit when nothing is scrambling this ship", () => {
  const decision = decidePropulsionModule(inputs({ modules: [UNKNOWN], scrammed: null }));
  assert.deepEqual(decision, { kind: "light", module: UNKNOWN });
});

// --- rule 5: the floor gates the lighting and nothing else -----------------

test("below the capacitor floor nothing is LIT — this is how a pilot caps itself out", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ capacitorRatio: 0.2, capFloor: 0.5 })), {
    kind: "none",
  });
});

// ⚠ AND THE FLOOR MUST NOT GATE THE OFF-HALF, or a burner is stranded ON at
// exactly the capacitor level that made it dangerous.
test("below the floor a running module is still STOPPED — it must always be stoppable", () => {
  const decision = decidePropulsionModule(
    inputs({
      wantBurn: false,
      activeModuleIDs: new Set([MWD.itemID]),
      capacitorRatio: 0.01,
      capFloor: 0.5,
    }),
  );
  assert.deepEqual(decision, { kind: "stop", module: MWD });
});

test("an unreadable capacitor does not gate — the same fail-open rule", () => {
  const decision = decidePropulsionModule(inputs({ capacitorRatio: null, capFloor: 0.5 }));
  assert.deepEqual(decision, { kind: "light", module: MWD });
});

test("exactly AT the floor still lights — the gate is strictly below", () => {
  const decision = decidePropulsionModule(inputs({ capacitorRatio: 0.5, capFloor: 0.5 }));
  assert.deepEqual(decision, { kind: "light", module: MWD });
});

// --- nothing to do ---------------------------------------------------------

test("a hull with no prop mod fitted decides nothing", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ modules: [] })), { kind: "none" });
  assert.deepEqual(decidePropulsionModule(inputs({ modules: [], wantBurn: false })), {
    kind: "none",
  });
});

// ⚠ ONE CALL AND THEN FALL THROUGH. Both of these are the ordinary tick: the
// rack already agrees with what is wanted, so everything below this rung gets
// the tick instead.
test("a prop mod already lit while the burn is wanted is not re-activated", () => {
  const decision = decidePropulsionModule(inputs({ activeModuleIDs: new Set([MWD.itemID]) }));
  assert.deepEqual(decision, { kind: "none" });
});

test("a prop mod already off while the burn is not wanted is left alone", () => {
  assert.deepEqual(decidePropulsionModule(inputs({ wantBurn: false })), { kind: "none" });
});

// One module per call, both halves: a rack with two lit modules gives up one
// stop now and the other on the tick after, rather than two calls at once.
test("only one module is named per decision", () => {
  const decision = decidePropulsionModule(
    inputs({
      modules: [MWD, AFTERBURNER],
      wantBurn: false,
      activeModuleIDs: new Set([MWD.itemID, AFTERBURNER.itemID]),
    }),
  );
  assert.deepEqual(decision, { kind: "stop", module: MWD });
});
