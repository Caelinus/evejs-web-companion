// The fitting window as it actually RENDERS (goal R21).
//
// fittingGeometry.test.ts pins the maths; this pins that the panel is wired to
// it — that the ring the player sees has exactly the sockets the SERVER's slot
// counts imply, on two different hulls, with no 8/8/8 anywhere.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile } from "svelte/compiler";
import { decodeGetAllInfo } from "../bridge/boundDogma.ts";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { createAppFlow } = await import("../app/flow.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

/**
 * A `GET /api/bridge/fitting` envelope in raw retail shapes, for a hull with
 * the given slot counts. Everything the panel draws comes from here — this is
 * the SERVER speaking.
 */
function rawFittingRead(
  counts: { high: number; mid: number; low: number; rig: number },
  fitted: readonly { itemID: number; typeID: number; flagID: number }[] = [],
  extraAttributes: Record<number, number | null> = {},
): unknown {
  const attributes: Record<number, number | null> = {
    48: 168,
    49: 3.6,
    11: 88.44,
    15: 6,
    482: null,
    18: 460,
    1132: 400,
    1152: 100,
    14: counts.high,
    13: counts.mid,
    12: counts.low,
    1137: counts.rig,
    ...extraAttributes,
  };
  return {
    ok: true,
    activeShipID: 9988400029047,
    stationID: 60003760,
    slots: {
      type: "list",
      items: fitted.map((row) => packedRow({ ...row, groupID: 53 })),
    },
    shipInfo: {
      type: "dict",
      entries: [
        [
          9988400029047,
          {
            type: "object",
            name: "util.KeyVal",
            args: {
              type: "dict",
              entries: [
                ["itemID", 9988400029047],
                [
                  "attributes",
                  {
                    type: "dict",
                    entries: Object.entries(attributes).map(([id, value]) => [Number(id), value]),
                  },
                ],
              ],
            },
          },
        ],
      ],
    },
    online: { type: "list", items: fitted.length > 0 ? [fitted[0]!.itemID] : [] },
    errors: { slots: null, shipInfo: null, online: null },
  };
}

function fittingFetch(envelope: unknown): typeof fetch {
  return (async (input: unknown) => ({
    ok: true,
    status: 200,
    async json() {
      return String(input) === "/api/bridge/fitting" ? envelope : { ok: true, applied: true };
    },
  })) as unknown as typeof fetch;
}

async function renderFitting(envelope: unknown): Promise<string> {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fittingFetch(envelope) });
  await flow.loadFitting();
  const { default: Panel } = (await import("./Fitting.svelte")) as { default: unknown };
  return render(Panel as never, { props: { store, flow } } as never).body;
}

/**
 * How many sockets the ring drew. Anchored on the socket BUTTON's class, which
 * always begins `fit-socket ` — a looser pattern also catches the
 * `fit-socket-text` span inside each one and silently doubles the count.
 */
