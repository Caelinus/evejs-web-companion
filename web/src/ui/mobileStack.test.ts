// The in-space mobile home: one column of collapsible cards (direction 1D).
//
// ⚠ THE TWO CLAIMS WORTH A TEST FILE are both about what a folded card does,
// because a fold is the one piece of UI that can make something disappear
// without the pilot being able to see that it has:
//
//   1. An UNKNOWN card is OPEN. A store that cannot be read, or holds
//      nonsense, must never fold anything away.
//   2. A folded card is NOT RENDERED, not hidden. These bodies poll, tick and
//      animate; `display: none` leaves every one of them running on a phone.
//
// Plus the structural one: the cards are the SAME components the desktop
// mounts. A mobile variant of any of these panels would be a second thing to
// keep honest, and the honesty is the whole product.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const {
  MOBILE_CARDS,
  isCollapsed,
  readCollapsed,
  tabsShownInStack,
  toggleCollapsed,
  writeCollapsed,
} = await import("./mobileCards.ts");
const MobileCard = (await import("./MobileCard.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = readFileSync(path.join(UI_DIR, "MobileWorkspace.svelte"), "utf8");
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");

// --- the stack itself --------------------------------------------------------

test("the stack is the handoff's six sections, in its order", () => {
  assert.deepEqual(
    MOBILE_CARDS.map((card) => card.id),
    ["ship", "overview", "drones", "shots", "flight", "mining"],
  );
});

test("⚠ SHIP IS FIRST, and it is the one card with no panel to open instead", () => {
  // It is the gauges and the racks — what a pilot glances at. There is no HUD
  // panel anywhere in the app, so it can only ever be here.
  assert.equal(MOBILE_CARDS[0]!.id, "ship");
  assert.equal(tabsShownInStack().has("ship"), false, "ship must not be filtered from the nav bar");
});

test("every LONG card caps its own height — the rule is length, not shape", () => {
  // ⚠ FLIGHT IS CAPPED THOUGH IT IS NOT A LIST. Measured live on a 375x812
  // phone its body is 1,427px, which is nearly two screens: the next card's
  // header would be off the bottom, and so would the fold control a pilot is
  // reaching for. Ship is 453px and is the one thing they glance at, so it is
  // left whole.
  const scrolls = MOBILE_CARDS.filter((card) => card.scrolls).map((card) => card.id);
  assert.deepEqual(scrolls, ["overview", "drones", "shots", "flight", "mining"]);
  assert.equal(
    MOBILE_CARDS.find((card) => card.id === "ship")?.scrolls,
    false,
    "the glance card must not be boxed into a scroller",
  );
  // ...and the cap exists in the stylesheet, or the claim is decorative.
  assert.match(CSS, /\.mob-card-body\.scrolls \{[\s\S]{0,120}max-height: 320px/);
});

// --- what a fold remembers ---------------------------------------------------

function fakeStorage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value } as Pick<Storage, "getItem">;
}

test("nothing remembered means nothing folded", () => {
  assert.deepEqual(readCollapsed(fakeStorage(null)), {});
  assert.deepEqual(readCollapsed(fakeStorage("")), {});
  assert.deepEqual(readCollapsed(null), {});
});

test("⚠ AN UNREADABLE STORE READS AS NOTHING FOLDED, never as folded", () => {
  // A private window throws outright on localStorage. A card folded by a
  // storage failure is one a pilot cannot see they are missing.
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
  } as Pick<Storage, "getItem">;
  assert.deepEqual(readCollapsed(throwing), {});
});

test("⚠ ONLY A REAL `true` FOLDS A CARD", () => {
  // A hand-edited or migrated value can be anything. "true", 1 and null are all
  // truthy-ish in some reading and none of them is a fold.
  const stored = readCollapsed(fakeStorage(JSON.stringify({
    shots: true,
    mining: "true",
    drones: 1,
    flight: null,
    overview: false,
  })));
  assert.deepEqual(stored, { shots: true });
});

test("a store holding something that is not an object folds nothing", () => {
  for (const raw of ["null", "[]", '"folded"', "42", "{ not json"]) {
    assert.deepEqual(readCollapsed(fakeStorage(raw)), {}, `raw: ${raw}`);
  }
});

test("an absent card is OPEN, and toggling flips it both ways", () => {
  assert.equal(isCollapsed({}, "shots"), false, "an unknown card must be open");
  const folded = toggleCollapsed({}, "shots");
  assert.equal(isCollapsed(folded, "shots"), true);
  assert.equal(isCollapsed(toggleCollapsed(folded, "shots"), "shots"), false);
});

