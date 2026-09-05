// The R23 slice B decoders. The theme of this file is one distinction:
// ZERO IS NOT UNKNOWN.
//
// A quantity of 0 is a real, useful answer — "this rock is mined out", "this
// hold is empty". An absent field is not an answer at all. Collapsing the two
// would put confident numbers in front of a player that nobody computed: a full
// belt shown as mined out, or a station's ISK tax shown as free.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeMiningHolds,
  decodeReprocessingQuotes,
  decodeSurveyResults,
  decodeTaxRate,
} from "./mining.ts";
import type { JsonValue } from "./wire.ts";

// --- The holds --------------------------------------------------------------

test("holds decode by NAME, with capacity and contents", () => {
  const holds = decodeMiningHolds([
    {
      key: "ore",
      label: "Ore hold",
      present: true,
      capacity: { capacity: 5000, used: 120 },
      items: [{ itemID: 8800001, typeID: 1230, groupID: 462, categoryID: 25, quantity: 500 }],
      error: null,
    },
  ] as unknown as JsonValue);

  assert.equal(holds.length, 1);
  assert.equal(holds[0]?.label, "Ore hold");
  assert.equal(holds[0]?.capacity?.capacity, 5000);
  assert.deepEqual(holds[0]?.items, [
    { itemID: 8800001, typeID: 1230, groupID: 462, categoryID: 25, quantity: 500 },
  ]);
});

test("a hold row from a bridge that does not publish a category decodes to null, not zero", () => {
  // "Could not classify" and "classified as category 0" are different, and a
  // delivery filtering on the category has to be able to tell them apart.
  const holds = decodeMiningHolds([
    {
      key: "cargo",
      label: "Cargo hold",
      present: true,
      items: [{ itemID: 8800002, typeID: 1230, quantity: 5 }],
      error: null,
    },
  ] as unknown as JsonValue);

  assert.equal(holds[0]?.items?.[0]?.groupID, null);
  assert.equal(holds[0]?.items?.[0]?.categoryID, null);
});

test("a hold whose read FAILED decodes items to null — not to an empty hold", () => {
  const holds = decodeMiningHolds([
    { key: "ore", label: "Ore hold", present: true, items: null, error: "READ_FAILED" },
    { key: "ice", label: "Ice hold", present: true, items: [], error: null },
  ] as unknown as JsonValue);

  assert.equal(holds[0]?.items, null, "null is 'we could not look'");
  assert.deepEqual(holds[1]?.items, [], "[] is 'we looked, and it is empty'");
  assert.equal(holds[0]?.error, "READ_FAILED");
});

test("hold IDs decode long-aware, and a row missing an ID is dropped", () => {
  const holds = decodeMiningHolds([
    {
      key: "ore",
      label: "Ore hold",
      present: true,
      items: [
        { itemID: { type: "long", value: "8800001" }, typeID: 1230, quantity: 500 },
        { typeID: 1230, quantity: 9 },
      ],
    },
  ] as unknown as JsonValue);

  assert.equal(holds[0]?.items?.length, 1, "the unidentifiable row is dropped, not zeroed");
  assert.equal(holds[0]?.items?.[0]?.itemID, 8800001);
});

test("a malformed holds payload decodes to an empty list rather than throwing", () => {
  assert.deepEqual(decodeMiningHolds(undefined), []);
  assert.deepEqual(decodeMiningHolds(null as unknown as JsonValue), []);
  assert.deepEqual(decodeMiningHolds({ nope: true } as unknown as JsonValue), []);
});

// --- The survey scanner -----------------------------------------------------

test("survey triples decode, and a scanned EMPTY rock keeps its real zero", () => {
  const survey = decodeSurveyResults([
    [50001248, 1230, 4200],
    [50001249, 1228, 0],
  ] as unknown as JsonValue);

  assert.equal(survey.length, 2);
  assert.equal(survey[0]?.remainingQuantity, 4200);
  assert.equal(
    survey[1]?.remainingQuantity,
    0,
    "a mined-out rock is a real answer and must survive as 0",
  );
});

test("survey IDs decode long-aware, and an unreadable row is dropped", () => {
  const survey = decodeSurveyResults([
    [{ type: "long", value: "50001248" }, { type: "long", value: "1230" }, 4200],
    ["nonsense", 1230, 10],
    "not-a-triple",
  ] as unknown as JsonValue);

  assert.equal(survey.length, 1, "a row that cannot be tied to a rock is dropped, not zeroed");
  assert.equal(survey[0]?.itemID, 50001248);
  assert.equal(survey[0]?.yieldTypeID, 1230);
});

test("a survey row with an unreadable amount is UNKNOWN, not zero", () => {
  const survey = decodeSurveyResults([[50001248, 1230, "?"]] as unknown as JsonValue);
  assert.equal(
    survey[0]?.remainingQuantity,
    null,
    "we could not read it, so we must not say the rock is empty",
  );
});

test("a malformed survey payload decodes to an empty list", () => {
  assert.deepEqual(decodeSurveyResults(undefined), []);
  assert.deepEqual(decodeSurveyResults({ nope: true } as unknown as JsonValue), []);
});

// --- The refinery -----------------------------------------------------------

test("quotes decode, including the per-stack ISK cost and the mineral yield", () => {
  const quotes = decodeReprocessingQuotes([
    {
      itemID: 8800001,
      typeID: 1230,
      quantityToProcess: 500,
      leftOvers: 0,
      iskCost: 1234.5,
      outputs: [
        { typeID: 34, quantity: 1000 },
        { typeID: 35, quantity: 200 },
      ],
    },
  ] as unknown as JsonValue);

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]?.quantityToProcess, 500);
  assert.equal(quotes[0]?.leftOvers, 0, "zero left over is a real answer");
  assert.equal(quotes[0]?.iskCost, 1234.5);
  assert.deepEqual(quotes[0]?.outputs, [
    { typeID: 34, quantity: 1000 },
    { typeID: 35, quantity: 200 },
  ]);
});

test("a quote with no ISK cost given reads as UNKNOWN", () => {
  const quotes = decodeReprocessingQuotes([
    { itemID: 8800001, typeID: 1230, outputs: [] },
  ] as unknown as JsonValue);
  assert.equal(quotes[0]?.iskCost, null, "not 0 — we were not told what it costs");
  assert.deepEqual(quotes[0]?.outputs, []);
});

test("⚠ the TAX RATE is null when unknown, and 0 only when the server really said 0", () => {
  // This one matters more than it looks. Reprocessing DEBITS the station's tax
  // from the wallet, so a null shown as 0 would tell the player the refinery is
  // free — a confidently wrong number about their money.
  assert.equal(decodeTaxRate(undefined), null);
  assert.equal(decodeTaxRate(null as unknown as JsonValue), null);
  assert.equal(decodeTaxRate("nonsense" as unknown as JsonValue), null);
  assert.equal(decodeTaxRate(-1 as unknown as JsonValue), null, "a negative rate is not a rate");
  assert.equal(decodeTaxRate(0 as unknown as JsonValue), 0, "a real zero survives");
  assert.equal(decodeTaxRate(0.05 as unknown as JsonValue), 0.05);
});

test("a malformed quotes payload decodes to an empty list", () => {
  assert.deepEqual(decodeReprocessingQuotes(undefined), []);
  assert.deepEqual(decodeReprocessingQuotes({ nope: true } as unknown as JsonValue), []);
  // A quote row with no itemID cannot be tied to a stack, so it is dropped.
  assert.deepEqual(decodeReprocessingQuotes([{ typeID: 1230 }] as unknown as JsonValue), []);
});
