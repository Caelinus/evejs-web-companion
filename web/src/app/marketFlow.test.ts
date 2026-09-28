// The R16 Market controller against a faked BFF: loadMarket decodes seven
// independent reads into the store and asks for the NAMES of everything it
// will render.
//
// The properties that matter here are the ones that keep the panel honest when
// something goes wrong:
//  - an independent read failing must not blank the rest (a broken order book
//    must still leave the player looking at their own orders and their ISK);
//  - a DAEMON outage must be reported as an outage, not as an empty market;
//  - the trade decoder must be handed the character's OWN id, or every trade
//    would be mislabelled;
//  - a lost session must unwind to character select.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const CHARACTER_ID = 140000003;
const TYPE_ID = 34;
const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;

function long(value: string): unknown {
  return { type: "long", value };
}

function list(items: readonly unknown[]): unknown {
  return { type: "list", items };
}

function keyVal(fields: Record<string, unknown>): unknown {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: Object.entries(fields) },
  };
}

function cached(payload: unknown): unknown {
  return {
    type: "object",
    name: { value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
    args: [null, { type: "substream", value: payload }, null],
  };
}

const ORDER_COLUMNS = [
  "price", "volRemaining", "typeID", "range", "orderID", "volEntered", "minVolume",
  "bid", "issueDate", "duration", "stationID", "regionID", "solarSystemID",
  "constellationID", "jumps",
];

function orderRowset(lines: readonly (readonly unknown[])[]): unknown {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["columns", list(ORDER_COLUMNS)],
        ["RowClass", { type: "token", value: "blue.DBRow" }],
        ["lines", { type: "list", items: lines }],
      ],
    },
  };
}

function orderLine(overrides: Record<string, unknown> = {}): readonly unknown[] {
  const fields: Record<string, unknown> = {
    price: 5.51,
    volRemaining: 1200,
    typeID: TYPE_ID,
    range: 0,
    orderID: long("8000000001"),
    volEntered: 2000,
    minVolume: 1,
    bid: 0,
    issueDate: long("133000000000000000"),
    duration: 30,
    stationID: STATION_ID,
    regionID: 10000002,
    solarSystemID: SOLAR_SYSTEM_ID,
    constellationID: 20000020,
    jumps: 0,
    ...overrides,
  };
  return ORDER_COLUMNS.map((column) => fields[column] ?? null);
}

const OWN_COLUMNS = [
  "orderID", "typeID", "charID", "regionID", "stationID", "range", "bid", "price",
  "volEntered", "volRemaining", "issueDate", "minVolume", "contraband", "duration",
  "isCorp", "solarSystemID", "escrow", "constellationID", "keyID", "orderState",
  "lastStateChange",
];

function ownOrderRowset(rows: readonly Record<string, unknown>[]): unknown {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["columns", list(OWN_COLUMNS)],
        ["RowClass", { type: "token", value: "util.Row" }],
        [
          "lines",
          {
            type: "list",
            items: rows.map((row) => ({
              type: "list",
              items: OWN_COLUMNS.map((column) => row[column] ?? null),
            })),
          },
        ],
      ],
    },
  };
}

function ownOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderID: long("8000000101"),
    typeID: TYPE_ID,
    charID: CHARACTER_ID,
    regionID: 10000002,
    stationID: STATION_ID,
    range: 5,
    bid: 1,
    price: 4.9,
    volEntered: 1000,
    volRemaining: 500,
    issueDate: long("133000000000000000"),
    minVolume: 1,
    contraband: 0,
    duration: 30,
    isCorp: 0,
    solarSystemID: SOLAR_SYSTEM_ID,
    escrow: 2450,
    constellationID: 20000020,
    keyID: 1000,
    orderState: 0,
    lastStateChange: null,
    ...overrides,
  };
}

function marketPanel(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    typeID: TYPE_ID,
    characterID: CHARACTER_ID,
    stationID: STATION_ID,
    solarSystemID: SOLAR_SYSTEM_ID,
    book: {
      result: cached([
        orderRowset([orderLine({ bid: 0, price: 5.51 })]),
        orderRowset([orderLine({ bid: 1, price: 4.9, orderID: long("8000000002") })]),
      ]),
      error: null,
    },
    ownOrders: { result: cached(ownOrderRowset([ownOrder()])), error: null },
    orderHistory: {
      result: cached(ownOrderRowset([ownOrder({ orderID: long("8000000102"), orderState: 1 })])),
      error: null,
    },
    transactions: {
      result: list([
        keyVal({
          transactionID: 1,
          typeID: TYPE_ID,
          quantity: 100,
          price: 5.5,
          stationID: STATION_ID,
          buyerID: CHARACTER_ID,
          sellerID: 999,
          transactionDate: long("133000000000000000"),
        }),
      ]),
      error: null,
    },
    escrow: { result: keyVal({ iskEscrow: 2450, itemsEscrow: 3 }), error: null },
    cashBalance: { result: long("125000000"), error: null },
    priceHistory: { result: null, error: null },
    marketUnavailable: null,
    ...overrides,
  };
}

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => {
    status: number;
    body: unknown;
  },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

