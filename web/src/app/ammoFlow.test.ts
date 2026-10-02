// Loading and unloading ammunition through the page controller.
//
// What matters here is the SHAPE OF THE REQUEST and what happens to a refusal.
//
// Where the charges come from is a WORD — "cargo" or "hangar" — never a
// location id: the BFF pins the concrete ids from the session's own active ship
// and docked station, so a browser cannot aim a load somewhere else. And both
// verbs are confirm-gated at the BFF, so the flow must actually send it.
//
// Compatibility is deliberately NOT decided here. Which charges a module accepts
// lives in dogma attributes the browser has no allowlisted read for, so an
// incompatible charge is the server's refusal to give — surfaced as the fitting
// slice's action error, in the server's own words.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const MODULE_ID = 9988400094759;
const CHARGE_ID = 9988400094757;

interface Recorded {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function makeFakeBff(options: { ammoStatus?: number; ammoBody?: unknown } = {}) {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    const respond = (status: number, payload: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
    });
    if (path.startsWith("/api/bridge/dogma/ammo/")) {
      return respond(options.ammoStatus ?? 200, options.ammoBody ?? { ok: true, applied: true });
    }
    // The fitting re-read that every fitting action runs afterwards.
    if (path.startsWith("/api/bridge/fitting")) {
      return respond(200, { ok: true, activeShipID: 1, slots: null, shipInfo: null, online: null, errors: {} });
    }
    return respond(200, { ok: true });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

test("loadAmmo names the module, the charge stack and a PLACE — never a location id", async () => {
  const store = createClientStore();
  const bff = makeFakeBff();
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  const write = bff.requests.find((r) => r.path === "/api/bridge/dogma/ammo/load");
  assert.deepEqual(write?.body, {
    moduleIDs: [MODULE_ID],
    chargeItemIDs: [CHARGE_ID],
    source: "hangar",
    confirm: true,
  });
});

test("cargo is the other place, and it travels as a word too", async () => {
  const store = createClientStore();
  const bff = makeFakeBff();
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  assert.equal(
    bff.requests.find((r) => r.path === "/api/bridge/dogma/ammo/load")?.body.source,
    "cargo",
  );
});

test("unloadAmmo empties the module completely — no partial-quantity control", async () => {
  const store = createClientStore();
  const bff = makeFakeBff();
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.unloadAmmo([MODULE_ID], "hangar");

  const write = bff.requests.find((r) => r.path === "/api/bridge/dogma/ammo/unload");
  assert.deepEqual(write?.body, {
    moduleIDs: [MODULE_ID],
    destination: "hangar",
    confirm: true,
  });
  // An omitted quantity is what makes the server empty it; sending 0 or null
  // would be a different request the BFF rejects.
  assert.equal("quantity" in (write?.body ?? {}), false);
});

test("both verbs re-read the fit afterwards — the panel shows what the SERVER did", async () => {
  const store = createClientStore();
  const bff = makeFakeBff();
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  const order = bff.requests.map((r) => r.path);
  const wrote = order.indexOf("/api/bridge/dogma/ammo/load");
  const reread = order.findIndex((p, i) => i > wrote && p.startsWith("/api/bridge/fitting"));
  assert.ok(reread > wrote, "the fit is re-read after the load, not before");
});

// ⚠ THE INCOMPATIBLE-CHARGE PATH. The panel offers every charge in the chosen
// inventory on purpose, so this refusal is a NORMAL outcome rather than an edge
// case — it has to arrive in the player's words, not vanish.
test("⚠ a charge the module will not take surfaces the SERVER's own refusal", async () => {
  const store = createClientStore();
  const bff = makeFakeBff({
    ammoStatus: 409,
    ammoBody: {
      ok: false,
      error: "CALL_REFUSED",
      message: "That module cannot use that type of charge.",
    },
  });
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.match(store.fitting.get().actionError ?? "", /cannot use that type of charge/i);
});

// --- ⚠ The silent decline ------------------------------------------------------
//
// MEASURED LIVE, and the reason this verification exists. dogmaIM.LoadAmmo
// returns null whether it loaded or refused, so the BFF answers a flat
// `{ok:true, applied:true, result:null, notifications:[]}` either way. Clicking
// "Load Arch Angel Carbonized Lead XL" into a 150mm Light AutoCannon I on a live
// Rifter produced exactly that envelope, changed nothing, and told the player
// nothing at all. The RE-READ is the only authority.

/** A fitting read whose one high slot holds `charge` (or nothing). */
function fittingBody(charge: { typeID: number; quantity: number } | null) {
  const rows: unknown[] = [
    { type: "packedrow", fields: { itemID: MODULE_ID, typeID: 485, groupID: 55, categoryID: 7, flagID: 27, quantity: -1 } },
  ];
  if (charge) {
    rows.push({
      type: "packedrow",
      fields: { itemID: 777, typeID: charge.typeID, groupID: 83, categoryID: 8, flagID: 27, quantity: charge.quantity },
    });
  }
  return {
    ok: true,
    activeShipID: 1,
    slots: { type: "list", items: rows },
    shipInfo: {
      type: "dict",
      entries: [
        [
          1,
          {
            type: "object",
            name: "util.KeyVal",
            args: { type: "dict", entries: [["attributes", { type: "dict", entries: [[14, 4]] }]] },
          },
        ],
      ],
    },
    online: { type: "list", items: [MODULE_ID] },
    errors: {},
  };
}

/** A BFF whose fitting read returns a scripted sequence of charge states. */
function makeAmmoBff(states: (({ typeID: number; quantity: number }) | null)[], notifications: unknown[] = []) {
  const requests: Recorded[] = [];
  let read = 0;
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    const respond = (payload: unknown) => ({ ok: true, status: 200, async json() { return payload; } });
    if (path.startsWith("/api/bridge/dogma/ammo/")) {
      // The envelope the live server actually sends, refusal or not.
      return respond({ ok: true, applied: true, result: null, notifications });
    }
    if (path.startsWith("/api/bridge/fitting")) {
      const state = states[Math.min(read, states.length - 1)] ?? null;
      read += 1;
      return respond(fittingBody(state));
    }
    return respond({ ok: true });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

test("⚠ a load that changed nothing is reported, not passed off as success", async () => {
  const store = createClientStore();
  // Loaded before, identically loaded after: the XL round went nowhere.
  const loaded = { typeID: 184, quantity: 160 };
  const bff = makeAmmoBff([loaded, loaded]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  const message = store.fitting.get().actionError ?? "";
  assert.match(message, /loaded nothing/i);
  assert.match(message, /gave no reason/i);
  // And it points at the real cause without diagnosing this particular call.
  assert.match(message, /only takes certain kinds of charge/i);
});

test("a load that DID change what is held says nothing", async () => {
  const store = createClientStore();
  const bff = makeAmmoBff([null, { typeID: 184, quantity: 160 }]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null);
});

test("reloading the same type but a different amount counts as a change", async () => {
  const store = createClientStore();
  const bff = makeAmmoBff([{ typeID: 184, quantity: 40 }, { typeID: 184, quantity: 160 }]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null, "topping a stack up is a real load");
});

test("⚠ an unload that left the ammunition in place is reported", async () => {
  const store = createClientStore();
  const loaded = { typeID: 184, quantity: 160 };
  const bff = makeAmmoBff([loaded, loaded]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  await flow.unloadAmmo([MODULE_ID], "hangar");

  assert.match(store.fitting.get().actionError ?? "", /still loaded/i);
});

test("an unload that emptied the module says nothing", async () => {
  const store = createClientStore();
  const bff = makeAmmoBff([{ typeID: 184, quantity: 160 }, null]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  await flow.unloadAmmo([MODULE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null);
});

// In space the server QUEUES a load for the module's reload time, so the fit
// read straight after the call still shows the gun empty. Its announcement
// (`OnChargeBeingLoadedToModule`, drained with the LoadAmmo response) is the
// proof the load is coming, and must not be reported as a load that did nothing.
const RELOAD_ANNOUNCED = {
  method: "OnChargeBeingLoadedToModule",
  args: [{ type: "list", items: [MODULE_ID] }, 184, 10000],
};

test("an in-space load the server queued and announced is reloading, not declined", async () => {
  const store = createClientStore();
  // A drained notification is only applied for the pilot it was drained for.
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Synthetic Pilot",
      stationID: null,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 98000001,
    },
    station: null,
  });
  const bff = makeAmmoBff([null, null], [RELOAD_ANNOUNCED]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  const outcome = await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  assert.equal(outcome, "reloading");
  assert.equal(store.fitting.get().actionError, null);
  const reload = store.fitting.get().reloads[MODULE_ID];
  assert.equal(reload?.chargeTypeID, 184);
  assert.equal(reload?.durationMs, 10000);
});

test("without the announcement an unchanged fit is still a decline", async () => {
  const store = createClientStore();
  const bff = makeAmmoBff([null, null]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  const outcome = await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  assert.equal(outcome, "unchanged");
  assert.match(store.fitting.get().actionError ?? "", /loaded nothing/i);
});

test("a load the fit shows is changed", async () => {
  const store = createClientStore();
  const bff = makeAmmoBff([null, { typeID: 184, quantity: 160 }]);
  const flow = createAppFlow(store, { fetch: bff.fetch });

  await flow.loadFitting();
  assert.equal(await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo"), "changed");
});
