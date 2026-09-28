// What the character bar's connection indicator actually means.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The indicator used to be a 10-second `GET /api/health` poll and nothing else.
// That poll runs at the LOWEST priority ("poll") in a transport that allows
// four concurrent requests (app/transport.ts), so the moment the server got
// slow the page's own reads filled the lane and the health ping — the thing
// whose entire job is to report health — was the first request to be starved.
// It then resolved `{ ready: false }` and the bar said "Server offline" about a
// server that was up, because of load the page itself created.
//
// That is why the companion appeared to disconnect with two clients as readily
// as with twelve: the indicator never measured the server's capacity, it
// measured whether one low-priority request won a lane. The retail client has
// no equivalent — it holds a socket, and a slow second is just a slow second.
//
// So do what the real client does: BELIEVE THE OPEN CONNECTION. The push stream
// (app/api.ts openLiveStream -> BFF SSE -> gateway WebSocket) is already there,
// already reconnects, and its status is already tracked. While it is open, the
// server is by definition reachable AND serving this session, and no poll can
// tell us anything the socket has not already proven.
//
// ⚠ WHY NOT "have we heard from it recently": the BFF's SSE keepalive is a
// `: ping` COMMENT, and per the EventSource spec a comment never fires
// `onmessage`. A healthy but quiet session can therefore go minutes without a
// visible event. Judging liveness on event recency would report a perfectly
// good connection as dead. The connection's own open/error state is the honest
// signal, and the browser gives it to us: EventSource fires `onerror` when it
// drops, which is what moves the status off "live".
//
// The health poll is NOT deleted. It stays as the answer for the cases the
// stream cannot cover — the character-select screen, where no pilot and so no
// stream exists yet, and any pilot whose stream is degraded or ended. It just
// stops being the primary signal, and slows down while the stream is carrying.

import type { LiveStreamStatus } from "../store/types.ts";

/** What the character bar renders. Unchanged shape; only its derivation moves. */
export type ServerStatus = "checking" | "online" | "offline";

/**
 * Health-poll cadence while the push stream is open.
 *
 * Not zero. The poll still keeps a slow watch on the BFF itself, and a held
 * bridge session has an idle TTL that benefits from an occasional beat. But at
 * this cadence it is a background check rather than a competitor for the four
 * lanes the player's own reads need. Mirrors app/chatPoll.ts, which made the
 * same live-vs-fallback split for the same reason.
 */
export const HEALTH_POLL_LIVE_MS = 30_000;

/** The original cadence, used whenever the stream is not carrying. */
export const HEALTH_POLL_FALLBACK_MS = 10_000;

/** How often to ping `/api/health` for a given stream state. */
export function healthPollIntervalMs(live: LiveStreamStatus): number {
  return live === "live" ? HEALTH_POLL_LIVE_MS : HEALTH_POLL_FALLBACK_MS;
}

export interface ServerStatusInput {
  /** The ACTIVE pilot's push-stream status; "idle" when there is no pilot. */
  readonly live: LiveStreamStatus;
  /** Last health answer: true ready, false not ready, null never answered. */
  readonly healthReady: boolean | null;
}

/**
 * Resolve what the bar should say.
 *
 * An open stream wins outright: it is proof of reachability that a poll can
 * only ever approximate, and it cannot be starved by the page's own traffic.
 * Everything else defers to the health poll exactly as before, so the
 * character-select screen and a degraded pilot behave the way they always did.
 */
export function resolveServerStatus({ live, healthReady }: ServerStatusInput): ServerStatus {
  if (live === "live") {
    return "online";
  }
  if (healthReady === null) {
    return "checking";
  }
  return healthReady ? "online" : "offline";
}
