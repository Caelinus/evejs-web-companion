// The Contracts panel as it actually RENDERS: the contracts offered to this
// character, and taking one on.
//
// ⚠ THE DEFECT THIS FILE EXISTS FOR. The summary line said "1 waiting for you"
// and every list under it was empty, because a contract someone RESERVES for
// you is in none of them: the board is public-only, "waiting" is what you
// issued, "taken on" is what you accepted. The count was real and the page had
// nowhere to put what it counted. A flow test cannot catch that — the row was
// decoded correctly and simply never reached a screen — so the claims here are
// checked against real markup.
//
// Three things are load-bearing:
//
//   1. THE COUNT AND THE LIST AGREE. A contract offered to this character is on
//      screen, on its own tab, with who offered it.
//
//   2. TAKING IT ON ASKS FIRST, AND SAYS WHAT CHANGES HANDS. It moves ISK and
//      items and cannot be undone, so the first press only opens a summary of
//      the terms; nothing is sent until the second.
//
//   3. THE BUTTON IS OFFERED ONLY WHERE IT MEANS SOMETHING. A contract YOU
//      issued gets no accept button, and neither does one already taken on.
//
// The standing invariants hold on the new markup too: R7d (no numeric id
// reaches the player) and R9a (plain player language).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Contracts = (await import("./Contracts.svelte")).default;

const CONTRACT_ID = 8100;
const OWN_CONTRACT_ID = 8101;
const ISSUER_ID = 140000009;
const CHARACTER_ID = 90000001;
const START_STATION = 60003760;
const END_STATION = 60008494;
const START_SYSTEM = 30000142;
const END_SYSTEM = 30002187;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/** Everything a player can see, with markup stripped and whitespace collapsed. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function contractRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractID: CONTRACT_ID,
    type: 3,
    status: 0,
    availability: 1,
    issuerID: ISSUER_ID,
    issuerCorpID: 98000000,
    forCorp: false,
    assigneeID: CHARACTER_ID,
    acceptorID: null,
    dateIssued: 133000000000000000n,
    dateExpired: 134000000000000000n,
    dateAccepted: null,
    dateCompleted: null,
    numDays: 7,
    startStationID: START_STATION,
    endStationID: END_STATION,
    startSolarSystemID: START_SYSTEM,
    endSolarSystemID: END_SYSTEM,
    price: null,
    reward: "2500000",
    collateral: "10000000",
    volume: 1200,
    title: "Ore run",
    description: "",
    ...overrides,
  };
}

interface SceneOptions {
  readonly assigned?: readonly unknown[];
  readonly outstanding?: readonly unknown[];
  readonly numAssigned?: number;
  readonly assignedError?: string | null;
  /** What GetLoginInfo counted, when it disagrees with the rows fetched. */
  readonly summaryAssigned?: number;
  /** The contract to open in full, if any. */
  readonly detailOf?: unknown;
  readonly acceptError?: string | null;
  readonly acceptedContractID?: number | null;
}

function scene(options: SceneOptions = {}): { body: string; text: string } {
  const store = createClientStore();
  store.apply({
    type: "names/resolved",
    entries: {
      [`character:${ISSUER_ID}`]: "Broker Vanth",
      [`owner:${CHARACTER_ID}`]: "Test Pilot",
      [`station:${START_STATION}`]: "Jita IV - Moon 4",
      [`station:${END_STATION}`]: "Amarr VIII - Emperor Family",
      [`system:${START_SYSTEM}`]: "Jita",
      [`system:${END_SYSTEM}`]: "Amarr",
    },
  } as never);
  store.apply({
    type: "contracts/loaded",
    browse: [],
    numFound: 0,
    page: 0,
    pageSize: 100,
    outstanding: (options.outstanding ?? []) as never,
    accepted: [],
    expired: [],
    assigned: (options.assigned ?? []) as never,
    numAssigned: options.numAssigned ?? (options.assigned ?? []).length,
    summary: {
      needsAttention: 0,
      inProgress: 0,
      assignedToMe: options.summaryAssigned ?? (options.assigned ?? []).length,
    },
    browseError: null,
    mineError: null,
    assignedError: options.assignedError ?? null,
    worldHasNoContracts: true,
  } as never);
  if (options.detailOf) {
    store.apply({
      type: "contracts/detail",
      detail: {
        contract: options.detailOf,
        items: [],
        startSolarSystemID: START_SYSTEM,
        endSolarSystemID: END_SYSTEM,
      },
    } as never);
  }
  if (options.acceptError) {
    store.apply({ type: "contracts/accept-error", message: options.acceptError } as never);
  }
  if (options.acceptedContractID) {
    store.apply({
      type: "contracts/accepted",
      contractID: options.acceptedContractID,
    } as never);
  }
  const output = render(Contracts as never, {
    props: { store, flow: fakeFlow() },
  } as never);
  return { body: output.body, text: visibleText(output.body) };
}

// --- 1. The count and the list agree ----------------------------------------

