import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_COMMAND_VERBS,
  COMPANION_FOLLOW_RANGE_M,
  isChatCommandSenderAllowed,
  parseChatCommand,
} from "./chatCommands.ts";
import type { ChatMessage } from "../store/types.ts";

// The documented synthetic character id (ESI's own `CharacterID` example),
// used throughout instead of any real pilot's id or name.
const SENDER_ID = 90000001;

function chatMessage(message: string, characterID = SENDER_ID): ChatMessage {
  return { characterID, characterName: "Fleet Mate", message, createdAtMs: 1_000 };
}

// --- target / primary ------------------------------------------------------

test("'target <link>' parses to a target command carrying the ITEMID", () => {
  const command = parseChatCommand(
    chatMessage("target <url=showinfo:670//1099511628000>Some Rifter</url>"),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });
});

test("'primary <link>' is an alias for the same target command", () => {
  const command = parseChatCommand(
    chatMessage("primary <url=showinfo:670//1099511628000>Some Rifter</url>"),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });
});

test("the display text is ignored entirely — only the ITEMID (not TYPEID) is read", () => {
  const command = parseChatCommand(
    chatMessage("target <url=showinfo:670//1099511628000>This text is thrown away</url>"),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });
});

// --- align / travel / jump --------------------------------------------------

test("'align <link>' parses to an align command", () => {
  const command = parseChatCommand(
    chatMessage("align <url=showinfo:16//30000144>Some Structure</url>"),
  );
  assert.deepEqual(command, { kind: "align", itemID: 30000144 });
});

test("'travel <link>' parses to a travel command — the ITEMID is a solar system id here, decoded the same way", () => {
  const command = parseChatCommand(chatMessage("travel <url=showinfo:5//30000142>Jita</url>"));
  assert.deepEqual(command, { kind: "travel", itemID: 30000142 });
});

test("'jump <link>' parses to a jump command carrying the stargate's ITEMID", () => {
  const command = parseChatCommand(
    chatMessage("jump <url=showinfo:16//50011239>Stargate (Amarr)</url>"),
  );
  assert.deepEqual(command, { kind: "jump", itemID: 50011239 });
});

test("'warp <link>' parses to a warp command carrying the link's ITEMID", () => {
  const command = parseChatCommand(
    chatMessage("warp <url=showinfo:16//50011239>Stargate (Amarr)</url>"),
  );
  assert.deepEqual(command, { kind: "warp", itemID: 50011239 });
});

test("'warp <character link>' parses the same way — whose id it is, is not this parser's question", () => {
  // ⚠ A CHARACTER LINK IS THE "COME TO ME" CASE, and the id in it is a
  // CHARACTER id rather than an object on anybody's grid. This module reads one
  // number out of one link; which id space it belongs to is answered by the
  // reader that knows the grid and the fleet roster -- see `decideFleetOrders`.
  const command = parseChatCommand(
    chatMessage("warp to me <url=showinfo:1377//90000001>Some Capsuleer</url>"),
  );
  assert.deepEqual(command, { kind: "warp", itemID: 90000001 });
});

test("'warping' does not match the 'warp' verb", () => {
  assert.equal(
    parseChatCommand(chatMessage("warping <url=showinfo:16//50011239>Stargate</url>")),
    null,
  );
});

// --- the <a href="showinfo:..."> form --------------------------------------

test("accepts the <a href=\"showinfo:...\"> form other client surfaces emit", () => {
  const command = parseChatCommand(
    chatMessage('target <a href="showinfo:670//1099511628001">Some Punisher</a>'),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628001 });
});

// --- links contain spaces — the whole reason this cannot whitespace-split --

test("a display name containing spaces does not break the parse", () => {
  const command = parseChatCommand(
    chatMessage(
      "travel <url=showinfo:5//30000142>Jita IV - Moon 4 - Caldari Navy Assembly Plant</url>",
    ),
  );
  assert.deepEqual(command, { kind: "travel", itemID: 30000142 });
});

