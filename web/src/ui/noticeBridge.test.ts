// THE BRIDGE — the half of the notice system that was missing.
//
// ⚠ WHAT THIS IS ACTUALLY GUARDING. `notices.ts` shipped complete and correct —
// a board, dedupe, a cap, two surfaces, sound — and `notify()` had ZERO callers.
// Everything in it passed its tests and none of it ever ran, because a
// notification system with no producers is a display with no input. So the
// claims below are not about the board (notices.test.ts holds those); they are
// about a message getting OUT OF A STORE and INTO IT, which is the part that was
// never there.
//
// Real store, real events, real signal contract — no Svelte, no DOM. The bridge
// is plain TypeScript precisely so this can be that direct.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "../store/clientStore.ts";
import { watchNotices } from "./noticeBridge.ts";
import { NOTICE_SOURCES, messageOf, noticeKey } from "./noticeSources.ts";
import type { NoticeInput } from "./notices.ts";

/** A store plus a list of everything the bridge tried to raise from it. */
function watched(): {
  store: ReturnType<typeof createClientStore>;
  raised: NoticeInput[];
  stop: () => void;
} {
  const store = createClientStore();
  const raised: NoticeInput[] = [];
  const stop = watchNotices(store, (input) => {
    raised.push(input);
    return null;
  });
  return { store, raised, stop };
}

// --- the thing that was missing ---------------------------------------------

test("a refusal raised in a slice reaches the notice board", () => {
  const { store, raised, stop } = watched();
  store.apply({ type: "mining/action-error", message: "The ship is not in space." } as never);
  stop();
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.title, "Mining");
  assert.equal(raised[0]?.detail, "The ship is not in space.");
  assert.equal(raised[0]?.kind, "danger");
});

test("⚠ A SILENT DECLINE IS RAISED TOO, and as a WARNING rather than a danger", () => {
  // The more important of the two. A refusal at least said something; a silent
  // decline is the server accepting a call and then not doing it, which is the
  // failure this client exists to make visible. It is a warning because nothing
  // broke — something simply did not happen.
  const { store, raised, stop } = watched();
  store.apply({ type: "drones/silent-decline", message: "Nothing moved." } as never);
  stop();
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.kind, "warn");
  assert.equal(raised[0]?.title, "Drones");
});

test("every slice in the table is reachable — no source is wired to a name that is gone", () => {
  // ⚠ THE TABLE NAMES SLICES AND FIELDS AS STRINGS, WHICH NO COMPILER CHECKS.
  // The bridge skips a source it cannot find, deliberately, so one renamed slice
  // costs one notice rather than the workspace. That safety is exactly what
  // would let the whole table rot silently, so it is checked here instead.
  const store = createClientStore() as unknown as Record<string, unknown>;
  for (const source of NOTICE_SOURCES) {
    const slice = store[source.slice];
    assert.ok(
      slice && typeof (slice as { subscribe?: unknown }).subscribe === "function",
      `there is no store slice called "${source.slice}"`,
    );
    const value = (slice as { get: () => unknown }).get();
    assert.ok(
      value !== null && typeof value === "object" && source.field in (value as object),
      `"${source.slice}" has no field "${source.field}"`,
    );
  }
});

// --- edge-triggered, which is the whole design ------------------------------

test("⚠ A REFUSAL ALREADY STANDING AT MOUNT IS NOT FLASHED", () => {
  // `subscribe` fires synchronously with the current value, and `actionError`
  // HOLDS the last refusal until something clears it. A level-triggered bridge
  // would therefore throw a message across the screen on every reload, for
  // something the player did before it — and it would look, convincingly, like
  // it had just happened.
  const store = createClientStore();
  store.apply({ type: "mining/action-error", message: "The ship is not in space." } as never);
  const raised: NoticeInput[] = [];
  const stop = watchNotices(store, (input) => {
    raised.push(input);
    return null;
  });
  stop();
  assert.deepEqual(raised, [], "a refusal from before the bridge existed was flashed as new");
});

test("⚠ THE SAME MESSAGE RE-SET BY A POLL IS NOT A SECOND EVENT", () => {
  // Every slice is written wholesale on every poll. Nothing about the store says
  // "this is new" — only the change does.
  const { store, raised, stop } = watched();
  for (let i = 0; i < 5; i += 1) {
    store.apply({ type: "mining/action-error", message: "The ship is not in space." } as never);
  }
  stop();
  assert.equal(raised.length, 1, "a standing refusal was re-flashed by the polling loop");
});

