// SSR render checks for the Bot Manager panel.
//
// The SSR harness runs neither `$effect` nor `onMount`, so the panel's fetch
// never fires here and every render below is the FIRST-MOUNT state. That is on
// purpose: the loaded/empty/error/no-match wording is decided by the pure
// module and tested directly in web/src/bots/libraryView.test.ts, which needs
// no DOM and no seam on the component's props. What is worth asserting here is
// what only a real render can show — that the panel mounts without throwing,
// that its shell copy is honest about a shared library, and that no raw id
// reaches the page (R7d).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const BotManager = (await import("./BotManager.svelte")).default;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => ({}) });
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPanel(): string {
  const store = createClientStore();
  const output = render(BotManager as never, {
    props: { store, flow: fakeFlow() },
  } as never);
  return output.body;
}

test("the Bot Manager panel renders on first mount without throwing", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Bot manager/i);
});

test("deleting a bot says plainly that the library is shared, not private", () => {
  // ⚠ THE WARNING MOVED, IT DID NOT GO. The panel used to carry a standing note
  // saying the library is shared; that note is gone, and the fact now reaches a
  // player at the moment it can cost them something — the delete confirm. That
  // is the better place for it (a standing paragraph is read once and then never
  // again), but it is also the ONLY place left, so it is worth pinning: the row
  // being deleted may not be the caller's own, and "delete this bot" alone would
  // not say so.
  const source = readFileSync(new URL("./BotManager.svelte", import.meta.url), "utf8");
  const confirm = source.match(/Delete .{0,200}cannot be undone\./s);
  assert.ok(confirm, "the delete confirm is gone");
  assert.match(confirm[0], /shared/i);
  assert.match(confirm[0], /any account|everyone|anyone/i);
});

test("first mount reads as loading, never as an empty library", () => {
  // Before the first read lands we know nothing — claiming "no bots saved"
  // here would be a lie a player could act on.
  const text = visibleText(renderPanel());
  assert.match(text, /Loading/i);
  assert.doesNotMatch(text, /No bots saved yet/i);
});

test("region A (pilots) heading is present", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Pilots/i);
});

test("region A reads as loading on first mount, never as 'no pilots'", () => {
  // The SSR harness never runs onMount, so the server roster fetch has not
  // fired — the panel must not guess "No pilots online" before it knows.
  const text = visibleText(renderPanel());
  assert.match(text, /Loading pilots/i);
  assert.doesNotMatch(text, /No pilots online/i);
});

test("the panel mounts fine with an explicit empty sessions array too", () => {
  const store = createClientStore();
  const output = render(BotManager as never, {
    props: { store, flow: fakeFlow(), sessions: [] },
  } as never);
  const text = visibleText(output.body);
  assert.match(text, /Bot manager/i);
  assert.match(text, /Pilots/i);
});

test("the panel mounts fine with a held pilot session too (the new per-row Start controls never reach a first mount)", () => {
  // The SSR harness never runs onMount, so region A stays gated behind
  // "Loading pilots…" regardless of how many sessions are held — a held
  // session's row (and its new script picker / Run here / Run on server
  // controls, wired from THAT session's own flow and store) is never
  // actually rendered here. This only pins that threading a real held
  // session through — which now also feeds BotManagerPilotRow the shared
  // `scripts` prop and the renamed `onChanged` callback — does not throw
  // before that row is ever reached.
  const store = createClientStore();
  const pilotSession = { id: "session-1", store: createClientStore(), flow: fakeFlow() };
  const output = render(BotManager as never, {
    props: { store, flow: fakeFlow(), sessions: [pilotSession] },
  } as never);
  const text = visibleText(output.body);
  assert.match(text, /Bot manager/i);
  assert.match(text, /Loading pilots/i);
});

test("the panel offers a search box", () => {
  assert.match(renderPanel(), /type="search"/);
});

test("region C (recent runs) heading is present", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /Recent runs/i);
});

test("region C shows the not-durable caveat", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /remembered only until the server restarts/i);
});

test("region C reads as loading on first mount, never as 'nothing has finished yet'", () => {
  // Same fetch as region A (`serverBots`) — the SSR harness never runs
  // onMount, so this must not guess an empty history before it knows.
  const text = visibleText(renderPanel());
  assert.match(text, /Loading recent runs/i);
  assert.doesNotMatch(text, /Nothing has finished yet/i);
});

test("no raw numeric id reaches the page (R7d)", () => {
  const text = visibleText(renderPanel());
  // Author account ids are the id most likely to leak here, since the row
  // carries one right next to the name it is allowed to show.
  assert.doesNotMatch(text, /\b\d{4,}\b/);
});

test("the R7d sweep would actually catch a leak", () => {
  // Guards the assertion above against being vacuously true: if the matcher
  // could not spot an id in rendered text, the test above would pass forever.
  const leaked = visibleText("<td>Saved by</td><td>424242</td>");
  assert.match(leaked, /\b\d{4,}\b/);
});

// --- the one door onto bots -------------------------------------------------
//
// The Bot Builder has no launcher entry any more: it is reached from this
// panel. That makes the ways in from here load-bearing rather than convenient,
// so they get their own tests.

test("the panel offers a way to write a bot that does not exist yet", () => {
  const text = visibleText(renderPanel());
  assert.match(text, /New bot/i);
});

test("the Manager is the door onto BOTH panels that left the rail", () => {
  // `botBuilder` and `bots` are both `launchable: false` now, so the rail cannot
  // reach either. This panel is the only way in, and each door answers a
  // different question: "write or change a bot" (the Builder) and "set up one of
  // the built-ins on this pilot" (Bots). If either opener is lost or retargeted,
  // that panel becomes unreachable and nothing else in the app will say so.
  const source = readFileSync(new URL("./BotManager.svelte", import.meta.url), "utf8");
  const opened = new Set([...source.matchAll(/onOpen\?\.\("([a-zA-Z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...opened].sort(), ["botBuilder", "bots"]);
});

test("setting up a built-in names THIS ROW'S pilot, not whoever is active", () => {
  // ⚠ THE BUG THIS PINS SHOWS THE WRONG SHIP. The Manager lists every held pilot,
  // but only ONE pilot's workspace is mounted, and the built-in bots panel reads
  // the mounted pilot's fitting, holds and flight status. An unaddressed open
  // would put one pilot's hull under another pilot's name — a requirement
  // checklist about a ship that is not the one named, which a player would act
  // on. Addressing it is what lets App switch pilots first.
  const source = readFileSync(new URL("./BotManager.svelte", import.meta.url), "utf8");
  assert.match(
    source,
    /onOpen\?\.\("bots",\s*session\.id\)/,
    "opening the built-in bots panel must name the row's own session",
  );
});
test("the empty library points at the button, not at a launcher entry that is gone", () => {
  // ⚠ The regression this guards is a dead end, not a typo. The old copy read
  // "Build one in the Bot Builder", which was a direction to a rail entry that
  // no longer exists — so a player with no saved bots was told to go somewhere
  // unreachable.
  const source = readFileSync(new URL("./BotManager.svelte", import.meta.url), "utf8");
  const empty = source.match(/No bots saved yet.*?<\/p>/s);
  assert.ok(empty, "the empty-library message is gone");
  assert.doesNotMatch(empty[0], /in the Bot Builder/i);
  assert.match(empty[0], /New bot/);
});
