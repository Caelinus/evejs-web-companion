// The distance a ranged flight verb flies at (web/src/ui/spaceRanges.ts), and
// the storage rule underneath it.
//
// ⚠ WHAT THIS SUITE IS REALLY GUARDING. Orbit and keep-at-range are the two
// verbs where the app has to remember a number on the player's behalf, and the
// in-space redesign moves the PICKING of that number from Settings onto the
// action button itself. The danger in that move is not the picker — it is
// ending up with two places that both believe they own the value. So:
//
//   1. there is ONE stored home per verb, and this module only names it;
//   2. a CUSTOM distance survives a reload, which it did not before — the
//      loader validated against the fixed ladder and would have accepted a
//      typed number until the next refresh and then silently dropped it back
//      to 1 km. A setting that works until you stop watching it is worse than
//      one that refuses outright.
//   3. nothing here ever arrives at 0 metres by failing to read something. A
//      zero-metre orbit is a real instruction — fly into it.

import test from "node:test";
import assert from "node:assert/strict";

import { HOLD_RANGES, rangeLabel, WARP_RANGES } from "./flyingDistances.ts";
import {
  MAX_RANGE_METRES,
  RANGE_PRESETS,
  isPresetRange,
  parseCustomRange,
  rangeActionLabel,
  rangeName,
  rangeStorageKey,
  storedRangeMetres,
} from "./spaceRanges.ts";

// --- one stored home per verb ------------------------------------------------

test("each ranged verb names the field it is stored under", () => {
  assert.equal(rangeStorageKey("orbit"), "orbit");
  // ⚠ `keep` is stored as `hold`: that is what the field has always been called
  // and what the dispatcher reads for keepAtRange. Renaming it would drop every
  // player's stored distance, because the loader discards fields it cannot name.
  assert.equal(rangeStorageKey("keep"), "hold");
});

test("the two verbs do not share one stored distance", () => {
  assert.notEqual(rangeStorageKey("orbit"), rangeStorageKey("keep"));
});

// --- the ladder --------------------------------------------------------------

test("the ladder is the app's existing one, which already covers the handoff's", () => {
  // The handoff asks for 1 / 5 / 10 / 20 km. The app offers those plus 500 m,
  // 2.5 km and 30 km, so there is nothing to merge — adopting the handoff's
  // four would only take choices away from a player who already has them.
  const metres = RANGE_PRESETS.map((choice) => choice.metres);
  for (const asked of [1000, 5000, 10000, 20000]) {
    assert.ok(metres.includes(asked), `the handoff's ${asked} m step is missing`);
  }
  assert.deepEqual(metres, HOLD_RANGES.map((choice) => choice.metres));
});

test("a ladder step is recognised as one; anything else is custom", () => {
  assert.equal(isPresetRange(5000), true);
  assert.equal(isPresetRange(500), true);
  assert.equal(isPresetRange(7500), false, "a typed distance is not a ladder step");
  assert.equal(isPresetRange(0), false);
});

// --- reading a typed distance ------------------------------------------------

test("a custom distance is typed in KILOMETRES and stored in metres", () => {
  assert.equal(parseCustomRange("7"), 7000);
  assert.equal(parseCustomRange("2.5"), 2500);
  assert.equal(parseCustomRange(" 12 "), 12000);
});

test("⚠ nothing that is not a distance ever becomes one", () => {
  // Every one of these would otherwise land as a stored range the ship obeys.
  for (const junk of ["", "   ", "0", "-3", "abc", "1e999", "NaN", "1/2"]) {
    assert.equal(parseCustomRange(junk), null, `"${junk}" was read as a distance`);
  }
});

test("an absurd distance is refused rather than stored", () => {
  // A sanity bound, not a game rule: the server decides what a ship can hold.
  // This only stops "100000" typed into a KILOMETRE field becoming 100,000 km.
  assert.equal(parseCustomRange(String(MAX_RANGE_METRES / 1000)), MAX_RANGE_METRES);
  assert.equal(parseCustomRange(String(MAX_RANGE_METRES / 1000 + 1)), null);
  assert.equal(parseCustomRange("100000"), null);
});

test("a fraction of a metre rounds to whole metres, which is what the bridge takes", () => {
  assert.equal(parseCustomRange("1.2345"), 1235);
  assert.equal(Number.isInteger(parseCustomRange("3.7")), true);
});

// --- naming a distance -------------------------------------------------------

test("⚠ a ladder value is NAMED by the ladder, never formatted", () => {
  // "10 km" formatted from 10000 becomes "10.0 km" or "10000" depending on who
  // wrote the formatter; the app already has one right answer for these seven.
  for (const choice of RANGE_PRESETS) {
    assert.equal(rangeName(choice.metres), choice.label);
  }
});

