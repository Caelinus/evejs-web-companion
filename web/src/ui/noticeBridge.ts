// THE BRIDGE — one pilot's store into the one notice board.
//
// Plain TypeScript on purpose. The signals follow the Svelte store contract but
// are not Svelte, so this needs no component, no SSR hook and no DOM to test:
// hand it a real store, apply a real event, read the board. A `$effect` in
// `NoticeBridge.svelte` is the only Svelte in the whole feature, and all it does
// is call this and return its unsubscriber.
//
// ---------------------------------------------------------------------------
// ⚠ EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. THIS IS THE WHOLE FILE.
//
// `actionError` is not an event queue — it is a field that HOLDS the last
// refusal until something clears it. Every slice is re-set on every poll, and
// `subscribe` also fires once immediately with whatever is already there. So a
// bridge that raised a notice whenever it saw a non-null message would:
//
//   • flash a stale refusal the moment the workspace mounts, for something the
//     player did before a reload, and
//   • re-flash a standing one forever, at whatever rate that panel polls.
//
// So a notice is raised only where the message CHANGES to a new one. The first
// value a subscription delivers is recorded and never raised — the bridge
// starts by learning what is already true, then reports what happens next.
//
// `notices.ts`'s own dedupe window is a second net under this, not the plan.

import type { ClientStore } from "../store/clientStore.ts";
import type { ReadableSignal, Unsubscribe } from "../store/signals.ts";
import { notify, type Notice, type NoticeInput } from "./notices.ts";
import { NOTICE_SOURCES, messageOf, noticeKey, type NoticeSource } from "./noticeSources.ts";

/** What the bridge does with a raised notice. Swappable so a test can watch. */
export type PostNotice = (input: NoticeInput) => Notice | null;

/**
 * Watch every source in `NOTICE_SOURCES` and raise a notice on each new message.
 *
 * Returns an unsubscriber that drops every subscription. Calling it is not
 * optional: a Workspace is mounted and unmounted as pilots are switched, and a
 * bridge that outlived its store would go on flashing a pilot you have left.
 */
export function watchNotices(store: ClientStore, post: PostNotice = notify): Unsubscribe {
  const stops: Unsubscribe[] = [];

  for (const source of NOTICE_SOURCES) {
    const signal = sliceOf(store, source.slice);
    if (signal === null) {
      // ⚠ A MISSING SLICE IS NOT A CRASH. The table names slices as strings,
      // which no compiler checks; a renamed slice must cost that one source and
      // not the other fifteen, and never the workspace it is mounted in.
      continue;
    }
    stops.push(watchOne(signal, source, post));
  }

  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

/** One field on one slice, from its first delivery onward. */
function watchOne(
  signal: ReadableSignal<unknown>,
  source: NoticeSource,
  post: PostNotice,
): Unsubscribe {
  // `undefined` distinguishes "nothing delivered yet" from "delivered, and it
  // was null". Only the first delivery is silent; a null seen later is a real
  // clearing, and the message that follows it is a real new event.
  let seen: string | null | undefined;

  return signal.subscribe((value) => {
    const message = messageOf(value, source.field);
    if (seen === undefined) {
      seen = message;
      return;
    }
    if (message === seen) {
      return;
    }
    seen = message;
    if (message === null) {
      return;
    }
    post({
      kind: source.kind,
      title: source.title,
      detail: message,
      key: noticeKey(source, message),
    });
  });
}

/**
 * The named slice, or null when the store has no such field.
 *
 * ⚠ IT CHECKS FOR `subscribe`, NOT MERELY FOR THE NAME. A store carries plenty
 * that is not a signal — methods, plain flags — and `store.apply.subscribe` is
 * a `TypeError` at mount time rather than a wrong notice later.
 */
function sliceOf(store: ClientStore, name: string): ReadableSignal<unknown> | null {
  const candidate = (store as unknown as Record<string, unknown>)[name];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }
  const signal = candidate as Partial<ReadableSignal<unknown>>;
  return typeof signal.subscribe === "function" && typeof signal.get === "function"
    ? (candidate as ReadableSignal<unknown>)
    : null;
}
