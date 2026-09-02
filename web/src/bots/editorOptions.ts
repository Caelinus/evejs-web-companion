// The Bot Builder editor's pure data layer — everything the rebuilt inspector
// needs to draw a widget for an argument, an option list for a condition, or a
// label for a value, DERIVED from the format (`botScript.ts`, `macroSpecs.ts`)
// rather than hand-maintained here. That is the whole point: the previous
// `BotBuilder.svelte` hand-wrote an `{#if step.macro === "..."}` chain for
// arguments and two separate hardcoded condition-kind arrays, so three arg
// kinds (`equipment`, `corporation`, `agent`) had NO widget, `request-mission`
// had no editor branch at all, and `wallet-below` / `wallet-above` /
// `cargo-full` were legal `until` conditions the editor could never offer.
// Every export below closes one of those gaps STRUCTURALLY: a `Record<K, …>`
// over a closed union fails to COMPILE when a new value of `K` appears, the
// same guarantee `MACRO_CATALOG` (`macroCatalogView.ts`) already gives macros.
//
// Pure UI metadata. No id ever reaches a label (R7d); every string here is
// plain language, no engineering jargon, no raw token (R9a).

import {
  CONDITION_KINDS,
  conditionAllowedAt,
  ITEM_PLACES,
  INTERRUPT_RESPONSES,
  MAX_COUNT_ARG,
  MAX_ISK_ARG,
  MAX_QTY_ARG,
  MAX_CONDITION_FRACTION,
  MIN_COUNT_ARG,
  MIN_ISK_ARG,
  MIN_QTY_ARG,
  MIN_CONDITION_FRACTION,
  MAX_ORE_HOLD_FRACTION,
  type Arg,
  type Condition,
  type ConditionKind,
  type InterruptResponse,
  type ItemPlace,
  type MacroID,
} from "./botScript.ts";
import { MACRO_IDS } from "./botScript.ts";
import { MACRO_SPECS, type MacroArgSpec } from "./macroSpecs.ts";

// ─── Argument widgets ────────────────────────────────────────────────────────
//
// One widget kind per `Arg["kind"]`. The `Record<Arg["kind"], WidgetKind>`
// below is what makes `equipment` / `agent` / `corp` structurally unable to go
// missing again: adding a new `Arg` variant without adding a widget for it is
// a compile error here, not a silent `undefined` in a template.

/** Which inspector control renders a value of this argument kind. */
export type WidgetKind =
  | "belt-picker"
  | "station-picker"
  | "equipment-picker"
  | "agent-picker"
  | "count-input"
  | "corp-picker"
  | "fitting-picker"
  | "item-type-picker"
  | "place-select"
  | "bookmark-picker"
  | "isk-input"
  | "qty-input"
  | "character-picker"
  | "chat-channel-select"
  | "destination-picker"
  | "rock-pick-select"
  | "text-input";

/** Every `Arg["kind"]` mapped to the widget that edits it — exhaustive by type. */
export const ARG_KIND_WIDGET: Readonly<Record<Arg["kind"], WidgetKind>> = {
  belt: "belt-picker",
  station: "station-picker",
  equipment: "equipment-picker",
  agent: "agent-picker",
  count: "count-input",
  corp: "corp-picker",
  fitting: "fitting-picker",
  itemType: "item-type-picker",
  place: "place-select",
  bookmark: "bookmark-picker",
  isk: "isk-input",
  qty: "qty-input",
  character: "character-picker",
  chatChannel: "chat-channel-select",
  destination: "destination-picker",
  rockPick: "rock-pick-select",
  text: "text-input",
};

/** A plain-language name for an argument KIND — used when no per-macro label fits. */
export const ARG_KIND_LABEL: Readonly<Record<Arg["kind"], string>> = {
  belt: "Belt",
  station: "Station",
  equipment: "Equipment",
  agent: "Agent",
  count: "Amount",
  corp: "Corporation",
  fitting: "Saved fitting",
  itemType: "Item",
  place: "Place",
  bookmark: "Saved spot",
  isk: "ISK amount",
  qty: "Quantity",
  character: "Pilot",
  chatChannel: "Channel",
  destination: "Destination",
  rockPick: "Which rock first",
  text: "Text",
};

