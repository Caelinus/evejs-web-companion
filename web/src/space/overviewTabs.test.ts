import test from "node:test";
import assert from "node:assert/strict";

const freshModule = async (tag: string): Promise<typeof import("./overviewTabs.ts")> =>
  import(`./overviewTabs.ts?${tag}`);

test("creating after reload keeps stored tab IDs distinct when the clock suffix repeats", async (t) => {
  const storage = new Map<string, string>();
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  t.after(() => { (globalThis as { localStorage?: unknown }).localStorage = previous; });
  let now = 1_700_000_123_456;
  t.mock.method(Date, "now", () => now);

  const first = await freshModule("stored-clock-first");
  const original = first.overviewTabs.tabs.get()[1];
  assert.ok(original);
  const originalIDs = first.overviewTabs.tabs.get().map(tab => tab.id);

  // The module counter restarts on reload; the timestamp suffix repeats every
  // 1,000,000 ms. Both values therefore have to account for persisted IDs.
  now += 1_000_000;
  const fresh = await freshModule("stored-clock-reloaded");
  const bar = fresh.overviewTabs;
  const created = bar.create("travel", "New Route");
  assert.equal(originalIDs.includes(created.id), false, "the new tab reused a stored hidden-state key");
  assert.equal(new Set(bar.tabs.get().map(tab => tab.id)).size, bar.tabs.get().length);
  assert.equal(bar.selected.get().name, "New Route");
  bar.remove(created.id);
  assert.deepEqual(bar.tabs.get().map(tab => tab.id), originalIDs, "deleting the new tab also deleted a saved tab");
  assert.equal(bar.tabs.get().find(tab => tab.id === original.id)?.name, original.name);
});