test("entity-escaped <, > and & inside display text cannot fake a closing tag", () => {
  const command = parseChatCommand(
    chatMessage("align <url=showinfo:16//30000144>Weird &lt;Name&gt; &amp; Co.</url>"),
  );
  assert.deepEqual(command, { kind: "align", itemID: 30000144 });
});

// --- conservative: null rather than a guess ---------------------------------

test("an unrecognised verb parses to null", () => {
  // ⚠ THIS USED TO USE "warp", WHICH IS NOW A VERB. The point of the case is a
  // well-formed LINK behind a word this parser does not know, so it needs a word
  // that is not on the list and is not about to join it -- not a near-miss of a
  // real order.
  assert.equal(
    parseChatCommand(chatMessage("scoop <url=showinfo:670//1099511628000>Some Rifter</url>")),
    null,
  );
});

test("a recognised verb with no link at all parses to null", () => {
  assert.equal(parseChatCommand(chatMessage("target that guy")), null);
});

test("a verb merely mentioned mid-message, not at the start, is not a command", () => {
  assert.equal(
    parseChatCommand(
      chatMessage("did you see the target <url=showinfo:670//1099511628000>Some Rifter</url> warp off?"),
    ),
    null,
  );
});

test("a word that starts with the verb but is a different word does not match ('targeting')", () => {
  assert.equal(
    parseChatCommand(chatMessage("targeting <url=showinfo:670//1099511628000>Some Rifter</url>")),
    null,
  );
});

test("a link truncated mid-tag by the 2048-char message cap parses to null, never a guessed id", () => {
  // Simulates `chat/client/util.py:51`'s hard truncation with a trailing
  // " ..." landing partway through the closing tag.
  const truncated = "target <url=showinfo:670//1099511628 ...";
  assert.equal(parseChatCommand(chatMessage(truncated)), null);
});

test("a link missing its closing tag entirely parses to null", () => {
  assert.equal(
    parseChatCommand(chatMessage("target <url=showinfo:670//1099511628000>Some Rifter")),
    null,
  );
});

test("an empty message parses to null", () => {
  assert.equal(parseChatCommand(chatMessage("")), null);
  assert.equal(parseChatCommand(chatMessage("   ")), null);
});

test("an item id of zero is rejected — never a positive game object id", () => {
  assert.equal(
    parseChatCommand(chatMessage("target <url=showinfo:670//0>Nothing</url>")),
    null,
  );
});

test("an item id beyond Number.MAX_SAFE_INTEGER is rejected rather than silently truncated", () => {
  const tooLarge = "9".repeat(40);
  assert.equal(
    parseChatCommand(chatMessage(`target <url=showinfo:670//${tooLarge}>Absurd</url>`)),
    null,
  );
});

// --- case-insensitive verb, first link wins, whitespace tolerance ----------

test("the verb is matched case-insensitively", () => {
  const command = parseChatCommand(
    chatMessage("TARGET <url=showinfo:670//1099511628000>Some Rifter</url>"),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });

  const mixedCase = parseChatCommand(
    chatMessage("Align <url=showinfo:16//30000144>Some Structure</url>"),
  );
  assert.deepEqual(mixedCase, { kind: "align", itemID: 30000144 });
});

test("leading and trailing whitespace around the message does not block the verb match", () => {
  const command = parseChatCommand(
    chatMessage("   target <url=showinfo:670//1099511628000>Some Rifter</url>   "),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });
});

test("when a message carries two links, the first one is the command's target", () => {
  const command = parseChatCommand(
    chatMessage(
      "target <url=showinfo:670//1099511628000>First</url> not " +
        "<url=showinfo:670//1099511628001>Second</url>",
    ),
  );
  assert.deepEqual(command, { kind: "target", itemID: 1099511628000 });
});

// --- salvage / loot: the area verbs, no link at all -------------------------
//
// Unlike the four verbs above, these carry no `itemID` — see chatCommands.ts's
// header, "the first verbs with no link at all". A bare verb IS the whole
// command; nothing needs to follow it.