function socketCount(body: string): number {
  return (body.match(/class="fit-socket /g) ?? []).length;
}

test("the module detail renders completed dogma readings and a first-read failure", async () => {
  // SSR skips onMount, which normally selects list view on a narrow screen.
  // Initialize only that view in memory so the real module-details template runs.
  const filename = path.join(UI_DIR, "Fitting.svelte");
  const source = readFileSync(filename, "utf8");
  const initialView = 'let view = $state<"radial" | "list">("radial");';
  assert.ok(source.includes(initialView));
  const { js } = compile(source.replace(initialView, 'let view = $state<"radial" | "list">("list");'), {
    filename, generate: "server",
  });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) =>
    `from ${JSON.stringify(import.meta.resolve(specifier))}`);
  const { default: Panel } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fittingFetch(rawFittingRead(
    { high: 1, mid: 0, low: 0, rig: 0 }, [{ itemID: 90000011, typeID: 589, flagID: 27 }],
  )) });
  await flow.loadFitting();
  // Finish its companion read before installing the deliberate dogma fixture.
  await flow.loadDogma();
  const snapshot = decodeGetAllInfo({ type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["activeShipID", 9988400029047],
    ["shipInfo", { type: "dict", entries: [[90000011, {
      type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
        ["itemID", 90000011], ["attributes", { type: "dict", entries: [[54, 18500], [73, 4500]] }],
      ] },
    }]] }],
  ] } });
  store.apply({ type: "dogma/loaded", allInfo: snapshot, error: null });
  let body = render(Panel, { props: { store, flow } }).body;
  assert.match(body, /Optimal range/);
  assert.match(body, /18\.5 km/);
  assert.match(body, /Activation time/);
  assert.match(body, /4\.5 s/);
  assert.doesNotMatch(body, /Reading this module/);

  store.apply({ type: "dogma/loaded", allInfo: null, error: "Read interrupted" });
  body = render(Panel, { props: { store, flow } }).body;
  assert.match(body, /18\.5 km/, "a refresh failure retains the last effective stats");
  store.apply({ type: "fitting/cleared" });
  await flow.loadFitting();
  await flow.loadDogma();
  store.apply({ type: "dogma/loaded", allInfo: null, error: "Read interrupted" });
  body = render(Panel, { props: { store, flow } }).body;
  assert.match(body, /effective stats could not be read: Read interrupted/);
  assert.doesNotMatch(body, /Reading this module/);
});

test("the ring draws exactly the sockets the server's slot counts imply", async () => {
  // A Rifter: 4 high / 3 mid / 3 low / 3 rig = 13 sockets.
  const rifter = await renderFitting(rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }));
  assert.equal(socketCount(rifter), 13);

  // A Drake: 8 / 6 / 5 / 3 = 22. Same component, a different ring — which is
  // only possible if the counts really do come from the read.
  const drake = await renderFitting(rawFittingRead({ high: 8, mid: 6, low: 5, rig: 3 }));
  assert.equal(socketCount(drake), 22);
});

test("every socket is positioned by the geometry, not by a stylesheet guess", async () => {
  const body = await renderFitting(rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }));
  const positioned = body.match(/left: [\d.]+%; top: [\d.]+%/g) ?? [];
  assert.equal(positioned.length, 13, "each socket carries its own computed position");
  // The positions are genuinely different from one another.
  assert.equal(new Set(positioned).size, 13);
});

test("the ring names the slot families and reports how many are filled", async () => {
  const body = await renderFitting(
    rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }, [
      { itemID: 5001, typeID: 3634, flagID: 27 },
      { itemID: 5004, typeID: 31358, flagID: 92 },
    ]),
  );
  assert.match(body, /High slots: 1 of 4 filled/);
  assert.match(body, /Mid slots: 0 of 3 filled/);
  assert.match(body, /Rigs: 1 of 3 filled/);
});

test("a socket says in words which slot it is and what state it is in", async () => {
  const body = await renderFitting(
    rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }, [
      { itemID: 5001, typeID: 3634, flagID: 27 },
      { itemID: 5002, typeID: 3634, flagID: 28 },
    ]),
  );
  // Slot 1 is online (it is in the `online` list), slot 2 is not.
  assert.match(body, /High slot 1, .*, online/);
  assert.match(body, /High slot 2, .*, offline/);
  assert.match(body, /High slot 3, empty/);
  // Rigs have no online state to speak of, so they never claim one.
  assert.match(body, /Rig 1, empty/);
});

test("a hull with no rigs and no subsystems draws neither", async () => {
  const body = await renderFitting(rawFittingRead({ high: 2, mid: 1, low: 1, rig: 0 }));
  assert.equal(socketCount(body), 4);
  assert.doesNotMatch(body, /Rigs:/);
  assert.doesNotMatch(body, /Subsystems:/);
});

