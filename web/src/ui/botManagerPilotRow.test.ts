// SSR render checks for ONE pilot row in the Bot Manager.
//
// WHY THIS FILE EXISTS SEPARATELY FROM botManagerPanel.test.ts. The panel loads
// its roster in `onMount`, which the SSR harness never runs — so rendering the
// PANEL never reaches a single row, and the Start controls (which start real
// bots on real ships) would otherwise have no coverage at all. Rendering the row
// directly is the only way to see them, and it needs no test-only seam: the row
// takes everything it renders as props, and its store subscriptions live in an
// `$effect` that SSR skips, so the run-state fallbacks put a fresh row in
// exactly the "nothing running" state the Start controls key off.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const PilotRow = (await import("./BotManagerPilotRow.svelte")).default;

// ESI's own published example CharacterID — documented, obviously synthetic.
const PILOT_ID = 90000001;

function fakeSession(): unknown {
  return {
    id: "session-under-test",
    store: createClientStore(),
    flow: new Proxy({}, { get: () => async () => ({}) }),
  };
}

function fakeServerBot(over: Record<string, unknown> = {}): unknown {
  return {
    botID: "bot-under-test",
    characterID: PILOT_ID,
    characterName: "Test Pilot One",
    scriptID: "script-1",
    scriptName: "Sample belt loop",
    scriptRev: 1,
    scriptHash: "hash",
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 720,
    expiresAt: null,
    status: "running",
    phase: "Mining",
    why: null,
    stepPath: null,
    pauseReason: null,
    note: null,
    startedAt: "2026-09-02T12:00:00.000Z",
    endedAt: null,
    resumedAt: null,
    lastAlert: null,
    vitals: null,
    ...over,
  };
}

const SCRIPTS = [
  { scriptID: "script-1", name: "Sample belt loop", rev: 1, updatedAt: "2026-09-02T12:00:00.000Z", authorAccountID: 424242, authorName: "Test Pilot One" },
  { scriptID: "script-2", name: "Second sample bot", rev: 3, updatedAt: "2026-09-02T12:00:00.000Z", authorAccountID: 424242, authorName: null },
];

function renderRow(props: Record<string, unknown>): string {
  const output = render(PilotRow as never, {
    props: { serverBot: null, scripts: SCRIPTS, onChanged: () => {}, ...props },
  } as never);
  return output.body;
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("a held pilot with nothing running offers the Start controls", () => {
  const html = renderRow({ session: fakeSession() });
  const text = visibleText(html);
  assert.match(text, /Run here/);
  assert.match(text, /Run on server/);
  assert.match(text, /Choose a bot/);
});

test("the bot picker lists the library rows it was handed, and fetches nothing itself", () => {
  const text = visibleText(renderRow({ session: fakeSession() }));
  assert.match(text, /Sample belt loop/);
  assert.match(text, /Second sample bot/);
});

test("the server run limit offers the same choices as the Bots launcher", () => {
  const text = visibleText(renderRow({ session: fakeSession() }));
  for (const label of ["1 hour", "4 hours", "12 hours", "24 hours"]) {
    assert.match(text, new RegExp(label));
  }
});

test("a pilot already flying a server bot gets Stop, never Start", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.match(text, /Stop/);
  assert.doesNotMatch(text, /Run here/);
  assert.doesNotMatch(text, /Choose a bot/);
});

test("a server bot is labelled as flying on the server, and says it outlives the tab", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.match(text, /On the server/i);
  assert.match(text, /Keeps flying/i);
});

test("a character with no tab open here cannot be started, and says why", () => {
  // No session at all: nothing in this browser tab is holding that pilot, so a
  // Start control would be a button that cannot work.
  const text = visibleText(renderRow({ session: undefined, serverBot: null }));
  assert.doesNotMatch(text, /Run here/);
  assert.match(text, /No tab is open here/i);
});

test("no raw numeric id reaches the row (R7d)", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.doesNotMatch(text, /\b\d{4,}\b/);
});

test("the R7d sweep would actually catch a leaked id", () => {
  // Keeps the assertion above from passing vacuously.
  assert.match(visibleText(`<td>${PILOT_ID}</td>`), /\b\d{4,}\b/);
});
