// "Edit THIS saved bot in the Bot Builder" — the one-shot handoff from the Bot
// Manager's library rows to the Bot Builder panel.
//
// A tab switch carries only a TabID (PanelHost's `onOpen`), so the script the
// player clicked has to travel some other way. It rides a per-pilot mailbox,
// keyed by that pilot's flow: App mounts only the active pilot's Workspace, and
// the Manager and the Builder inside it share that one flow, so a request can
// never land in another pilot's editor.
//
// ONE-SHOT. The Builder consumes a request as it reads it (the slot goes back to
// null), so a later mount does not reload a bot the player already moved on
// from, and clicking Edit on the same row twice still loads it twice. It works
// whether the Builder is already open (a Desktop window: the subscription fires
// at once) or not yet mounted (the request waits for its first subscribe).

import { createSignal, type Unsubscribe, type WritableSignal } from "../store/signals.ts";

const mailboxes = new WeakMap<object, WritableSignal<string | null>>();

function mailbox(owner: object): WritableSignal<string | null> {
  let slot = mailboxes.get(owner);
  if (slot === undefined) {
    slot = createSignal<string | null>(null);
    mailboxes.set(owner, slot);
  }
  return slot;
}

/** Ask this pilot's Bot Builder to load `scriptID` for editing. */
export function requestBuilderEdit(owner: object, scriptID: string): void {
  mailbox(owner).set(scriptID);
}

/**
 * Receive this pilot's edit requests: a pending one at once, later ones as they
 * arrive. Each request is handed over exactly once.
 */
export function watchBuilderEdits(owner: object, onRequest: (scriptID: string) => void): Unsubscribe {
  const slot = mailbox(owner);
  return slot.subscribe((scriptID) => {
    if (scriptID === null) {
      return;
    }
    slot.set(null);
    onRequest(scriptID);
  });
}
