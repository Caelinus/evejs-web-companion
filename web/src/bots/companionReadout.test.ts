import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMPANION_ORDER_SOURCE_LABELS,
  COMPANION_ROLE_LABELS,
  canTagWords,
  companionRoleLabel,
  inFleetWords,
  orderFromWords,
} from "./companionReadout.ts";
import {
  FLEET_COMPANION_ORDER_SOURCES,
  FLEET_COMPANION_ROLES,
} from "../nav/fleetCompanionLoop.ts";

test("every role the request can carry has a label", () => {
  // Exhaustive over the SOURCE OF TRUTH rather than over a hand-written list:
  // a fifth role added to FLEET_COMPANION_ROLES must fail here rather than
  // render as `undefined` in two readouts.
  for (const role of FLEET_COMPANION_ROLES) {
    const label = COMPANION_ROLE_LABELS[role];
    assert.equal(typeof label, "string", `no label for role ${role}`);
    assert.ok(label.length > 0, `empty label for role ${role}`);
  }
  assert.equal(Object.keys(COMPANION_ROLE_LABELS).length, FLEET_COMPANION_ROLES.length);
});

test("every order source has a label", () => {
  for (const source of FLEET_COMPANION_ORDER_SOURCES) {
    const label = COMPANION_ORDER_SOURCE_LABELS[source];
    assert.equal(typeof label, "string", `no label for source ${source}`);
    assert.ok(label.length > 0, `empty label for source ${source}`);
  }
  assert.equal(
    Object.keys(COMPANION_ORDER_SOURCE_LABELS).length,
    FLEET_COMPANION_ORDER_SOURCES.length,
  );
});

test("the chat channel is named LOCAL to the player, never fleet", () => {
  // ⚠ THIS IS A REGRESSION GUARD FOR A STRING THAT SHIPPED WRONG. The panel
  // said "Fleet chat commands" and "a fleet chat command" while `flow.ts` read
  // LOCAL deliberately -- fleet chat is not reachable on this server at all.
  // The operator accepted Local knowingly; what they accepted is that the whole
  // system can read the command. A label saying "fleet" hid exactly that.
  const label = COMPANION_ORDER_SOURCE_LABELS.chat;
  assert.match(label, /local/i, "the chat channel label must say Local");
  assert.doesNotMatch(label, /fleet/i, "the chat channel is not fleet chat");

  const phrase = orderFromWords("chat");
  assert.match(phrase, /local/i);
  assert.doesNotMatch(phrase, /fleet/i);
});

test("a run that has not reported a role reads as a dash, not as undefined", () => {
  assert.equal(companionRoleLabel(null), "-");
  assert.equal(companionRoleLabel("logi"), "Logistics");
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
  const said = new Set<string>();
  for (const value of ["broadcast", "tag", "chat", "squad-board", "own-ladder", null] as const) {
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
