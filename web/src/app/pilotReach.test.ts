import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApiOptions, ServerBot } from "./api.ts";
import type { AccountPass } from "./accountPass.ts";
import { createPilotReach, type HeldPilot, type KnownPilot } from "./pilotReach.ts";

function held(characterID: number, token: string): HeldPilot {
  return {
    store: { station: { get: () => ({ online: { characterID } }) } },
    flow: { requestOptions: () => ({ token }) },
  };
}

function stubPass(refuse: ReadonlySet<string> = new Set()) {
  const asked: string[] = [];
  const forgotten: string[] = [];
  const pass: AccountPass = {
    async optionsFor(accountName) {
      asked.push(accountName);
      if (accountName === "" || refuse.has(accountName)) throw new Error("refused");
      return { token: `pass-${accountName}` };
    },
    forget(accountName) {
      forgotten.push(accountName);
    },
    async release() {},
  };
  return { pass, asked, forgotten };
}

const KNOWN: KnownPilot[] = [
  { characterID: 90000001, accountName: "alpha" },
  { characterID: 90000002, accountName: "alpha" },
  { characterID: 90000003, accountName: "beta" },
];

test("a pilot this tab holds rides its own session", async () => {
  const { pass, asked } = stubPass();
  const reach = createPilotReach({
    held: () => [held(90000001, "own")],
    known: () => KNOWN,
    accounts: () => ["alpha", "beta"],
    pass,
  });
  assert.deepEqual(await reach.ownerOptions(90000001), { token: "own" });
  assert.deepEqual(asked, []);
});

test("a pilot nobody here holds is reached as its OWN account, not the held pilot's", async () => {
  const { pass } = stubPass();
  const reach = createPilotReach({
    held: () => [held(90000001, "own")],
    known: () => KNOWN,
    accounts: () => ["alpha", "beta"],
    pass,
  });
  assert.deepEqual(await reach.ownerOptions(90000003), { token: "pass-beta" });
});

test("a pilot with no known account is refused rather than guessed", async () => {
  const { pass } = stubPass();
  const reach = createPilotReach({ held: () => [], known: () => KNOWN, accounts: () => [], pass });
  await assert.rejects(reach.ownerOptions(90000099));
});

test("an account with a held pilot is read with that pilot's session", async () => {
  const { pass, asked } = stubPass();
  const reach = createPilotReach({
    held: () => [held(90000002, "own")],
    known: () => KNOWN,
    accounts: () => ["alpha"],
    pass,
  });
  assert.deepEqual(await reach.accountOptions("alpha"), { token: "own" });
  assert.deepEqual(asked, []);
});

test("the library falls through to the first account that signs in", async () => {
  const { pass } = stubPass(new Set(["alpha"]));
  const reach = createPilotReach({ held: () => [], known: () => KNOWN, accounts: () => ["alpha", "beta"], pass });
  assert.deepEqual(await reach.libraryOptions(), { token: "pass-beta" });
});

test("the library refuses when no account signs in", async () => {
  const { pass } = stubPass(new Set(["alpha"]));
  const reach = createPilotReach({ held: () => [], known: () => KNOWN, accounts: () => ["alpha"], pass });
  await assert.rejects(reach.libraryOptions(), /No account/);
});

function bot(botID: string, characterID: number): ServerBot {
  return { botID, characterID } as unknown as ServerBot;
}

test("the server roster is read from every account and merged", async () => {
  const { pass } = stubPass();
  const calls: ApiOptions[] = [];
  const reach = createPilotReach({
    held: () => [],
    known: () => KNOWN,
    accounts: () => ["alpha", "beta"],
    pass,
    listServerBots: async (options) => {
      calls.push(options);
      return options.token === "pass-alpha" ? [bot("a1", 90000001)] : [bot("b1", 90000003)];
    },
  });
  const read = await reach.readServerBots();
  assert.deepEqual(
    read.bots.map((b) => b.botID),
    ["a1", "b1"],
  );
  assert.deepEqual(read.missing, []);
  assert.equal(read.allFailed, false);
  assert.ok(calls.every((options) => options.priority === "poll"));
});

test("an account that cannot be read is named, and its token forgotten", async () => {
  const { pass, forgotten } = stubPass();
  const reach = createPilotReach({
    held: () => [],
    known: () => KNOWN,
    accounts: () => ["alpha", "beta"],
    pass,
    listServerBots: async (options) => {
      if (options.token === "pass-beta") throw new Error("401");
      return [bot("a1", 90000001)];
    },
  });
  const read = await reach.readServerBots();
  assert.deepEqual(read.missing, ["beta"]);
  assert.equal(read.allFailed, false);
  assert.deepEqual(forgotten, ["beta"]);
});

test("every account failing is an error, not an empty roster", async () => {
  const { pass } = stubPass();
  const reach = createPilotReach({
    held: () => [],
    known: () => KNOWN,
    accounts: () => ["alpha", "beta"],
    pass,
    listServerBots: async () => {
      throw new Error("down");
    },
  });
  const read = await reach.readServerBots();
  assert.equal(read.allFailed, true);
  assert.deepEqual(read.bots, []);
});

test("no accounts at all is an empty roster, not an error", async () => {
  const { pass } = stubPass();
  const reach = createPilotReach({ held: () => [], known: () => [], accounts: () => [], pass });
  const read = await reach.readServerBots();
  assert.equal(read.allFailed, false);
  assert.deepEqual(read.bots, []);
});
