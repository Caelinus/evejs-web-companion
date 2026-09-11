// Typed chat commands (fleet-companion phase 2 groundwork) — turning one
// fleet-chat line into a typed order this pilot can act on, or nothing.
//
// PURE PARSER ONLY. No store, no I/O, no wiring into `flow.ts` or the
// companion loop — that happens later, once this shape is settled. Mirrors
// `web/src/bridge/fleetBroadcasts.ts` in spirit: a small set of legal
// command kinds, a strict decoder that returns `null` rather than guess, and
// a companion predicate (there, freshness; here, who may command at all).
//
// ─── WHY A CHAT COMMAND, AND WHY IT LOOKS LIKE A BROADCAST ──────────────────
//
// `docs/fleet-companion-plan.md`'s precedence list puts chat commands below
// FC broadcasts and above this pilot's own ladder: a fleet-mate who is not
// the FC can still say "target this" in fleet chat and be obeyed, the same
// way `decideFleetOrders` (`web/src/nav/fleetCompanionLoop.ts`) already obeys
// a `Target` or `AlignTo` broadcast. So the command set below is not
// invented — it is restricted to the rungs `decideFleetOrders` genuinely has
// TODAY: `target`/`primary` (mirrors the `Target` broadcast, rung c),
// `align` (mirrors `AlignTo`, rung d), `travel` (mirrors `TravelTo`, rung e —
// the carried id is a solar SYSTEM id, not an on-grid object, same as the
// broadcast it mirrors) and `jump` (mirrors `JumpTo`, rung f — an honest
// partial: gets the ship to the named gate and holds, never fires the jump,
// exactly like the broadcast rung it mirrors).
//
// ⚠ THE HEAL FAMILY (`HealShield`/`HealArmor`/`HealCapacitor`/`HealTarget`,
// rung a) IS DELIBERATELY NOT A CHAT VERB HERE. `decideFleetOrders` keys the
// four apart by broadcast NAME alone — which remote-rep list it draws from is
// entirely determined by which of the four names it saw. A single chat verb
// ("heal", "rep") is ambiguous across all four, and any sub-verb grammar to
// disambiguate ("heal shield <link>" vs "heal armor <link>" vs plain "heal
// <link>" for the third-party case) is a genuinely new design decision this
// task's brief never specified — not a mirror of an existing rung's grammar
// the way `target`/`align`/`travel`/`jump` are. Guessing that grammar here
// risks exactly the failure mode this module exists to avoid: a chat command
// firing the WRONG repairer at the wrong ship. Left for the integrator to
// decide alongside the store wiring.
//
// The fleet-tag rung (b) is not a chat verb either, for an unrelated reason:
// it reads `obs.fleetTargetTags`, server-authoritative FLEET STATE pushed by
// `OnFleetStateChange`, never a chat line at all — there is nothing here to
// parse a verb for.
//
// `WarpTo`, `JumpBeacon`, `EnemySpotted`, `NeedBackup`, `HoldPosition`,
// `InPosition` and `Location` are the remaining broadcast names, and
// `decideFleetOrders` has NO rung at all for any of them (see
// `fleetBroadcasts.ts`'s `FLEET_BROADCAST_CLASSIFICATION`: all seven are
// `act: false`, announcements or server-driven, never something a follower
// acts on itemID for) — so none of them gets a chat verb either.
//
// ─── THE LINK FORMAT DECIDES THE GRAMMAR ────────────────────────────────────
//
// See docs/fleet-companion-plan.md, "The chat link format, read out of the
// client" (search "showinfo"). Settled from the decompiled client
// (`chat/client/window.py:381`, `show_info/parse.py:22`), not guessed:
//
//   <url=showinfo:TYPEID//ITEMID>Display text</url>
//
// and — because other client surfaces (mail, notifications) emit it too, and
// being liberal about accepting it costs nothing — the anchor form as well:
//
//   <a href="showinfo:TYPEID//ITEMID">Display text</a>
//
// Two rules follow straight from the doc and shape every regex below:
//
// 1. LINKS CONTAIN SPACES (the display text is an object's name — station
//    and bookmark names routinely have them), so THIS PARSER NEVER
//    WHITESPACE-SPLITS THE WHOLE MESSAGE. It splits once on the verb — an
//    ANCHORED match at the start of the (trimmed) message, never a search
//    inside it, so an ordinary chat line that merely MENTIONS a verb ("did
//    you see the target that guy warped off with?") never fires a command —
//    and only then runs a tag regex over what is left.
//
// 2. The numeric id is AUTHORITATIVE. `TYPEID` is matched only to keep the
//    tag shape strict; it is never read back. `ITEMID` — the second number —
//    is the whole of what a command carries. Display text is matched with
//    `[^<]*` and thrown away unread, which is safe because `<`, `>` and `&`
//    inside it are always entity-escaped (`editPlainText.py:320`) and so can
//    never smuggle in a fake `</url>`/`</a>` close.
//
// A message is hard-truncated at 2048 chars with a trailing " ..."
// (`chat/client/util.py:51`), which CAN cut a link mid-tag. Both tag
// patterns below require their own closing tag, so a truncated tag simply
// fails to match — the message decodes to `null`, never to a guessed,
// possibly-wrong id built from a fragment.

