"use strict";

// D1 — the library store, exercised against a throwaway temp directory so the
// real data/ is never touched. Global visibility, authorship, quotas, size,
// the optimistic revision, and the old-shape migration are the load-bearing
// behaviours.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createBotScriptStore, MAX_SCRIPTS_TOTAL, MAX_DOC_BYTES, MAX_NAME_LEN, STORE_FILENAME } = require("./botScriptStore");

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "botstore-"));
  let n = 0;
  let clock = 0;
  const store = createBotScriptStore({
    dataDir,
    uuid: () => `uuid-${(n += 1)}`,
    now: () => `2026-07-23T00:00:${String((clock += 1)).padStart(2, "0")}.000Z`,
  });
  return { store, dataDir };
}

// Obviously synthetic account ids/names — not real EVE account/character data.
const ALICE = 1001;
const BOB = 2002;
const ALICE_NAME = "alice-test-pilot";
const BOB_NAME = "bob-test-pilot";

function doc(name) {
  return { format: "evejs-bot-script", version: 1, name, program: [] };
}

test("a script created by one account is visible to list() and get() with no account argument", () => {
  const { store } = tempStore();
  const { scriptID, rev } = store.create(ALICE, ALICE_NAME, doc("Belt runner"));
  assert.equal(rev, 1);

  const got = store.get(scriptID);
  assert.ok(got);
  assert.equal(got.doc.name, "Belt runner");
  assert.equal(got.name, "Belt runner");

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].scriptID, scriptID);
  assert.equal(listed[0].bytes > 0, true);
  assert.equal(listed[0].doc, undefined, "list returns metadata only, never the doc");

  // A second, unrelated account sees it too — visibility is global now.
  assert.equal(store.list().length, 1);
  assert.equal(store.get(scriptID).doc.name, "Belt runner");
});

test("create records authorAccountID; meta exposes it", () => {
  const { store } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("Mine and haul"));

  const record = store.get(scriptID);
  assert.equal(record.authorAccountID, ALICE);
  assert.equal(record.accountID, undefined);

  const [entry] = store.list();
  assert.equal(entry.authorAccountID, ALICE);
});

test("authorName is recorded at create time and exposed via list() and get()", () => {
  const { store } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("Named"));

  assert.equal(store.get(scriptID).authorName, ALICE_NAME);
  const [entry] = store.list();
  assert.equal(entry.authorName, ALICE_NAME);
});

test("a blank or missing authorName is stored as null, not the empty string", () => {
  const { store } = tempStore();
  const { scriptID: blankID } = store.create(ALICE, "   ", doc("Blank name"));
  const { scriptID: missingID } = store.create(ALICE, undefined, doc("Missing name"));

  assert.equal(store.get(blankID).authorName, null);
  assert.equal(store.list().find((m) => m.scriptID === blankID).authorName, null);
  assert.equal(store.get(missingID).authorName, null);
});

test("an over-long authorName is capped the same way doc names are", () => {
  const { store } = tempStore();
  const longName = "x".repeat(MAX_NAME_LEN + 20);
  const { scriptID } = store.create(ALICE, longName, doc("Capped"));

  const record = store.get(scriptID);
  assert.equal(record.authorName, longName.slice(0, MAX_NAME_LEN));
  assert.equal(record.authorName.length, MAX_NAME_LEN);
});

test("update() never changes authorAccountID or authorName, even when a different account edits", () => {
  const { store } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("v1"));

  // BOB edits Alice's script — the store has no per-edit authority check
  // (that lives elsewhere); authorship must still stay with Alice.
  store.update(scriptID, doc("v2, edited by someone else"), 1);

  const record = store.get(scriptID);
  assert.equal(record.authorAccountID, ALICE);
  assert.equal(record.authorName, ALICE_NAME);
});

test("update bumps the revision; a stale baseRev conflicts", () => {
  const { store } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("v1"));
  const { rev } = store.update(scriptID, doc("v2"), 1);
  assert.equal(rev, 2);
  assert.equal(store.get(scriptID).doc.name, "v2");

  assert.throws(() => store.update(scriptID, doc("v3"), 1), (e) => e.code === "SCRIPT_REV_CONFLICT");
  assert.throws(
    () => store.update(scriptID, doc("v3"), 1),
    /changed in another tab/i,
    "the player-facing conflict sentence stays byte-identical",
  );
});

test("update on a missing script fails with BOTSCRIPT_NOT_FOUND", () => {
  const { store } = tempStore();
  assert.throws(
    () => store.update("does-not-exist", doc("ghost"), 1),
    (e) => e.code === "BOTSCRIPT_NOT_FOUND" && /could not be found/i.test(e.message),
  );
});