/**
 * Plain-language label per argument KEY, for the keys `MACRO_SPECS` actually
 * declares. Falls back to `ARG_KIND_LABEL[kind]` for a key this table has not
 * seen — so a new arg is never unlabelled, only generically labelled until
 * someone gives it a sharper name.
 */
const ARG_KEY_LABEL: Readonly<Record<string, string>> = {
  belt: "Belt",
  station: "Station",
  equipment: "Equipment",
  agent: "Agent",
  level: "Agent level",
  maxJumps: "Longest trip (jumps)",
  corporation: "Corporation",
  seconds: "Seconds",
  fitting: "Saved fitting",
  item: "Item",
  from: "From",
  to: "To",
  amount: "How many",
  bookmark: "Saved spot",
  quantity: "How many",
  price: "Price each (ISK)",
  who: "Pilot",
  only: "Only this pilot",
  range: "Scanner reach (AU)",
  channel: "Channel",
  message: "Message",
  destination: "Destination",
  pick: "Which rock first",
};

function argLabel(arg: MacroArgSpec): string {
  return ARG_KEY_LABEL[arg.key] ?? ARG_KIND_LABEL[arg.kind];
}

/** One argument, described for the inspector: what it is, whether it is
 * required, and which widget renders it. */
export interface ArgDescriptor {
  readonly key: string;
  readonly kind: Arg["kind"];
  readonly required: boolean;
  readonly label: string;
  readonly widget: WidgetKind;
}

function argDescriptor(arg: MacroArgSpec): ArgDescriptor {
  return {
    key: arg.key,
    kind: arg.kind,
    required: arg.required,
    label: argLabel(arg),
    widget: ARG_KIND_WIDGET[arg.kind],
  };
}

/**
 * A macro's arguments, split required-first so the inspector can put the
 * required ones in the always-visible action summary and the rest behind a
 * "More options" disclosure — Apple's Shortcuts action-summary rule, cited in
 * the design doc (docs/bot-builder-interface.md §1/§4): the sentence a player
 * reads first should not be crowded with defaults they did not have to touch.
 */
export interface MacroArgDescriptors {
  readonly macro: MacroID;
  /** Every arg, in `MACRO_SPECS` order (required and optional interleaved). */
  readonly all: readonly ArgDescriptor[];
  readonly required: readonly ArgDescriptor[];
  readonly optional: readonly ArgDescriptor[];
  /** Whether an `until` is mandatory for this macro (`mine-at-belt`). */
  readonly untilRequired: boolean;
  /**
   * Whether the inspector shows a "stop when…" control for this macro at all.
   * The FORMAT allows an `until` on any step (`scriptCodec.ts` reads one
   * wherever a step is read), so this is a UI judgement, not a format fact:
   * offering "Leave the station until your wallet rises above 10m ISK" on all
   * 49 macros would put a control nobody wants on almost every step. It is
   * offered where the macro cannot end on its own (`untilRequired`) and on
   * `wait`, whose own spec names "wait until shields are back above X" as the
   * intended combination. A step that ALREADY carries an `until` — from an
   * import, or from a macro this list later stops offering — must still be
   * editable, so the inspector ORs this with `step.until !== undefined`
   * rather than treating it as the whole answer.
   */
  readonly untilOffered: boolean;
}

function macroArgDescriptors(id: MacroID): MacroArgDescriptors {
  const spec = MACRO_SPECS[id];
  const all = spec.args.map(argDescriptor);
  return {
    macro: id,
    all,
    required: all.filter((a) => a.required),
    optional: all.filter((a) => !a.required),
    untilRequired: spec.untilRequired,
    untilOffered: spec.untilRequired || id === "wait",
  };
}

/**
 * Every macro's argument descriptors, keyed by macro id. `Record<MacroID, …>`
 * over `MACRO_IDS` — exhaustive the same way `MACRO_CATALOG` is: a macro added
 * to `MacroID` without a `MACRO_SPECS` entry fails to compile before it ever
 * reaches this table, so the inspector can never be missing a macro's args.
 */
export const MACRO_ARG_DESCRIPTORS: Readonly<Record<MacroID, MacroArgDescriptors>> = Object.fromEntries(
  MACRO_IDS.map((id) => [id, macroArgDescriptors(id)]),
) as Readonly<Record<MacroID, MacroArgDescriptors>>;

