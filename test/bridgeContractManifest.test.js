"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const manifest = require("../contracts/evejs-web-bridge-contract.json");
const policy = require("../src/bridgeCallPolicy");

function digest(values) {
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

test("the shared bridge manifest pins the web write boundary", () => {
  const actual = [...policy.BRIDGE_WRITE_PAIR_KEYS].sort();
  assert.deepEqual(actual, manifest.bffWritePolicy.pairs);
  assert.equal(manifest.bffWritePolicy.count, actual.length);
  assert.equal(manifest.bffWritePolicy.sha256, digest(actual));
  assert.equal(manifest.boundary.genericBridgeAllowsWrites, false);
  assert.deepEqual(manifest.boundary.browserSessionFields, policy.SAFE_BROWSER_SESSION_FIELDS);
});

test("the pinned EveJS allowlist is independently counted and hashed", () => {
  assert.equal(manifest.gatewayAllowlist.count, manifest.gatewayAllowlist.pairs.length);
  assert.equal(manifest.gatewayAllowlist.sha256, digest(manifest.gatewayAllowlist.pairs));
});
