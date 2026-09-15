// SSR render checks for ONE group row in the Bot Manager.
//
// WHY THIS FILE EXISTS SEPARATELY FROM botManagerPanel.test.ts, for the same
// reason botManagerPilotRow.test.ts does: the panel's roster load is in
// `onMount`, which SSR never runs, so rendering the PANEL never reaches a row.
// The controls here start real bots on several real ships at once, which is
// exactly the kind of button that should not be reachable only through a path
// nothing renders.
//
// No test-only seam is needed: the row takes everything it renders as props,
// and the store reads it does make are plain `.get()`s on a fresh client store.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { COMPANIONS_GROUP_ID } = await import("../bots/pilotGroups.ts");
const GroupRow = (await import("./BotManagerGroupRow.svelte")).default;

// ESI's own published example CharacterID — documented, obviously synthetic.
const PILOT_A = 90000001;
const PILOT_B = 90000002;

const SCRIPTS = [
  {
    scriptID: "script-1",
    name: "Sample belt loop",
    rev: 1,
    updatedAt: "2026-09-02T12:00:00.000Z",
    authorAccountID: 424242,
    authorName: "Test Pilot One",
  },
];

const NAMES: Record<number, string> = {
  [PILOT_A]: "Test Pilot One",
  [PILOT_B]: "Test Pilot Two",
};

function squadGroup(members: readonly number[] = [PILOT_A, PILOT_B]): unknown {
  return { id: "squad-1", name: "Mining Op", color: "#52d9a3", kind: "squad", members };
}

function companionsGroup(members: readonly number[] = [PILOT_A]): unknown {
  return { id: COMPANIONS_GROUP_ID, name: "Companions", color: null, kind: "companions", members };
}

function renderRow(props: Record<string, unknown>): string {
  const output = render(GroupRow as never, {
    props: {
      scripts: SCRIPTS,
      sessions: [],
      serverBots: [],
      flow: new Proxy({}, { get: () => async () => ({}) }),
      companionSetups: new Map(),
      nameOf: (characterID: number) => NAMES[characterID] ?? null,
      onChanged: () => {},
      ...props,
    },
  } as never);
  return output.body;
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("a squad row names the group and counts its pilots", () => {
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Mining Op/);
  assert.match(text, /2 pilots/);
  // Nobody is flying anything and nothing here holds them, so both are free.
  assert.match(text, /2 free/);
});

test("NO RAW ID REACHES THE PAGE — members are named (R7d)", () => {
  const body = renderRow({ group: squadGroup() });
  assert.match(visibleText(body), /Test Pilot One/);
  assert.doesNotMatch(visibleText(body), new RegExp(String(PILOT_A)));
});

test("a squad row offers the saved library, and says why the built-ins are absent", () => {
  // ⚠ THE ABSENCE IS DELIBERATE AND HAS TO READ AS SUCH. A built-in is set up
  // against one pilot's own ship; in a group list it would be a choice with no
  // button under it.
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Sample belt loop/);
  assert.match(text, /Built-in bots/i);
  assert.match(text, /that pilot's row/i);
});

test("THE COMPANIONS ROW HAS NO BOT PICKER — its bot is what it is", () => {
  const text = visibleText(renderRow({ group: companionsGroup() }));
  assert.match(text, /Companions/);
  assert.match(text, /Always flies the fleet companion/i);
  assert.doesNotMatch(text, /Choose a bot/);
  assert.doesNotMatch(text, /Sample belt loop/);
});

test("the Companions row sends in-tab companions to the window that owns them", () => {
  // An op is watched and stopped in the Fleet companions window; a second,
  // weaker door onto it here would split one operation across two windows.
  const text = visibleText(renderRow({ group: companionsGroup() }));
  assert.match(text, /Companions window/);
  assert.doesNotMatch(text, /Run here/);
});

test("an empty group says where to go and fill it, rather than showing dead controls", () => {
  const squad = visibleText(renderRow({ group: squadGroup([]) }));
  assert.match(squad, /Pilot Hangar/);
  assert.doesNotMatch(squad, /Choose a bot/);

  const companions = visibleText(renderRow({ group: companionsGroup([]) }));
  assert.match(companions, /Pilot Hangar/);
  assert.match(companions, /companion/i);
});

test("'Run here' is present but says it can reach nobody when no tab is open", () => {
  // ⚠ A DISABLED BUTTON WITH NO SENTENCE BESIDE IT READS AS BROKEN.
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Run here/);
  assert.match(text, /No pilot in this group has a tab open here/);
});

test("a member the server is already flying is counted as flying, not as free", () => {
  const serverBots = [
    {
      botID: "bot-1",
      characterID: PILOT_A,
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
      kind: "script",
      companion: null,
    },
  ];
  const text = visibleText(renderRow({ group: squadGroup(), serverBots }));
  assert.match(text, /1 already flying/);
  assert.match(text, /1 free/);
  // And it says WHAT is flying it, beside the pilot's name.
  assert.match(text, /Test Pilot One \(Sample belt loop\)/);
});

test("a row with a held session still renders — the store reads are plain gets", () => {
  // The row reads other pilots' stores directly rather than through `$store`
  // sugar; a fresh store must not throw on the server.
  const session = {
    id: "session-under-test",
    store: createClientStore(),
    flow: new Proxy({}, { get: () => async () => ({}) }),
  };
  const text = visibleText(renderRow({ group: squadGroup(), sessions: [session] }));
  assert.match(text, /Mining Op/);
});

test("the server start says plainly that it outlives the tab", () => {
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Run on server/);
  assert.match(text, /Keeps flying if this tab closes/);
});
