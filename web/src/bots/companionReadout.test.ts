import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canTagWords, inFleetWords, orderFromWords } from "./companionReadout.ts";

test("the chat channel is named LOCAL to the player, never fleet", () => {
  // ⚠ THIS IS A REGRESSION GUARD FOR A STRING THAT SHIPPED WRONG. The panel
  // said "Fleet chat commands" and "a fleet chat command" while `flow.ts` read
  // LOCAL deliberately -- fleet chat is not reachable on this server at all.
  // The operator accepted Local knowingly; what they accepted is that the whole
  // system can read the command. A label saying "fleet" hid exactly that.
  const phrase = orderFromWords("chat");
  assert.match(phrase, /local/i);
  assert.doesNotMatch(phrase, /fleet/i);
});

test("canTag keeps three states, and the unread one is never 'no'", () => {
  // ⚠ THE THIRD STATE IS THE WHOLE POINT. The server drops a non-commander's
  // tag write while answering ok, so a pilot that CANNOT tag looks identical to
  // one with nothing to tag. Flattening "not known" into "no" would report a
  // confident falsehood on every tick before the roster is read.
  //
  // ⚠ AND "THE THREE READ DIFFERENTLY" IS NOT THE ASSERTION. That was the first
  // version of this test and it was VACUOUS: flattening the unread state to
  // "no" still left it distinct from "no - not a fleet commander", so the guard
  // passed over the exact bug it was written to catch. Mutation-tested both
  // ways. What is actually required is that the unread state is NEITHER ANSWER,
  // so that is what is asserted.
  const unread = canTagWords(null);
  assert.doesNotMatch(unread, /^no\b/i, "an unread roster must not read as a refusal");
  assert.doesNotMatch(unread, /^yes\b/i, "nor as permission");
  assert.match(canTagWords(false), /^no\b/i);
  assert.match(canTagWords(false), /commander/, "a refusal should say why");
  assert.equal(canTagWords(true), "yes");
});

test("inFleet keeps three states too", () => {
  assert.notEqual(inFleetWords(null), inFleetWords(false));
  assert.equal(inFleetWords(true), "yes");
  assert.equal(inFleetWords(false), "no");
});

test("every authority the progress can name has its own words", () => {
  // ⚠ `squad-board` IS DELIBERATELY ABSENT FROM THIS LIST. It used to be a
  // fourth channel here; it is gone from `CompanionOrderAuthority` itself
  // (`nav/fleetCompanionLoop.ts`) because nothing in the loop ever emitted it
  // -- see the comment on `orderFromWords`. This list is typed against that
  // same union (`as const` feeding a `CompanionOrderAuthority | null`
  // parameter), so writing "squad-board" back in here would fail to compile,
  // not just fail an assertion.
  const said = new Set<string>();
  for (const value of ["broadcast", "tag", "chat", "own-ladder", null] as const) {
    const words = orderFromWords(value);
    assert.ok(words.length > 0, `no words for ${String(value)}`);
    assert.ok(!said.has(words), `two authorities read identically: ${words}`);
    said.add(words);
  }
});

test("no string in this module carries a decorative non-ASCII character", () => {
  // Every string literal in this module is player-facing by construction --
  // that is what the module is for -- so the scan needs no allowlist. Code
  // COMMENTS are exempt and are stripped before judging, exactly as the
  // equivalent guard in fleetCompanionLoop.test.ts does.
  const source = readFileSync(new URL("./companionReadout.ts", import.meta.url), "utf8");
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const code = source
    .replace(blockComment, "")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");

  const doubleQuoted = new RegExp('"((?:[^"\\\\\\n]|\\\\.)*)"', "g");
  const offenders: string[] = [];
  for (const match of code.matchAll(doubleQuoted)) {
    const value = match[1] ?? "";
    if ([...value].some((character) => (character.codePointAt(0) ?? 0) > 127)) {
      offenders.push(value);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "player-facing strings must be plain ASCII; an em-dash is the usual culprit",
  );
});
