import test from "node:test";
import assert from "node:assert/strict";

import type { MacroMemory } from "./scriptDecide.ts";
import {
  clearCloseInStall,
  closeInStall,
  hullMode,
  isCourseStalled,
  STALL_STUCK_REASON,
} from "./closeInStall.ts";
import type { CloseInStallStep } from "./closeInStall.ts";

/**
 * Drive the ladder until it reports something other than "flying", and answer
 * with that step. The grace window is deliberately NOT spelled as a number here
 * — a test that hard-codes STALL_TICKS breaks every time the window is tuned,
 * and the thing worth pinning is the ORDER of the stages, not their length.
 */
function advance(mem: MacroMemory, mode = "STOP"): { step: CloseInStallStep; mem: MacroMemory } {
  let carried = mem;
  for (let i = 0; i < 50; i += 1) {
    const out = closeInStall(mode, carried);
    carried = out.mem;
    if (out.step !== "flying") {
      return { step: out.step, mem: carried };
    }
  }
  assert.fail("the ladder never left the grace window — it must be bounded");
}

test("a mode the snapshot did not give is 'I cannot tell', never a stall", () => {
  // Acting on a reading this client could not make is how a rung like this
  // breaks working flights. Null must be inert, however long it persists.
  let mem: MacroMemory = {};
  for (let i = 0; i < 20; i += 1) {
    const out = closeInStall(null, mem);
    assert.equal(out.step, "flying", "an unreadable mode must never escalate");
    mem = out.mem;
  }
});

test("a hull under a target-relative order is not stalled, whatever the ladder had counted", () => {
  // Part-way up the ladder...
  const climbing = advance({});
  assert.notEqual(climbing.step, "flying");

  // ...and then the hull is seen actually flying: the counters must go back to
  // zero, so a later leg gets its full grace window instead of a spent one.
  for (const mode of ["FOLLOW", "ORBIT", "WARP"]) {
    const out = closeInStall(mode, climbing.mem);
    assert.equal(out.step, "flying", `${mode} is a hull doing something`);
    assert.equal(out.mem["stallStage"], 0, `${mode} must reset the stage`);
    assert.equal(out.mem["stallTicks"], 0, `${mode} must reset the ticks`);
  }
});

test("the ladder escalates re-order, cut engines, re-order, and then gives up", () => {
  // ⚠ THE LAST RUNG IS THE POINT OF THE WHOLE THING. Nothing the client can send
  // clears a pending landing — every session movement command on this server
  // refuses on it, the stop included — so the ladder's job is to spend a bounded
  // number of tries and then say so, rather than re-ordering a hull for ever.
  let mem: MacroMemory = {};
  const seen: CloseInStallStep[] = [];
  for (let i = 0; i < 4; i += 1) {
    const out = advance(mem);
    seen.push(out.step);
    mem = out.mem;
  }
  assert.deepEqual(seen, ["reorder", "unstick", "reorder", "stuck"]);
});

test("once stuck it stays stuck — a caller polling it never sees the ladder restart", () => {
  let mem: MacroMemory = {};
  for (let i = 0; i < 4; i += 1) {
    mem = advance(mem).mem;
  }
  for (let i = 0; i < 10; i += 1) {
    const out = closeInStall("STOP", mem);
    assert.equal(out.step, "stuck", "a hull that will not move does not become flyable by asking again");
    mem = out.mem;
  }
});

test("a new thing to close on gets a full grace window, not the last leg's leftovers", () => {
  const spent = advance(advance({}).mem).mem;
  const fresh = clearCloseInStall(spent);
  assert.equal(closeInStall("STOP", fresh).step, "flying", "the first tick of a new leg is never an escalation");
});

test("STOP and GOTO are the readings that prove nothing target-relative is running", () => {
  for (const mode of ["STOP", "stopped", "GOTO", " goto "]) {
    assert.equal(isCourseStalled(mode), true, `${mode} proves no course`);
  }
  for (const mode of ["FOLLOW", "ORBIT", "WARP", "KEEPATRANGE", "something-new"]) {
    assert.equal(isCourseStalled(mode), false, `${mode} is not evidence of a stall`);
  }
});

test("the hull's mode is read from the ship block, else from this pilot's own row", () => {
  const row = { itemID: 1, isSelf: true, mode: "ORBIT" } as never;
  assert.equal(hullMode({ ship: { mode: "FOLLOW" }, entities: [row] } as never), "FOLLOW", "the ship block wins");
  assert.equal(hullMode({ ship: null, entities: [row] } as never), "ORBIT", "else this pilot's row");
  assert.equal(hullMode({ ship: null, entities: [] } as never), null, "and otherwise it did not say");
  assert.equal(hullMode(null), null, "no snapshot is no reading");
});

test("giving up names the remedy, because there is no in-game one to offer", () => {
  // The operator's only move is to sign the pilot in again; a reason that did
  // not say so would send them looking for a stuck rock or a bad fit instead.
  assert.match(STALL_STUCK_REASON, /sign this pilot in again/i);
  assert.doesNotMatch(STALL_STUCK_REASON, /landingPending|WARP_LANDING_PENDING|CmdStop/i, "R9a: no jargon in a player's face");
});
