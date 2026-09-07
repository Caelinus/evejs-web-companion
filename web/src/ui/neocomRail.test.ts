// The Neocom icon rail as it actually RENDERS (goal R74).
//
// The glyph data and the readout formatting are unit-tested in
// `neocomIcons.test.ts`; this checks the thing that only a render can show — that
// an icon rail did not quietly become unusable by anyone who is not looking at
// it. Every launcher button must still carry the panel's NAME as its accessible
// name, and the two readouts must be present and honest.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Neocom = (await import("./Neocom.svelte")).default;
const { launchableTabsFor } = await import("./tabs.ts");
const { isWindowTab } = await import("./desktop.ts");

const CHARACTER_ID = 140000005;

function onlineStore(over: { cashBalance?: string } = {}): unknown {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Rada Farmer",
      stationID: 60000358,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 98000001,
    },
    station: null,
  } as never);
  if (over.cashBalance !== undefined) {
    store.apply({
      type: "wallet/loaded",
      cashBalance: over.cashBalance,
      cashError: null,
      corpDivisions: null,
      corpError: null,
      journal: null,
      journalError: null,
      transactions: null,
      transactionsError: null,
    } as never);
  }
  return store;
}

function renderRail(isDocked: boolean, over: { cashBalance?: string } = {}): string {
  return render(Neocom as never, {
    props: {
      store: onlineStore(over) as never,
      flow: null,
      isDocked,
      openIds: new Set(),
      focusedId: null,
      onSelect: () => {},
    } as never,
  }).body;
}

/**
 * HTML-escape a label for matching against rendered markup.
 *
 * ⚠ "Inventory & Ship" renders as "Inventory &amp; Ship". A test that compared
 * the raw label would fail on exactly the tabs whose names contain punctuation —
 * and, worse, a test written the other way round (matching only the escaped
 * form) would silently stop checking the ones that do not.
 */
function escaped(label: string): string {
  return label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

test("every launcher button carries the panel's NAME, not just a glyph", () => {
  // ⚠ THE POINT OF THE WHOLE FILE. An icon rail is an accelerator for someone who
  // has learnt it; it must never be the only way to find out what a button does.
  // A refactor that drops aria-label leaves a column of unlabelled pictures.
  const body = renderRail(false);
  for (const tab of launchableTabsFor(false).filter((t) => isWindowTab(t.id))) {
    assert.ok(
      body.includes(`aria-label="${escaped(tab.label)}"`),
      `the '${tab.id}' button has no accessible name`,
    );
    assert.ok(
      body.includes(`title="${escaped(tab.label)}"`),
      `the '${tab.id}' button has no tooltip`,
    );
  }
});

test("each launcher button draws a glyph", () => {
  const body = renderRail(false);
  // ⚠ The obvious /class="neocom-item[^"]*"/ ALSO matches `neocom-item-label`,
  // which double-counts every button and made this assert 48 against 24.
  const buttons = body.match(/class="neocom-item(?: [^"]*)?"/g) ?? [];
  const glyphs = body.match(/class="neocom-glyph"/g) ?? [];
  assert.ok(buttons.length > 0, "expected launcher buttons");
  assert.equal(glyphs.length, buttons.length, "every button needs exactly one glyph");
});

test("the rail shows the pilot, by name and by initials", () => {
  const body = renderRail(false);
  assert.match(body, /Rada Farmer/);
  assert.match(body, /class="neocom-portrait"[^>]*>RF</);
});

test("the wallet readout is shown, and links to the real figure", () => {
  const body = renderRail(false, { cashBalance: "184250000.55" });
  // The glance is rounded...
  assert.match(body, /184\.2M/);
  // ...and the exact, grouped amount rides on the accessible name, because the
  // short form ROUNDS and must never be mistaken for the balance itself.
  assert.match(body, /aria-label="Wallet, 184,250,000\.55 ISK/);
});

test("an unread wallet shows a dash, never a zero balance", () => {
  // A fabricated 0 ISK in the rail says the pilot is broke — a fact a player
  // would act on.
  const body = renderRail(false);
  assert.match(body, /class="neocom-readout-value">—</);
  assert.equal(body.includes(">0 ISK<"), false);
});

test("EVE time is labelled as such", () => {
  const body = renderRail(false);
  assert.match(body, /class="neocom-readout-label">EVE</);
  assert.match(body, /neocom-readout-value">\d{2}:\d{2}</);
  assert.match(body, /title="EVE time \(UTC\)/);
});

test("a CONTEXTUAL panel is not offered in the rail", () => {
  // Show Info opens on the thing you clicked. A rail entry for it could only
  // ever open it onto nothing, which is why `launchable: false` exists rather
  // than the rail special-casing the id.
  const body = renderRail(false);
  assert.equal(
    body.includes('aria-label="Show Info"'),
    false,
    "Show Info must not sit in the launcher rail",
  );
});

test("the rail follows the docked / in-space state", () => {
  // A docked pilot must not be offered the in-space panels, and vice versa.
  const docked = renderRail(true);
  const inSpace = renderRail(false);
  assert.match(docked, /aria-label="Fitting"/);
  assert.equal(/aria-label="Mining"/.test(docked), false);
  assert.match(inSpace, /aria-label="Mining"/);
  assert.equal(/aria-label="Fitting"/.test(inSpace), false);
});

test("the rail offers ONE way into the bots that run on the server, not two", () => {
  // The Server Bots entry is gone: the Bot Manager's pilots region lists the
  // same rows beside the tab runs and the pilots that could take one. This is a
  // crowding fix, so what it guards against is the entry quietly coming back
  // and the rail growing a second door onto one subject again.
  for (const docked of [true, false]) {
    const body = renderRail(docked);
    assert.match(body, /aria-label="Bot Manager"/);
    assert.equal(
      body.includes('aria-label="Server Bots"'),
      false,
      "Server Bots must not sit in the launcher rail",
    );
  }
});

test("R7d: the rail renders no bare numeric game ID", () => {
  const body = renderRail(false, { cashBalance: "184250000.55" });
  assert.equal(body.includes(String(CHARACTER_ID)), false, "the characterID must never show");
  assert.equal(body.includes("60000358"), false, "the stationID must never show");
});
