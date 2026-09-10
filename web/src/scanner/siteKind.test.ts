import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPLORATION_SITE_KINDS,
  SCAN_STRENGTH_COMBAT,
  SCAN_STRENGTH_DATA,
  SCAN_STRENGTH_GAS,
  SCAN_STRENGTH_ORE,
  SCAN_STRENGTH_RELIC,
  SCAN_STRENGTH_WORMHOLE,
  SITE_KIND_LABELS,
  siteKind,
} from "./siteKind.ts";

test("siteKind: the scan-strength attribute names the group, as it does in the client", () => {
  assert.equal(siteKind(SCAN_STRENGTH_ORE), "ore");
  assert.equal(siteKind(SCAN_STRENGTH_GAS), "gas");
  assert.equal(siteKind(SCAN_STRENGTH_RELIC), "relic");
  assert.equal(siteKind(SCAN_STRENGTH_DATA), "data");
  assert.equal(siteKind(SCAN_STRENGTH_COMBAT), "combat");
  assert.equal(siteKind(SCAN_STRENGTH_WORMHOLE), "wormhole");
});

test("siteKind: ore and combat are the two that must never be confused", () => {
  assert.notEqual(siteKind(SCAN_STRENGTH_ORE), siteKind(SCAN_STRENGTH_COMBAT));
  // An asteroid cluster carrying the combat archetype is impossible, but if the
  // two fields ever disagree the ATTRIBUTE wins — it is what the client groups by.
  assert.equal(siteKind(SCAN_STRENGTH_ORE, 24), "ore");
});

test("siteKind: a missing attribute is unknown, never a guess", () => {
  // The observed failure mode: a family the exploration authority does not know
  // resolves to 0 and reaches the wire as null.
  assert.equal(siteKind(null), "unknown");
  assert.equal(siteKind(undefined), "unknown");
  assert.equal(siteKind(0), "unknown");
  // A number no build of this module has heard of is unknown too.
  assert.equal(siteKind(99999), "unknown");
  // Non-numbers cannot classify anything.
  assert.equal(siteKind("211"), "unknown");
  assert.equal(siteKind(211.5), "unknown");
});

test("siteKind: the archetype rescues a row whose attribute went missing", () => {
  assert.equal(siteKind(null, 27), "ore"); // dunArchetypeOreAnomaly
  assert.equal(siteKind(null, 28), "ore"); // dunArchetypeIceBelt — same lasers
  assert.equal(siteKind(null, 30), "gas"); // dunArchetypeGasClouds
  assert.equal(siteKind(null, 24), "combat"); // dunArchetypeCombatSites
  assert.equal(siteKind(null, 20), "unknown"); // a mission dungeon is neither
});

test("siteKind: every kind has a label", () => {
  for (const kind of EXPLORATION_SITE_KINDS) {
    assert.equal(typeof SITE_KIND_LABELS[kind], "string");
    assert.ok(SITE_KIND_LABELS[kind].length > 0, `${kind} needs a label`);
  }
});