test("⚠ a contract offered to this character has a tab of its OWN, and is on it", () => {
  const { text } = scene({ assigned: [contractRow()] });
  // The tab exists and is counted, and it is the one that opens by default —
  // a contract waiting for a decision outranks the ones already settled.
  assert.match(text, /Offered to you \(1\)/);
  // The row itself, in words: who offered it, where it runs, what it pays.
  assert.match(text, /Broker Vanth/);
  assert.match(text, /Jita IV - Moon 4/);
  assert.match(text, /Amarr VIII - Emperor Family/);
  assert.match(text, /2,500,000\.00 ISK/);
});

test("with nothing offered the panel opens on the board and claims nothing", () => {
  const { text } = scene({ assigned: [] });
  // No count with nothing behind it, and no tab jumping the player somewhere
  // there is nothing to see.
  assert.doesNotMatch(text, /waiting for you/i);
  assert.match(text, /no public delivery jobs in this world yet/i);
});

test("⚠ a read that FAILED still opens the tab, and is worded differently", () => {
  const { text } = scene({ assigned: [], assignedError: "CALL_FAILED" });
  // ⚠ THE FAILURE MUST NOT HIDE. With zero rows the panel would otherwise
  // land on the board and never mention that the look-up broke — which is the
  // same "the page looks fine and is silently wrong" failure this whole file
  // exists for.
  assert.match(text, /Offered to you \(0\)/);
  assert.match(text, /could not be loaded/i);
  // "Nothing was offered" and "we could not look" are different facts about
  // the world, and only the first is a claim about the player.
  assert.doesNotMatch(text, /Nobody has offered you a contract/i);
});

test("an empty-but-successful offered list says so plainly, once opened", () => {
  // The tab opens because the summary counted one; the fan-out is what came
  // back empty. Both sentences are on screen and neither reads as the other.
  const { text } = scene({ assigned: [], numAssigned: 0, summaryAssigned: 1 });
  assert.match(text, /Nobody has offered you a contract/i);
});

test("a list cut short by the fetch limit says so, with both numbers", () => {
  const { text } = scene({ assigned: [contractRow()], numAssigned: 60 });
  assert.match(text, /Showing 1 of the 60/);
});

test("R7d: no contract id, station id or character id reaches the player", () => {
  const { text } = scene({ assigned: [contractRow()] });
  for (const id of [CONTRACT_ID, ISSUER_ID, START_STATION, END_STATION, START_SYSTEM]) {
    assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`), `${id} must not be on screen`);
  }
  // The companion check: the sweep really does catch an id when one is there.
  assert.match(`x ${CONTRACT_ID} y`, new RegExp(`\\b${CONTRACT_ID}\\b`));
});

// --- 2. Taking one on asks first --------------------------------------------

test("⚠ the first press only OFFERS to take it on — nothing is sent yet", () => {
  const { text } = scene({ assigned: [contractRow()], detailOf: contractRow() });
  assert.match(text, /Take this on…/);
  // The irreversible wording belongs to the SECOND step, and must not be on
  // screen before the player has asked to see the terms.
  assert.doesNotMatch(text, /Yes, take this contract on/);
  assert.doesNotMatch(text, /cannot be undone/i);
});

test("⚠ a contract YOU issued is never offered an accept button", () => {
  // It is in `outstanding` (what you issued), not on the board and not offered
  // to you — so there is nothing here for this character to take on.
  const own = contractRow({ contractID: OWN_CONTRACT_ID, assigneeID: null });
  const { text } = scene({ outstanding: [own], detailOf: own });
  assert.doesNotMatch(text, /Take this on/);
});

test("a contract already taken on is not offered again", () => {
  const taken = contractRow({ status: 1, acceptorID: CHARACTER_ID });
  const { text } = scene({ assigned: [taken], detailOf: taken });
  assert.doesNotMatch(text, /Take this on/);
});

test("⚠ a refusal reaches the player in the SERVER's words", () => {
  const { text } = scene({
    assigned: [contractRow()],
    detailOf: contractRow(),
    acceptError: "You do not have enough ISK to cover the collateral.",
  });
  // Not enough ISK and no room for the cargo are different problems with
  // different fixes; a house sentence would throw that away.
  assert.match(text, /enough ISK to cover the collateral/);
});

test("a contract just taken on says where it went", () => {
  const { text } = scene({
    assigned: [contractRow()],
    detailOf: contractRow({ status: 1, acceptorID: CHARACTER_ID }),
    acceptedContractID: CONTRACT_ID,
  });
  assert.match(text, /You have taken this on/i);
  assert.doesNotMatch(text, /Take this on…/);
});

// --- 3. Plain language (R9a) -------------------------------------------------

test("R9a: the tab and its rows speak player language, not wire language", () => {
  const { text } = scene({ assigned: [contractRow()] });
  for (const jargon of [/assigneeID/, /acceptorID/, /availability/, /contractProxy/]) {
    assert.doesNotMatch(text, jargon);
  }
  assert.match(text, /Delivery job/, "contractType 3 reads as what it is");
});
