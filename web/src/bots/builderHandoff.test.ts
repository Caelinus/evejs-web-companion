import test from "node:test";
import assert from "node:assert/strict";
import { requestBuilderEdit, watchBuilderEdits } from "./builderHandoff.ts";

test("a request made before the Builder mounts is delivered on its first subscribe", () => {
  const flow = {};
  requestBuilderEdit(flow, "script-a");
  const got: string[] = [];
  const stop = watchBuilderEdits(flow, (id) => got.push(id));
  assert.deepEqual(got, ["script-a"]);
  stop();
});

test("a request is handed over once: a later mount does not reload it", () => {
  const flow = {};
  requestBuilderEdit(flow, "script-a");
  const first: string[] = [];
  watchBuilderEdits(flow, (id) => first.push(id))();
  const second: string[] = [];
  watchBuilderEdits(flow, (id) => second.push(id))();
  assert.deepEqual(first, ["script-a"]);
  assert.deepEqual(second, []);
});

test("an already-open Builder gets each Edit click, including the same row twice", () => {
  const flow = {};
  const got: string[] = [];
  const stop = watchBuilderEdits(flow, (id) => got.push(id));
  requestBuilderEdit(flow, "script-a");
  requestBuilderEdit(flow, "script-a");
  requestBuilderEdit(flow, "script-b");
  assert.deepEqual(got, ["script-a", "script-a", "script-b"]);
  stop();
});

test("a request for one pilot never reaches another pilot's Builder", () => {
  const pilotA = {};
  const pilotB = {};
  const gotB: string[] = [];
  const stop = watchBuilderEdits(pilotB, (id) => gotB.push(id));
  requestBuilderEdit(pilotA, "script-a");
  assert.deepEqual(gotB, []);
  stop();
});
