// Turning a verb into a server call (goal R77). The point of the module is that
// the verb bar and the radial menu cannot drift apart, so these tests pin WHICH
// call each verb makes and WHICH arguments it carries — the branch-level detail
// that a second copy would get subtly wrong.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MULTI_STEP_ACTIONS,
  dispatchRowAction,
  isSingleCallAction,
  type FlyingRanges,
  type RowActionFlow,
} from "./rowActionRunner.ts";
import type { GateLink } from "./gateLinks.ts";

const RANGES: FlyingRanges = { warp: 10_000, orbit: 5_000, hold: 2_500 };
const ITEM = 50001248;

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

function recordingFlow(): { flow: RowActionFlow; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ name, args });
    };
  return {
    calls,
    flow: {
      warpTo: record("warpTo"),
      approach: record("approach"),
      orbit: record("orbit"),
      keepAtRange: record("keepAtRange"),
      alignTo: record("alignTo"),
      dockAt: record("dockAt"),
      jump: record("jump"),
      lockTarget: record("lockTarget"),
      unlockTarget: record("unlockTarget"),
    } as RowActionFlow,
  };
}

const NO_GATE = { itemID: ITEM, gateLink: null };

test("each movement verb calls its own flow method", async () => {
  for (const [id, name] of [
    ["approach", "approach"],
    ["align", "alignTo"],
    ["dock", "dockAt"],
    ["lock", "lockTarget"],
    ["unlock", "unlockTarget"],
  ] as const) {
    const { flow, calls } = recordingFlow();
    const ran = await dispatchRowAction(flow, id, NO_GATE, RANGES);
    assert.equal(ran, true, `${id} must dispatch`);
    assert.deepEqual(calls, [{ name, args: [ITEM] }]);
  }
});

test("the ranged verbs carry the PLAYER'S chosen distance, each its own", async () => {
  // ⚠ The branch a second copy of this switch gets wrong: warp/orbit/keep-at-
  // range look interchangeable and take three DIFFERENT settings.
  const { flow, calls } = recordingFlow();
  await dispatchRowAction(flow, "warp", NO_GATE, RANGES);
  await dispatchRowAction(flow, "orbit", NO_GATE, RANGES);
  await dispatchRowAction(flow, "keepAtRange", NO_GATE, RANGES);
  assert.deepEqual(calls, [
    { name: "warpTo", args: [ITEM, 10_000] },
    { name: "orbit", args: [ITEM, 5_000] },
    { name: "keepAtRange", args: [ITEM, 2_500] },
  ]);
});

test("jump carries the FAR side of the gate, not the gate itself", async () => {
  const link = { destinationGateID: 60009, destinationSolarSystemID: 30000144 } as unknown as GateLink;
  const { flow, calls } = recordingFlow();
  const ran = await dispatchRowAction(flow, "jump", { itemID: ITEM, gateLink: link }, RANGES);
  assert.equal(ran, true);
  assert.deepEqual(calls, [{ name: "jump", args: [ITEM, 60009] }]);
});

test("jump with no far side calls NOTHING rather than sending a guess", async () => {
  const { flow, calls } = recordingFlow();
  const ran = await dispatchRowAction(flow, "jump", NO_GATE, RANGES);
  assert.equal(ran, false, "it must report that it did not run");
  assert.deepEqual(calls, [], "and it must not have called anything");
});

test("a multi-step verb is refused, not silently ignored", async () => {
  // `mine`, `haul` and `loot` run loops with their own per-step reporting and
  // live in the overview. A caller that forgot to filter them must find out.
  for (const id of ["mine", "haul", "loot"] as const) {
    const { flow, calls } = recordingFlow();
    const ran = await dispatchRowAction(flow, id, NO_GATE, RANGES);
    assert.equal(ran, false, `${id} must report that it did not run`);
    assert.deepEqual(calls, []);
  }
});

test("the multi-step set and the predicate agree", () => {
  assert.equal(isSingleCallAction("warp"), true);
  assert.equal(isSingleCallAction("mine"), false);
  assert.equal(isSingleCallAction("haul"), false);
  // "Take everything" opens a container and then issues one transfer per bay
  // that will take something, reporting how much of it landed — reporting this
  // module deliberately does not own.
  assert.equal(isSingleCallAction("loot"), false);
  assert.deepEqual([...MULTI_STEP_ACTIONS].sort(), ["haul", "loot", "mine"]);
});

test("a failing call propagates rather than being swallowed", async () => {
  // The dispatching surface owns error reporting; this module must not eat it.
  const flow = {
    ...recordingFlow().flow,
    approach: async () => {
      throw new Error("the server said no");
    },
  } as RowActionFlow;
  await assert.rejects(
    () => dispatchRowAction(flow, "approach", NO_GATE, RANGES),
    /the server said no/,
  );
});
