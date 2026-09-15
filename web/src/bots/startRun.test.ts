import test from "node:test";
import assert from "node:assert/strict";

import {
  runApprovalPrompt,
  startGroupHere,
  startGroupOnServer,
  startHere,
  startOnServer,
  type LocalStartDeps,
  type ServerGroupStartDeps,
  type ServerStartDeps,
} from "./startRun.ts";
import { encodeScriptDoc } from "./scriptCodec.ts";
import type { BotRunPolicy } from "./runPolicy.ts";
import type { BotScript } from "./botScript.ts";

// ESI's own documented example CharacterID — synthetic, never a real pilot.
const CHARACTER_ID = 90000001;

function policy(over: Partial<BotRunPolicy> = {}): BotRunPolicy {
  return {
    macroIDs: [],
    riskClasses: [],
    restartSafe: true,
    restartBlockers: [],
    containsSubBots: false,
    ...over,
  };
}

function minimalDoc(name = "Sample belt loop"): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name,
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [{ id: "n1", kind: "macro", macro: "undock", args: {} }],
  };
}

// ─── runApprovalPrompt wording ──────────────────────────────────────────────

test("no risks reads as the plain no-permissions sentence", () => {
  const text = runApprovalPrompt("Mining loop", policy(), null);
  assert.match(
    text,
    /No spending, destructive, social, fleet, mission, colony, inventory, or combat permission was found\./,
  );
  assert.ok(!text.includes("sub-bots"));
});

test("risks are joined and worded as 'This run may ...'", () => {
  const text = runApprovalPrompt("Ratting bot", policy({ riskClasses: ["combat", "financial"] }), null);
  assert.match(text, /This run may control weapons, drones, or combat modules; spend or commit ISK\./);
});

test("sub-bots add their own sentence", () => {
  const text = runApprovalPrompt("Mission chain", policy({ containsSubBots: true }), null);
  assert.match(
    text,
    /It includes other saved bots, whose current contents will be loaded when it starts\./,
  );
});

test("a runtime limit under an hour is worded in minutes", () => {
  const text = runApprovalPrompt("Server bot", policy(), 45);
  assert.match(text, /The server will stop it after 45 minutes\./);
});

test("a runtime limit of an hour or more is worded in hours", () => {
  const text = runApprovalPrompt("Server bot", policy(), 120);
  assert.match(text, /The server will stop it after 2 hours\./);
});

test("no runtime limit adds no sentence at all", () => {
  const text = runApprovalPrompt("Local bot", policy(), null);
  assert.ok(!text.includes("The server will stop it"));
});

test("the bot name is quoted at the top", () => {
  const text = runApprovalPrompt("My Bot", policy(), null);
  assert.match(text, /^Run “My Bot”\?/);
});

// ─── startHere ──────────────────────────────────────────────────────────────

function localDeps(over: Partial<LocalStartDeps> = {}): LocalStartDeps & {
  calls: { startCustomBot: Array<{ doc: BotScript; scriptID: string }> };
} {
  const calls = { startCustomBot: [] as Array<{ doc: BotScript; scriptID: string }> };
  return {
    calls,
    fetchScript: async (scriptID) => ({
      scriptID,
      rev: 1,
      doc: JSON.parse(encodeScriptDoc(minimalDoc())),
    }),
    confirm: () => true,
    startCustomBot: async (doc, scriptID) => {
      calls.startCustomBot.push({ doc, scriptID });
    },
    ...over,
  };
}

test("declining the confirm starts nothing", async () => {
  const deps = localDeps({ confirm: () => false });
  const outcome = await startHere(deps, "script-1");
  assert.deepEqual(outcome, { kind: "declined" });
  assert.equal(deps.calls.startCustomBot.length, 0);
});

test("a missing script is refused with a sentence", async () => {
  const deps = localDeps({ fetchScript: async () => null });
  const outcome = await startHere(deps, "script-1");
  assert.deepEqual(outcome, { kind: "refused", sentence: "That bot could not be found." });
  assert.equal(deps.calls.startCustomBot.length, 0);
});