test("the 200-script total quota is enforced across different author accounts", () => {
  const { store } = tempStore();
  for (let i = 0; i < MAX_SCRIPTS_TOTAL; i += 1) {
    // Alternate authors so the quota is clearly counted platform-wide, not per author.
    store.create(i % 2 === 0 ? ALICE : BOB, i % 2 === 0 ? ALICE_NAME : BOB_NAME, doc(`bot ${i}`));
  }
  assert.equal(store.list().length, MAX_SCRIPTS_TOTAL);
  assert.throws(() => store.create(ALICE, ALICE_NAME, doc("one too many")), (e) => e.code === "BOTSCRIPT_LIMIT_REACHED");
  // The quota is global: a different author is blocked too, once the file is full.
  assert.throws(() => store.create(BOB, BOB_NAME, doc("also blocked")), (e) => e.code === "BOTSCRIPT_LIMIT_REACHED");
});

test("an oversized document is refused", () => {
  const { store } = tempStore();
  const big = { format: "evejs-bot-script", version: 1, name: "huge", blob: "y".repeat(MAX_DOC_BYTES) };
  assert.throws(() => store.create(ALICE, ALICE_NAME, big), (e) => e.code === "BOTSCRIPT_TOO_BIG");
});

test("non-object docs are refused", () => {
  const { store } = tempStore();
  assert.throws(() => store.create(ALICE, ALICE_NAME, null), (e) => e.code === "BOTSCRIPT_INVALID");
  assert.throws(() => store.create(ALICE, ALICE_NAME, [1, 2, 3]), (e) => e.code === "BOTSCRIPT_INVALID");
});

test("remove returns true then false", () => {
  const { store } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("temp"));
  assert.equal(store.remove(scriptID), true);
  assert.equal(store.get(scriptID), null);
  assert.equal(store.remove(scriptID), false, "removing again is a no-op");
});

test("data survives a fresh store instance over the same directory", () => {
  const { store, dataDir } = tempStore();
  const { scriptID } = store.create(ALICE, ALICE_NAME, doc("persisted"));
  const reopened = createBotScriptStore({ dataDir });
  assert.equal(reopened.get(scriptID).doc.name, "persisted");
});

test("migration: old per-account records get authorAccountID and stay stable on repeat reads", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "botstore-migrate-"));
  const oldShape = {
    scripts: {
      "old-1": {
        scriptID: "old-1",
        accountID: ALICE,
        rev: 3,
        name: "Legacy hauler",
        bytes: 42,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        doc: doc("Legacy hauler"),
      },
      "old-2": {
        scriptID: "old-2",
        accountID: BOB,
        rev: 1,
        name: "Legacy miner",
        bytes: 42,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        doc: doc("Legacy miner"),
      },
    },
  };
  fs.writeFileSync(path.join(dataDir, STORE_FILENAME), JSON.stringify(oldShape, null, 2), "utf8");
  const fileBefore = fs.readFileSync(path.join(dataDir, STORE_FILENAME), "utf8");

  const store = createBotScriptStore({ dataDir });

  const listed = store.list();
  assert.equal(listed.length, 2);
  const byID = Object.fromEntries(listed.map((m) => [m.scriptID, m]));
  assert.equal(byID["old-1"].authorAccountID, ALICE);
  assert.equal(byID["old-2"].authorAccountID, BOB);

  const got = store.get("old-1");
  assert.equal(got.authorAccountID, ALICE);
  assert.equal(got.accountID, undefined);
  assert.equal(got.authorName, null, "an old-shape record with no authorName reads back as null, not undefined");
  assert.equal(byID["old-1"].authorName, null);

  // A GET/LIST must not itself write — the file on disk is untouched.
  const fileAfter = fs.readFileSync(path.join(dataDir, STORE_FILENAME), "utf8");
  assert.equal(fileAfter, fileBefore, "reading must not write to disk");

  // Reading twice more is stable (idempotent) and produces the same result.
  const again = store.get("old-1");
  assert.equal(again.authorAccountID, ALICE);
  assert.equal(again.accountID, undefined);
  assert.equal(again.authorName, null);
  assert.equal(store.list().length, 2);

  // A write after migration persists the new shape.
  store.update("old-1", doc("Legacy hauler v2"), 3);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, STORE_FILENAME), "utf8"));
  assert.equal(persisted.scripts["old-1"].authorAccountID, ALICE);
  assert.equal(persisted.scripts["old-1"].accountID, undefined);
});
