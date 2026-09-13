// R107 — the character bar's server-connection indicator. Rendered with Svelte's
// server generator (no DOM), like characterChip.test.ts. Empty roster so no chip
// mounts; we only assert the status indicator reflects the passed serverStatus.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const CharacterBar = (await import("./CharacterBar.svelte")).default;

function renderBar(serverStatus: "checking" | "online" | "offline"): string {
  return render(CharacterBar as never, {
    props: { sessions: [], activeId: null, serverStatus, onSwitch: () => {}, onAdd: () => {} },
  } as never).body;
}

test("the bar shows a Connected status when the server is online", () => {
  const body = renderBar("online");
  assert.match(body, /char-bar-status-online/);
  assert.match(body, /Connected/);
});

test("the bar shows Server offline when the health poll fails", () => {
  const body = renderBar("offline");
  assert.match(body, /char-bar-status-offline/);
  assert.match(body, /Server offline/);
});

test("the bar shows Connecting… while the first health ping is in flight", () => {
  const body = renderBar("checking");
  assert.match(body, /char-bar-status-checking/);
  assert.match(body, /Connecting/);
});

// ─── the Fleet companions door ───────────────────────────────────────────────
//
// ⚠ THIS BUTTON IS THE ONLY WAY INTO A WHOLE WINDOW. Fleet companions is global
// and deliberately NOT in the Neocom rail (it is about every pilot, and the rail
// belongs to one), so if this button ever stops rendering the panel becomes
// unreachable rather than merely harder to find.

function renderCompanionBar(props: Record<string, unknown>): string {
  return render(CharacterBar as never, {
    props: {
      sessions: [],
      activeId: null,
      serverStatus: "online",
      onSwitch: () => {},
      onAdd: () => {},
      onCompanions: () => {},
      ...props,
    },
  } as never).body;
}

test("the bar carries a Fleet companions button", () => {
  const body = renderCompanionBar({});
  assert.match(body, /char-bar-companions/);
  assert.match(body, /Fleet companions/);
});

test("the count is shown only when somebody is actually flying", () => {
  // A badge reading "0" is a badge that has to be read before it can be
  // dismissed; the absence of one says the same thing faster.
  const idle = renderCompanionBar({ companionCount: 0 });
  assert.doesNotMatch(idle, /char-bar-companions-count/);

  const flying = renderCompanionBar({ companionCount: 2 });
  assert.match(flying, /char-bar-companions-count/);
  assert.match(flying, /2 flying/, "and it is in the accessible name too, in words");
});

test("the button says whether its window is already open", () => {
  // The bar doubles as the answer to "is that thing on screen somewhere?" — a
  // window that is merely put away still counts as open.
  assert.match(renderCompanionBar({ companionsOpen: true }), /aria-pressed="true"/);
  assert.match(renderCompanionBar({ companionsOpen: false }), /aria-pressed="false"/);
});

test("a bar mounted without the door renders without one, rather than throwing", () => {
  // Harnesses and older mounts pass no `onCompanions`; a bar that crashed on
  // that would take the whole top of the tab down with it.
  const body = render(CharacterBar as never, {
    props: {
      sessions: [],
      activeId: null,
      serverStatus: "online",
      onSwitch: () => {},
      onAdd: () => {},
    },
  } as never).body;
  assert.doesNotMatch(body, /char-bar-companions/);
});