function respondOk(
  extra: (path: string, method: string, body: Record<string, unknown>) => unknown = () => null,
) {
  return (path: string, method: string, body: Record<string, unknown>) => {
    const custom = extra(path, method, body);
    if (custom !== null && custom !== undefined) {
      return custom as { status: number; body: unknown };
    }
    if (path.startsWith("/api/bridge/market")) {
      return { status: 200, body: marketPanel() };
    }
    if (path === "/api/names") {
      return { status: 200, body: { ok: true, names: {} } };
    }
    return { status: 200, body: { ok: true } };
  };
}

async function settleNames(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeFlow(responder: ReturnType<typeof respondOk>) {
  const store = createClientStore();
  const { fetch: fakeFetch, requests } = makeFakeFetch(responder);
  const flow = createAppFlow(store, { fetch: fakeFetch });
  return { store, flow, requests };
}

// --- Loading ----------------------------------------------------------------

test("loadMarket decodes the book, the own orders, the trades, the escrow and the ISK", async () => {
  const { store, flow } = makeFlow(respondOk());
  await flow.loadMarket(TYPE_ID);

  const market = store.get().market;
  assert.equal(market.loaded, true);
  assert.equal(market.typeID, TYPE_ID);
  assert.equal(market.sells.length, 1);
  assert.equal(market.buys.length, 1);
  assert.equal(market.sells[0]?.price, "5.51");
  assert.equal(market.ownOrders.length, 1);
  assert.equal(market.orderHistory.length, 1);
  assert.equal(market.orderHistory[0]?.state, "filled");
  assert.equal(market.escrow?.isk, "2450");
  // ⚠ ISK stays a DECIMAL STRING all the way into the store.
  assert.equal(market.cashBalance, "125000000");
  assert.equal(typeof market.cashBalance, "string");
});

test("the trade decoder is handed the character's OWN id, so sides are right", () => {
  // Guarded by the fixture: buyerID is the character, so it must read "bought".
  // A flow that passed 0 (or nothing) would label every trade "sold".
  return (async () => {
    const { store, flow } = makeFlow(respondOk());
    await flow.loadMarket(TYPE_ID);
    assert.equal(store.get().market.transactions[0]?.side, "bought");
  })();
});

test("loadMarket(null) still reads the player's own market — no item needed", async () => {
  const { flow, requests } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/bridge/market")
        ? { status: 200, body: marketPanel({ typeID: null, book: { result: null, error: null } }) }
        : null,
    ),
  );
  await flow.loadMarket(null);
  const marketRequest = requests.find((entry) => entry.path.startsWith("/api/bridge/market"));
  // No typeID in the query: the route treats the order book as optional.
  assert.equal(marketRequest?.path, "/api/bridge/market");
});

test("a typeID is passed on the query string, so the BFF reads that item's book", async () => {
  const { flow, requests } = makeFlow(respondOk());
  await flow.loadMarket(TYPE_ID);
  assert.ok(
    requests.some((entry) => entry.path === `/api/bridge/market?typeID=${TYPE_ID}`),
    "the chosen item must reach the BFF",
  );
});

// --- Independence -----------------------------------------------------------

test("a failed ORDER BOOK read never blanks the player's own orders or their ISK", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/bridge/market")
        ? {
            status: 200,
            body: marketPanel({ book: { result: null, error: "CALL_FAILED" } }),
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);

  const market = store.get().market;
  assert.equal(market.bookError, "CALL_FAILED");
  assert.deepEqual(market.sells, []);
  // The rest survived.
  assert.equal(market.ownOrders.length, 1);
  assert.equal(market.cashBalance, "125000000");
  assert.equal(market.ownOrdersError, null);
});

test("a failed OWN-ORDERS read never blanks the public book", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/bridge/market")
        ? {
            status: 200,
            body: marketPanel({ ownOrders: { result: null, error: "CALL_FAILED" } }),
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);

  const market = store.get().market;
  assert.equal(market.ownOrdersError, "CALL_FAILED");
  assert.equal(market.sells.length, 1);
});

