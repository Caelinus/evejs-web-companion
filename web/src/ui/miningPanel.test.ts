// The R23 slice B mining panel as it actually RENDERS.
//
// Three things get checked here, in order of how much damage getting them wrong
// would do:
//
//   1. The two-step confirm gate. Reprocessing consumes the ore for good and
//      charges ISK, so the button that does it must be unreachable until the
//      player has seen the station's own numbers and armed it deliberately —
//      and changing what is selected must disarm it again.
//   2. Honesty. A number the server did not give reads as "not known", never as
//      0. That matters most for the station's TAX: a confident 0 would tell the
//      player the refinery is free.
//   3. The standing invariants on new markup — R7d (no visible numeric IDs, and
//      specifically no flagID: "ore hold", not "flag 134"), R9a (plain player
//      language) and R8 (reflow tables with data-label on every cell).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Mining = (await import("./Mining.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Mining.svelte"), "utf8");

const ORE_STACK_ID = 8800001;
const ORE_TYPE_ID = 1230;
const TRITANIUM_TYPE_ID = 34;
const SHIP_ID = 9001;
const STATION_ID = 60003760;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function renderLoaded(options: {
  docked?: boolean;
  taxRate?: number | null;
  quotes?: unknown[];
  quotesFor?: number[];
  holdItemsNull?: boolean;
  capacityUnknown?: boolean;
} = {}): string {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: options.docked === false,
      docked: options.docked !== false,
      solarSystemID: 30000142,
      stationID: STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "mining/holds",
    holds: [
      {
        key: "ore",
        label: "Ore hold",
        present: true,
        capacity: options.capacityUnknown ? null : { capacity: 5000, used: 1250 },
        items: options.holdItemsNull
          ? null
          : [{ itemID: ORE_STACK_ID, typeID: ORE_TYPE_ID, groupID: 462, categoryID: 25, quantity: 500 }],
        error: options.holdItemsNull ? "READ_FAILED" : null,
      },
      // A hull without a gas bay: absent, so it must not be drawn at all.
      { key: "gas", label: "Gas hold", present: false, capacity: null, items: [], error: null },
    ],
  });
  if (options.quotes) {
    store.apply({
      type: "mining/quotes",
      quotes: options.quotes as never,
      taxRate: options.taxRate === undefined ? 0.05 : options.taxRate,
      quotesFor: options.quotesFor ?? [ORE_STACK_ID],
    });
  }
  store.apply({
    type: "names/resolved",
    entries: {
      [`type:${ORE_TYPE_ID}`]: "Veldspar",
      [`type:${TRITANIUM_TYPE_ID}`]: "Tritanium",
    },
  });
  return render(Mining, { props: { store, flow: fakeFlow() } }).body;
}

const QUOTE = {
  itemID: ORE_STACK_ID,
  typeID: ORE_TYPE_ID,
  quantityToProcess: 500,
  leftOvers: 0,
  iskCost: 1234.5,
  outputs: [{ typeID: TRITANIUM_TYPE_ID, quantity: 1000 }],
};

// --- The holds --------------------------------------------------------------

test("the panel names each hold and shows its fill from the server's numbers", () => {
  const text = visibleText(renderLoaded());
  assert.match(text, /Ore hold/);
  assert.match(text, /1,250 of 5,000 m³/);
  assert.match(text, /Veldspar/, "ore is named, not numbered");
});

test("a hold the hull does not have is not drawn at all", () => {
  const text = visibleText(renderLoaded());
  assert.doesNotMatch(text, /Gas hold/, "an absent hold must not show an empty 0 / 0 bar");
});

test("a hold that could not be READ says so — it does not read as empty", () => {
  const text = visibleText(renderLoaded({ holdItemsNull: true }));
  assert.match(text, /could not be read/i);
  assert.doesNotMatch(text, /Nothing in here yet/);
});

test("a capacity the ship did not report reads 'not known', never 0", () => {
  const text = visibleText(renderLoaded({ capacityUnknown: true }));
  assert.match(text, /not known/);
  assert.doesNotMatch(text, /0 of 0/);
});