test("a codec refusal surfaces the codec's own sentence", async () => {
  const deps = localDeps({ fetchScript: async () => ({ scriptID: "script-1", rev: 1, doc: { not: "a script" } }) });
  const outcome = await startHere(deps, "script-1");
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.kind === "refused" ? outcome.sentence : "", "This script has parts this app does not recognise.");
  assert.equal(deps.calls.startCustomBot.length, 0);
});

test("a successful local start calls startCustomBot with the DECODED doc", async () => {
  const deps = localDeps();
  const outcome = await startHere(deps, "script-1");
  assert.deepEqual(outcome, { kind: "started" });
  assert.equal(deps.calls.startCustomBot.length, 1);
  assert.equal(deps.calls.startCustomBot[0]?.scriptID, "script-1");
  assert.equal(deps.calls.startCustomBot[0]?.doc.name, "Sample belt loop");
  // Decoded, not the raw wire value — a decoded doc round-trips through the
  // codec's own writer identically, which the raw JsonValue is not guaranteed to.
  assert.equal(deps.calls.startCustomBot[0]?.doc.format, "evejs-bot-script");
});

// ─── startOnServer ──────────────────────────────────────────────────────────

function serverDeps(over: Partial<ServerStartDeps> = {}): ServerStartDeps & {
  calls: string[];
  startArgs: { characterID: number; scriptID: string; grant: unknown } | null;
} {
  const calls: string[] = [];
  let startArgs: { characterID: number; scriptID: string; grant: unknown } | null = null;
  return {
    calls,
    get startArgs() {
      return startArgs;
    },
    fetchScript: async (scriptID) => ({
      scriptID,
      rev: 7,
      doc: JSON.parse(encodeScriptDoc(minimalDoc())),
    }),
    confirm: () => true,
    startServerBot: async (characterID, scriptID, grant) => {
      calls.push("start");
      startArgs = { characterID, scriptID, grant };
      return { ok: true };
    },
    releaseSession: async () => {
      calls.push("release");
    },
    ...over,
  } as ServerStartDeps & { calls: string[]; startArgs: { characterID: number; scriptID: string; grant: unknown } | null };
}

test("a successful server start creates the grant from the record's rev and calls startServerBot before releaseSession", async () => {
  const deps = serverDeps();
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.deepEqual(outcome, { kind: "started" });
  assert.deepEqual(deps.calls, ["start", "release"]);
  assert.equal(deps.startArgs?.characterID, CHARACTER_ID);
  assert.equal(deps.startArgs?.scriptID, "script-1");
  assert.deepEqual(deps.startArgs?.grant, {
    scriptRev: 7,
    riskClasses: [],
    maxRuntimeMinutes: 90,
  });
});

test("declining the confirm starts nothing on the server", async () => {
  const deps = serverDeps({ confirm: () => false });
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.deepEqual(outcome, { kind: "declined" });
  assert.deepEqual(deps.calls, []);
});

test("a missing script is refused before any server call", async () => {
  const deps = serverDeps({ fetchScript: async () => null });
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.deepEqual(outcome, { kind: "refused", sentence: "That bot could not be found." });
  assert.deepEqual(deps.calls, []);
});

test("a codec refusal on the server path surfaces the codec's own sentence", async () => {
  const deps = serverDeps({ fetchScript: async () => ({ scriptID: "script-1", rev: 1, doc: { not: "a script" } }) });
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.kind === "refused" ? outcome.sentence : "", "This script has parts this app does not recognise.");
  assert.deepEqual(deps.calls, []);
});

test("a failed startServerBot call is refused and never releases the session", async () => {
  const deps = serverDeps({
    startServerBot: async () => {
      throw new Error("The character is already flying a bot.");
    },
  });
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.deepEqual(outcome, { kind: "refused", sentence: "The character is already flying a bot." });
  assert.deepEqual(deps.calls, []);
});

