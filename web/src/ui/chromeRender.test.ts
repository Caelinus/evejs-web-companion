// The always-on chrome as it actually RENDERS (SSR).
//
// ⚠ THIS FILE WAS `shellRender.test.ts`, AND IT WAS TESTING DEAD CODE. It
// rendered `StationShell` and `SpaceShell`, two top-level layouts that the
// windowing workspace superseded and that nothing in the app imported — so a
// green run here proved something about components no player could reach, while
// the live chrome that replaced them (the HUD bar, the workspace header) had no
// render coverage at all.
//
// The shells are gone. The claims that still MATTER were re-pointed at the
// components that actually render them:
//
//   • "in space you can read your ship's condition, reach your modules, and get
//     to the flight panels"     → `HudBar`
//   • "the UI says where you are, in either state"  → `WorkspaceHeader`
//   • the Neocom, PanelHost and target-bracket tests were already about live
//     components and are unchanged.
//
// The one claim deliberately NOT replaced is the docked "station interior":
// there is no such surface any more. Docked, the dock panel and the Neocom are
// the station, and both are covered by `neocomRail.test.ts` and
// `panelFirstMount.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const HudBar = (await import("./HudBar.svelte")).default;
const WorkspaceHeader = (await import("./WorkspaceHeader.svelte")).default;
const Neocom = (await import("./Neocom.svelte")).default;
const PanelHost = (await import("./PanelHost.svelte")).default;
const TargetBracket = (await import("./TargetBracket.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUD_SOURCE = readFileSync(path.join(UI_DIR, "HudBar.svelte"), "utf8");
/** The stylesheet, line endings normalised — the working copy is CRLF. */
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8").replace(/\r\n/g, "\n");
/**
 * The same stylesheet with its comments stripped.
 *
 * ⚠ FOR ASSERTIONS THAT PROVE A RULE IS ABSENT. The notes in this file quote
 * the rules they describe — the one left where the old `@media` override was
 * spells out `.hud-body { grid-template-columns: 1fr }` word for word — so a
 * guard run against the raw text finds the prose and reports the rule it was
 * written to catch. `squareCorners.test.ts` does the same, for the same
 * reason.
 */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** A flow stub — the server generator never runs onMount / handlers. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

const SHIP_ID = 9001;
const SHIP_TYPE_ID = 622;
const STATION_ID = 60000358;
const SYSTEM_ID = 30000142;

/** Everything visible to a player, markup + images stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dockedStore(): unknown {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: SYSTEM_ID,
      stationID: STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: STATION_ID,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    structureName: null,
  });
  return store;
}

/** The in-space snapshot, hoisted so a test can clone and vary one field. */
const SHIP_SNAPSHOT = {
  inSpace: true,
  solarSystemID: SYSTEM_ID,
  shipID: SHIP_ID,
  sampledAtMs: 1_700_000_000_000,
  entities: [],
  ship: {
    itemID: SHIP_ID,
    typeID: SHIP_TYPE_ID,
    name: null as string | null,
    mode: "STOP",
    shieldRatio: 1,
    armorRatio: 0.5,
    hullRatio: 1,
    capacitorRatio: 0.75,
    shieldCapacity: 400,
    armorCapacity: 300,
    hullCapacity: 600,
    radius: 100,
    maxVelocity: 300,
    activeModuleIDs: [] as number[],
    overloadedModuleIDs: [] as number[],
    moduleDamage: {},
    weaponBanks: {},
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  },
};

function inSpaceStore(): unknown {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: SYSTEM_ID,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: null,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: null,
    structureName: null,
  });
  store.apply({ type: "space/snapshot", snapshot: SHIP_SNAPSHOT });
  return store;
}

function renderHud(store: unknown): string {
  return render(HudBar as never, {
    props: { store, flow: fakeFlow() },
  } as never).body;
}

function renderHeader(store: unknown, isDocked: boolean): string {
  return render(WorkspaceHeader as never, {
    props: { store, flow: fakeFlow(), isDocked },
  } as never).body;
}

// --- where you are -----------------------------------------------------------

test("the header says where you are while docked", () => {
  const text = visibleText(renderHeader(dockedStore(), true));
  assert.match(text, /Jita/, "the system is not named");
  assert.match(text, /Undock/, "no undock control");
});