test("⚠ ONLY THE FOLDED ONES ARE WRITTEN, so a card added later is never pre-folded", () => {
  const written: Record<string, string> = {};
  const storage = { setItem: (k: string, v: string) => (written[k] = v) } as Pick<Storage, "setItem">;
  writeCollapsed(storage, { shots: true, mining: false, drones: true });
  const saved = JSON.parse(Object.values(written)[0] as string);
  assert.deepEqual(saved, { shots: true, drones: true });
});

test("a storage that refuses to be written is not an error", () => {
  const refusing = {
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  } as Pick<Storage, "setItem">;
  assert.doesNotThrow(() => writeCollapsed(refusing, { shots: true }));
  assert.doesNotThrow(() => writeCollapsed(null, { shots: true }));
});

// --- the card component ------------------------------------------------------

function renderCard(collapsed: boolean): string {
  return render(MobileCard as never, {
    props: {
      title: "Shots fired",
      collapsed,
      onToggle: () => {},
      children: () => {},
    },
  } as never).body;
}

test("the header is a real button that says which way it is (R8)", () => {
  const open = renderCard(false);
  assert.match(open, /<button[^>]*aria-expanded="true"/, "an open card must report itself open");
  const shut = renderCard(true);
  assert.match(shut, /<button[^>]*aria-expanded="false"/);
  // The chevron is decoration: `aria-expanded` already says it, and a reader
  // announcing both would say it twice.
  assert.match(shut, /aria-hidden="true"/);
});