test("a bare 'salvage' parses to a salvage command carrying no itemID", () => {
  assert.deepEqual(parseChatCommand(chatMessage("salvage")), { kind: "salvage" });
});

test("a bare 'loot' parses to a loot command carrying no itemID", () => {
  assert.deepEqual(parseChatCommand(chatMessage("loot")), { kind: "loot" });
});

test("'salvage'/'loot' are matched case-insensitively", () => {
  assert.deepEqual(parseChatCommand(chatMessage("SALVAGE")), { kind: "salvage" });
  assert.deepEqual(parseChatCommand(chatMessage("Loot")), { kind: "loot" });
});

test("leading and trailing whitespace around a bare area verb does not block the match", () => {
  assert.deepEqual(parseChatCommand(chatMessage("   salvage   ")), { kind: "salvage" });
  assert.deepEqual(parseChatCommand(chatMessage("   loot   ")), { kind: "loot" });
});

// Trailing-chatter decision (see chatCommands.ts header): the task's own
// phrasing of these commands — "salvage the wrecks in vicinity", "loot the
// wrecks and containers in vicinity" — IS a verb plus trailing words, so
// trailing chatter after the verb is accepted, same as the four link verbs
// already tolerate arbitrary text before their link.
test("'salvage'/'loot' followed by trailing chatter still parse — natural phrasing is verb-plus-words", () => {
  assert.deepEqual(parseChatCommand(chatMessage("salvage the wrecks in vicinity")), {
    kind: "salvage",
  });
  assert.deepEqual(
    parseChatCommand(chatMessage("loot the wrecks and containers in vicinity")),
    { kind: "loot" },
  );
});

test("a link after 'salvage'/'loot' is irrelevant — these verbs never look for one", () => {
  assert.deepEqual(
    parseChatCommand(chatMessage("salvage <url=showinfo:670//1099511628000>Some Rifter</url>")),
    { kind: "salvage" },
  );
  assert.deepEqual(
    parseChatCommand(chatMessage("loot <url=showinfo:670//1099511628000>Some Rifter</url>")),
    { kind: "loot" },
  );
});

test("'salvaged' does not match the 'salvage' verb", () => {
  assert.equal(parseChatCommand(chatMessage("salvaged")), null);
});

test("'salvager' does not match the 'salvage' verb", () => {
  assert.equal(parseChatCommand(chatMessage("salvager reporting in")), null);
});

test("'looting' does not match the 'loot' verb", () => {
  assert.equal(parseChatCommand(chatMessage("looting the last can")), null);
});

test("a sentence merely mentioning 'loot' or 'salvage', not at the start, is not a command", () => {
  assert.equal(parseChatCommand(chatMessage("did you loot that wreck?")), null);
  assert.equal(parseChatCommand(chatMessage("someone salvage this later")), null);
});

// --- follow: a verb that carries a DISTANCE ---------------------------------
//
// The third family (see chatCommands.ts's header): not a link verb, because
// nothing is being named, and not an area verb, because the order carries a
// value. `rangeM` always comes back defaulted and clamped, so nothing
// downstream ever has to re-check it.

test("a bare 'follow' parses at the default escort range", () => {
  assert.deepEqual(parseChatCommand(chatMessage("follow")), {
    kind: "follow",
    rangeM: COMPANION_FOLLOW_RANGE_M,
  });
});

