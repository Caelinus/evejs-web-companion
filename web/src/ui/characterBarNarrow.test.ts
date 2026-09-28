// The character bar on a phone: one pilot, and a way to change it.
//
// ⚠ WHAT WENT WRONG, AND WHY IT WENT UNNOTICED. The bar is a scrolling strip of
// 11rem pilot tabs — a desktop shape. At 375px it had 359px to spend, the
// brand, status, Pilots and "+ Add character" took 316, and the strip is
// `flex: 1 1 auto`, so the pilot chip absorbed the entire shortfall: eleven
// pixels, a border and a dot with the name clipped away inside it. It read as a
// rendering artefact rather than as a squeezed control, which is exactly why
// nobody filed it as one.
//
// So below the breakpoint the strip becomes the ACTIVE pilot plus a switcher.
// The claims worth holding are about what a pilot can still find out and still
// do — never about which of them happens to be on screen.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const CharacterBar = (await import("./CharacterBar.svelte")).default;
const CharacterChip = (await import("./CharacterChip.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAR = readFileSync(path.join(UI_DIR, "CharacterBar.svelte"), "utf8");
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");

/** One online pilot's session, named and placed. */
function session(id: string, name: string, inSpace: boolean): unknown {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: { characterID: 90000001, characterName: name, corporationID: null, allianceID: null },
    station: null,
  } as never);
  store.apply({
    type: "flight/status",
    status: {
      inSpace,
      docked: !inSpace,
      solarSystemID: 30000142,
      stationID: inSpace ? null : 60000358,
      structureID: null,
      shipID: 9001,
      shipMode: inSpace ? "STOP" : null,
      shipSpeedFraction: null,
    },
  } as never);
  return { id, store, flow: new Proxy({}, { get: () => async () => {} }) };
}

function renderChip(compact: boolean): string {
  return render(CharacterChip as never, {
    props: { session: session("s1", "First Pilot", true), active: true, onSelect: () => {}, compact },
  } as never).body;
}

// --- the chip's compact form -------------------------------------------------

test("the compact chip keeps the dot and the NAME — the two things the bar is for", () => {
  const body = renderChip(true);
  assert.match(body, /char-chip-dot/, "the state dot must survive");
  assert.match(body, /First Pilot/, "the pilot must still be named");
});

test("⚠ ONLY THE ACTIVE CHIP MAY DROP ITS STATE LINE, and only because the header repeats it", () => {
  // The workspace header sits directly under the bar and says where the ship is
  // in more detail than this line can ("IN SPACE · Jita · ORBIT 100%").
  // For any OTHER pilot the state is the whole point — it is how you tell which
  // one you are switching to — so `compact` must never reach the switcher list.
  assert.equal(/char-chip-where/.test(renderChip(true)), false, "the compact chip kept its state line");
  assert.match(renderChip(false), /char-chip-where/, "the full chip lost its state line");
  const list = BAR.slice(BAR.indexOf('class="char-bar-pilots"'));
  assert.ok(list.length > 0, "the switcher list is not where this test looks");
  assert.equal(
    /compact/.test(list.slice(0, list.indexOf("{/each}"))),
    false,
    "the pilots you are choosing between lost the state you choose by",
  );
});

