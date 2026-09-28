import test from "node:test";
import assert from "node:assert/strict";

import { runApprovalPrompt, startHere, startOnServer, type LocalStartDeps, type ServerStartDeps } from "./startRun.ts";
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