import type { ChatMessage } from "../store/types.ts";
// ⚠ Not `../bridge/chat.ts`, even though that is the module that PRODUCES a
// `ChatMessage` (`decodeMessageEntry` et al.) and the one this task's brief
// names — `ChatMessage` itself is DECLARED in `store/types.ts` and only
// imported, re-used, by `chat.ts`. Importing the type from its actual home
// avoids a needless dependency on the whole decoder module for a type that
// module does not own.

/** The chat-command kinds this parser recognises. */
export type ChatCommandKind = "target" | "align" | "travel" | "jump";

/**
 * One parsed chat command. Every kind carries exactly the resolved numeric
 * item id the `decideFleetOrders` rung it mirrors expects — never a name,
 * never the raw link — so a caller can hand `itemID` straight to the same
 * rung logic that already handles the broadcast it mirrors.
 */
export type ChatCommand =
  | { readonly kind: "target"; readonly itemID: number }
  | { readonly kind: "align"; readonly itemID: number }
  | { readonly kind: "travel"; readonly itemID: number }
  | { readonly kind: "jump"; readonly itemID: number };

/**
 * Verb -> command kind, each with its own anchored, case-insensitive
 * pattern. `target` and `primary` are aliases for the SAME kind — both mean
 * "engage this ship", matching this task's own "target / primary -> engage
 * that ship" and `decideFleetOrders` rung c, which answers to a single
 * `Target` broadcast name regardless of which word a human fleet-mate
 * reaches for.
 *
 * Each pattern is anchored (`^`) and word-bounded (`\b`) so "targeting" or
 * "targets" never matches the `target` verb, and matches only at the very
 * START of the trimmed message — see the header above for why a search
 * anywhere in the message would be wrong.
 */
const COMMAND_VERBS: ReadonlyArray<{
  readonly verb: string;
  readonly pattern: RegExp;
  readonly kind: ChatCommandKind;
}> = [
  { verb: "target", pattern: /^target\b/i, kind: "target" },
  { verb: "primary", pattern: /^primary\b/i, kind: "target" },
  { verb: "align", pattern: /^align\b/i, kind: "align" },
  { verb: "travel", pattern: /^travel\b/i, kind: "travel" },
  { verb: "jump", pattern: /^jump\b/i, kind: "jump" },
];

/** The chat verbs this parser recognises (`target`/`primary` alias to the same kind). */
export const CHAT_COMMAND_VERBS: readonly string[] = Object.freeze(COMMAND_VERBS.map((c) => c.verb));