test("R7d: the ring never renders a raw numeric ID", async () => {
  const body = await renderFitting(
    rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }, [
      { itemID: 5001, typeID: 3634, flagID: 27 },
    ]),
  );
  // The ship's itemID, the module's itemID and its flagID are all absent from
  // anything the player can read. (The typeID appears only inside the icon's
  // src, which is an asset path and not data on screen — asserted separately.)
  assert.equal(body.includes("9988400029047"), false);
  assert.equal(body.includes("5001"), false);
  const visible = body.replace(/<img[^>]*>/g, "").replace(/<[^>]+>/g, " ");
  assert.equal(/\b3634\b/.test(visible), false, "a typeID must never be visible text");
  assert.equal(/\bflag\b/i.test(visible), false);
});

// --- the toggle -------------------------------------------------------------

test("both views exist and the toggle names them in plain language", async () => {
  const body = await renderFitting(rawFittingRead({ high: 4, mid: 3, low: 3, rig: 3 }));
  assert.match(body, /Ship view/);
  assert.match(body, /List view/);
  // The ring is the default above the breakpoint, so it is what rendered.
  assert.match(body, /fit-ring/);
});

test("the panel remembers the chosen view and defaults from the viewport", () => {
  // The behaviour lives in onMount (which the server generator never runs), so
  // this pins the wiring by reading it: a remembered choice wins, and with
  // none the R8 breakpoint decides.
  const source = readFileSync(path.join(UI_DIR, "Fitting.svelte"), "utf8");
  assert.match(source, /localStorage\?\.getItem\(VIEW_STORAGE_KEY\)/);
  assert.match(source, /localStorage\?\.setItem\(VIEW_STORAGE_KEY, next\)/);
  assert.match(source, /matchMedia\?\.\("\(max-width: 640px\)"\)/);
});

// --- the sockets drive R12's existing actions, they do not reimplement them --

test("socket actions route into the R12 flow calls, unchanged", () => {
  const source = readFileSync(path.join(UI_DIR, "Fitting.svelte"), "utf8");
  // The panel owns exactly one call site per action, shared by BOTH views —
  // the ring reuses R12's handlers rather than growing a parallel set. The one
  // exception is fitModule, which has two deliberate call sites: into a chosen
  // slot (fitInto) and into the first free one (fitAnywhere, the server-picked
  // auto-fit flag).
  const callSites: Readonly<Record<string, number>> = {
    "flow.fitModule(": 2,
    "flow.unfitModule(": 1,
    "flow.setModuleOnline(": 1,
    "flow.destroyRig(": 1,
  };
  for (const [call, expected] of Object.entries(callSites)) {
    assert.equal(
      source.split(call).length - 1,
      expected,
      `${call} must have exactly ${expected} call site(s), shared by the ring and the list`,
    );
  }
  // Clicking a socket goes through those same helpers.
  assert.match(source, /function clickSocket/);
  assert.match(source, /fitInto\(slot\)/);
});

test("removing a rig from a socket still takes two deliberate steps", () => {
  const source = readFileSync(path.join(UI_DIR, "Fitting.svelte"), "utf8");
  // The destroy button is only reachable once confirmingRigID is armed, and
  // arming it is its own click.
  assert.match(source, /confirmingRigID === selectedSlot\.module\.itemID/);
  assert.match(source, /Destroy rig…/);
  assert.match(source, /Yes, destroy it/);
  assert.match(source, /Destroying a rig is permanent/);
});

// --- the statistic panels ---------------------------------------------------

/**
 * The `drake-shield` fit's real ship attributes, as `ShipGetInfo` returns them
 * (assumed-active — both hardeners applied). The same numbers
 * `bridge/shipStats.test.ts` checks the maths against; here they prove the
 * maths actually reaches the screen.
 */