test("a DIFFERENT refusal from the same panel is a second event and is said", () => {
  // The opposite failure, and the more expensive one: swallowing the second of
  // two genuinely different failures because they came from the same place.
  const { store, raised, stop } = watched();
  store.apply({ type: "mining/action-error", message: "The ship is not in space." } as never);
  store.apply({ type: "mining/action-error", message: "The hold is full." } as never);
  stop();
  assert.deepEqual(raised.map((n) => n.detail), ["The ship is not in space.", "The hold is full."]);
});

test("a refusal, cleared, then raised again IS said again", () => {
  // A player fixes what was wrong, tries again, and hits it again. That is two
  // events by any reading, and only the clearing in between distinguishes it
  // from a poll — which is why the null is tracked rather than ignored.
  const { store, raised, stop } = watched();
  store.apply({ type: "mining/action-error", message: "The hold is full." } as never);
  store.apply({ type: "mining/action", action: "start" } as never);
  store.apply({ type: "mining/action-error", message: "The hold is full." } as never);
  stop();
  assert.equal(raised.length, 2);
});

test("clearing a refusal does not itself flash anything", () => {
  const { store, raised, stop } = watched();
  store.apply({ type: "mining/action", action: "start" } as never);
  stop();
  assert.deepEqual(raised, []);
});

// --- two fields on one slice are two independent sources --------------------

test("an action error and a silent decline on the same slice do not mask each other", () => {
  // `mining/action-error` writes one field and leaves the other alone. Watching
  // the SLICE rather than each field would make the second write look like a
  // change to the first.
  const { store, raised, stop } = watched();
  store.apply({ type: "mining/action-error", message: "The hold is full." } as never);
  store.apply({ type: "mining/silent-decline", message: "The laser did not start." } as never);
  stop();
  assert.deepEqual(raised.map((n) => n.kind), ["danger", "warn"]);
  assert.deepEqual(raised.map((n) => n.detail), ["The hold is full.", "The laser did not start."]);
});

// --- teardown ----------------------------------------------------------------

test("⚠ STOPPING THE BRIDGE ACTUALLY STOPS IT", () => {
  // A Workspace is mounted and unmounted as pilots are switched, and every
  // pilot's store stays live in memory. A bridge that outlived its workspace
  // would flash refusals from a pilot you had left, labelled as if they were
  // the one you are flying.
  const { store, raised, stop } = watched();
  stop();
  store.apply({ type: "mining/action-error", message: "The hold is full." } as never);
  assert.deepEqual(raised, [], "the bridge went on reporting after it was stopped");
});

// --- the key, and what an empty message means -------------------------------

test("the dedupe key carries the message, so two failures are not deduped into one", () => {
  const source = { slice: "mining", field: "actionError", kind: "danger", title: "Mining" } as const;
  assert.notEqual(noticeKey(source, "The hold is full."), noticeKey(source, "Not in space."));
  assert.equal(noticeKey(source, "The hold is full."), "mining.actionError:The hold is full.");
});

test("⚠ AN EMPTY MESSAGE IS ABSENT, NOT A NOTICE WITH NO WORDS IN IT", () => {
  assert.equal(messageOf({ actionError: "" }, "actionError"), null);
  assert.equal(messageOf({ actionError: "   " }, "actionError"), null);
  assert.equal(messageOf({ actionError: null }, "actionError"), null);
  assert.equal(messageOf(null, "actionError"), null);
  // A field name that is wrong, or a value that is not a string, comes back
  // silent rather than rendering at a player.
  assert.equal(messageOf({ actionError: { message: "x" } }, "actionError"), null);
  assert.equal(messageOf({ actionError: "The hold is full." }, "nope"), null);
});

test("a message is trimmed, because a flash is one line and leading space shows", () => {
  assert.equal(messageOf({ actionError: "  The hold is full.  " }, "actionError"), "The hold is full.");
});

// --- what is deliberately NOT watched ---------------------------------------

test("⚠ LOAD ERRORS ARE NOT FLASHED — only things that HAPPENED", () => {
  // Half the slices also carry a plain `error`. That is the STATE of a panel
  // you just opened and are looking at, not an event; flashing it would also
  // mean re-flashing every time a retry failed. `mining.holdsError` is the one
  // exception in the table and says why in noticeSources.ts.
  const watchedFields = new Set(NOTICE_SOURCES.map((s) => `${s.slice}.${s.field}`));
  assert.equal(watchedFields.has("space.error"), false);
  assert.equal(watchedFields.has("chat.error"), false);
  assert.equal(watchedFields.has("planets.error"), false);
  assert.equal(watchedFields.has("finder.error"), false);
  assert.ok(watchedFields.has("mining.holdsError"), "the one deliberate load error is missing");
});

test("no source is listed twice, or one event becomes two flashes", () => {
  const keys = NOTICE_SOURCES.map((s) => `${s.slice}.${s.field}`);
  assert.equal(new Set(keys).size, keys.length, "a slice field is watched twice");
});