test("a throwing releaseSession still reports started — the bot has the hull either way", async () => {
  const deps = serverDeps({
    releaseSession: async () => {
      throw new Error("network blip");
    },
  });
  const outcome = await startOnServer(deps, "script-1", CHARACTER_ID, 90);
  assert.deepEqual(outcome, { kind: "started" });
});

// ─── the same two paths, for a GROUP ────────────────────────────────────────

const PILOT_B = 90000002;
const PILOT_C = 90000003;

function groupServerDeps(over: Partial<ServerGroupStartDeps> = {}): ServerGroupStartDeps & {
  fetches: number;
  prompts: string[];
  starts: { characterID: number; scriptID: string; grant: unknown }[];
  released: number[];
} {
  const state = {
    fetches: 0,
    prompts: [] as string[],
    starts: [] as { characterID: number; scriptID: string; grant: unknown }[],
    released: [] as number[],
  };
  return {
    // Getters, not a spread: a spread would copy the counter's VALUE at build
    // time and the test would read 0 for ever. The arrays survive a spread by
    // reference, but mixing the two idioms is how the next helper gets it
    // wrong, so all four are read through the live object.
    get fetches() {
      return state.fetches;
    },
    get prompts() {
      return state.prompts;
    },
    get starts() {
      return state.starts;
    },
    get released() {
      return state.released;
    },
    fetchScript: async (scriptID) => {
      state.fetches += 1;
      return { scriptID, rev: 7, doc: JSON.parse(encodeScriptDoc(minimalDoc())) };
    },
    confirm: (message) => {
      state.prompts.push(message);
      return true;
    },
    startServerBot: async (characterID, scriptID, grant) => {
      state.starts.push({ characterID, scriptID, grant });
      return { ok: true };
    },
    releaseHeld: async (characterID) => {
      state.released.push(characterID);
    },
    ...over,
  } as ServerGroupStartDeps & typeof state;
}

test("ONE APPROVAL AND ONE FETCH FOR THE WHOLE GROUP", async () => {
  // ⚠ SIX CONFIRMS IS NOT SIX TIMES THE CONSENT — it is a dialog that gets
  // clicked through. And re-fetching per pilot would let the library change
  // underneath a run the player agreed to once, so pilot six would fly
  // something nobody approved.
  const deps = groupServerDeps();
  const outcome = await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B, PILOT_C], 90);
  assert.equal(deps.fetches, 1);
  assert.equal(deps.prompts.length, 1);
  assert.equal(outcome.kind, "ran");
  assert.deepEqual(
    deps.starts.map((call) => call.characterID),
    [CHARACTER_ID, PILOT_B, PILOT_C],
  );
});

test("the prompt says how many hulls the one yes commits", async () => {
  const deps = groupServerDeps();
  await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B], 90);
  assert.match(deps.prompts[0]!, /on 2 pilots\?/);
});

test("a single-pilot group keeps the wording every existing caller has", async () => {
  // The one-pilot prompt is already reviewed copy; a group of one must not
  // start saying "on 1 pilots".
  const deps = groupServerDeps();
  await startGroupOnServer(deps, "script-1", [CHARACTER_ID], 90);
  assert.doesNotMatch(deps.prompts[0]!, /on 1 pilot/);
  assert.match(deps.prompts[0]!, /^Run .Sample belt loop.\?/);
});

test("ONE GRANT, THE SAME ONE, FOR EVERY PILOT", async () => {
  // One script means one rev and one set of risk classes. (A companion squad
  // is the opposite case and builds a grant per pilot — see squadStart.ts.)
  const deps = groupServerDeps();
  await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B], 90);
  assert.equal(deps.starts[0]?.grant, deps.starts[1]?.grant);
});