/**
 * Both legal showinfo tag forms in one alternation, so "the first tag in the
 * remainder" is well-defined regardless of which form a client surface
 * happened to emit. Capture group 1 is the `url=` form's ITEMID, group 2 the
 * anchor form's — exactly one is ever set on a match. TYPEID is matched with
 * a plain `\d+` and deliberately not captured: this module never reads it.
 *
 * Display text is `[^<]*` — safe because `<`/`>`/`&` are always
 * entity-escaped inside it, so it can never contain a literal `<` that would
 * let it swallow past its own closing tag.
 */
const SHOWINFO_LINK =
  /<url=showinfo:\d+\/\/(\d+)>[^<]*<\/url>|<a href="showinfo:\d+\/\/(\d+)">[^<]*<\/a>/;

/**
 * A positive game item id out of a regex capture that is already known to be
 * all ASCII digits. Still bounded against `Number.MAX_SAFE_INTEGER` via
 * `BigInt` rather than trusted outright — the digits come from player-typed
 * (or pasted) chat TEXT, not from a server-normalized field, so an absurdly
 * long digit run is exactly the kind of input this must not silently coerce
 * into the wrong number.
 */
function parseItemID(digits: string): number | null {
  const value = BigInt(digits);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

/** The first showinfo link's ITEMID in `text`, or `null` if none parses cleanly. */
function extractShowInfoItemID(text: string): number | null {
  const match = SHOWINFO_LINK.exec(text);
  if (match === null) {
    return null;
  }
  const digits = match[1] ?? match[2];
  return digits === undefined ? null : parseItemID(digits);
}

/**
 * Parse one fleet-chat line into a typed command, or `null` for anything
 * that is not confidently one of the recognised verbs with a well-formed
 * link attached.
 *
 * Deliberately returns `null`, never a best guess, for: an unrecognised
 * verb, a recognised verb with no link at all, a link that does not parse
 * (including one truncated mid-tag by the 2048-char message cap), or an
 * item id out of the safe-integer range. A wrong target is far worse than no
 * target — see this module's own header.
 *
 * Takes the whole `ChatMessage` (rather than just its `.message` text) so a
 * caller wiring this in later never has to juggle two different values for
 * "the chat line" — the same reason `isChatCommandSenderAllowed` below also
 * takes the whole message.
 */
export function parseChatCommand(message: ChatMessage): ChatCommand | null {
  const trimmed = message.message.trim();
  for (const { pattern, kind } of COMMAND_VERBS) {
    const verbMatch = pattern.exec(trimmed);
    if (verbMatch === null) {
      continue;
    }
    const remainder = trimmed.slice(verbMatch[0].length);
    const itemID = extractShowInfoItemID(remainder);
    if (itemID === null) {
      // This verb matched but no usable link followed it (missing, malformed,
      // or truncated mid-tag) — no command, never a guess.
      return null;
    }
    return { kind, itemID };
  }
  return null;
}

/**
 * Whether `message`'s sender may issue fleet-chat commands, gated on
 * `characterID` ALONE.
 *
 * That field is the one part of a chat entry a player cannot spoof: the chat
 * backend fills it in server-side from the authenticated session
 * (`chatRuntime.js:87` — `session.characterID || session.charid ||
 * session.userid`), never from anything in the message TEXT, so no amount of
 * crafting the message body changes who it is attributed to — which is the
 * entire basis for gating on it at all. Gating on `characterName` instead
 * would be gating on display text a player can rename at will, worthless as
 * an allowlist key.
 *
 * `chatCommandSenders` mirrors `FleetCompanionRequest.chatCommandSenders`
 * (`web/src/nav/fleetCompanionLoop.ts`) — an operator-controlled allowlist,
 * never populated from chat text itself. Taken by shape here rather than by
 * importing that type, so this module stays a standalone parser with no
 * dependency on the loop that will eventually consume it.
 *
 * An empty list allows nobody. That is
 * `DEFAULT_FLEET_COMPANION_REQUEST.chatCommandSenders`'s own default: a
 * companion nobody has explicitly authorized obeys no one over chat.
 */
export function isChatCommandSenderAllowed(
  message: ChatMessage,
  chatCommandSenders: readonly number[],
): boolean {
  return chatCommandSenders.includes(message.characterID);
}
