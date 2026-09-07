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
    "ShipHud",
    "ModuleRack",
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
