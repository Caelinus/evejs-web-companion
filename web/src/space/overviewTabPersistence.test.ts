import test from "node:test";
import assert from "node:assert/strict";
import type { TabBar } from "./overviewTabs.ts";

const KEY = "evejs-web:overview-tabs:v1";

async function storedBar(seed: unknown[], suffix: string, run: (bar: TabBar, reload: () => TabBar) => void): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const clock = Date.now;
  const values = new Map([[KEY, JSON.stringify(seed)]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  Date.now = () => 1_000_123;
  try {
    // A fresh module represents a browser reload, including its reset ID counter.
    const { createTabBar } = await import(new URL(`./overviewTabs.ts?${suffix}`, import.meta.url).href);
    run(createTabBar(), createTabBar);
  } finally {
    Date.now = clock;
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("creating after a reload cannot collide with a persisted tab at the repeated clock remainder", async () => {
  await storedBar([{ id: "all", name: "All", recipeId: "all", fixed: true },
    { id: "t1-123", name: "System", recipeId: "system", fixed: false }], "collision", bar => {
    const tab = bar.create("mining", "New Mining");
    assert.notEqual(tab.id, "t1-123");
    assert.equal(bar.selected.get().name, "New Mining");
    bar.remove(tab.id);
    assert.deepEqual(bar.tabs.get().map(tab => tab.name), ["All", "System"]);
  });
});

test("the reserved All identity cannot be reused by an editable stored tab", async () => {
  await storedBar([{ id: "all", name: "Pretender", recipeId: "mining", fixed: false },
    { id: "keep", name: "My tab", recipeId: "combat", fixed: false }], "reserved", bar => {
    assert.equal(bar.tabs.get().filter(tab => tab.id === "all").length, 1);
    assert.equal(bar.tabs.get()[0]?.fixed, true);
    assert.equal(bar.tabs.get().some(tab => tab.id === "keep"), true);
  });
});

test("edited recipes and names persist, and name-only rename retains the edited recipe", async () => {
  await storedBar([{ id: "keep", name: "My tab", recipeId: "mining", fixed: false }], "edit", (bar, reload) => {
    bar.rename("keep", "Routes", "travel");
    assert.equal(reload().tabs.get().find(tab => tab.id === "keep")?.recipeId, "travel");
    bar.rename("keep", "");
    const saved = reload().tabs.get().find(tab => tab.id === "keep");
    assert.equal(saved?.name, "Travel");
    assert.equal(saved?.recipeId, "travel");
  });
});