test("'follow 10 km' and 'follow 10km' both read 10 000 metres", () => {
  assert.deepEqual(parseChatCommand(chatMessage("follow 10 km")), { kind: "follow", rangeM: 10_000 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 10km")), { kind: "follow", rangeM: 10_000 });
});

test("the unit may be spelled out, in either spelling", () => {
  for (const line of ["follow 10 kilometres", "follow 10 kilometers", "follow 10 kilometre"]) {
    assert.deepEqual(parseChatCommand(chatMessage(line)), { kind: "follow", rangeM: 10_000 }, line);
  }
});

test("'follow 5000 m' and 'follow 5000m' read metres, not kilometres", () => {
  assert.deepEqual(parseChatCommand(chatMessage("follow 5000 m")), { kind: "follow", rangeM: 5_000 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 5000m")), { kind: "follow", rangeM: 5_000 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 5000 metres")), {
    kind: "follow",
    rangeM: 5_000,
  });
});

test("a bare number is read as KILOMETRES — the judgment call, pinned", () => {
  // ⚠ Nothing in the game says what an undecorated number in chat means. It is
  // km because the order the operator asked for is written `follow <N> km`, and
  // because the other reading (ten metres) clamps to the floor and glues the
  // companion to its anchor. See `followRangeFrom`'s own comment.
  assert.deepEqual(parseChatCommand(chatMessage("follow 10")), { kind: "follow", rangeM: 10_000 });
});

test("a decimal distance is accepted and rounded to a whole metre", () => {
  assert.deepEqual(parseChatCommand(chatMessage("follow 7.5 km")), { kind: "follow", rangeM: 7_500 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 1.2345 km")), {
    kind: "follow",
    rangeM: 1_235,
  });
});

test("trailing text that is not a distance falls back to the default — 'follow me' is still an order", () => {
  // ⚠ THE CASE THAT MATTERS MOST IN PRACTICE. These are the natural English
  // phrasings of the same order; a parser that returned null for them would
  // leave a companion sitting still while its FC told it to come along.
  for (const line of ["follow me", "follow the fc", "follow us out", "follow 3 jumps behind"]) {
    assert.deepEqual(
      parseChatCommand(chatMessage(line)),
      { kind: "follow", rangeM: COMPANION_FOLLOW_RANGE_M },
      line,
    );
  }
});

test("a distance below the floor or above the ceiling clamps rather than being refused", () => {
  // The intent is unambiguous; only the magnitude is wrong. See the band's own
  // comment for the two numbers.
  assert.deepEqual(parseChatCommand(chatMessage("follow 10 m")), { kind: "follow", rangeM: 500 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 0")), { kind: "follow", rangeM: 500 });
  assert.deepEqual(parseChatCommand(chatMessage("follow 100000 km")), {
    kind: "follow",
    rangeM: 250_000,
  });
});

test("an absurd digit run clamps to the ceiling rather than decoding to nothing", () => {
  const absurd = "9".repeat(400);
  assert.deepEqual(parseChatCommand(chatMessage(`follow ${absurd} km`)), {
    kind: "follow",
    rangeM: 250_000,
  });
});

test("'following' does not match the 'follow' verb", () => {
  assert.equal(parseChatCommand(chatMessage("following the fc now")), null);
});

test("a 'follow' mentioned mid-sentence is not a command", () => {
  assert.equal(parseChatCommand(chatMessage("i will follow 10 km behind you")), null);
  assert.equal(parseChatCommand(chatMessage("does anyone follow?")), null);
});

test("'follow' is matched case-insensitively, and outer whitespace does not block it", () => {
  assert.deepEqual(parseChatCommand(chatMessage("   FOLLOW 10 KM   ")), {
    kind: "follow",
    rangeM: 10_000,
  });
});

// --- destination: a verb that carries a SOLAR SYSTEM -------------------------
//
// The link form is `travel`'s own, unchanged. The bare-number form is an
// ADDITION rather than a mirror of it — see chatCommands.ts's header.

test("'destination <link>' reads the solar system id out of the link", () => {
  assert.deepEqual(parseChatCommand(chatMessage("destination <url=showinfo:5//30000142>Jita</url>")), {
    kind: "destination",
    systemID: 30000142,
  });
});

test("'destination <bare id>' is accepted — far easier to type than a pasted link", () => {
  assert.deepEqual(parseChatCommand(chatMessage("destination 30000142")), {
    kind: "destination",
    systemID: 30000142,
  });
  assert.deepEqual(parseChatCommand(chatMessage("   destination   30000142   ")), {
    kind: "destination",
    systemID: 30000142,
  });
});

test("a bare 'destination' with nothing after it parses to null", () => {
  assert.equal(parseChatCommand(chatMessage("destination")), null);
  assert.equal(parseChatCommand(chatMessage("destination please")), null);
});

test("a number buried in a sentence is not a destination", () => {
  // "destination 3 jumps out" names no system; reading its first number would
  // send the companion somewhere nobody asked for.
  assert.equal(parseChatCommand(chatMessage("destination 3 jumps out")), null);
});

test("a 'destination' link truncated mid-tag parses to null, never a guessed id", () => {
  assert.equal(parseChatCommand(chatMessage("destination <url=showinfo:5//30000 ...")), null);
});

test("a destination id out of the safe-integer range is rejected, same bound as a link's", () => {
  const tooLarge = "9".repeat(40);
  assert.equal(parseChatCommand(chatMessage(`destination ${tooLarge}`)), null);
  assert.equal(parseChatCommand(chatMessage("destination 0")), null);
});

test("'destinations' does not match the 'destination' verb", () => {
  assert.equal(parseChatCommand(chatMessage("destinations 30000142")), null);
});

// --- the four link verbs are unaffected by salvage/loot ---------------------

test("the four link verbs still return null with no link, unaffected by the area verbs' branch", () => {
  assert.equal(parseChatCommand(chatMessage("target that guy")), null);
  assert.equal(parseChatCommand(chatMessage("align over there")), null);
  assert.equal(parseChatCommand(chatMessage("travel somewhere")), null);
  assert.equal(parseChatCommand(chatMessage("jump through")), null);
});

// --- CHAT_COMMAND_VERBS ------------------------------------------------------

test("CHAT_COMMAND_VERBS lists exactly the recognised verbs, target/primary included as aliases", () => {
  assert.deepEqual(
    [...CHAT_COMMAND_VERBS].sort(),
    [
      "align",
      "destination",
      "follow",
      "jump",
      "loot",
      "primary",
      "salvage",
      "stop",
      "target",
      "travel",
      "warp",
    ],
  );
});

// --- the sender gate ---------------------------------------------------------

test("isChatCommandSenderAllowed: an allow-listed characterID is allowed", () => {
  assert.equal(isChatCommandSenderAllowed(chatMessage("target <link>", SENDER_ID), [SENDER_ID]), true);
});

test("isChatCommandSenderAllowed: a characterID not on the list is refused", () => {
  assert.equal(isChatCommandSenderAllowed(chatMessage("target <link>", SENDER_ID), [90000002]), false);
});

test("isChatCommandSenderAllowed: an empty allowlist refuses everyone — the safe default", () => {
  assert.equal(isChatCommandSenderAllowed(chatMessage("target <link>", SENDER_ID), []), false);
});

test("isChatCommandSenderAllowed: the gate is verb-blind — a 'follow' from a stranger is refused too", () => {
  // ⚠ The new verbs go through the SAME gate as every other line; there is no
  // per-verb allowance and there must never be one. A companion that would
  // take a standing escort order, or a multi-jump trip, from anybody in local
  // is a companion anybody in local can fly away.
  const stranger = chatMessage("follow 10 km", 90000002);
  assert.equal(isChatCommandSenderAllowed(stranger, [SENDER_ID]), false);
  assert.equal(isChatCommandSenderAllowed(chatMessage("destination 30000142"), [SENDER_ID]), true);
});

test("isChatCommandSenderAllowed: gated on characterID alone, never on characterName", () => {
  const impostorName: ChatMessage = {
    characterID: 90000002,
    characterName: "Fleet Mate", // same display name as the allowed sender
    message: "target <link>",
    createdAtMs: 1_000,
  };
  assert.equal(isChatCommandSenderAllowed(impostorName, [SENDER_ID]), false);
});