test("the header says where you are while in space", () => {
  const text = visibleText(renderHeader(inSpaceStore(), false));
  assert.match(text, /Jita/, "the system is not named");
});

// --- the in-space HUD --------------------------------------------------------

test("in space the HUD reads the ship's condition off the live snapshot", () => {
  const body = renderHud(inSpaceStore());
  const text = visibleText(body);
  // ⚠ ANCHORED TO THE READOUT ELEMENT, not just to the words. "Armor" and
  // "Shield" appear in more than one place in this markup, so a bare text match
  // passes even when the readout itself is gone — which is exactly what a
  // mutation run showed.
  assert.match(body, /class="hud-readout"/, "the numeric readout is missing entirely");
  assert.match(text, /Shield/, "no shield reading");
  assert.match(text, /Armor/, "no armor reading");
  assert.match(text, /Cap/, "no capacitor reading");
  // The armor ratio was 0.5 — shown as a percentage, never a raw ratio or id.
  assert.match(text, /50%/, "the armor reading does not report its ratio");
});

test("the HUD offers the module rack", () => {
  const body = renderHud(inSpaceStore());
  // ⚠ THE HEADING, not the word. `/Modules/` against the visible text also
  // matches the rack's own empty hint ("Modules appear once your ship's fitting
  // has loaded"), so it went on passing with the heading renamed to nonsense.
  assert.match(body, /id="hud-modules-h"[^>]*>Modules</, "no module rack heading");
});

test("the HUD no longer duplicates the rail's own launchers", () => {
  // ⚠ THIS ANCHOR MOVED DELIBERATELY. It used to assert /Mining/ — a nav button
  // for the Mining window. Every one of those buttons was also a Neocom rail
  // entry, on screen at the same time; two ways to open one window, one of them
  // costing a row of a fixed-height HUD, is not a feature. `neocomRail.test.ts`
  // and the neocom test below are what now hold the promise that the panels are
  // reachable, so nothing here is unprotected.
  const text = visibleText(renderHud(inSpaceStore()));
  for (const gone of ["Mining", "Flight"]) {
    assert.equal(new RegExp(gone).test(text), false, `${gone} is a rail entry, not a HUD button`);
  }
});

test("the HUD header names the ship once, not the same word twice", () => {
  // ⚠ FOUND LIVE. A ship nobody renamed carries its hull's own name, so a header
  // that prints name AND hull unconditionally says "Sunchaser Sunchaser" — one fact
  // rendered as two, which reads as a bug rather than as detail.
  const store = inSpaceStore() as { apply: (event: unknown) => void; space: { get: () => never } };
  store.apply({
    type: "names/resolved",
    entries: { [`type:${SHIP_TYPE_ID}`]: "Sunchaser" },
  });
  // The ship carries the hull's own name — the live case this was found in.
  const snapshot = JSON.parse(JSON.stringify(SHIP_SNAPSHOT));
  snapshot.ship.name = "Sunchaser";
  store.apply({ type: "space/snapshot", snapshot });
  const head = renderHud(store);
  const from = head.indexOf("hud-head");
  const header = visibleText(head.slice(from, head.indexOf("</header>", from)));
  assert.match(header, /Sunchaser/, "the hull is not named at all");
  assert.equal(
    (header.match(/Sunchaser/g) ?? []).length,
    1,
    "the hull was printed twice — the ship carries its hull's name",
  );
});

test("⚠ THE HEADER CARRIES THE SENTENCE, NOT THE ONE-WORD MODE", () => {
  // REVERSED, BY THE OPERATOR. The header used to say "ORBIT" and a footer
  // underneath said "Orbiting Foo at 2.1 AU". Both described the same thing and
  // the short one described it worse — it is the sentence with the useful half
  // removed. The sentence took the header slot and the footer went with the
  // duplication.
  //
  // The fixture ship is stopped, so the line goes quiet rather than blue.
  const body = renderHud(inSpaceStore());
  assert.match(body, /class="hud-head-state[^"]*"[^>]*>Engines stopped\./);
  assert.match(body, /class="hud-head-state stopped"/, "a stopped ship must not read as an event");
  assert.equal(/hud-head-mode/.test(body), false, "the one-word mode came back");
});