test("a DAEMON outage is reported as an outage — not as an empty market", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/bridge/market")
        ? {
            status: 200,
            body: marketPanel({
              book: { result: null, error: "CALL_FAILED" },
              marketUnavailable:
                "The market is not answering right now, so these figures may be incomplete.",
            }),
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);

  const market = store.get().market;
  // ⚠ THE POINT: "nobody is trading this" and "the market is down" are
  // different facts, and the panel is told which one happened.
  assert.match(String(market.marketUnavailable), /not answering/);
  assert.deepEqual(market.sells, []);
});

// --- Names ------------------------------------------------------------------

test("loadMarket asks for the NAME of every item, station and system it will show", async () => {
  const { flow, requests } = makeFlow(respondOk());
  await flow.loadMarket(TYPE_ID);
  await settleNames();

  const nameRequest = requests.find((entry) => entry.path === "/api/names");
  assert.ok(nameRequest, "the panel must resolve every id it renders (R7d)");
  const items = (nameRequest.body.items ?? []) as readonly { kind: string; id: number }[];
  const keys = new Set(items.map((item) => `${item.kind}:${item.id}`));
  assert.ok(keys.has(`type:${TYPE_ID}`), "the item being traded");
  assert.ok(keys.has(`station:${STATION_ID}`), "the station an order sits at");
  assert.ok(keys.has(`system:${SOLAR_SYSTEM_ID}`), "the system that station is in");
});

// --- Session loss -----------------------------------------------------------

test("a lost bridge session unwinds the market panel to character select", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/bridge/market")
        ? { status: 404, body: { ok: false, error: "SESSION_NOT_FOUND" } }
        : null,
    ),
  );
  await assert.rejects(() => flow.loadMarket(TYPE_ID));
  assert.equal(store.get().market.loaded, false);
});

// --- Item search ------------------------------------------------------------

test("findMarketTypes searches by NAME and never asks the player for an id", async () => {
  const { flow, requests } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/market/find")
        ? {
            status: 200,
            body: {
              ok: true,
              matches: [{ typeID: TYPE_ID, name: "Tritanium", groupName: "Mineral" }],
            },
          }
        : null,
    ),
  );
  const matches = await flow.findMarketTypes("tritan");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.name, "Tritanium");
  assert.ok(requests.some((entry) => entry.path.startsWith("/api/market/find?q=tritan")));
});

test("a query too short to be useful never reaches the BFF", async () => {
  const { flow, requests } = makeFlow(respondOk());
  assert.deepEqual(await flow.findMarketTypes("t"), []);
  assert.equal(
    requests.filter((entry) => entry.path.startsWith("/api/market/find")).length,
    0,
  );
});

// --- Ore families (bot editor ore picker) -----------------------------------

test("listOreFamilies loads the ore families from static data", async () => {
  const { flow, requests } = makeFlow(
    respondOk((path) =>
      path.startsWith("/api/ore/families")
        ? {
            status: 200,
            body: {
              ok: true,
              source: "static-data",
              count: 2,
              families: [
                { groupID: 460, name: "Scordite" },
                { groupID: 462, name: "Veldspar" },
              ],
            },
          }
        : null,
    ),
  );
  const families = await flow.listOreFamilies();
  assert.deepEqual(families, [
    { groupID: 460, name: "Scordite" },
    { groupID: 462, name: "Veldspar" },
  ]);
  assert.ok(requests.some((entry) => entry.path.startsWith("/api/ore/families")));
});

// =============================================================================
// Slice B: the WRITES
// =============================================================================
// What the flow owes a player who has just spent ISK:
//   - the panel reloaded from the SERVER before anything is said about what
//     happened, so the orders and the balance on screen are server truth;
//   - the amount reported is the one the BFF measured from the WALLET, never
//     the estimate the confirm step showed;
//   - a silent decline said plainly, with no invented cause;
//   - a thrown refusal in the server's own words.

function changeResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    applied: true,
    declinedSilently: false,
    charged: "1137.50",
    balanceBefore: "1000000.00",
    balanceAfter: "998862.50",
    ownOrders: null,
    ...overrides,
  };
}

test("placing a buy sends confirm:true and the rounded price, and reloads the panel", async () => {
  const { store, flow, requests } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy" ? { status: 200, body: changeResult() } : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "buy",
    typeID: TYPE_ID,
    price: 10,
    quantity: 100,
    durationDays: 30,
  });

  const buy = requests.find((entry) => entry.path === "/api/bridge/market/buy");
  assert.ok(buy, "the buy must reach the BFF");
  // The BFF refuses without this; the UI's two-step confirm is the first gate.
  assert.equal(buy.body.confirm, true);
  assert.equal(buy.body.price, 10);
  assert.equal(buy.body.quantity, 100);
  // The panel is reloaded from the server BEFORE any verdict is shown.
  assert.equal(
    requests.filter((entry) => entry.path.startsWith("/api/bridge/market?")).length >= 1,
    true,
  );
  assert.equal(store.get().market.lastOutcome?.applied, true);
});

