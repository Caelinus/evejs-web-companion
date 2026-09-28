// Chat refresh cadence (goal R10).
//
// Before the live event channel, the Chat panel's only path to a new message
// was a 4s backlog poll — chat bypasses the notification drain entirely, so
// nothing else could deliver one. With the push channel live, messages arrive
// as they happen and the poll stops being the liveness mechanism.
//
// It is NOT removed, for two reasons that are both about honesty rather than
// caution: the push channel carries messages but not roster changes, and a
// browser whose stream is degraded (no EventSource, a dropped SSE connection,
// a gateway restart) must still converge. So the poll stays as a slow safety
// net while the channel is live, and snaps back to the old fast cadence the
// moment it is not.
//
// A held bridge session also expires on idle, and the poll is what keeps it
// warm for a player who is only watching chat — another reason the safety net
// is a real requirement, not a vestige.

import type { LiveStreamStatus } from "../store/types.ts";

/** Safety-net cadence while the live channel is delivering. */
export const CHAT_POLL_LIVE_MS = 30_000;
/** The original R7 cadence, used whenever the live channel is not delivering. */
export const CHAT_POLL_FALLBACK_MS = 4_000;

/** How often the Chat panel should re-read the backlog for a given channel state. */
export function chatPollIntervalMs(status: LiveStreamStatus): number {
  return status === "live" ? CHAT_POLL_LIVE_MS : CHAT_POLL_FALLBACK_MS;
}

export interface ChatPollerDeps {
  /** Current live-channel status (read fresh on every re-arm). */
  readonly status: () => LiveStreamStatus;
  /** Perform one backlog read. */
  readonly refresh: () => void;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface ChatPoller {
  /** Start polling (and re-arm at the cadence the current status implies). */
  start(): void;
  /**
   * Re-evaluate the cadence; call when the live status changes. A no-op when
   * the interval is unchanged, so a steady stream never churns the timer.
   */
  sync(): void;
  stop(): void;
  /** The interval currently armed, or null when stopped (for tests/diagnostics). */
  currentIntervalMs(): number | null;
}

export function createChatPoller(deps: ChatPollerDeps): ChatPoller {
  const setTimer = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearTimer =
    deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let handle: unknown = null;
  let armedMs: number | null = null;

  function arm(ms: number): void {
    if (handle !== null) {
      clearTimer(handle);
    }
    armedMs = ms;
    handle = setTimer(() => deps.refresh(), ms);
  }

  return {
    start() {
      arm(chatPollIntervalMs(deps.status()));
    },
    sync() {
      if (handle === null) {
        return;
      }
      const next = chatPollIntervalMs(deps.status());
      if (next !== armedMs) {
        arm(next);
      }
    },
    stop() {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      armedMs = null;
    },
    currentIntervalMs() {
      return handle === null ? null : armedMs;
    },
  };
}