test("⚠ THE CELL IS TWO ROWS — THE FOOTER IS GONE, AND SO IS THE GESTURE LEGEND", () => {
  // The legend read "click = on/off · hold ≈ 0.6 s = overload". It was kept once
  // as the one hint in the app that explains a CONTROL rather than a rule of
  // EVE — press-and-hold genuinely has no affordance. The operator cut it
  // anyway, along with the row it sat in: a legend that is on screen for every
  // second of every session is paying for the thousandth press to help with the
  // first.
  const body = renderHud(inSpaceStore());
  const text = visibleText(body);
  assert.equal(/click = on\/off/.test(text), false, "the gesture legend came back");
  assert.equal(/overload/.test(text), false, "the legend came back in other words");
  assert.equal(/hud-foot/.test(body), false, "the footer row came back");
});

// --- Stop, and the rule that travels with it ---------------------------------
//
// These three moved here from `flightStrip.test.ts` when Stop moved from the
// overview window's flight strip to the HUD footer. The rule did not soften in
// the move: it is the control a pilot reaches for when things are going wrong,
// which is exactly the moment other requests are in flight.

test("in space, the HUD carries Stop", () => {
  // ⚠ THE LABEL IS "Stop", NOT "Stop the ship". It sits in a row that already
  // carries a sentence about the ship, so the longer label was saying "ship"
  // twice in one row; the reference's is the short one.
  assert.ok(visibleText(renderHud(inSpaceStore())).includes("Stop"));
  assert.match(renderHud(inSpaceStore()), /class="hud-stop"/);
});

