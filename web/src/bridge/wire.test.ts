import test from "node:test";
import assert from "node:assert/strict";

import { readKeyVal, readPlainJsonField, unwrapReal, type JsonValue } from "./wire.ts";

test("plain JSON fields are read directly without treating the envelope as util.KeyVal", () => {
  const result: JsonValue = { type: "list", items: [7, 8] };
  const envelope: JsonValue = { ok: true, applied: true, result };

  assert.equal(readPlainJsonField(envelope, "ok"), true);
  assert.equal(readPlainJsonField(envelope, "applied"), true);
  assert.equal(readPlainJsonField(envelope, "result"), result);
  assert.equal(readPlainJsonField(envelope, "missing"), undefined);
});

test("plain JSON reader rejects arrays/null and never descends into util.KeyVal", () => {
  const keyVal: JsonValue = {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [["ok", true]] },
  };

  assert.equal(readPlainJsonField(null, "ok"), undefined);
  assert.equal(readPlainJsonField([], "ok"), undefined);
  assert.equal(readPlainJsonField(keyVal, "ok"), undefined);
  assert.equal(readKeyVal(keyVal, "ok"), true);
});

test("unwrapReal reads a real wrapper or a bare number and rejects everything else", () => {
  assert.equal(unwrapReal({ type: "real", value: 100000.5 }), 100000.5);
  assert.equal(unwrapReal({ type: "real", value: 0 }), 0);
  assert.equal(unwrapReal(-42), -42);
  assert.equal(unwrapReal(null), null);
  assert.equal(unwrapReal(undefined), null);
  assert.equal(unwrapReal("100000.5"), null, "bare strings are not reals");
  assert.equal(unwrapReal({ type: "real", value: "100000.5" }), null);
  assert.equal(unwrapReal({ type: "long", value: 7 }), null);
});