test("⚠ A FOLDED CARD IS NOT RENDERED — not hidden with CSS", () => {
  // These bodies poll, tick and animate. `display: none` would leave every one
  // of them running behind a closed header, on the device least able to afford
  // it. The body element must be absent entirely.
  assert.match(renderCard(false), /class="mob-card-body/, "an open card must have a body");
  assert.equal(
    /mob-card-body/.test(renderCard(true)),
    false,
    "a folded card kept its body in the DOM",
  );
});

// --- the workspace wires it up ----------------------------------------------

test("every card mounts the SAME component the desktop uses", () => {
  // A mobile variant of any of these panels is a second implementation to keep
  // honest, and every capability check in this suite would then only be
  // checking one of the two.
  for (const component of [
    "HudBar",
    "SpaceOverview",
    "DronesPanel",
    "ShotsPanel",
    "Flight",
    "Mining",
  ]) {
    assert.match(
      WORKSPACE,
      new RegExp(`import ${component} from`),
      `${component} is not the one the desktop mounts`,
    );
  }
});

test("⚠ THE NAV BAR DROPS WHAT THE STACK ALREADY SHOWS", () => {
  // Two ways to open one thing is not a feature — the same call the HUD's nav
  // buttons lost. All six are the home screen in space.
  assert.match(WORKSPACE, /tabsShownInStack\(\)\.has\(tab\.id\)/);
  const hidden = tabsShownInStack();
  for (const id of ["overview", "drones", "shots", "flight", "mining"]) {
    assert.ok(hidden.has(id), `${id} is in the stack and must not also be in the bar`);
  }
});

test("⚠ THE HOLD-TO-OVERLOAD GESTURE IS REACHABLE ON TOUCH", () => {
  // This is the tier that gesture was introduced FOR. Without `touch-action`,
  // a press on a slot is claimed by the page's scroll and long-press handling
  // long before the 600ms hold completes — so on a phone, overloading would
  // have been exactly as unreachable as the shift-click it replaced.
  const rule = CSS.slice(CSS.indexOf("  .module-slot {"), CSS.indexOf("button.module-slot:hover"));
  assert.ok(rule.length > 0, "the .module-slot rule is not where this test looks");
  assert.match(rule, /touch-action: none/);
});

test("the radar is not on the phone at all", () => {
  // It is a picture that needs room to mean anything, and there is none. It is
  // not hidden with CSS — it is simply never mounted here.
  assert.equal(/Radar|<Desktop/.test(WORKSPACE), false, "the radar reached the mobile workspace");
});

// --- the ship card, against the reference ------------------------------------

test("⚠ STOP IS ON THE SHIP CARD — not three cards down, behind a fold", () => {
  // FOUND BY COMPARING WITH THE HANDOFF. The card was `ShipHud` + `ModuleRack`,
  // which left the phone with no Stop on the one screen a pilot looks at: it
  // was inside Navigation & Flight, two cards below, and that card can be
  // folded away. Stop is the control you reach for when things are going wrong.
  //
  // The card mounts `HudBar` — the same component the desktop cell is — which
  // is header, gauge, racks and the footer carrying the ship's state and Stop.
  assert.match(WORKSPACE, /<HudBar \{store\} \{flow\} \/>/);
  assert.equal(
    /<ShipHud/.test(WORKSPACE),
    false,
    "the card went back to mounting half the HUD",
  );
});

test("the HUD's own header is hidden in a card, but the rack's is only CLIPPED", () => {
  // ⚠ TWO DIFFERENT TREATMENTS, ON PURPOSE. The HUD's header duplicates the
  // card's own title, so it is `display: none`. The rack's "Modules" heading is
  // what `aria-labelledby` points at, so removing it from the tree would take
  // the section's accessible name with it — it is clipped instead: still read
  // aloud, just not occupying a row.
  assert.match(CSS, /\.mob-card-body > \.hud-bar > \.hud-head \{ display: none; \}/);
  const rackHead = CSS.slice(
    CSS.indexOf(".mob-card-body > .hud-bar .module-rack > .panel-head"),
    CSS.indexOf(".mob-card-body > .hud-bar > .hud-foot"),
  );
  assert.ok(rackHead.length > 0, "the rack heading rule is not where this test looks");
  assert.equal(/display: none/.test(rackHead), false, "the accessible name was removed, not clipped");
  assert.match(rackHead, /clip-path: inset\(50%\)/);
});

test("the gauge takes the reference's 170px on a phone, not the cell's 136", () => {
  // The desktop cell squeezes the wheel to sit beside its numbers; a phone has
  // the vertical room, and the reference stacks them.
  assert.match(CSS, /\.mob-card-body > \.hud-bar \.hud-wheel \{[^}]*max-width: 170px/);
  assert.match(CSS, /\.mob-card-body > \.hud-bar \.ship-hud \{[^}]*flex-direction: column/);
});

test("⚠ AN EMPTY SLOT IS A DASHED RING, never a filled box", () => {
  // A solid square on a rack of round faces reads as a fitted module whose icon
  // failed to load — the one thing an empty slot must not look like. Nothing
  // else on the rack is dashed.
  const rack = readFileSync(path.join(UI_DIR, "ModuleRack.svelte"), "utf8");
  assert.match(rack, /class="slot-ring-empty"/);
  assert.match(CSS, /\.slot-ring-empty \{[^}]*stroke-dasharray: 3 3/);
  const box = CSS.slice(CSS.indexOf("  .module-slot.empty {"));
  assert.match(box.slice(0, 160), /background: none/, "the empty slot kept a solid fill");
});

test("⚠ THE CARD CARRIES NO `<section>` DRESSING — no band, no hairline", () => {
  // FOUND BY EYE. `.mob-card` is a `<section>`, and this app dresses every
  // `<section>` as a panel: padding, a bottom margin, and an accent hairline —
  // a 1px line inset from each side that starts accent-blue and fades to
  // transparent on the right. Together they drew an empty padded band across
  // the top of every card with a blue mark floating at its left edge, tapering
  // away to the right, above a header that should meet its own edges.
  //
  // The station and space panels cancelled the same hairline for the same
  // reason; this is the third, and the HUD's two clusters and any panel inside
  // a card are the fourth and fifth.
  for (const selector of [
    ".mob-card::before { content: none; }",
    ".hud-bar .hud-cluster::before { content: none; }",
    ".mob-card-body > .panel::before,",
  ]) {
    assert.ok(CSS.includes(selector), `${selector} — the section hairline is still drawn`);
  }
  assert.match(
    CSS.slice(CSS.indexOf(".mob-card-body > .panel::before,")),
    /^[\s\S]{0,120}content: none/,
    "the panel-in-card hairline is not cancelled",
  );
  // And the card itself has no padding to open a band with.
  const rule = CSS.slice(CSS.indexOf("  .mob-card {"), CSS.indexOf("  .mob-card::before"));
  assert.match(rule, /padding: 0;/);
  assert.match(rule, /margin: 0;/);
});

test("⚠ A WINDOWED PANEL DOES NOT REPEAT THE WINDOW'S OWN TITLE", () => {
  // The title bar says EQUIPMENT and the panel underneath said "YOUR
  // EQUIPMENT" again, in a 42px band, on every window.
  //
  // The title is CLIPPED rather than removed: panels are `aria-labelledby`
  // their heading, so taking it out of the tree takes the accessible name with
  // it. The head ROW stays, because that is where a panel's own controls and
  // counts live — it only collapses when the title was all it had.
  const rule = CSS.slice(
    CSS.indexOf(".win-body > .panel > .panel-head > h2"),
    CSS.indexOf(".win-body > .panel > .panel-head:not("),
  );
  assert.ok(rule.length > 0, "the rule is not where this test looks");
  assert.equal(/display: none/.test(rule), false, "the accessible name was removed, not clipped");
  assert.match(rule, /clip-path: inset\(50%\)/);
});

// ⚠ THE CHARACTER BAR'S OWN CLAIMS MOVED TO `characterBarNarrow.test.ts`.
// They lived here for one turn because the bar was found while looking at the
// phone; the bar is app chrome above every workspace, not part of this stack.
