// The R15 Industry controller against a faked BFF: loadIndustry decodes the
// five reads into the store, asks for the NAMES of everything it will render,
// and follows up with the STATIC recipes for the blueprint types it saw.
//
// The properties that matter here are the ones that keep the panel honest when
// something goes wrong: an independent read failing must not blank the rest, a
// failed recipe fetch must not blank the panel at all (it is static data), and
// a lost session must unwind to character select.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;
const BLUEPRINT_TYPE_ID = 681;
const BLUEPRINT_ITEM_ID = 7_100_000_001;
const PRODUCT_TYPE_ID = 165;

function keyVal(fields: Record<string, unknown>): unknown {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: Object.entries(fields) },
  };
}

function list(items: readonly unknown[]): unknown {
  return { type: "list", items };
}

function dict(entries: readonly (readonly [unknown, unknown])[]): unknown {
  return { type: "dict", entries };
}

function industryPanel(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ownerID: 7,
    stationID: STATION_ID,
    solarSystemID: SOLAR_SYSTEM_ID,
    blueprints: {
      // ⚠ A 2-TUPLE: [rows, facilityID -> count].
      result: [
        list([
          keyVal({
            typeID: BLUEPRINT_TYPE_ID,
            itemID: BLUEPRINT_ITEM_ID,
            timeEfficiency: 20,
            materialEfficiency: 10,
            runs: 40,
            locationID: STATION_ID,
            facilityID: null,
            ownerID: 7,
            jobID: null,
            original: false,
          }),
        ]),
        dict([[STATION_ID, 1]]),
      ],
      error: null,
    },
    jobs: {
      result: list([
        keyVal({
          activityID: 1,
          jobID: 4_200_001,
          blueprintID: BLUEPRINT_ITEM_ID,
          blueprintTypeID: BLUEPRINT_TYPE_ID,
          facilityID: STATION_ID,
          status: 3,
          runs: 3,
          successfulRuns: 0,
          cost: 1250,
          timeInSeconds: 1800,
          productTypeID: PRODUCT_TYPE_ID,
          startDate: { type: "long", value: "133000000000000000" },
          endDate: { type: "long", value: "133000000018000000" },
        }),
      ]),
      error: null,
    },
    jobCounts: { result: dict([[1, 1]]), error: null },
    facilities: {
      result: list([
        keyVal({
          facilityID: STATION_ID,
          typeID: 52678,
          ownerID: 1000035,
          tax: 0.01,
          solarSystemID: SOLAR_SYSTEM_ID,
          online: true,
          activities: dict([
            [1, { type: "tuple", items: [] }],
            [5, { type: "tuple", items: [] }],
          ]),
        }),
      ]),
      error: null,
    },
    activityModifiers: { result: dict([[1, 1.0]]), error: null },
    ...overrides,
  };
}

const RAW_DEFINITIONS = {
  [String(BLUEPRINT_TYPE_ID)]: {
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    blueprintName: "Clone Grade Beta Blueprint",
    productTypeID: PRODUCT_TYPE_ID,
    productName: "Clone Grade Beta",
    maxProductionLimit: 300,
    activities: {
      manufacturing: {
        materials: [{ typeID: 38, quantity: 86 }],
        products: [{ typeID: PRODUCT_TYPE_ID, quantity: 1 }],
        time: 600,
      },
      copying: { time: 480 },
    },
  },
};

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
    if (path === "/api/bridge/industry") {
      return { status: 200, body: industryPanel() };
    }
    if (path === "/api/industry/blueprints") {
      return {
        status: 200,
        body: { ok: true, source: "static-data", definitions: RAW_DEFINITIONS },
      };
    }
    if (path === "/api/names") {
      return { status: 200, body: { ok: true, names: {} } };
    }
    return { status: 200, body: { ok: true } };
  };
}