test("one pilot's refusal does not strand the rest, and is carried as its own row", async () => {
  const deps = groupServerDeps({
    startServerBot: async (characterID) => {
      if (characterID === PILOT_B) throw new Error("A web session is flying this character.");
      return { ok: true };
    },
  });
  const outcome = await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B, PILOT_C], 90);
  assert.equal(outcome.kind, "ran");
  const entries = outcome.kind === "ran" ? outcome.entries : [];
  assert.deepEqual(
    entries.map((entry) => entry.state),
    ["started", "refused", "started"],
  );
  assert.equal(entries[1]?.sentence, "A web session is flying this character.");
});

test("declining the confirm starts NOBODY and reports no entries", async () => {
  const deps = groupServerDeps({ confirm: () => false });
  const outcome = await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B], 90);
  assert.deepEqual(outcome, { kind: "declined" });
  assert.deepEqual(deps.starts, []);
});

test("a script that cannot be fetched refuses the whole group before anything starts", async () => {
  const deps = groupServerDeps({ fetchScript: async () => null });
  const outcome = await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B], 90);
  assert.deepEqual(outcome, { kind: "refused", sentence: "That bot could not be found." });
  assert.deepEqual(deps.starts, []);
});

test("each started pilot's tab session is released AFTER its start, never before", async () => {
  const order: string[] = [];
  const deps = groupServerDeps({
    startServerBot: async (characterID) => {
      order.push(`start:${characterID}`);
      return { ok: true };
    },
    releaseHeld: async (characterID) => {
      order.push(`release:${characterID}`);
    },
  });
  await startGroupOnServer(deps, "script-1", [CHARACTER_ID, PILOT_B], 90);
  assert.deepEqual(order, [
    `start:${CHARACTER_ID}`,
    `release:${CHARACTER_ID}`,
    `start:${PILOT_B}`,
    `release:${PILOT_B}`,
  ]);
});

test("a refused start never releases that pilot's session", async () => {
  const deps = groupServerDeps({
    startServerBot: async () => {
      throw new Error("The character is already flying a bot.");
    },
  });
  await startGroupOnServer(deps, "script-1", [CHARACTER_ID], 90);
  assert.deepEqual(deps.released, []);
});

test("a throwing releaseHeld still counts as started — the host has the hull", async () => {
  const deps = groupServerDeps({
    releaseHeld: async () => {
      throw new Error("network blip");
    },
  });
  const outcome = await startGroupOnServer(deps, "script-1", [CHARACTER_ID], 90);
  assert.equal(outcome.kind === "ran" ? outcome.entries[0]?.state : null, "started");
});

test("the tab path starts each member on ITS OWN session, with the decoded doc", async () => {
  // ⚠ ADDRESSED BY CHARACTER. A starter that ran against "the active pilot"
  // would start the same bot on one hull as many times as the group has members.
  const started: { characterID: number; name: string }[] = [];
  const outcome = await startGroupHere(
    {
      fetchScript: async (scriptID) => ({
        scriptID,
        rev: 7,
        doc: JSON.parse(encodeScriptDoc(minimalDoc())),
      }),
      confirm: () => true,
      startCustomBotFor: async (characterID, doc) => {
        started.push({ characterID, name: doc.name });
      },
    },
    "script-1",
    [CHARACTER_ID, PILOT_B],
  );
  assert.equal(outcome.kind, "ran");
  assert.deepEqual(started, [
    { characterID: CHARACTER_ID, name: "Sample belt loop" },
    { characterID: PILOT_B, name: "Sample belt loop" },
  ]);
});

test("the tab path's prompt carries no runtime limit — nothing stops a tab run but the tab", async () => {
  const prompts: string[] = [];
  await startGroupHere(
    {
      fetchScript: async (scriptID) => ({
        scriptID,
        rev: 7,
        doc: JSON.parse(encodeScriptDoc(minimalDoc())),
      }),
      confirm: (message) => {
        prompts.push(message);
        return true;
      },
      startCustomBotFor: async () => {},
    },
    "script-1",
    [CHARACTER_ID, PILOT_B],
  );
  assert.doesNotMatch(prompts[0]!, /The server will stop it after/);
  assert.match(prompts[0]!, /on 2 pilots\?/);
});