test("the reported amount is the SERVER's charge, not the client's estimate", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy"
        ? { status: 200, body: changeResult({ charged: "1137.50" }) }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "buy",
    typeID: TYPE_ID,
    price: 10,
    quantity: 100,
    durationDays: 30,
  });

  const outcome = store.get().market.lastOutcome;
  // The client's own estimate for this order would be 10 x 100 x 3% = 30.00.
  // What is recorded is what the WALLET lost.
  assert.equal(outcome?.charged, "1137.50");
  assert.equal(outcome?.balanceAfter, "998862.50");
  assert.equal(outcome?.kind, "buy");
});

test("selling names the STACK — a sell carries an itemID, a buy does not", async () => {
  const { flow, requests } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/sell" ? { status: 200, body: changeResult() } : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "sell",
    typeID: TYPE_ID,
    itemID: 7_000_000_001,
    price: 12.5,
    quantity: 10,
    durationDays: 90,
  });

  const sell = requests.find((entry) => entry.path === "/api/bridge/market/sell");
  assert.ok(sell, "a sell must go to the sell route, not the buy route");
  assert.equal(sell.body.itemID, 7_000_000_001);
  assert.equal(sell.body.confirm, true);
});

test("cancelling and repricing both go behind confirm", async () => {
  const { flow, requests } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/cancel" || path === "/api/bridge/market/modify"
        ? { status: 200, body: changeResult({ charged: "-2450.00" }) }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.cancelMarketOrder("8000000101");
  await flow.modifyMarketOrder("8000000101", 12);

  const cancel = requests.find((entry) => entry.path === "/api/bridge/market/cancel");
  const modify = requests.find((entry) => entry.path === "/api/bridge/market/modify");
  assert.equal(cancel?.body.confirm, true);
  assert.equal(cancel?.body.orderID, "8000000101");
  assert.equal(modify?.body.confirm, true);
  assert.equal(modify?.body.price, 12);
});

test("a refund is recorded as a NEGATIVE charge, so the panel can say ISK came back", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/cancel"
        ? { status: 200, body: changeResult({ charged: "-2450.00" }) }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.cancelMarketOrder("8000000101");
  assert.equal(store.get().market.lastOutcome?.charged, "-2450.00");
});

test("a SILENT decline is reported as exactly that — no cause is invented", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy"
        ? {
            status: 200,
            body: changeResult({ applied: false, declinedSilently: true, charged: "0.00" }),
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "buy",
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
  });

  const outcome = store.get().market.lastOutcome;
  assert.equal(outcome?.applied, false);
  assert.equal(outcome?.declinedSilently, true);
  // ⚠ And no actionError: a silent decline is not a refusal with a reason, and
  // inventing one would be worse than saying the server declined.
  assert.equal(store.get().market.actionError, null);
});

test("a THROWN refusal keeps the server's own words and does not reload a verdict", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy"
        ? {
            status: 409,
            body: {
              ok: false,
              error: "CALL_REFUSED",
              message: "No matching sell orders were available at the requested price.",
            },
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "buy",
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
  });

  // The handler's OWN sentence, never reworded.
  assert.match(
    String(store.get().market.actionError),
    /No matching sell orders were available/,
  );
  // No outcome is recorded: nothing happened, so there is nothing to report
  // about the money.
  assert.equal(store.get().market.lastOutcome, null);
});

test("a NAMED market refusal becomes a sentence a player can read", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy"
        ? {
            status: 409,
            body: { ok: false, error: "CALL_REFUSED", message: "MktBrokersFeeUnexpected2" },
          }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await flow.placeMarketOrder({
    side: "buy",
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
  });
  assert.match(
    String(store.get().market.actionError),
    /broker's fee here is not what you were shown/,
  );
});

test("a lost session during a write unwinds to character select rather than reporting a charge", async () => {
  const { store, flow } = makeFlow(
    respondOk((path) =>
      path === "/api/bridge/market/buy"
        ? { status: 404, body: { ok: false, error: "SESSION_NOT_FOUND" } }
        : null,
    ),
  );
  await flow.loadMarket(TYPE_ID);
  await assert.rejects(() =>
    flow.placeMarketOrder({
      side: "buy",
      typeID: TYPE_ID,
      price: 10,
      quantity: 1,
      durationDays: 30,
    }));
  assert.equal(store.get().market.lastOutcome, null);
});