// ─── Numeric bounds ──────────────────────────────────────────────────────────
//
// A widget asks HERE for its min/max rather than retyping the numbers from
// botScript.ts — one source of truth for what the codec will accept.

export interface NumericBounds {
  readonly min: number;
  readonly max: number;
}

export const COUNT_ARG_BOUNDS: NumericBounds = Object.freeze({ min: MIN_COUNT_ARG, max: MAX_COUNT_ARG });
export const ISK_ARG_BOUNDS: NumericBounds = Object.freeze({ min: MIN_ISK_ARG, max: MAX_ISK_ARG });
export const QTY_ARG_BOUNDS: NumericBounds = Object.freeze({ min: MIN_QTY_ARG, max: MAX_QTY_ARG });

/** The bounds for a numeric argument kind, or null when that kind is not a plain number. */
export function numericArgBounds(kind: Arg["kind"]): NumericBounds | null {
  switch (kind) {
    case "count":
      return COUNT_ARG_BOUNDS;
    case "isk":
      return ISK_ARG_BOUNDS;
    case "qty":
      return QTY_ARG_BOUNDS;
    default:
      return null;
  }
}

/**
 * Bounds NARROWER than the format's own, per argument key. `MIN/MAX_COUNT_ARG`
 * is 1..500 for every `count` argument, because that is all the codec can say
 * about a number whose meaning it does not know. The inspector knows: an agent
 * level is 1..5, a scanner reach is measured in AU, a trip is measured in
 * jumps. Offering a spinner that runs to 500 on all three teaches the wrong
 * range and lets a player set a value the game can never satisfy.
 *
 * These are the exact ranges the editor shipped with before the redesign; they
 * live here rather than in the component so the numbers are testable and so a
 * widget asks ONE place what a number may be.
 */
const ARG_KEY_BOUNDS: Readonly<Record<string, NumericBounds>> = {
  level: { min: 1, max: 5 },
  maxJumps: { min: 1, max: 50 },
  seconds: { min: 1, max: 500 },
  range: { min: 1, max: 100 },
  amount: { min: 1, max: 500 },
};

/**
 * Per-macro overrides of the above, for a key whose sensible range genuinely
 * differs by macro. `hunt-player`'s `maxJumps` is a LEASH on a bot that chases
 * a player — it is deliberately shorter than the distance a courier bot may
 * travel to reach an agent, even though both are "maxJumps".
 */
const MACRO_ARG_BOUNDS: Readonly<Partial<Record<MacroID, Readonly<Record<string, NumericBounds>>>>> = {
  "hunt-player": { maxJumps: { min: 1, max: 30 } },
};

/**
 * The bounds a numeric widget should enforce for one argument of one macro —
 * the per-macro override, else the per-key range, else the format's own bounds
 * for that kind. `null` when the argument is not a plain number at all.
 */
export function argBounds(macro: MacroID, arg: ArgDescriptor): NumericBounds | null {
  const override = MACRO_ARG_BOUNDS[macro]?.[arg.key];
  if (override !== undefined) {
    return override;
  }
  const byKey = ARG_KEY_BOUNDS[arg.key];
  if (byKey !== undefined) {
    return byKey;
  }
  return numericArgBounds(arg.kind);
}

/** A condition threshold's 0..1 fraction bounds — never 0 (a watch that can never fire). */
export const CONDITION_FRACTION_BOUNDS: NumericBounds = Object.freeze({
  min: MIN_CONDITION_FRACTION,
  max: MAX_CONDITION_FRACTION,
});

/** The ore-hold "nearly full" until-threshold ceiling (0.9, not 1.0 — see botScript.ts). */
export const ORE_HOLD_FRACTION_MAX = MAX_ORE_HOLD_FRACTION;

// ─── Condition option lists ──────────────────────────────────────────────────
//
// Both lists below are FILTERED from `CONDITION_KINDS` through
// `conditionAllowedAt`, never a second hand-maintained array — the exact fix
// for the audited gap (an `until` list of 7 hardcoded kinds when the format
// admits 10; a watch-add list of 11 when the format admits all 14).

/**
 * The kinds legal as a step's or branch's `until`/`when` — every own-ship read,
 * never a grid read (see `conditionSites` in botScript.ts for why). Currently
 * 10 of the 14 `CONDITION_KINDS`.
 */
