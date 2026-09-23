"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const originalDataDir = process.env.EVEJS_WEB_POC_DATA_DIR;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-auth-"));
process.env.EVEJS_WEB_POC_DATA_DIR = temporaryDataDir;

const webAuth = require("../src/webAuth");

test.after(() => {
  if (originalDataDir === undefined) {
    delete process.env.EVEJS_WEB_POC_DATA_DIR;
  } else {
    process.env.EVEJS_WEB_POC_DATA_DIR = originalDataDir;
  }
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

test("signed web sessions contain independent cryptorandom session IDs", () => {
  const account = { username: "pilot", accountID: 42 };
  const firstToken = webAuth.createSessionToken(account);
  const secondToken = webAuth.createSessionToken(account);
  const first = webAuth.verifySessionToken(firstToken);
  const second = webAuth.verifySessionToken(secondToken);

  assert.equal(first.username, "pilot");
  assert.equal(first.accountID, 42);
  assert.match(first.sessionID, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.sessionID, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.sessionID, second.sessionID);
});

test("the server rejects a session ID changed without a valid signature", () => {
  const token = webAuth.createSessionToken({ username: "pilot", accountID: 42 });
  const [encodedPayload, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  payload.sessionID = "attacker-controlled-session-id-000000000000";
  const changedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");

  assert.equal(webAuth.verifySessionToken(`${changedPayload}.${signature}`), null);
});

// ── How long a token lives ──────────────────────────────────────────────────
// A sign-in takes the configured default. A caller that knows how long its work
// runs says so instead — see createSessionToken's header for the twelve-hour
// bot run that died on the default and could not authenticate its own shutdown.

const ACCOUNT = { username: "pilot", accountID: 42 };

function lifeOf(token) {
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  return payload.exp - payload.iat;
}

test("a session with no stated life gets the configured default", () => {
  const config = require("../src/config");
  assert.equal(lifeOf(webAuth.createSessionToken(ACCOUNT)), config.sessionTtlMs);
});

test("a caller that knows how long it needs gets exactly that", () => {
  const twoHours = 2 * 60 * 60 * 1000;
  assert.equal(lifeOf(webAuth.createSessionToken(ACCOUNT, { ttlMs: twoHours })), twoHours);
});

test("a job longer than a sign-in gets a token longer than a sign-in", () => {
  // The case that was broken: a run approved for 20 hours used to be handed a
  // 12-hour credential and go quiet 8 hours early.
  const config = require("../src/config");
  const twentyHours = 20 * 60 * 60 * 1000;
  const token = webAuth.createSessionToken(ACCOUNT, { ttlMs: twentyHours });
  assert.ok(lifeOf(token) > config.sessionTtlMs);
  assert.equal(lifeOf(token), twentyHours);
  assert.ok(webAuth.verifySessionToken(token), "and it verifies");
});

test("an unusable or absurd life falls back rather than minting nonsense", () => {
  const config = require("../src/config");
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "soon", null, undefined]) {
    assert.equal(
      lifeOf(webAuth.createSessionToken(ACCOUNT, { ttlMs })),
      config.sessionTtlMs,
      `${String(ttlMs)} is not a life`,
    );
  }
});

test("no caller can mint a token that outlives the day it was made in", () => {
  const aYear = 365 * 24 * 60 * 60 * 1000;
  assert.equal(
    lifeOf(webAuth.createSessionToken(ACCOUNT, { ttlMs: aYear })),
    webAuth.MAX_SESSION_TTL_MS,
    "the rail holds whatever the caller's arithmetic said",
  );
});
