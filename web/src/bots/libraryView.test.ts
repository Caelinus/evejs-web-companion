import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_BOTS,
  categoryLabel,
  deleteCategoryPrompt,
  filterLibrary,
  lastSavedPhrase,
  libraryView,
  liveShelf,
  onShelf,
  savedByLabel,
  shelfCounts,
} from "./libraryView.ts";
import type { BotCategory, BotScriptSummary } from "../app/api.ts";

function row(over: Partial<BotScriptSummary> = {}): BotScriptSummary {
  return {
    scriptID: "script-1",
    name: "Sample belt loop",
    rev: 1,
    updatedAt: "2026-09-02T12:00:00.000Z",
    authorAccountID: 424242,
    authorName: "Test Pilot One",
    categoryID: null,
    ...over,
  };
}

// ─── saved-by ────────────────────────────────────────────────────────────────

test("saved by shows the author's name", () => {
  assert.equal(savedByLabel(row()), "Test Pilot One");
});

test("a bot saved before authorship was recorded shows an em-dash, not a blank", () => {
  assert.equal(savedByLabel(row({ authorName: null })), "—");
  assert.equal(savedByLabel(row({ authorName: "   " })), "—");
});

// ─── filtering ───────────────────────────────────────────────────────────────

test("an empty or whitespace query matches everything", () => {
  const rows = [row(), row({ scriptID: "script-2", name: "Ratting night" })];
  assert.equal(filterLibrary(rows, "").length, 2);
  assert.equal(filterLibrary(rows, "   ").length, 2);
});

test("search matches the bot name, case-insensitively", () => {
  const rows = [row({ name: "Mining day" }), row({ scriptID: "script-2", name: "Ratting night" })];
  assert.deepEqual(
    filterLibrary(rows, "MINING").map((r) => r.name),
    ["Mining day"],
  );
});

test("search also matches the author, so 'who saved these' is one search", () => {
  const rows = [
    row({ name: "Mining day", authorName: "Test Pilot One" }),
    row({ scriptID: "script-2", name: "Ratting night", authorName: "Second Tester" }),
  ];
  assert.deepEqual(
    filterLibrary(rows, "second").map((r) => r.name),
    ["Ratting night"],
  );
});

test("a bot with no author is not matched by an author search, and does not throw", () => {
  const rows = [row({ authorName: null })];
  assert.equal(filterLibrary(rows, "pilot").length, 0);
});

// ─── last saved ──────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

test("last saved reads in plain words at each scale", () => {
  assert.equal(lastSavedPhrase("2026-09-02T11:59:30.000Z", NOW), "just now");
  assert.equal(lastSavedPhrase("2026-09-02T11:59:00.000Z", NOW), "1 minute ago");
  assert.equal(lastSavedPhrase("2026-09-02T11:30:00.000Z", NOW), "30 minutes ago");
  assert.equal(lastSavedPhrase("2026-09-02T09:00:00.000Z", NOW), "3 hours ago");
  assert.equal(lastSavedPhrase("2026-08-30T12:00:00.000Z", NOW), "3 days ago");
});

test("an unreadable timestamp says unknown rather than rendering NaN", () => {
  assert.equal(lastSavedPhrase("not a date", NOW), "unknown");
});

test("a clock skewed into the future never renders a negative age", () => {
  assert.equal(lastSavedPhrase("2026-09-02T12:05:00.000Z", NOW), "just now");
});

// ─── the three honest states ─────────────────────────────────────────────────

test("before the first read finishes the list is loading, not empty", () => {
  assert.deepEqual(libraryView(false, null, [], ""), { kind: "loading" });
});

test("A FAILED READ IS NEVER 'no bots saved'", () => {
  // The whole point of the state machine: a player whose server blinked must
  // not be told their library is gone.
  const view = libraryView(true, "Could not load the bot library.", [], "");
  assert.equal(view.kind, "error");
});

test("an error wins even when rows are already on screen", () => {
  const view = libraryView(true, "Could not load the bot library.", [row()], "");
  assert.equal(view.kind, "error");
});

test("a genuinely empty library reads as empty", () => {
  assert.deepEqual(libraryView(true, null, [], ""), { kind: "empty" });
});

test("a search that matches nothing is distinct from an empty library", () => {
  const view = libraryView(true, null, [row({ name: "Mining day" })], "zzz");
  assert.equal(view.kind, "no-matches");
});