export const UNTIL_CONDITION_KINDS: readonly ConditionKind[] = Object.freeze(
  CONDITION_KINDS.filter((k) => conditionAllowedAt(k, "until")),
);

/**
 * The kinds legal as an "always watching" interrupt row. Every condition kind
 * is legal at `"interrupt"` (see `conditionSites`), so this is all 14 — but it
 * is still DERIVED, not hardcoded, so a future condition kind that is ever
 * restricted away from `"interrupt"` drops out of this list automatically
 * instead of the watch-add button silently keeping a dead entry.
 */
export const WATCH_CONDITION_KINDS: readonly ConditionKind[] = Object.freeze(
  CONDITION_KINDS.filter((k) => conditionAllowedAt(k, "interrupt")),
);

/**
 * A short noun label per condition kind — the watch-add button / chip text.
 * `Record<ConditionKind, string>`: a condition kind added to the format
 * without an entry here fails to compile, the way a macro without a
 * `MACRO_CATALOG` entry already does.
 */
export const CONDITION_NOUN_LABEL: Readonly<Record<ConditionKind, string>> = {
  "ore-hold-at-least": "Ore hold",
  "hold-empty": "Hold",
  "shield-below": "Shields",
  "armor-below": "Armor",
  "hull-below": "Hull",
  "health-below": "Ship health",
  "capacitor-below": "Capacitor",
  "wallet-below": "Wallet drops below",
  "wallet-above": "Wallet rises above",
  "hostile-on-grid": "A pirate shows up",
  "cargo-full": "Cargo hold",
  "players-in-system-above": "Other pilots in system",
  "targeted-by-player": "Being targeted",
  "drone-health-below": "A drone's health",
};

/**
 * The clause a condition kind reads as in an "until…" dropdown — a short
 * phrase, not the full rendered sentence (`conditionSentence` in
 * `scriptText.ts` fills in the number; this is just the option label). Covers
 * every `ConditionKind` for exhaustiveness even though only the
 * `UNTIL_CONDITION_KINDS` subset is ever offered in an until picker.
 */
export const CONDITION_UNTIL_LABEL: Readonly<Record<ConditionKind, string>> = {
  "ore-hold-at-least": "the ore hold is nearly full",
  "hold-empty": "the hold is empty",
  "shield-below": "shields drop below…",
  "armor-below": "armor drops below…",
  "hull-below": "hull drops below…",
  "health-below": "ship health drops below…",
  "capacitor-below": "the capacitor drops below…",
  "wallet-below": "the wallet drops below…",
  "wallet-above": "the wallet rises above…",
  "hostile-on-grid": "a pirate shows up",
  "cargo-full": "the cargo hold is nearly full",
  "players-in-system-above": "another pilot comes into this system",
  "targeted-by-player": "another player locks onto your ship",
  "drone-health-below": "one of your drones drops below…",
};

/**
 * A condition threshold's ceiling for THIS kind. The ore hold's "nearly full"
 * stops at 90% (`MAX_ORE_HOLD_FRACTION`, because the last tenth of an ore hold
 * is not reliably fillable); every other fraction runs to 95%.
 */
export function conditionFractionCap(kind: ConditionKind): number {
  return kind === "ore-hold-at-least" ? ORE_HOLD_FRACTION_MAX : CONDITION_FRACTION_BOUNDS.max;
}

/** A 0..1 fraction, clamped into the range a condition may legally carry. */
export function clampConditionFraction(fraction: number, kind: ConditionKind): number {
  return Math.min(conditionFractionCap(kind), Math.max(CONDITION_FRACTION_BOUNDS.min, fraction));
}