/** Let the microtask-batched name queue flush. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- the read ---------------------------------------------------------------

test("loadIndustry decodes blueprints, jobs, slots and facilities into the store", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(respondOk());
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();

  const industry = store.get().industry;
  assert.equal(industry.loaded, true);
  assert.equal(industry.ownerID, 7);
  assert.equal(industry.solarSystemID, SOLAR_SYSTEM_ID);

  assert.equal(industry.blueprints.length, 1);
  assert.equal(industry.blueprints[0]!.materialEfficiency, 10);
  assert.equal(industry.blueprints[0]!.timeEfficiency, 20);
  assert.equal(industry.blueprints[0]!.runs, 40);

  assert.equal(industry.jobs.length, 1);
  // The SERVER said ready; the browser did no clock arithmetic of its own.
  assert.equal(industry.jobs[0]!.status, "ready");
  assert.equal(industry.jobs[0]!.activity, "manufacturing");

  assert.deepEqual(industry.slotsUsed, { manufacturing: 1 });

  assert.equal(industry.facilities.length, 1);
  assert.deepEqual(industry.facilities[0]!.activities, ["manufacturing", "copying"]);
});

test("loadIndustry fetches the STATIC recipes for the blueprint types it saw", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(respondOk());
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();

  const recipeCall = requests.find((entry) => entry.path === "/api/industry/blueprints");
  assert.ok(recipeCall, "the recipes must be fetched");
  assert.deepEqual(recipeCall.body.blueprintTypeIDs, [BLUEPRINT_TYPE_ID]);

  const definition = store.get().industry.definitions[BLUEPRINT_TYPE_ID]!;
  assert.equal(definition.productName, "Clone Grade Beta");
  assert.deepEqual(
    definition.recipes.map((recipe) => recipe.activity),
    ["manufacturing", "copying"],
  );
});

test("a second load does not refetch recipes it already holds", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(respondOk());
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();
  await flow.loadIndustry();

  const recipeCalls = requests.filter((entry) => entry.path === "/api/industry/blueprints");
  assert.equal(recipeCalls.length, 1, "static recipes are fetched once and cached");
});

test("loadIndustry asks for the NAMES of every id the panel will render", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(respondOk());
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();
  await settle();

  const nameCall = requests.find((entry) => entry.path === "/api/names");
  assert.ok(nameCall, "names must be requested (R7d: nothing renders as a number)");
  const asked = (nameCall.body.items as { kind: string; id: number }[]).map(
    (ref) => `${ref.kind}:${ref.id}`,
  );
  // The blueprint, the product it makes, and the facility + system it runs in.
  assert.ok(asked.includes(`type:${BLUEPRINT_TYPE_ID}`));
  assert.ok(asked.includes(`type:${PRODUCT_TYPE_ID}`));
  assert.ok(asked.includes(`station:${STATION_ID}`));
  assert.ok(asked.includes(`system:${SOLAR_SYSTEM_ID}`));
});

test("a failed facility read never blanks the blueprints or the jobs", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry"
        ? {
            status: 200,
            body: industryPanel({ facilities: { result: null, error: "CALL_FAILED" } }),
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();

  const industry = store.get().industry;
  assert.equal(industry.facilitiesError, "CALL_FAILED");
  assert.deepEqual(industry.facilities, []);
  // The rest of the panel is intact.
  assert.equal(industry.blueprints.length, 1);
  assert.equal(industry.jobs.length, 1);
  assert.equal(industry.blueprintsError, null);
});

test("a failed job-slot read is reported as a jobs-side failure", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry"
        ? {
            status: 200,
            body: industryPanel({ jobCounts: { result: null, error: "CALL_FAILED" } }),
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.loadIndustry();
  assert.equal(store.get().industry.jobsError, "CALL_FAILED");
  // The jobs themselves still read fine, so they are still shown.
  assert.equal(store.get().industry.jobs.length, 1);
});

test("a failed recipe fetch leaves the panel fully populated", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/industry/blueprints"
        ? { status: 500, body: { ok: false, error: "BOOM" } }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  // Static reference data: its failure must not throw or blank anything.
  await flow.loadIndustry();

  const industry = store.get().industry;
  assert.equal(industry.loaded, true);
  assert.equal(industry.blueprints.length, 1);
  assert.equal(industry.jobs.length, 1);
  assert.deepEqual(industry.definitions, {});
});

test("a lost session during an industry read unwinds to character select", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(() => flow.loadIndustry());
  assert.equal(store.get().station.online, null, "the character is offline again");
  assert.equal(store.get().industry.loaded, false, "the industry slice is cleared");
});

// --- Slice B: install / deliver / cancel ------------------------------------

test("installIndustryJob passes the request through and reloads the panel", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/install"
        ? { status: 200, body: { ok: true, applied: true, declinedSilently: false, jobID: 5 } }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.installIndustryJob({
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "manufacturing",
    facilityID: STATION_ID,
    runs: 3,
  });

  const install = requests.find((entry) => entry.path === "/api/bridge/industry/install");
  assert.ok(install);
  // The browser names the ACTIVITY; the activityID lives only on the BFF.
  assert.equal(install.body.activity, "manufacturing");
  assert.equal(install.body.runs, 3);
  // The second gate behind the UI's own confirm.
  assert.equal(install.body.confirm, true);
  // The panel reloaded, so it shows server truth rather than an optimistic edit.
  assert.ok(
    requests.filter((entry) => entry.path === "/api/bridge/industry").length >= 1,
    "the panel must reload after a mutation",
  );
  assert.equal(store.get().industry.actionError, null);
});

test("a SILENT decline is reported as a decline with no invented cause", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/install"
        ? {
            status: 200,
            body: { ok: true, applied: false, declinedSilently: true, jobID: null },
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.installIndustryJob({
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "manufacturing",
    facilityID: STATION_ID,
    runs: 1,
  });

  const message = store.get().industry.actionError ?? "";
  assert.match(message, /gave no reason/i);
  // It must not guess at a cause the server never gave.
  assert.doesNotMatch(message, /material|fee|slot|skill/i);
});

test("a STRUCTURED refusal becomes the server's own reasons in plain words", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/install"
        ? {
            status: 409,
            body: {
              ok: false,
              error: "CALL_REFUSED",
              message: "IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS",
            },
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.installIndustryJob({
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "manufacturing",
    facilityID: STATION_ID,
    runs: 1,
  });

  const message = store.get().industry.actionError ?? "";
  assert.match(message, /materials/i, "the server said MISSING_MATERIAL");
  assert.match(message, /installation fee/i, "the server said ACCOUNT_FUNDS");
  // The raw code is jargon and must never reach the player (R9a / R7d).
  assert.doesNotMatch(message, /MISSING_MATERIAL|ACCOUNT_FUNDS|IndustryValidationError/);
});

test("a PROSE refusal is passed through verbatim - the handler's own words", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/deliver"
        ? {
            status: 409,
            body: {
              ok: false,
              error: "CALL_REFUSED",
              message: "That industry job is not ready yet.",
            },
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  await flow.deliverIndustryJob(5);
  assert.equal(store.get().industry.actionError, "That industry job is not ready yet.");
});

test("deliver and cancel reload the panel and clear a stale error on success", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/deliver" || path === "/api/bridge/industry/cancel"
        ? { status: 200, body: { ok: true, applied: true, declinedSilently: false, jobID: 5 } }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  store.apply({ type: "industry/action-error", message: "something old" });
  await flow.deliverIndustryJob(5);
  assert.equal(store.get().industry.actionError, null);

  await flow.cancelIndustryJob(5);
  const cancel = requests.find((entry) => entry.path === "/api/bridge/industry/cancel");
  assert.ok(cancel);
  // Cancelling refunds nothing, so it carries the confirmation flag too.
  assert.equal(cancel.body.confirm, true);
  assert.equal(cancel.body.jobID, 5);
});

test("the preview returns what the player HAS, and starts nothing", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/bridge/industry/preview"
        ? { status: 200, body: { ok: true, available: { "38": 500 } } }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  const available = await flow.previewIndustryJob({
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "manufacturing",
    facilityID: STATION_ID,
    runs: 3,
  });
  assert.deepEqual(available, { "38": 500 });
  assert.equal(
    requests.some((entry) => entry.path === "/api/bridge/industry/install"),
    false,
    "a preview must never install anything",
  );
});

test("a lost session during a mutation unwinds to character select", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(() =>
    flow.installIndustryJob({
      blueprintItemID: BLUEPRINT_ITEM_ID,
      blueprintTypeID: BLUEPRINT_TYPE_ID,
      activity: "manufacturing",
      facilityID: STATION_ID,
      runs: 1,
    }),
  );
  assert.equal(store.get().station.online, null);
});

test("an invention install carries its decryptor; the decryptor list is read from static data", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(
    respondOk((path) =>
      path === "/api/industry/invention-terms"
        ? {
            status: 200,
            body: {
              ok: true,
              lowerRateSkillTypeIDs: [],
              decryptors: [{ typeID: 34204, name: "Parity Decryptor", probabilityMultiplier: 1.5, materialEfficiency: 1, timeEfficiency: -2, maxRuns: 3 }],
            },
          }
        : null,
    ),
  );
  const flow = createAppFlow(store, { fetch });

  const decryptors = await flow.loadDecryptors();
  assert.deepEqual(decryptors.map((decryptor) => [decryptor.typeID, decryptor.maxRuns]), [[34204, 3]]);

  await flow.installIndustryJob({
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "invention",
    facilityID: STATION_ID,
    runs: 2,
    decryptorTypeID: 34204,
  });
  const install = requests.find((entry) => entry.path === "/api/bridge/industry/install");
  assert.ok(install);
  assert.equal(install.body.decryptorTypeID, 34204);
  assert.equal(install.body.confirm, true);
});