// --- The two-step confirm gate ----------------------------------------------

test("⚠ the button that consumes the ore does NOT exist until a quote has been seen", () => {
  // With nothing quoted, there is no path to reprocessing at all — not even a
  // disabled one. The player has to ask what they would get first.
  const text = visibleText(renderLoaded());
  assert.doesNotMatch(text, /Yes, refine it/, "the destructive control must not be rendered");
  assert.doesNotMatch(text, /Refine it…/, "not even the control that ARMS it");
  assert.match(text, /Pick what you want to refine/, "the panel asks for a pick first");

  // With a quote on screen for stacks OTHER than what is picked, the
  // destructive control still must not appear: confirming against numbers
  // computed for a different set of stacks is the exact mistake this prevents.
  const mismatched = visibleText(renderLoaded({ quotes: [QUOTE], quotesFor: [999999] }));
  assert.doesNotMatch(mismatched, /Yes, refine it/);
  assert.doesNotMatch(mismatched, /Refine it…/);
  assert.match(mismatched, /quote is for a different pick/);
});

test("⚠ even with a quote up, the destructive button is behind a second click", () => {
  // Arming is its own deliberate act: the quote shows "Refine it…", and only
  // that click reveals "Yes, refine it".
  const source = SOURCE;
  assert.match(source, /Refine it…/, "the arming control");
  assert.match(source, /Yes, refine it/, "the armed control");
  assert.match(source, /Keep the ore/, "and an escape from it");
  // The armed control is reachable ONLY through the armed flag.
  const armedBlock = source.slice(source.indexOf("{#if armed}"));
  assert.ok(
    armedBlock.indexOf("Yes, refine it") < armedBlock.indexOf("{:else}"),
    "the destructive button lives inside the armed branch",
  );
  // Conventions: the armed half is .danger, the escape is .minor.
  assert.match(source, /class="danger"[\s\S]{0,120}Yes, refine it/);
});

test("⚠ arming is keyed to the exact stacks it was armed FOR", () => {
  // A confirmation must never outlive the thing it was shown for. Changing the
  // selection recomputes the key, so the armed state falls away by itself —
  // and toggling an item clears it outright.
  assert.match(SOURCE, /confirmingFor === selectionKey\(selected\)/);
  assert.match(SOURCE, /confirmingFor = null;/);
});

test("the panel calls reprocess exactly once, through the flow", () => {
  assert.equal(
    SOURCE.split("flow.reprocessItems(").length - 1,
    1,
    "one call site — no parallel path to the destructive action",
  );
  assert.equal(SOURCE.split("flow.unloadMiningHolds(").length - 1, 1);
});

// --- The tax ----------------------------------------------------------------

test("the station's cut is shown BEFORE the player can commit", () => {
  const text = visibleText(renderLoaded({ quotes: [QUOTE], taxRate: 0.05 }));
  assert.match(text, /takes a cut/i);
  assert.match(text, /5\.00%/);
  // And the per-stack ISK cost the station computed.
  assert.match(text, /1,234\.50 ISK/);
});

test("⚠ an unknown tax reads 'not known' — never as free", () => {
  const body = renderLoaded({ quotes: [QUOTE], taxRate: null });
  const text = visibleText(body);
  assert.match(text, /its cut is not known/i);
  assert.doesNotMatch(text, /\b0\.00%/, "a wrong 0% would say the refinery is free");
  assert.match(body, /stat-unavailable/, "unavailable uses the shared unavailable style");
});

test("a quote with no yield given says 'not known' rather than showing nothing", () => {
  const text = visibleText(
    renderLoaded({ quotes: [{ ...QUOTE, outputs: [], iskCost: null }] }),
  );
  assert.match(text, /not known/);
});

test("the yield is named, never numbered", () => {
  const text = visibleText(renderLoaded({ quotes: [QUOTE] }));
  assert.match(text, /1,000 Tritanium/);
});

// --- Docked gating ----------------------------------------------------------