test("⚠ STOP IS IN THE HEADER, CENTRED BY THE GRID AND NOT BY WHAT IS BESIDE IT", () => {
  // It moved out of the footer when the footer went. Centring it with the grid
  // rather than with auto margins is the point: `1fr auto 1fr` puts it at the
  // middle of the CELL, so it does not drift as the ship's name and the state
  // sentence change length. It is the control a pilot presses without looking.
  const body = renderHud(inSpaceStore());
  const head = body.slice(body.indexOf('class="hud-head"'), body.indexOf("</header>"));
  assert.ok(head.length > 0, "the header is not where this test looks");
  assert.match(head, /class="hud-stop"/, "Stop is not in the header");
  const css = CSS;
  assert.match(css, /\.hud-head \{[\s\S]{0,300}grid-template-columns: 1fr auto 1fr;/);
  assert.match(css, /\.hud-stop \{[\s\S]{0,200}justify-self: center;/);
});

test("⚠ THE CARGO READOUT IS IN THE CELL, AND NOT ON THE PHONE", () => {
  // The cell answers what shape the ship is in and what its modules are doing;
  // for a miner or a hauler, how full the holds are is the third question asked
  // on the same two-second cycle, and it lived only behind a window you had to
  // open. It is FIRST in the body, in the space the centred pair already left.
  //
  // ⚠ The card hides it. That card is already a scroll, and a third block above
  // the gauge would push the module rack below the fold on the tier where the
  // fold is tightest — and Mining and Inventory & Ship are both one tap away in
  // the tab strip there.
  assert.match(HUD_SOURCE, /import CargoBays from "\.\/CargoBays\.svelte";/);
  assert.match(HUD_SOURCE, /<CargoBays \{store\} \{flow\} \/>/);
  assert.match(CSS, /\.mob-card-body \.cargo-cluster \{ display: none; \}/);
});

test("⚠ THE SPEED AND THE NUMBERS SIT AGAINST THE WHEEL, not at the floor of its box", () => {
  // The wheel's box is SQUARE but its ink is not: a 240 degree sweep with a 120
  // degree notch on the bottom puts the lowest stroke at 72% of the height, so
  // the bottom 28% of the box is empty. The speed was parked at `bottom: 0` —
  // the floor of that empty band, a finger's width below the instrument it
  // belongs to — and the readout was laid out below the BOX rather than below
  // the ink.
  //
  // Measured live after the change: 5px from the CAP reading to the speed, 17px
  // from the speed to the numbers.
  assert.match(CSS, /\.wheel-speed \{[\s\S]{0,900}bottom: 26%;/);
  assert.match(CSS, /\.hud-bar \.hud-wheel \{[\s\S]{0,900}margin-bottom: -1\.8rem;/);
});

test("⚠ THE CLUSTERS WRAP RATHER THAN SQUEEZE, and there is no breakpoint left", () => {
  // FOUND BY THE OPERATOR, at a window a hair above the mobile breakpoint. The
  // body was a three-column grid with a `@media (max-width: 820px)` override
  // that collapsed it to `1fr` — a rule written when there were TWO clusters
  // and stacking was the whole answer. With three it forced all of them into
  // one 323px column, the rack overflowed it by 33px, and `overflow: auto`
  // turned that into a horizontal scrollbar with the slots strung down the
  // right-hand edge.
  //
  // A wrapping row cannot do that: flex moves an item to the next LINE before
  // it shrinks one, and the rack has a hard minimum (26px gutter + 132px header
  // + 182px of slots + gaps = 356px) below which it stops being readable.
  // Verified live at 1600, 1280, 900, 760 and 375: no sideways scroll at any of
  // them.
  assert.match(CSS, /\.hud-body \{[\s\S]{0,2600}display: flex;/);
  assert.match(CSS, /\.hud-body \{[\s\S]{0,2600}flex-wrap: wrap;/);
  // ⚠ AND THE BREAKPOINT IS GONE, not adjusted. Wrapping is width-driven by
  // definition, so there is no number left to keep in step with the number of
  // clusters — which is exactly how the last one went stale.
  assert.equal(
    /@media \(max-width: 820px\)[\s\S]{0,600}\.hud-body/.test(CSS_NO_COMMENTS),
    false,
    "a breakpoint is overriding the cell's layout again",
  );
});

test("⚠ CENTRED, AND EACH CLUSTER KEEPS ITS OWN WIDTH", () => {
  // The rack column used to be `minmax(0, 1fr)`. A rack is at most four slots
  // wide, so on a wide cell the slots sat at the left edge of a 660px box and
  // the right half of the instrument panel was empty. Measured at 1600px after
  // the change: 160px of margin on the left, 161 on the right, one line.
  assert.match(CSS, /justify-content: safe center;/);
  assert.match(CSS, /\.hud-body > \.hud-cluster \{ flex: 0 1 auto; min-width: 0; \}/);
  // ⚠ `safe center`, NOT PLAIN `center`. Centred content that outgrows its box
  // overflows on BOTH sides and the left overflow cannot be scrolled to, so a
  // cluster too wide for the cell would lose its left edge with no way to reach
  // it. `safe` falls back to start-alignment at exactly that point.
  //
  // The gauge is 150px — the wheel's own cap. It was 170, left over from the
  // handoff's two-column grid, and the extra 20 was blank either side.
  assert.match(CSS, /\.hud-body > \.ship-gauges \{ flex: 0 0 150px; \}/);
});

test("⚠ WHEN THEY STACK, CARGO GOES LAST", () => {
  // Stacked, the cell is at its ceiling and scrolls, so the order stops being
  // cosmetic and becomes which instrument you can see without scrolling for it.
  // The gauge and the rack are what a pilot flies by. In the DOM cargo is
  // first, because on a wide cell it belongs in the space on the left, so this
  // moves it with `order` rather than with the markup.
  assert.match(CSS, /@container hud \(max-width: 420px\) \{[\s\S]{0,80}\.hud-body > \.cargo-cluster \{ order: 1; \}/);
});

test("⚠ THE HUD CELL SIZES TO ITS CONTENT — 24rem IS A CEILING, NOT A HEIGHT", () => {
  // It was a fixed 21rem, measured against content that has since changed: the
  // footer came off the cell and the number stayed, leaving a band of empty
  // panel under the racks. A measured height is only ever right for what it was
  // measured against, and this one had already been 17rem and 19rem before.
  //
  // `auto` cannot be wrong in either direction — it cannot cut the rack short
  // and it cannot leave a gap. What the old number was actually protecting is a
  // ceiling: a hull with a great many slots must not squeeze the radar to
  // nothing, and `.hud-body` scrolls when it hits it.
  assert.match(CSS, /\.workspace\.in-space \.work-main \{[\s\S]{0,1400}grid-template-rows: minmax\(0, 1fr\) auto;/);
  // ⚠ RAISED FROM 21rem. That was measured when the cell held ONE line of
  // clusters; three of them wrap to two lines on a 1280px window with the dock
  // panel open, which is 340px of content against a 336px ceiling — the cell
  // scrolled to hide four pixels. The radar still keeps the clear majority of
  // the surface (435px against the cell's 378 at that width).
  assert.match(CSS, /\.workspace\.in-space \.work-main > \.hud-bar \{ max-height: 24rem; \}/);
  assert.match(CSS, /\.hud-body \{[\s\S]{0,2000}overflow: auto;/, "the ceiling has nothing to scroll");
});

test("⚠ STOP IS SHORTER THAN R8's 40px, AND ONLY WHERE A MOUSE IS DOING THE PRESSING", () => {
  // The operator asked for the row to be shorter, and the row is exactly as
  // tall as Stop. R8's 40px is a TOUCH minimum, and this row sits at the top of
  // a fixed-height cell where every pixel it takes comes off the instruments
  // underneath. 30px is a comfortable mouse target and is not a finger target,
  // so the exception is scoped to the pointer that makes it safe.
  //
  // ⚠ ON `pointer: coarse`, NOT ON A WIDTH. A desktop-width tablet lands on
  // this same cell, and a breakpoint would hand it the 30px button. The query
  // asks the question that actually matters.
  assert.match(CSS, /\.hud-stop \{[\s\S]{0,900}min-height: 30px;/);
  assert.match(CSS, /@media \(pointer: coarse\) \{\n\s*\.hud-stop \{ min-height: 40px; \}/);
});

test("⚠ AND IT SURVIVES ON A PHONE, where the header used to be hidden whole", () => {
  // The mobile card hid `.hud-head` outright, because the card's own title
  // already named the ship. With Stop in that row, hiding it would take the
  // control off the phone entirely — which has happened on this tier once
  // already, and was only caught by flying it. Only the NAME is hidden now.
  const css = CSS;
  assert.equal(
    /\.mob-card-body > \.hud-bar > \.hud-head \{ display: none; \}/.test(css),
    false,
    "the mobile card hides the row Stop lives in",
  );
  assert.match(css, /\.mob-card-body > \.hud-bar > \.hud-head > \.hud-head-ship \{ display: none; \}/);
});

test("STOP IS NEVER DISABLED — not by a shared flag, not by its own", () => {
  const body = renderHud(inSpaceStore());
  const index = body.indexOf('class="hud-stop"');
  assert.ok(index > 0, "the Stop control is rendered");
  const openTag = body.lastIndexOf("<button", index);
  const buttonTag = body.slice(openTag, index);
  assert.equal(
    /disabled/.test(buttonTag),
    false,
    "Stop must never render a disabled attribute — see the comment in HudBar.svelte",
  );
});

test("Stop is not silently swallowed by a busy guard either", () => {
  // The other half of the same rule: an enabled button that drops the click
  // because something else is in flight is the same failure wearing a
  // friendlier face. So the handler must not be gated on anything at all.
  const handler = HUD_SOURCE.slice(
    HUD_SOURCE.indexOf("async function stopShip("),
    HUD_SOURCE.indexOf("</script>"),
  );
  assert.ok(handler.length > 0, "the Stop handler is not where this test looks");
  assert.equal(
    /if\s*\(/.test(handler),
    false,
    "Stop's handler grew a guard — any early return is the disabled button again",
  );
  assert.match(handler, /await flow\.stopShip\(\)/, "Stop must actually call stopShip");
  assert.match(HUD_SOURCE, /MUST NEVER GET ONE/, "the rule is not written down for the next reader");
});

test("the module rack draws its three racks, and invents no module", () => {
  const text = visibleText(renderHud(inSpaceStore()));
  // The three EVE activation racks are always drawn...
  assert.match(text, /High/, "no high rack row");
  assert.match(text, /Mid/, "no mid rack row");
  assert.match(text, /Low/, "no low rack row");
  // ...and with no fit loaded (this store never loaded fitting) the neutral hint
  // shows instead of a fabricated module.
  assert.match(text, /fitting has loaded/, "no empty-rack hint");
  assert.doesNotMatch(text, /placeholder/i, "the rack claims to be a placeholder");
});

test("R7d: no bare numeric ID reaches the HUD or the header", () => {
  for (const [what, text] of [
    ["the HUD", visibleText(renderHud(inSpaceStore()))],
    ["the in-space header", visibleText(renderHeader(inSpaceStore(), false))],
    ["the docked header", visibleText(renderHeader(dockedStore(), true))],
  ] as const) {
    for (const id of [SHIP_ID, SHIP_TYPE_ID, STATION_ID, SYSTEM_ID]) {
      assert.equal(
        new RegExp(`\\b${id}\\b`).test(text),
        false,
        `${id} is visible on ${what}`,
      );
    }
  }
});

// --- the launcher rail and the panel host ------------------------------------

function renderNeocom(isDocked: boolean): string {
  return render(Neocom as never, {
    props: {
      store: createClientStore() as never,
      flow: null,
      isDocked,
      openIds: new Set(),
      focusedId: null,
      onSelect: () => {},
    },
  } as never).body;
}

test("the neocom launches every openable panel for the current state", () => {
  const docked = visibleText(renderNeocom(true));
  const space = visibleText(renderNeocom(false));
  // The static set — reachable docked or in space — is in both.
  for (const label of ["Market", "Wallet", "Mail", "Skills", "Standings", "Planets"]) {
    assert.match(docked, new RegExp(label), `${label} missing from the docked neocom`);
    assert.match(space, new RegExp(label), `${label} missing from the in-space neocom`);
  }
  // No state badge in the rail: the workspace header carries docked/in-space —
  // the rail proves its state through WHICH tabs it offers.
  assert.doesNotMatch(docked, /Docked/);
  assert.doesNotMatch(space, /In Space/);
  // State-specific tabs appear only in their own state.
  assert.match(space, /Flight/, "the in-space Flight tab is missing");
  assert.doesNotMatch(docked, /Flight/, "an in-space-only tab leaked into the docked rail");
  assert.match(docked, /Fitting/, "the docked Fitting tab is missing");
  assert.doesNotMatch(space, /Fitting/, "a docked-only tab leaked into the in-space rail");
  // ⚠ "Around Your Ship" IS GONE, and this assertion is its headstone.
  //
  // It was fixed chrome, then briefly a window while the cockpit was taken
  // apart section by section, and now the file behind it does not exist. The
  // overview is `SpaceOverview` in the dock panel — always on screen, never
  // something to launch — and every section that used to sit under that tab has
  // its own home: Drones, Shots Fired and Equipment are rail entries of their
  // own, the gauges and racks are the HUD, and the flight narration is on
  // Flight.
  assert.doesNotMatch(space, /Around Your Ship/, "the deleted cockpit tab came back");
  for (const moved of ["Drones", "Shots Fired", "Equipment"]) {
    assert.match(space, new RegExp(moved), `${moved} must be reachable in space`);
    assert.doesNotMatch(docked, new RegExp(moved), `${moved} leaked into the docked rail`);
  }
});

test("the panel host renders the real panel for a selected tab", () => {
  const wallet = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "wallet" },
  } as never).body;
  const market = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "market" },
  } as never).body;
  const fitting = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "fitting" },
  } as never).body;
  assert.match(visibleText(wallet), /Wallet/);
  assert.match(visibleText(market), /Market/);
  assert.match(visibleText(fitting), /Fitting/);
});

// --- locked targets ----------------------------------------------------------

test("the target bracket names a locked target and shows its condition", () => {
  const store = createClientStore();
  const target = {
    kind: "ship",
    itemID: 7777,
    typeID: 587,
    groupID: null,
    categoryID: null,
    name: "Guristas Wight",
    ownerID: null,
    radius: 30,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: 0.25,
    armorRatio: 1,
    hullRatio: 1,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    isNpc: true,
    npcEntityType: "npc",
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
  };
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: [target],
      ship: null,
    },
  } as never);
  store.apply({ type: "targeting/targets", targetIDs: [7777] } as never);
  const text = visibleText(render(TargetBracket as never, { props: { store } } as never).body);
  assert.match(text, /Guristas Wight/, "the locked target is not named");
  assert.match(text, /25%/, "its shield reading is missing");
  assert.equal(/\b7777\b/.test(text), false, "the target's itemID must never show");
});