const DRAKE_ATTRIBUTES: Record<number, number | null> = {
  4: 13500000,
  9: 4687.5,
  37: 187.5,
  38: 450,
  55: 468750,
  70: 0.43875,
  76: 81250,
  109: 0.67,
  110: 0.67,
  111: 0.67,
  113: 0.67,
  192: 8,
  211: 22.8,
  263: 17688.4375,
  265: 4062.5,
  267: 0.5,
  268: 0.9,
  269: 0.75,
  270: 0.55,
  271: 0.38746944336953026,
  272: 0.19373472168476513,
  273: 0.23248166602171813,
  274: 0.30997555469562427,
  283: 25,
  482: 3125,
  552: 377.991936,
  564: 243.75,
  600: 3.5,
  1271: 25,
  1281: 1,
};

async function renderDrake(): Promise<string> {
  return renderFitting(rawFittingRead({ high: 8, mid: 6, low: 5, rig: 3 }, [], DRAKE_ATTRIBUTES));
}

test("the defence panel shows the real resistances and EHP on screen", async () => {
  const body = await renderDrake();
  // The oracle's own figures for this fit, rendered.
  assert.match(body, /61\.3%/, "shield EM resist should be on screen");
  assert.match(body, /80\.6%/, "shield explosive resist should be on screen");
  assert.match(body, /75,982/, "total effective HP should be on screen");
  // And the damage profile it is quoted against, because EHP without one is
  // a meaningless number.
  assert.match(body, /25\/25\/25\/25/);
});

test("the defence panel names each layer in words, not just in colour", async () => {
  const body = await renderDrake();
  assert.match(body, /Shield/);
  assert.match(body, /Armor/);
  assert.match(body, /Structure/);
  // The triad tokens are applied as classes alongside those words.
  assert.match(body, /class="layer-shield"/);
  assert.match(body, /class="layer-armor"/);
  assert.match(body, /class="layer-hull"/);
});

test("navigation and targeting figures reach the screen", async () => {
  const body = await renderDrake();
  assert.match(body, /8\.21 s/, "align time");
  assert.match(body, /187\.5 m\/s/, "top speed");
  assert.match(body, /3\.5 AU\/s/, "warp speed");
  assert.match(body, /81\.3 km/, "targeting range in km");
  assert.match(body, /Gravimetric sensor strength/, "the hull's own sensor, named");
});

test("a statistic we cannot source says so in words, never as a zero", async () => {
  const body = await renderDrake();
  // DPS, volley, mining, repairs, cap delta and cap stability all need
  // per-module numbers or a solver we do not have.
  const unavailable = body.match(/class="stat-unavailable"/g) ?? [];
  assert.ok(
    unavailable.length >= 8,
    `expected the unsourceable statistics to be marked, found ${unavailable.length}`,
  );
  assert.match(body, /Unavailable/);
  // Each one carries its reason, so the player is told WHY rather than left
  // wondering whether the number really is zero.
  assert.match(body, /title="[^"]*cannot be worked out[^"]*"/);
  assert.match(body, /title="[^"]*not supported yet[^"]*"/);
});

test("the unsourceable statistics are labelled, so nothing reads as zero", async () => {
  const body = await renderDrake();
  // The rows exist (the player can see what is missing rather than the panel
  // silently omitting it) but none of them claims a value.
  for (const label of [
    "Damage per second",
    "Volley damage",
    "Mining yield",
    "Lasts for",
    "Shield repaired per second",
  ]) {
    assert.ok(body.includes(label), `${label} should be listed`);
  }
  // The capacitor figures we CAN source are shown as real numbers.
  assert.match(body, /3,125 GJ/);
  assert.match(body, /468\.75 s/);
});

test("before any read, every statistic is unavailable rather than zero", async () => {
  const { default: Panel } = (await import("./Fitting.svelte")) as { default: unknown };
  const store = createClientStore();
  const body = render(Panel as never, {
    props: { store, flow: new Proxy({}, { get: () => async () => {} }) },
  } as never).body;
  // No ship, so no statistics panel at all — and certainly no zeroes claimed.
  assert.doesNotMatch(body, /0 GJ/);
  assert.match(body, /No active ship/);
});
