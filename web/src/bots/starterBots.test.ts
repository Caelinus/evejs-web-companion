// THE SEEDS ARE ONLY AS GOOD AS THIS TEST.
//
// `src/starterBots.json` is the six ready-made bots the BFF puts into the
// library on first boot. The BFF is plain JS and deliberately cannot run this
// codec — `src/botScriptStore.js` says so in its own header, and its validation
// is envelope-lite on purpose because the real gate is the browser decoding
// every doc on read. That contract is fine for a doc a PLAYER saved: their
// browser encoded it, and their browser decodes it back.
//
// It is not fine for a doc we hand-wrote into a JSON file. Nothing on the
// server would notice a mistyped macro id, a missing argument or a world ref in
// the wrong shape — the seed would land in everyone's library and only fail
// when a player opened it, as a refusal sentence about a document they never
// wrote. So the seeds are decoded HERE, through the same codec the app uses,
// which is the only place that can prove them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeScriptValue } from "./scriptCodec.ts";
import { validateScript } from "./validateScript.ts";
import { MACRO_IDS } from "./botScript.ts";

const SEED_PATH = fileURLToPath(new URL("../../../src/starterBots.json", import.meta.url));
const seedFile = JSON.parse(readFileSync(SEED_PATH, "utf8")) as {
  seedVersion?: number;
  bots?: readonly { readonly id?: string; readonly doc?: unknown }[];
};

const bots = seedFile.bots ?? [];

test("the seed file holds the six starter bots", () => {
  assert.equal(bots.length, 6, "six ready-made sequences were promoted to starter bots");
});

test("every starter bot decodes through the real codec", () => {
  // The one check the server cannot do for itself.
  for (const entry of bots) {
    const decoded = decodeScriptValue(entry.doc);
    assert.ok(
      decoded.ok,
      `starter "${entry.id}" was refused by the codec: ${decoded.ok ? "" : decoded.refusal}`,
    );
  }
});

test("every starter bot uses macro ids the app actually has", () => {
  // A typo here would only surface as a refusal in a player's browser.
  const known = new Set<string>(MACRO_IDS);
  for (const entry of bots) {
    const decoded = decodeScriptValue(entry.doc);
    assert.ok(decoded.ok);
    if (!decoded.ok) continue;
    for (const node of decoded.doc.program) {
      if (node.kind === "macro") {
        assert.ok(known.has(node.macro), `unknown macro id "${node.macro}" in "${entry.id}"`);
      }
    }
  }
});

test("every starter carries a name and the sentence explaining what it does", () => {
  // `notes` had no writer at all until these seeds — an empty one here would
  // quietly waste the only field that says what a starter is for.
  for (const entry of bots) {
    const decoded = decodeScriptValue(entry.doc);
    assert.ok(decoded.ok);
    if (!decoded.ok) continue;
    assert.ok(decoded.doc.name.trim().length > 0, `"${entry.id}" has no name`);
    assert.ok(decoded.doc.notes.trim().length > 0, `"${entry.id}" has no notes`);
  }
});

test("a starter is either ready to run or asks the player for exactly what it needs", () => {
  // Seeding a bot that cannot run is fine — "dock, refit and repair" cannot
  // know which fitting you want. What is NOT fine is a starter that is broken
  // for a reason the player cannot see and fix, so every problem a starter
  // ships with must be a real, addressable one from validateScript.
  for (const entry of bots) {
    const decoded = decodeScriptValue(entry.doc);
    assert.ok(decoded.ok);
    if (!decoded.ok) continue;
    for (const problem of validateScript(decoded.doc)) {
      assert.ok(
        problem.sentence.trim().length > 0,
        `"${entry.id}" ships with a problem that says nothing`,
      );
    }
  }
});

test("starter ids are stable and distinct", () => {
  // The seed is keyed by these; a duplicate would silently drop a starter.
  const ids = bots.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "two starters share an id");
  for (const id of ids) {
    assert.ok(typeof id === "string" && id.length > 0);
  }
});
