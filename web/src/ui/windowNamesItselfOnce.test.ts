// A WINDOW NAMES ITSELF ONCE.
//
// ⚠ THE RULE THIS PINS HAD ALREADY ROTTED, SILENTLY, ACROSS EIGHT WINDOWS. The
// stylesheet hid a panel's own title with a PATH — `.win-body > .panel >
// .panel-head > h2` — which only matched a title sitting exactly three levels
// down in exactly that furniture. Bot Builder wrapped its head one level
// deeper; Wallet, Corp Wallet, Standings and Character Sheet used no head at
// all; Settings' root was `.settings-panel` rather than `.panel`; Scanner's
// heading lived in the component it delegates to. Every one of them went on
// printing its own name in a band under a title bar that had just said it:
// BOT BUILDER over BOT BUILDER, WALLET over WALLET.
//
// Nothing failed. Nothing could: a CSS selector that stops matching does not
// throw, it just stops hiding, and the doubling it stops hiding is the kind of
// thing you only notice when you put thirty windows side by side (see
// `window-harness.html`, which is how these eight were found).
//
// So the marker is now a CLASS the panel puts on its own title —
// `.panel-title`, honoured by every host that already names what is inside it
// (a window's title bar, a mobile card's header) — and this test is the thing
// that notices when a new panel forgets it.
//
// ⚠ IT RENDERS THROUGH `PanelHost`, not the components one by one, for the
// Scanner reason: Scanner.svelte has no heading of its own and would pass any
// source-level check, while the component it delegates to prints "Scanner /
// Exploration Center". Only a render sees through a delegation.
//
// What it cannot see: a heading behind an `{#if}` that a cold store does not
// reach, since `$effect` and `onMount` do not run under the server generator.
// That is the same limit every render test here has.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const PanelHost = (await import("./PanelHost.svelte")).default;
const { createClientStore } = await import("../store/clientStore.ts");
const { TABS, tabLabel } = await import("./tabs.ts");

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/** Compare the way a player does: case, punctuation and spacing are noise. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface Heading {
  readonly text: string;
  readonly attrs: string;
}

function headings(html: string): Heading[] {
  const found: Heading[] = [];
  for (const match of html.matchAll(/<h[123]([^>]*)>([\s\S]*?)<\/h[123]>/g)) {
    found.push({
      attrs: match[1] ?? "",
      text: (match[2] ?? "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return found;
}

function renderTab(id: string): string {
  const store = createClientStore();
  return render(PanelHost as never, {
    props: { store, flow: fakeFlow(), tab: id, sessions: [] },
  } as never).body;
}

for (const tab of TABS) {
  test(`the ${tab.id} window does not print its own name twice`, () => {
    const label = tabLabel(tab.id);
    const offenders = headings(renderTab(tab.id))
      .filter((heading) => norm(heading.text) === norm(label))
      .filter((heading) => !heading.attrs.includes("panel-title"));
    assert.deepEqual(
      offenders.map((heading) => heading.text),
      [],
      `"${label}" is already on the window's title bar. A heading that repeats ` +
        `it must carry class="panel-title", which is what tells the window (and ` +
        `a mobile card) to clip it — clipped, so the panel keeps its accessible ` +
        `name.`,
    );
  });
}

test("⚠ THE SWEEP WOULD ACTUALLY CATCH ONE — the marker is what it tests, not the words", () => {
  // Without this, a bug in `headings()` or in `norm()` would make every case
  // above pass by finding nothing at all.
  const doubled = headings('<section><h2>Fleet Companions</h2></section>').filter(
    (heading) => norm(heading.text) === norm("Fleet companions"),
  );
  assert.equal(doubled.length, 1, "the heading scan found nothing to check");
  assert.equal(doubled[0]!.attrs.includes("panel-title"), false);

  const marked = headings('<h2 class="panel-title">Wallet</h2>').filter(
    (heading) => norm(heading.text) === norm("Wallet"),
  );
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.attrs.includes("panel-title"), true, "a marked title still reads as marked");
});
