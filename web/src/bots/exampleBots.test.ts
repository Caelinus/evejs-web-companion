// The bundled examples must be programs the import gate ACCEPTS and the editor
// finds NOTHING to fix in — a preset that loads with a refusal or a red row is
// worse than no preset. Round-trips each through the codec (text and value) and
// the validator, and sweeps the copy for R7d/R9a.

import test from "node:test";
import assert from "node:assert/strict";

import { EXAMPLE_BOTS } from "./exampleBots.ts";
import { decodeScriptText, decodeScriptValue, encodeScriptDoc } from "./scriptCodec.ts";
import { validateScript } from "./validateScript.ts";

test("there are examples, each with distinct keys and plain copy", () => {
  assert.ok(EXAMPLE_BOTS.length >= 9, "the original examples plus fleet/exploration/operations presets");
  assert.equal(new Set(EXAMPLE_BOTS.map((e) => e.key)).size, EXAMPLE_BOTS.length);
  for (const example of EXAMPLE_BOTS) {
    assert.ok(example.label.length > 0 && example.blurb.length > 0);
    assert.doesNotMatch(example.label + example.blurb, /\d{5,}/, "no ids in preset copy");
  }
});

test("the expanded examples cover fleet, exploration, and operations play", () => {
  const keys = new Set(EXAMPLE_BOTS.map((example) => example.key));
  for (const key of ["fleet-medic", "fleet-anchor", "anomaly-expedition", "operations-closeout"]) {
    assert.ok(keys.has(key), `missing ${key}`);
  }
});

test("anomaly presets loot wrecks before salvaging removes them", () => {
  for (const key of ["ratting", "anomaly-expedition"]) {
    const example = EXAMPLE_BOTS.find((row) => row.key === key);
    assert.ok(example, `missing ${key}`);
    if (example === undefined) continue;
    const macros = example.doc.program.flatMap((node) =>
      node.kind === "loop"
        ? node.body.flatMap((element) => element.kind === "macro" ? [element.macro] : [])
        : node.kind === "macro"
          ? [node.macro]
          : [],
    );
    assert.ok(macros.indexOf("loot-wrecks") < macros.indexOf("salvage-wrecks"));
  }
});

for (const example of EXAMPLE_BOTS) {
  test(`example "${example.label}" passes the codec and the validator clean`, () => {
    // The VALUE path (what the preset button uses).
    const decoded = decodeScriptValue(example.doc);
    assert.ok(decoded.ok, decoded.ok ? "" : decoded.refusal);
    if (!decoded.ok) return;
    assert.deepEqual(decoded.warnings, [], "a bundled example must need no tidying");
    // BLOCKING problems only. A bundled example must be runnable as shipped —
    // nothing left unset, nothing out of range. An ADVISORY is a different
    // thing: it names a real trade-off the author made on purpose, and
    // "Planet keeper" makes one, looping forever with no watch that can stop it.
    // Demanding zero advisories would force every example into the same shape
    // and turn the advisory into a rule, which is exactly what it is not.
    const problems = validateScript(decoded.doc);
    assert.deepEqual(
      problems.filter((problem) => problem.severity === "blocking"),
      [],
      "the editor must find nothing to FIX",
    );
    for (const problem of problems) {
      assert.ok(problem.sentence.trim().length > 0, "an advisory must still say something");
    }

    // And the TEXT round-trip (export → import), so sharing an example works.
    const reimported = decodeScriptText(encodeScriptDoc(decoded.doc));
    assert.ok(reimported.ok);
  });
}