test("rows come back filtered", () => {
  const rows = [row({ name: "Mining day" }), row({ scriptID: "script-2", name: "Ratting night" })];
  const view = libraryView(true, null, rows, "ratting");
  assert.equal(view.kind, "rows");
  assert.deepEqual(view.kind === "rows" ? view.rows.map((r) => r.name) : [], ["Ratting night"]);
});

// ─── categories ──────────────────────────────────────────────────────────────

const MINING: BotCategory = { categoryID: "cat-mining", name: "Mining" };
const RATTING: BotCategory = { categoryID: "cat-ratting", name: "Ratting" };
const CATEGORIES = [MINING, RATTING];

function shelfRows(): BotScriptSummary[] {
  return [
    row({ scriptID: "a", name: "Belt miner", categoryID: MINING.categoryID }),
    row({ scriptID: "b", name: "Anomaly miner", categoryID: MINING.categoryID }),
    row({ scriptID: "c", name: "Night ratter", categoryID: RATTING.categoryID }),
    row({ scriptID: "d", name: "Move items", categoryID: null }),
    row({ scriptID: "e", name: "Orphan", categoryID: "cat-deleted" }),
  ];
}

test("onShelf: All is everything, a category is its bots, Uncategorized is the rest", () => {
  const rows = shelfRows();
  const ids = (shelf: Parameters<typeof onShelf>[2]) => onShelf(rows, CATEGORIES, shelf).map((r) => r.scriptID);
  assert.deepEqual(ids(ALL_BOTS), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids({ kind: "category", categoryID: MINING.categoryID }), ["a", "b"]);
  assert.deepEqual(ids({ kind: "uncategorized" }), ["d", "e"], "a bot in a deleted category is Uncategorized");
});

test("shelfCounts counts every bot exactly once", () => {
  const counts = shelfCounts(shelfRows(), CATEGORIES);
  assert.equal(counts.byCategory.get(MINING.categoryID), 2);
  assert.equal(counts.byCategory.get(RATTING.categoryID), 1);
  assert.equal(counts.uncategorized, 2);
  const total = [...counts.byCategory.values()].reduce((sum, n) => sum + n, 0) + counts.uncategorized;
  assert.equal(total, shelfRows().length);
});

test("an empty category has a count of zero, not no count", () => {
  const counts = shelfCounts([], CATEGORIES);
  assert.equal(counts.byCategory.get(RATTING.categoryID), 0);
});

test("liveShelf falls back to All when the selected category is gone", () => {
  const gone = { kind: "category", categoryID: "cat-deleted" } as const;
  assert.equal(liveShelf(gone, CATEGORIES).kind, "all");
  const here = { kind: "category", categoryID: MINING.categoryID } as const;
  assert.equal(liveShelf(here, CATEGORIES), here);
});

test("an empty category is its own state, not 'no bots saved'", () => {
  const rows = [row({ categoryID: MINING.categoryID })];
  assert.equal(libraryView(true, null, rows, "", CATEGORIES, { kind: "category", categoryID: RATTING.categoryID }).kind, "empty-shelf");
  assert.equal(libraryView(true, null, [], "", CATEGORIES, { kind: "category", categoryID: RATTING.categoryID }).kind, "empty");
});

test("search runs inside the selected category", () => {
  const view = libraryView(true, null, shelfRows(), "miner", CATEGORIES, { kind: "category", categoryID: MINING.categoryID });
  assert.deepEqual(view.kind === "rows" ? view.rows.map((r) => r.scriptID) : [], ["a", "b"]);
  const none = libraryView(true, null, shelfRows(), "ratter", CATEGORIES, { kind: "category", categoryID: MINING.categoryID });
  assert.equal(none.kind, "no-matches");
});

test("the delete-category prompt says the bots are kept", () => {
  assert.match(deleteCategoryPrompt("Mining", 2), /2 bots move to Uncategorized; no bot is deleted/);
  assert.match(deleteCategoryPrompt("Mining", 1), /1 bot moves to Uncategorized/);
  assert.match(deleteCategoryPrompt("Mining", 0), /holds no bots/);
});

test("a row's category label is its category's name, or Uncategorized", () => {
  const rows = shelfRows();
  assert.equal(categoryLabel(rows[0]!, CATEGORIES), "Mining");
  assert.equal(categoryLabel(rows[3]!, CATEGORIES), "Uncategorized");
  assert.equal(categoryLabel(rows[4]!, CATEGORIES), "Uncategorized", "a deleted category reads as Uncategorized");
});
