// The Bot Manager -> Bot Builder handoff: the request, and what the builder
// does with it. Pure; no DOM.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createBuilderTarget,
  decideHandoff,
  isStillSaved,
  libraryChanged,
  noteLibraryChanged,
  waitingSentence,
  wantedLabel,
  type BuilderRequest,
} from "./builderTarget.ts";

test("a request waits until it is served, then is gone", () => {
  const target = createBuilderTarget();
  assert.equal(target.pending.get(), null);

  target.ask("bot-a");
  const first = target.pending.get();
  assert.ok(first !== null);
  assert.equal(first.scriptID, "bot-a");

  target.served(first.n);
  assert.equal(target.pending.get(), null, "a served request must not still be waiting");
});

test("serving an OLD request never clears a newer one", () => {
  // The builder is loading bot A from the server when the player asks for B.
  // Clearing by identity rather than by number would drop B unserved.
  const target = createBuilderTarget();
  target.ask("bot-a");
  const first = target.pending.get() as BuilderRequest;
  target.ask("bot-b");
  target.served(first.n);
  const still = target.pending.get();
  assert.ok(still !== null && still.scriptID === "bot-b", "the newer request was thrown away");
});

test("a remount finds nothing to replay, which is why edits survive being put away", () => {
  const target = createBuilderTarget();
  target.ask("bot-a");
  target.served((target.pending.get() as BuilderRequest).n);
  // A minimized window is unmounted; the builder mounts again and asks what is
  // pending. Nothing is, so the draft it was holding is not reloaded over.
  assert.equal(target.pending.get(), null);
});

test("New bot asks for a null script, not for an empty string", () => {
  const target = createBuilderTarget();
  target.ask(null);
  assert.equal((target.pending.get() as BuilderRequest).scriptID, null);
});

test("a clean builder just loads what it was asked for", () => {
  assert.deepEqual(decideHandoff({ scriptID: "bot-b", n: 1 }, { currentID: "bot-a", dirty: false }), {
    kind: "load",
    scriptID: "bot-b",
  });
  assert.deepEqual(decideHandoff({ scriptID: null, n: 1 }, { currentID: "bot-a", dirty: false }), {
    kind: "load",
    scriptID: null,
  });
  assert.deepEqual(decideHandoff({ scriptID: "bot-b", n: 1 }, { currentID: null, dirty: false }), {
    kind: "load",
    scriptID: "bot-b",
  });
});

test("Edit on the bot already open, with edits in flight, does not re-read over them", () => {
  assert.deepEqual(decideHandoff({ scriptID: "bot-a", n: 1 }, { currentID: "bot-a", dirty: true }), {
    kind: "ignore",
  });
});

test("Edit on the bot already open reloads it when nothing would be lost", () => {
  // The library is shared, so a clean reload is how another account's save
  // arrives here.
  assert.deepEqual(decideHandoff({ scriptID: "bot-a", n: 1 }, { currentID: "bot-a", dirty: false }), {
    kind: "load",
    scriptID: "bot-a",
  });
});

test("unsaved changes to ANOTHER bot are never discarded to serve a request", () => {
  assert.deepEqual(decideHandoff({ scriptID: "bot-b", n: 1 }, { currentID: "bot-a", dirty: true }), {
    kind: "wait",
    scriptID: "bot-b",
  });
  // An unsaved draft that has never been saved has no id, and is exactly the
  // draft most worth not losing: there is no copy of it anywhere.
  assert.deepEqual(decideHandoff({ scriptID: "bot-b", n: 1 }, { currentID: null, dirty: true }), {
    kind: "wait",
    scriptID: "bot-b",
  });
  assert.deepEqual(decideHandoff({ scriptID: null, n: 1 }, { currentID: null, dirty: true }), {
    kind: "wait",
    scriptID: null,
  });
});

test("the waiting sentence names what is kept and what is waiting", () => {
  const said = waitingSentence("Mining day", wantedLabel("bot-b", "Fleet medic"));
  assert.match(said, /Mining day/);
  assert.match(said, /Fleet medic/);
  assert.match(said, /unsaved changes/i);
  // Both exits are named: saving completes the handoff, discarding is offered.
  assert.match(said, /Save/);
  assert.match(said, /discard/i);
});

test("an unnamed draft still reads as a sentence", () => {
  const said = waitingSentence("   ", wantedLabel(null, null));
  assert.match(said, /this bot/);
  assert.match(said, /a new bot/);
  assert.doesNotMatch(said, /“”/, "an empty name left empty quotes on screen");
});

test("a new bot is never described as a nameless saved one, nor the reverse", () => {
  assert.equal(wantedLabel(null, null), "a new bot");
  assert.equal(wantedLabel(null, "ignored"), "a new bot");
  // The library has not answered yet: it is still a saved bot, not a new one.
  assert.equal(wantedLabel("bot-b", null), "the bot you chose");
  assert.equal(wantedLabel("bot-b", "   "), "the bot you chose");
  assert.equal(wantedLabel("bot-b", "Fleet medic"), "“Fleet medic”");
});

test("a save says the library changed, and a reader can tell new from seen", () => {
  // The Bot Manager's library does not poll: a save in the builder is the only
  // thing that can tell it to look again.
  const before = libraryChanged.get();
  noteLibraryChanged();
  assert.equal(libraryChanged.get(), before + 1);
  noteLibraryChanged();
  assert.equal(libraryChanged.get(), before + 2, "two saves must be two changes, not one");
});

test("a reader seeded at mount does not read the library twice for one open", () => {
  // A panel mounting seeds its mark from the current count, so its first
  // effect run has nothing to serve — its own onMount fetch is the read.
  const seeded = libraryChanged.get();
  assert.equal(libraryChanged.get(), seeded, "mounting alone must not look like a change");
  noteLibraryChanged();
  assert.notEqual(libraryChanged.get(), seeded);
});

test("the bot open in the builder is noticed when it leaves the library", () => {
  const rows = [{ scriptID: "bot-a" }, { scriptID: "bot-b" }];
  assert.equal(isStillSaved("bot-a", rows), true);
  assert.equal(isStillSaved("bot-c", rows), false, "a deleted bot must not still count as saved");
  // A draft that was never saved has not been deleted — there was no row.
  assert.equal(isStillSaved(null, rows), true);
  assert.equal(isStillSaved(null, []), true);
});

test("an empty list from a FAILED read would condemn every open bot", () => {
  // Pinning the caller's obligation: this predicate cannot tell "the library is
  // empty" from "the read failed and the list was emptied", so the builder only
  // asks it on the success path. If that ever changes, this is the cost.
  assert.equal(isStillSaved("bot-a", []), false);
});
