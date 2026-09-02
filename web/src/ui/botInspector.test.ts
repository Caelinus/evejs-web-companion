// SSR render checks for the Bot Builder's INSPECTOR, rendered directly.
//
// WHY THIS FILE EXISTS SEPARATELY FROM botBuilderPanel.test.ts. The inspector
// only appears once a row is selected, and the SSR harness renders once and
// cannot click — so rendering the PANEL never reaches it, and the argument
// widgets (the single largest piece of template in the builder, and the piece
// that used to be a hand-written per-macro chain with three arguments missing
// from it entirely) would have no coverage at all. Rendering the component
// directly is the only way to see them, and it needs no test-only seam: the
// inspector holds no state and takes everything it draws as a prop.
//
// What it is really pinning: that `ARG_KIND_WIDGET`'s promise is kept. That
// table makes a missing widget a COMPILE error in editorOptions.ts; these
// tests make a widget that compiles but renders nothing a TEST failure.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const BotInspector = (await import("./BotInspector.svelte")).default;
const { MACRO_ARG_DESCRIPTORS } = await import("../bots/editorOptions.ts");

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** Everything the inspector can offer, so a widget never renders empty for
 * want of data. Ids here are invented, not observed: nothing in this file
 * needs to name a real character, item or station. */
const OPTIONS = {
  currentStation: { id: 60000001, name: "Test Station" },
  belts: [{ itemID: 40000001, name: "Asteroid Belt I" }],
  equipment: [{ groupID: 54, label: "Test Mining Laser" }],
  items: [{ typeID: 34, name: "Test Mineral" }],
  pilots: [{ characterID: 90000001, characterName: "Test Pilot One" }],
  agents: [{ agentID: 3010000, name: "Test Agent", stationName: "Test Station", solarSystemName: "Test System" }],
  fittings: [{ fittingID: 1, name: "Test Fitting" }],
  spots: [{ bookmarkID: 2, name: "Test Spot" }],
  savedBots: [{ scriptID: "script-1", name: "Test Saved Bot" }],
};

function renderInspector(target: unknown, over: Record<string, unknown> = {}): string {
  return render(BotInspector as never, {
    props: {
      target,
      flow: fakeFlow(),
      ...OPTIONS,
      problems: [],
      onArg: () => {},
      onCondition: () => {},
      onRespond: () => {},
      onAddToSide: () => {},
      onSubBot: () => {},
      onClose: () => {},
      ...over,
    },
  } as never).body;
}

function step(macro: string, extra: Record<string, unknown> = {}): unknown {
  return { id: "step-under-test", kind: "macro", macro, args: {}, ...extra };
}

// ── The generated argument widgets ──────────────────────────────────────────