test("a custom value is named as briefly as it can be read", () => {
  assert.equal(rangeName(7000), "7 km");
  assert.equal(rangeName(7500), "7.5 km");
  assert.equal(rangeName(250), "250 m");
  assert.equal(rangeName(1250), "1.3 km", "one decimal, and no trailing zero");
});

test("a distance that is not a distance is a dash, not a zero", () => {
  assert.equal(rangeName(0), "—");
  assert.equal(rangeName(-5), "—");
  assert.equal(rangeName(Number.NaN), "—");
});

test("the action wears the distance it will fly", () => {
  // Pressing Orbit is never a question about which distance is remembered.
  assert.equal(rangeActionLabel("Orbit", 5000), "Orbit 5 km");
  assert.equal(rangeActionLabel("Keep at", 10000), "Keep at 10 km");
});

// --- reading the stored value ------------------------------------------------

test("a stored distance reads back as metres", () => {
  assert.equal(storedRangeMetres("5000", 1000), 5000);
  assert.equal(storedRangeMetres("7500", 1000), 7500);
});

test("⚠ an unreadable stored distance falls back — it never becomes 0", () => {
  // A zero-metre orbit is a real instruction: fly into it. The app must never
  // arrive at that by failing to parse something.
  for (const junk of ["", "abc", "0", "-1"]) {
    assert.equal(storedRangeMetres(junk, 1000), 1000, `"${junk}" collapsed to 0`);
  }
});

interface StoredDistances {
  readonly warp: string;
  readonly orbit: string;
  readonly hold: string;
}

/**
 * `flyingDistances` reads storage ONCE, at module load, so each of these has to
 * import a fresh copy against the storage it just installed.
 */
async function readFresh(tag: string): Promise<StoredDistances> {
  const fresh = (await import(`./flyingDistances.ts?${tag}`)) as {
    flyingDistances: { subscribe(run: (value: StoredDistances) => void): () => void };
  };
  let seen: StoredDistances = { warp: "", orbit: "", hold: "" };
  fresh.flyingDistances.subscribe((value) => {
    seen = value;
  })();
  return seen;
}

// --- the storage rule this module exists to protect --------------------------

test("⚠ a CUSTOM distance survives a reload", async () => {
  // The regression this whole module is arranged around. Before it, `load()`
  // validated orbit/hold against HOLD_RANGES, so a typed 7 km was accepted for
  // the session and silently reverted to 1 km on the next refresh.
  const map = new Map<string, string>([
    ["evejs-web-flying-distances", JSON.stringify({ warp: "0", orbit: "7000", hold: "12500" })],
  ]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
  };
  // Fresh module instance, so `load()` runs against the storage above.
  const seen = await readFresh(`custom-${Date.now()}`);
  assert.equal(seen.orbit, "7000", "a typed orbit distance was dropped on reload");
  assert.equal(seen.hold, "12500", "a typed keep-at-range distance was dropped on reload");
});

test("⚠ but rubbish in storage still falls back to the default", async () => {
  // Widening the validator must not turn it off. Non-vacuous counterpart to the
  // test above: the same door that lets 7000 in keeps "" and 0 out.
  const map = new Map<string, string>([
    [
      "evejs-web-flying-distances",
      JSON.stringify({ warp: "nonsense", orbit: "0", hold: "-4" }),
    ],
  ]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (): void => {},
    removeItem: (): void => {},
    clear: (): void => map.clear(),
  };
  const seen = await readFresh(`junk-${Date.now()}`);
  // The handoff's defaults, not retail's 1 km each — see flyingDistances.ts.
  assert.deepEqual(seen, { warp: "0", orbit: "5000", hold: "10000" });
});

test("warp keeps its fixed menu, because nothing offers a custom warp range", () => {
  // The widening is deliberately narrow: two fields, not three.
  assert.ok(WARP_RANGES.some((choice) => choice.metres === 0), "warp keeps 'as close as it can'");
  assert.equal(rangeLabel(WARP_RANGES, "0"), "As close as it can");
  assert.equal(rangeLabel(WARP_RANGES, "7000"), "—", "a custom warp range has no name");
});

test("a range off the ladder can be named by the caller that knows how", () => {
  // `flyingDistances` does not import `spaceRanges` — the dependency runs the
  // other way — so a caller that can show a custom range passes its own namer.
  assert.equal(rangeLabel(HOLD_RANGES, "7000"), "—", "without a namer it is still a dash");
  assert.equal(
    rangeLabel(HOLD_RANGES, "7000", (metres) => rangeName(Number(metres))),
    "7 km",
  );
});