test("the compact chip is genuinely smaller, not just missing a line", () => {
  assert.match(
    CSS,
    /\.char-bar\.narrow \.char-bar-list > \.char-chip \{[\s\S]{0,200}min-height: 1\.7rem/,
  );
});

// --- the switcher ------------------------------------------------------------

function renderBar(count: number): string {
  const sessions = [
    session("s1", "First Pilot", true),
    session("s2", "Second Pilot", false),
    session("s3", "Third Pilot", true),
  ].slice(0, count);
  return render(CharacterBar as never, {
    props: {
      sessions,
      activeId: "s1",
      serverStatus: "online",
      onSwitch: () => {},
      onAdd: () => {},
      onHangar: () => {},
    },
  } as never).body;
}

test("⚠ THE SWITCHER EXISTS ONLY WHEN THERE IS SOMEBODY TO SWITCH TO", () => {
  // A control that can only ever open an empty list is a control that teaches a
  // player it does nothing.
  //
  // ⚠ SSR RENDERS THE WIDE ARM, because `narrow` is set by matchMedia in an
  // effect and effects never run on the server. So this reads the SOURCE for
  // the gate rather than the markup — the render below only proves the bar
  // survives either way.
  assert.match(BAR, /\{#if others\.length > 0\}/, "the switcher is not gated on there being others");
  assert.match(BAR, /others = \$derived\(sessions\.filter\(\(s\) => s\.id !== activeSession\?\.id\)\)/);
  // And an emptied list closes itself rather than hanging open over nothing.
  assert.match(BAR, /if \(others\.length === 0\) \{\s*\n\s*switching = false;/);
});

test("the switcher names how many pilots it would offer, not just an arrow", () => {
  // A bare `▾` is a control with no accessible name. The count is in the label
  // because "switch pilot" alone does not say whether it is worth pressing.
  assert.match(BAR, /aria-label=\{`Switch pilot — \$\{others\.length\} other/);
  assert.match(BAR, /aria-haspopup="listbox"/);
  assert.match(BAR, /aria-expanded=\{switching\}/);
});

test("the list closes on Escape and on the next tap anywhere", () => {
  // Both, because a popover that only one of them closes is a popover a player
  // gets stuck under.
  assert.match(BAR, /onkeydown=\{\(event\) => event\.key === "Escape" && \(switching = false\)\}/);
  assert.match(BAR, /class="char-bar-shade" onclick=\{\(\) => \(switching = false\)\}/);
  assert.match(CSS, /\.char-bar-shade \{ position: fixed; inset: 0;/);
});

test("the bar renders with one pilot and with three, and names every one", () => {
  const one = renderBar(1);
  assert.match(one, /First Pilot/);
  const three = renderBar(3);
  for (const name of ["First Pilot", "Second Pilot", "Third Pilot"]) {
    assert.match(three, new RegExp(name), `${name} is missing from the bar`);
  }
});

// --- the switch actually switches -------------------------------------------

test("⚠ THE ACTIVE CHIP IS KEYED ON ITS SESSION, or a switch changes nothing", () => {
  // FOUND LIVE. Switching pilot moved the whole workspace — the header went
  // from "DOCKED · a station" to "IN SPACE · a system" — and the bar went on
  // naming the pilot you had just left.
  //
  // `CharacterChip` reads its session's store slices ONCE, at init: it has to,
  // because `$station` needs a stable top-level binding. So handing a live
  // instance a different `session` prop changes nothing at all — it keeps
  // rendering the pilot it was created for, silently and convincingly.
  //
  // The desktop strip never hits this because `{#each … (session.id)}` keys
  // every chip. The narrow bar renders ONE chip for whichever pilot is active,
  // so it has to say so itself.
  const narrowArm = BAR.slice(BAR.indexOf("{#if narrow}"), BAR.indexOf("{:else}"));
  assert.ok(narrowArm.length > 0, "the narrow arm is not where this test looks");
  assert.match(narrowArm, /\{#key activeSession\.id\}/, "the active chip is not keyed on its session");
  assert.match(
    narrowArm.slice(narrowArm.indexOf("{#key activeSession.id}")),
    /^[\s\S]{0,400}<CharacterChip/,
    "the key does not wrap the chip",
  );
});

test("the chip says out loud that it binds to one session", () => {
  // The next reader has to be able to see why the key exists, from the file
  // that makes it necessary — not only from the one that supplies it.
  const chip = readFileSync(path.join(UI_DIR, "CharacterChip.svelte"), "utf8");
  assert.match(chip, /BOUND TO ONE SESSION FOR ITS WHOLE LIFE/);
  assert.match(chip, /MUST KEY IT ON `session\.id`/);
});

// --- what the narrow bar hides, and what it must not ------------------------

test("⚠ NEITHER HIDDEN LABEL LEAVES A CONTROL UNNAMED", () => {
  // A narrow bar drops the add button's words and the status text to buy room.
  // A "+" with no accessible name is a button nothing can read aloud, and a
  // coloured dot with no word is state carried by colour alone.
  assert.match(BAR, /aria-label="Add character"/, "the + button has no accessible name");
  assert.match(BAR, /class="char-bar-status[^"]*" title=/, "the status dot carries no word");
  // Both are hidden by CSS, not removed — they come back the moment there is
  // room, and they stay in the accessibility tree meanwhile.
  assert.match(BAR, /class="char-bar-add-text">Add character</);
  assert.match(BAR, /class="char-bar-status-text">\{statusLabel\}</);
  assert.match(CSS, /\.char-bar\.narrow \.char-bar-add-text \{ display: none; \}/);
  assert.match(CSS, /\.char-bar\.narrow \.char-bar-status-text \{ display: none; \}/);
});

// --- one number, in one place ------------------------------------------------

test("⚠ THE BREAKPOINT IS WRITTEN DOWN ONCE", () => {
  // The bar CHANGES SHAPE below it — a strip of tabs becomes one pilot and a
  // switcher — which is markup, not styling, so the decision has to be made in
  // the component. A `@media` carrying the same number in the stylesheet would
  // be a second copy to keep equal by hand.
  assert.match(BAR, /matchMedia\("\(max-width: 560px\)"\)/);
  const narrowRules = CSS.match(/\.char-bar\.narrow [^{]*\{/g) ?? [];
  assert.ok(narrowRules.length >= 3, "the narrow styling is not driven by the class");
  assert.equal(
    /@media \(max-width: 560px\)[\s\S]{0,200}char-bar/.test(CSS),
    false,
    "the breakpoint is written down twice",
  );
});