/** A 0..1 fraction as the whole percent a player types and reads. */
export function conditionPercent(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * A fresh `Condition` of `kind`, reusing `previous`'s own threshold when it
 * carried the same SHAPE (fraction / ISK / count).
 *
 * WHY IT KEEPS THE NUMBER. Changing the kind in a dropdown is a change of
 * subject, not of amount: a player who set 30% on shields and then switches to
 * armor meant the same 30%, and resetting it silently would be exactly the
 * invisible auto-correction CodeStruct measured as the worse failure. Kept
 * here rather than in a component because THREE pickers offer a condition — a
 * watch, a step's "stop when", and a branch's fork — and they must not
 * disagree about what a fresh one of each shape starts as.
 */
export function freshCondition(kind: ConditionKind, previous?: Condition): Condition {
  if (conditionUsesFraction(kind)) {
    // Ore hold and cargo hold read naturally as "nearly full" (90%); every
    // other fraction — shields, armor, hull, health, capacitor — as a lower
    // safety line (30%).
    const wantsFull = kind === "ore-hold-at-least" || kind === "cargo-full";
    const keep = previous !== undefined && "fraction" in previous ? previous.fraction : wantsFull ? 0.9 : 0.3;
    return { kind, fraction: clampConditionFraction(keep, kind) } as Condition;
  }
  if (conditionUsesIsk(kind)) {
    const keep = previous !== undefined && "isk" in previous ? previous.isk : 10_000_000;
    return { kind, isk: keep } as Condition;
  }
  if (conditionUsesCount(kind)) {
    // Zero = "anyone else at all", the setting a solo miner wants.
    const keep = previous !== undefined && "count" in previous ? previous.count : 0;
    return { kind, count: keep } as Condition;
  }
  return { kind } as Condition;
}

/** The ceiling on a pilot-count condition — a whole system's worth is plenty. */
export const MAX_CONDITION_PILOT_COUNT = 50;

/** What a pilot-count field's zero means, said in the field rather than left
 * to be discovered — an empty-looking "0" otherwise reads as "off". */
export const CONDITION_PILOT_COUNT_HINT = "0 means anyone else at all";

/** A pilot count, clamped. ZERO is legal and means "anyone else at all". */
export function clampConditionCount(raw: number): number {
  return Math.min(MAX_CONDITION_PILOT_COUNT, Math.max(0, Math.trunc(raw) || 0));
}

/** An ISK threshold, clamped to what the format will accept. */
export function clampConditionIsk(raw: number): number {
  return Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, Math.trunc(raw) || MIN_ISK_ARG));
}

/** True when a condition kind's threshold is a 0..1 fraction (a percent slider). */
export function conditionUsesFraction(kind: ConditionKind): boolean {
  return (
    kind !== "hold-empty" &&
    kind !== "hostile-on-grid" &&
    kind !== "wallet-below" &&
    kind !== "wallet-above" &&
    kind !== "targeted-by-player" &&
    kind !== "players-in-system-above"
  );
}

/** True when a condition kind's threshold is an ISK amount, not a fraction. */
export function conditionUsesIsk(kind: ConditionKind): boolean {
  return kind === "wallet-below" || kind === "wallet-above";
}

/** True when a condition kind takes a plain count (not a fraction or ISK). */
export function conditionUsesCount(kind: ConditionKind): boolean {
  return kind === "players-in-system-above";
}

// ─── Interrupt responses ─────────────────────────────────────────────────────

/**
 * A plain-language label per interrupt response. `Record<InterruptResponse,
 * string>` — exhaustive over `InterruptResponse`, the same guarantee as the
 * condition label tables above.
 */
export const RESPONSE_LABEL: Readonly<Record<InterruptResponse, string>> = {
  "dock-and-pause": "Dock at home and stop",
  pause: "Just stop and wait",
  "launch-drones": "Send out combat drones and keep going",
  repair: "Run the repairers until it recovers",
  // "Let me know" changes nothing about the ship, so it is the one response
  // that is safe to stack ABOVE a real one — it speaks once, then steps aside.
  alert: "Let me know and keep going",
};

/** The interrupt-response option list, in `INTERRUPT_RESPONSES` order — derived,
 * never a second hand-maintained array. */
export const RESPONSE_OPTIONS: readonly { readonly value: InterruptResponse; readonly label: string }[] =
  Object.freeze(INTERRUPT_RESPONSES.map((value) => ({ value, label: RESPONSE_LABEL[value] })));

// ─── Item places ─────────────────────────────────────────────────────────────

/** A plain-language label per place items can sit in while docked. */
export const PLACE_LABEL: Readonly<Record<ItemPlace, string>> = {
  hangar: "station hangar",
  cargo: "cargo hold",
  "ore-hold": "ore hold",
};

/** The place option list, in `ITEM_PLACES` order — derived, never hardcoded. */
export const PLACE_OPTIONS: readonly { readonly value: ItemPlace; readonly label: string }[] = Object.freeze(
  ITEM_PLACES.map((value) => ({ value, label: PLACE_LABEL[value] })),
);