// One case per WIDGET KIND, chosen through a macro that actually declares an
// argument of that kind. `equipment`, `corporation` and `agent` are the three
// that had NO widget before the editor was generated from the format, and
// `request-mission` had no editor branch whatsoever — so those three are the
// point of this table rather than incidental members of it.
const WIDGET_CASES: readonly { macro: string; key: string; expect: RegExp; why: string }[] = [
  { macro: "mine-at-belt", key: "belt", expect: /the nearest belt/, why: "belt-picker" },
  { macro: "mine-at-belt", key: "equipment", expect: /use everything fitted/, why: "equipment-picker" },
  { macro: "mine-at-belt", key: "pick", expect: /the biggest rock first/, why: "rock-pick-select" },
  { macro: "request-mission", key: "agent", expect: /use the agent your bot finds/, why: "agent-picker" },
  { macro: "find-distribution-agent", key: "corporation", expect: /placeholder="any corporation"/, why: "corp-picker" },
  { macro: "refit-ship", key: "fitting", expect: /Test Fitting/, why: "fitting-picker" },
  { macro: "warp-to-bookmark", key: "bookmark", expect: /Test Spot/, why: "bookmark-picker" },
  { macro: "move-items", key: "from", expect: /station hangar/, why: "place-select" },
  { macro: "buy-item", key: "item", expect: /Test Mineral/, why: "item-type-picker" },
  { macro: "invite-to-fleet", key: "who", expect: /Test Pilot One/, why: "character-picker" },
  { macro: "send-chat", key: "message", expect: /placeholder="write the message/, why: "text-input" },
  { macro: "send-chat", key: "channel", expect: /local chat/, why: "chat-channel-select" },
  // The two world-ref widgets delegate to StationPicker, and the ONLY visible
  // difference between them is whether it will also match a solar system —
  // which is exactly the bug a shared widget could hide, so it is what these
  // two look for.
  { macro: "travel-to-station", key: "station", expect: /or search a station by name/, why: "station-picker" },
  {
    macro: "set-destination",
    key: "destination",
    expect: /search a station or system by name/,
    why: "destination-picker, which also accepts a system",
  },
  { macro: "wait", key: "seconds", expect: /1 to 500/, why: "count-input shows its range" },
  { macro: "buy-item", key: "price", expect: /1 to 100000000000/, why: "isk-input shows its range" },
  { macro: "buy-item", key: "quantity", expect: /1 to 10000000/, why: "qty-input shows its range" },
];

for (const { macro, key, expect, why } of WIDGET_CASES) {
  test(`${macro}'s "${key}" renders its widget (${why})`, () => {
    // An optional argument sits behind "More options" until it is set, but a
    // <details> renders its contents either way — the disclosure hides them,
    // it does not withhold them — so one render covers both halves.
    // Matched against the RAW markup, not the visible text: a placeholder and
    // a select's options are both things a player sees, and only one of them
    // survives tag-stripping.
    const html = renderInspector({ kind: "step", step: step(macro) });
    assert.match(html, expect, `${macro}.${key} rendered no ${why}`);
  });
}

test("every argument of every macro is rendered by some widget, none silently skipped", () => {
  // The generic renderer's real promise: no macro has an argument the
  // inspector cannot draw. Proven by rendering all 49 and counting labels,
  // rather than by trusting the table above to have named every case.
  for (const [macro, descriptors] of Object.entries(MACRO_ARG_DESCRIPTORS)) {
    const text = visibleText(renderInspector({ kind: "step", step: step(macro) }));
    for (const arg of descriptors.all) {
      assert.ok(text.includes(arg.label), `${macro}'s "${arg.label}" argument has no field in the inspector`);
    }
  }
});

test("required arguments are visible; unset optional ones sit behind More options", () => {
  // Apple's action-summary rule. mine-at-belt has one required argument
  // (the belt) and two optional ones (equipment, which rock first).
  const html = renderInspector({ kind: "step", step: step("mine-at-belt") });
  assert.match(visibleText(html), /More options/, "no disclosure for the optional arguments");
  const summaryAt = html.indexOf("More options");
  assert.ok(html.indexOf("arg-step-under-test-belt") < summaryAt, "the required belt argument is hidden away");
  assert.ok(html.indexOf("arg-step-under-test-equipment") > summaryAt, "an unset optional argument is not hidden");
});

test("an optional argument the player has ALREADY set stays visible", () => {
  // A choice already made must not hide itself behind a disclosure the next
  // time the step is opened.
  const html = renderInspector({
    kind: "step",
    step: step("mine-at-belt", { args: { pick: { kind: "rockPick", pick: "biggest" } } }),
  });
  const summaryAt = html.indexOf("More options");
  assert.ok(summaryAt > 0, "the disclosure vanished entirely");
  assert.ok(html.indexOf("arg-step-under-test-pick") < summaryAt, "a set optional argument was hidden away");
});

// ── The "stop when" control ─────────────────────────────────────────────────

test("a mining step must say when to stop, so its until offers no way out", () => {
  const html = renderInspector({
    kind: "step",
    step: step("mine-at-belt", { until: { kind: "ore-hold-at-least", fraction: 0.9 } }),
  });
  const text = visibleText(html);
  assert.match(text, /Stop when/);
  assert.match(text, /the ore hold is nearly full/);
  assert.doesNotMatch(text, /when the step is done/, "a required until offered a 'no until' option");
});

test("wait offers an until, and offers to have none", () => {
  const text = visibleText(renderInspector({ kind: "step", step: step("wait") }));
  assert.match(text, /Stop when/);
  assert.match(text, /when the step is done/, "an optional until must be clearable");
});

test("a step with no until of its own does not grow a stop-when control", () => {
  const text = visibleText(renderInspector({ kind: "step", step: step("undock") }));
  assert.doesNotMatch(text, /Stop when/, "undock should not offer a stop-when");
});

test("the until list offers the conditions the format allows, not a shorter hardcoded set", () => {
  // wallet-below / wallet-above / cargo-full were legal `until` conditions the
  // old editor could never offer, because it kept its own array of seven.
  const text = visibleText(renderInspector({ kind: "step", step: step("wait") }));
  assert.match(text, /the cargo hold is nearly full/);
  assert.match(text, /the wallet drops below/);
  assert.match(text, /the wallet rises above/);
});

// ── Watches, branches and sub-bots ──────────────────────────────────────────

test("a watch is edited here, with its check and its response", () => {
  const html = renderInspector({
    kind: "watch",
    watch: { id: "watch-under-test", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" },
  });
  const text = visibleText(html);
  assert.match(text, /Watch — Shields/);
  assert.match(text, /If shields drop below 30%, dock at home and stop/);
  assert.match(text, /Dock at home and stop/, "the response picker is missing");
  assert.match(text, /Send out combat drones and keep going/, "the response list is not the derived one");
});

test("a watch can be switched to any condition the format allows at a watch", () => {
  // health-below, ore-hold-at-least and hold-empty had no watch button at all
  // before the list was derived from `conditionAllowedAt`.
  const text = visibleText(
    renderInspector({
      kind: "watch",
      watch: { id: "watch-under-test", when: { kind: "shield-below", fraction: 0.3 }, respond: "pause" },
    }),
  );
  for (const label of ["Ship health", "Ore hold", "Hold"]) {
    assert.ok(text.includes(label), `${label} is missing from the watch condition list`);
  }
});

test("a threshold field prints its own range rather than only enforcing it", () => {
  const oreHold = visibleText(
    renderInspector({
      kind: "watch",
      watch: { id: "w", when: { kind: "ore-hold-at-least", fraction: 0.9 }, respond: "pause" },
    }),
  );
  // The ore hold's ceiling is 90%, not 95% — a fact a player can only learn
  // from the field itself.
  assert.match(oreHold, /from 5 to 90/, "the ore hold's own ceiling is not shown");

  const shields = visibleText(
    renderInspector({
      kind: "watch",
      watch: { id: "w", when: { kind: "shield-below", fraction: 0.3 }, respond: "pause" },
    }),
  );
  assert.match(shields, /from 5 to 95/, "the general fraction range is not shown");
});

test("a branch edits its fork and can take a step into either side", () => {
  const text = visibleText(
    renderInspector({
      kind: "branch",
      branch: { id: "branch-under-test", kind: "branch", when: { kind: "shield-below", fraction: 0.5 }, then: [], else: [] },
    }),
  );
  assert.match(text, /A fork in the plan/);
  assert.match(text, /shields drop below/);
  assert.match(text, /Add a step to “then”/);
  assert.match(text, /Add a step to “otherwise”/);
});

test("a sub-bot picks from the shared library, and says it is a link and not a copy", () => {
  const text = visibleText(
    renderInspector({ kind: "sub-bot", subBot: { id: "sub-under-test", kind: "sub-bot", scriptID: null, name: null } }),
  );
  assert.match(text, /Another saved bot/);
  assert.match(text, /live link, not a copy/i);
  assert.match(text, /cannot repeat as a whole/i);
  assert.match(text, /Test Saved Bot/);
});

test("an empty library is said rather than shown as a blank picker", () => {
  const text = visibleText(
    renderInspector(
      { kind: "sub-bot", subBot: { id: "sub-under-test", kind: "sub-bot", scriptID: null, name: null } },
      { savedBots: [] },
    ),
  );
  assert.match(text, /No saved bots yet/);
});

test("an empty option list explains itself instead of offering an empty dropdown", () => {
  const noPilots = visibleText(renderInspector({ kind: "step", step: step("invite-to-fleet") }, { pilots: [] }));
  assert.match(noPilots, /No known pilots yet/);
  const noAgents = visibleText(renderInspector({ kind: "step", step: step("request-mission") }, { agents: [] }));
  assert.match(noAgents, /No agents found yet/);
});

// ── Problems, and the narrow-screen escape ──────────────────────────────────

test("a blocking problem shows as an error and an advisory does not", () => {
  const html = renderInspector(
    { kind: "step", step: step("undock") },
    {
      problems: [
        { path: "step-under-test", sentence: "This step needs a station to go to.", severity: "blocking" },
        { path: "step-under-test", sentence: "This bot never returns to a station.", severity: "advisory" },
      ],
    },
  );
  assert.match(html, /class="note error">This step needs a station to go to\./, "a blocking problem is not marked");
  assert.match(html, /class="note">This bot never returns to a station\./, "an advisory was marked as an error");
});

test("the sheet's way back always renders, so the narrow layout is never a trap", () => {
  // At or below 640px the inspector covers the plan; this is the only control
  // that brings the plan back, and the stylesheet is what hides it when there
  // is room for both. It must therefore exist in the markup at every width.
  const html = renderInspector({ kind: "step", step: step("undock") });
  assert.match(html, /inspector-back/);
  assert.match(visibleText(html), /Back to the plan/);
});

test("no world id reaches the screen (R7d)", () => {
  // Every picker renders NAMES; the ids in OPTIONS are only ever option values.
  const text = visibleText(renderInspector({ kind: "step", step: step("invite-to-fleet") }));
  assert.doesNotMatch(text, /90000001/, "a character id was rendered as text");
});