test("in space, the panel says to dock rather than offering the actions", () => {
  const text = visibleText(renderLoaded({ docked: false }));
  assert.match(text, /Dock at a station to unload/);
  assert.match(text, /Dock at a station to use its refinery/);
  assert.doesNotMatch(text, /Refine it…/);
});

// --- R7d --------------------------------------------------------------------

test("R7d: no itemID, typeID, stationID or FLAG is ever visible text", () => {
  const text = visibleText(renderLoaded({ quotes: [QUOTE] }));
  for (const id of [ORE_STACK_ID, ORE_TYPE_ID, SHIP_ID, STATION_ID]) {
    assert.equal(
      new RegExp(`\\b${id}\\b`).test(text),
      false,
      `${id} must never be readable text`,
    );
  }
  // The whole point of naming the holds on the BFF: 134 never exists here.
  assert.equal(/\bflag\b/i.test(text), false, "'flag' is wire vocabulary");
  for (const flag of [134, 135, 181, 182]) {
    assert.equal(new RegExp(`\\b${flag}\\b`).test(text), false, `flag ${flag} must not appear`);
  }
});

// --- R9a --------------------------------------------------------------------

test("R9a: the panel speaks to a player, not to a developer", () => {
  const text = visibleText(renderLoaded({ quotes: [QUOTE] }));
  for (const jargon of [
    "reprocessingSvc",
    "GetQuotes",
    "Reprocess(",
    "invbroker",
    "miningScanMgr",
    "perform_scan",
    "itemID",
    "typeID",
    "flagID",
    "bound object",
    "allowlist",
    "BFF",
  ]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" must not be on screen`);
  }
  // The labels a player would actually use.
  assert.match(text, /Your holds/);
  assert.match(text, /Move it to your hangar/);
  assert.match(text, /Refine it into minerals/);
});

// --- R8 ---------------------------------------------------------------------

test("R8: every table reflows, inside its own scroll wrapper", () => {
  const body = renderLoaded({ quotes: [QUOTE] });
  const reflow = body.match(/<table class="guests[^"]*reflow"/g) ?? [];
  assert.ok(reflow.length >= 2, `expected the hold and quote tables to reflow, saw ${reflow.length}`);
  const wrappers = body.match(/table-wrap overflow-x-auto/g) ?? [];
  assert.ok(wrappers.length >= 2);
});

test("R8: every cell carries a data-label for the narrow layout", () => {
  const body = renderLoaded({ quotes: [QUOTE] });
  const cells = body.match(/<td\b[^>]*>/g) ?? [];
  assert.ok(cells.length > 0, "the loaded panel must render cells");
  for (const cell of cells) {
    assert.match(cell, /data-label="/, `every <td> needs data-label; saw ${cell}`);
  }
});

test("R8: the controls are real buttons, and numeric columns are tabular", () => {
  // styles.css gives every button min-height 2.5rem (40px), so the target size
  // is inherited; what matters here is that these ARE buttons.
  assert.equal(/<a\s+href="#/.test(SOURCE), false, "actions are buttons, not fake links");
  assert.match(SOURCE, /class="controls"/);
  const body = renderLoaded({ quotes: [QUOTE] });
  assert.match(body, /<th class="num">Amount<\/th>/);
  assert.match(body, /class="num" data-label="Amount"/);
});

// --- The panel computes nothing about mining --------------------------------

test("the panel predicts nothing: every number on screen came from the server", () => {
  // No yield maths, no refining maths, no price maths. If a future change needs
  // to multiply a rate by a quantity here, that is a number nobody computed
  // server-side and it does not belong on screen.
  const script = SOURCE.split("</script>")[0] ?? "";
  const code = script.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of ["efficiency", "yieldPerCycle", "estimate", "predict"]) {
    assert.equal(
      new RegExp(forbidden, "i").test(code),
      false,
      `the panel must not compute "${forbidden}" — the server owns that`,
    );
  }
  // The one derived number is the tax PERCENTAGE, which is a unit conversion of
  // a rate the server gave, not a prediction.
  assert.match(code, /\$mining\.taxRate \* 100/);
});
