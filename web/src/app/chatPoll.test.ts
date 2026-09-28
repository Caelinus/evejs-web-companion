// Goal R10: the Chat panel's poll is no longer how messages arrive — the live
// channel is. The poll survives as a safety net, so the cadence has to follow
// the channel's health: slow while it delivers, back to the original R7 speed
// the moment it does not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_POLL_FALLBACK_MS,
  CHAT_POLL_LIVE_MS,
  chatPollIntervalMs,
  createChatPoller,
} from "./chatPoll.ts";
import type { LiveStreamStatus } from "../store/types.ts";

function makeFakeTimers() {
  const armed: { ms: number; handler: () => void }[] = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    setInterval(handler: () => void, ms: number) {
      const handle = { ms, handler };
      armed.push(handle);
      return handle;
    },
    clearInterval(handle: unknown) {
      cleared.push(handle);
    },
  };
}

test("only a live channel earns the slow cadence", () => {
  assert.equal(chatPollIntervalMs("live"), CHAT_POLL_LIVE_MS);
  for (const status of ["idle", "connecting", "degraded", "ended"] as LiveStreamStatus[]) {
    assert.equal(
      chatPollIntervalMs(status),
      CHAT_POLL_FALLBACK_MS,
      `${status} must keep the fast fallback poll`,
    );
  }
  assert.ok(
    CHAT_POLL_LIVE_MS > CHAT_POLL_FALLBACK_MS,
    "the safety net must be slower than the fallback poll",
  );
});

test("the poller starts at the cadence the current status implies", () => {
  const timers = makeFakeTimers();
  let status: LiveStreamStatus = "live";
  const poller = createChatPoller({
    status: () => status,
    refresh: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  poller.start();
  assert.equal(poller.currentIntervalMs(), CHAT_POLL_LIVE_MS);
  assert.equal(timers.armed.length, 1);
});

test("losing the channel snaps the poll back to the fast cadence", () => {
  const timers = makeFakeTimers();
  let status: LiveStreamStatus = "live";
  const poller = createChatPoller({
    status: () => status,
    refresh: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  poller.start();

  status = "degraded";
  poller.sync();
  assert.equal(poller.currentIntervalMs(), CHAT_POLL_FALLBACK_MS);
  assert.equal(timers.armed.length, 2, "the timer must be re-armed at the new cadence");
  assert.equal(timers.cleared.length, 1, "the old timer must be cleared, not left running");

  status = "live";
  poller.sync();
  assert.equal(poller.currentIntervalMs(), CHAT_POLL_LIVE_MS);
});

test("a steady status does not churn the timer", () => {
  const timers = makeFakeTimers();
  const poller = createChatPoller({
    status: () => "live",
    refresh: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  poller.start();
  poller.sync();
  poller.sync();
  assert.equal(timers.armed.length, 1);
  assert.equal(timers.cleared.length, 0);
});

test("sync before start does not begin polling", () => {
  const timers = makeFakeTimers();
  const poller = createChatPoller({
    status: () => "live",
    refresh: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  poller.sync();
  assert.equal(timers.armed.length, 0);
  assert.equal(poller.currentIntervalMs(), null);
});

test("the armed timer actually refreshes, and stop ends it", () => {
  const timers = makeFakeTimers();
  let refreshes = 0;
  const poller = createChatPoller({
    status: () => "live",
    refresh: () => {
      refreshes += 1;
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  poller.start();
  const armed = timers.armed[0];
  assert.ok(armed, "start must arm a timer");
  armed.handler();
  armed.handler();
  assert.equal(refreshes, 2);

  poller.stop();
  assert.equal(timers.cleared.length, 1);
  assert.equal(poller.currentIntervalMs(), null);
  // Stopping twice is safe (onDestroy can race a status change).
  poller.stop();
  assert.equal(timers.cleared.length, 1);
});
