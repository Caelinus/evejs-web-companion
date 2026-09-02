<script lang="ts">
  // THE BOT BUILDER — build a bot from ready-made BLOCKS (like Lego): an ordered
  // list of blocks that repeat as a whole, plus a row of "watches" that are
  // checked every moment. Built on the tested pure helpers (format, sentences,
  // validator, JSON codec), so what you see here is the logic the runner will run.
  //
  // Not yet wired (needs the live-session pass): the Start button. You can shape,
  // validate, and import/export a bot; running one comes next.

  import {
    type Arg,
    type BotScript,
    type BranchBlock,
    type Condition,
    type ConditionKind,
    type InterruptResponse,
    type InterruptRow,
    type LoopBodyNode,
    type MacroID,
    type MacroStep,
    type ProgramNode,
    type SubBotNode,
    type WorldRef,
    MAX_ISK_ARG,
    MAX_QTY_ARG,
    MIN_ISK_ARG,
    MIN_QTY_ARG,
    MAX_TEXT_ARG_LEN,
    MAX_NOTES_LEN,
    MAX_INTERRUPTS,
    DEFAULT_HUNT_MAX_JUMPS,
    DEFAULT_HUNT_RANGE_AU,
    startingStation,
  } from "../bots/botScript.ts";
  import {
    MACRO_CATALOG_LIST,
    CATEGORY_LABEL,
    categoriesInUse,
    type BlockCategory,
  } from "../bots/macroCatalogView.ts";
  import {
    MACRO_ARG_DESCRIPTORS,
    type ArgDescriptor,
    UNTIL_CONDITION_KINDS,
    WATCH_CONDITION_KINDS,
    CONDITION_NOUN_LABEL,
    CONDITION_UNTIL_LABEL,
    RESPONSE_OPTIONS,
    PLACE_OPTIONS,
    CONDITION_FRACTION_BOUNDS,
    ORE_HOLD_FRACTION_MAX,
    conditionUsesFraction,
    conditionUsesIsk,
    conditionUsesCount,
  } from "../bots/editorOptions.ts";
  import { EXAMPLE_BOTS, type ExampleBot } from "../bots/exampleBots.ts";
  import { insertSavedBotSteps, type FlatProgramNode } from "../bots/scriptEdit.ts";
  import { watchBuilderEdits } from "../bots/builderHandoff.ts";
  import { branchSentence, stepSentence, subBotSentence } from "../bots/scriptText.ts";
  import { validateScript, type ScriptProblem } from "../bots/validateScript.ts";
  import { decodeScriptText, decodeScriptValue, encodeScriptDoc } from "../bots/scriptCodec.ts";
  import {
    createBotScript,
    deleteBotScript,
    getBotScript,
    listBotScripts,
    updateBotScript,
    type BotScriptSummary,
  } from "../app/api.ts";
  import StationPicker from "./StationPicker.svelte";
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { nameKey } from "../store/names.ts";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const finder = store.finder;

  let idSeed = 0;
  const makeId = (): string => `n${(idSeed += 1)}`;

  // ── Editor state (the flat "blocks" shape the player thinks in) ──────────────
  let name = $state("My mining bot");
  let notes = $state("");
  let repeatMode = $state<"forever" | "times" | "once">("times");
  let repeatCount = $state(20);
  let home = $state<WorldRef>(startingStation());
  let watches = $state<InterruptRow[]>([
    { id: "w-shield", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" },
  ]);
  // The editor's list is exactly what a LOOP BODY may hold (steps and branches),
  // plus sub-bot nodes which are legal only at the top level — so the same list
  // builds either a looped bot or a run-once one.
  type EditorNode = MacroStep | BranchBlock | SubBotNode;
  let steps = $state<EditorNode[]>([
    { id: "s-undock", kind: "macro", macro: "undock", args: {} },
    {
      id: "s-mine",
      kind: "macro",
      macro: "mine-at-belt",
      args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
      until: { kind: "ore-hold-at-least", fraction: 0.9 },
    },
    {
      id: "s-haul",
      kind: "macro",
      macro: "deliver-ore",
      args: { station: { kind: "station", ref: startingStation() } },
    },
  ]);
  let importText = $state("");
  let importNote = $state<string | null>(null);
  let insertNote = $state<string | null>(null);

  // Branches and sub-bots are authored right in the list now. This still catches
  // the shapes the one-list editor cannot hold — several loops, or a loop beside
  // loose steps — by keeping such a program verbatim so it runs and round-trips
  // UNMANGLED while the list shows a flattened, read-only preview.
  let advancedProgram = $state<readonly ProgramNode[] | null>(null);

  // ── Palette search + category filter ─────────────────────────────────────────
  // The palette can hold dozens of blocks; a search box and one-tap category
  // chips keep it findable. Search matches the name, the "what it does", the
  // "needs", and the category label, so a word like "drone" or "sell" lands.
  let blockSearch = $state("");
  let activeCategory = $state<BlockCategory | "all">("all");
  const paletteCategories = categoriesInUse();
  const filteredBlocks = $derived.by(() => {
    const q = blockSearch.trim().toLowerCase();
    return MACRO_CATALOG_LIST.filter((e) => {
      if (activeCategory !== "all" && e.category !== activeCategory) return false;
      if (q.length === 0) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.does.toLowerCase().includes(q) ||
        (e.needs?.toLowerCase().includes(q) ?? false) ||
        CATEGORY_LABEL[e.category].toLowerCase().includes(q)
      );
    });
  });

  // Saved bots — kept platform-wide on the web server (src/botScriptStore.js);
  // every account can see and load every saved bot.
  let savedList = $state<BotScriptSummary[]>([]);
  let currentSavedId = $state<string | null>(null);
  let currentRev = $state(0);
  let libraryError = $state<string | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────────
  // The stations a player can pick right now — at least the one they are docked
  // at. (More sources come with the live pass.)
  const stations = $derived.by<{ id: number; name: string }[]>(() => {
    const out: { id: number; name: string }[] = [];
    const st = $flight.status;
    if (st !== null && st.docked && st.stationID !== null) {
      out.push({ id: st.stationID, name: $flight.stationName ?? "This station" });
    }
    return out;
  });

  const currentStation = $derived<{ id: number; name: string } | null>(stations[0] ?? null);
  const someWatchDocks = $derived(watches.some((w) => w.respond === "dock-and-pause"));
  const hasSubBot = $derived(steps.some((n) => n.kind === "sub-bot"));
  const builtDoc = $derived<BotScript>(buildScript());
  const problems = $derived(validateScript(builtDoc));
  const problemsByPath = $derived(groupProblems(problems));
  // Only BLOCKING problems count toward the header badge and gate Save — an
  // advisory note is worth reading, never worth stopping a save over.
  const blockingCount = $derived(problems.filter((p) => p.severity === "blocking").length);

  function buildScript(): BotScript {
    // A program the one-list editor cannot hold is returned verbatim (only
    // name/home/watches stay editable); otherwise the list builds the program.
    // ⚠ A sub-bot node is legal only at the TOP level (an included bot may carry
    // loops of its own), so a list containing one always builds a run-once bot —
    // the repeat control says as much.
    const program: readonly ProgramNode[] =
      advancedProgram !== null
        ? advancedProgram
        : steps.length === 0
          ? []
          : repeatMode === "once" || hasSubBot
            ? [...steps]
            : [
                {
                  id: "main-loop",
                  kind: "loop",
                  repeat: repeatMode === "forever" ? { kind: "forever" } : { kind: "times", count: repeatCount },
                  body: steps.filter((n): n is LoopBodyNode => n.kind !== "sub-bot"),
                },
              ];
    return {
      format: "evejs-bot-script",
      version: 1,
      name,
      notes: notes.slice(0, MAX_NOTES_LEN),
      home,
      interrupts: [...watches],
      program,
    };
  }

  /** Groups problems by row/path, keeping each one's severity so the row can
   * mark itself blocking (red, disables Save) or advisory (a quieter note). */
  function groupProblems(list: readonly ScriptProblem[]): Map<string, ScriptProblem[]> {
    const map = new Map<string, ScriptProblem[]>();
    for (const p of list) {
      const existing = map.get(p.path) ?? [];
      existing.push(p);
      map.set(p.path, existing);
    }
    return map;
  }

  // ── Small helpers ────────────────────────────────────────────────────────────
  function unboundStation(): WorldRef {
    return { entity: "station", id: null, name: null, systemName: null };
  }
  function pct(fraction: number): number {
    return Math.round(fraction * 100);
  }
  function clampFraction(f: number): number {
    return Math.min(0.95, Math.max(0.05, f));
  }
  // The station ref a step currently points at (unbound when unset).
  function stationArgRef(step: MacroStep): WorldRef {
    const station = step.args["station"];
    return station !== undefined && station.kind === "station" ? station.ref : unboundStation();
  }

  /** A pirate watch can also fight back, which the health watches cannot. */
  const HOSTILE_RESPONSE_OPTIONS: readonly { value: InterruptResponse; label: string }[] = [
    { value: "launch-drones", label: "Send out combat drones and keep going" },
    { value: "dock-and-pause", label: "Dock at home and stop" },
    { value: "pause", label: "Just stop and wait" },
    { value: "alert", label: "Let me know and keep going" },
  ];
  /**
   * The watch-add button's own caption, kept distinct from
   * `CONDITION_NOUN_LABEL` (the row's noun) so the eleven captions that shipped
   * before this slice read exactly as they did. `Record<ConditionKind, string>`
   * over the full union — the same exhaustiveness guarantee as the tables in
   * `editorOptions.ts` — so a 15th condition kind fails to compile here rather
   * than leaving the watch-add row one button short again.
   */
  const WATCH_BUTTON_LABEL: Readonly<Record<ConditionKind, string>> = {
    "shield-below": "Watch Shields",
    "armor-below": "Watch Armor",
    "hull-below": "Watch Hull",
    "capacitor-below": "Watch Capacitor",
    "hostile-on-grid": "Watch for Rats",
    "wallet-below": "Watch Wallet (low)",
    "wallet-above": "Watch Wallet (high)",
    "cargo-full": "Watch Cargo Hold",
    "players-in-system-above": "Watch for Players",
    "targeted-by-player": "Watch for Being Targeted",
    "drone-health-below": "Watch Drones",
    "health-below": "Watch Ship Health",
    "ore-hold-at-least": "Watch Ore Hold",
    "hold-empty": "Watch for an Empty Hold",
  };
  /** A fraction condition's ceiling — the ore hold's "nearly full" is 90%, everything else 95%. */
  function fractionCap(kind: ConditionKind): number {
    return kind === "ore-hold-at-least" ? ORE_HOLD_FRACTION_MAX : CONDITION_FRACTION_BOUNDS.max;
  }
  /**
   * A fresh `Condition` of `kind`, reusing `previous`'s own threshold when it
   * carried the same SHAPE (fraction / ISK / count) — so switching the kind in
   * an until/watch dropdown keeps whatever number the player already set rather
   * than resetting it. Shared by `addWatch`, `setStepUntilKind` and
   * `setBranchWhenKind`, so the three pickers this file offers over a condition
   * kind can never disagree about what a fresh one of each shape defaults to.
   */
  function freshCondition(kind: ConditionKind, previous?: Condition): Condition {
    if (conditionUsesFraction(kind)) {
      // Ore hold / cargo hold read naturally as "nearly full" (90%); every
      // other fraction (shields, armor, hull, health, capacitor) as a lower
      // safety line (30%) — the same defaults this file has always used.
      const wantsFull = kind === "ore-hold-at-least" || kind === "cargo-full";
      const keep = previous !== undefined && "fraction" in previous ? previous.fraction : wantsFull ? 0.9 : 0.3;
      return { kind, fraction: Math.min(fractionCap(kind), Math.max(CONDITION_FRACTION_BOUNDS.min, keep)) } as Condition;
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

  // ── Watches ──────────────────────────────────────────────────────────────────
  function hasWatch(kind: ConditionKind): boolean {
    return watches.some((w) => w.when.kind === kind);
  }
  function addWatch(kind: ConditionKind): void {
    if (hasWatch(kind)) return;
    const when = freshCondition(kind);
    // Sensible first responses: money, a full hold and an empty one are not
    // dangers, so they just stop; a pirate launches drones; being targeted or
    // joined by players is news rather than damage, so it tells you; anything
    // about health heads home.
    const respond: InterruptResponse =
      kind === "hostile-on-grid"
        ? "launch-drones"
        : kind === "targeted-by-player"
          ? "alert"
          : kind === "wallet-below" ||
              kind === "wallet-above" ||
              kind === "cargo-full" ||
              kind === "ore-hold-at-least" ||
              kind === "hold-empty"
            ? "pause"
            : "dock-and-pause";
    watches = [...watches, { id: makeId(), when, respond }];
  }
  function removeWatch(id: string): void {
    watches = watches.filter((w) => w.id !== id);
  }
  /**
   * Pair an existing watch with an "alert me" row for the SAME check — the
   * "tell me, and also do the thing" combination.
   *
   * ⚠ THE NEW ROW GOES ABOVE THE ONE IT PAIRS WITH, and that is not cosmetic.
   * Watches are first-match-wins: below, the dock row would fire first and the
   * alert would never speak. Above, the alert speaks once, marks itself spent,
   * and from then on the scan skips it and reaches the dock row underneath. The
   * threshold is copied as-is so the pair means "both, on the same trigger"; the
   * player can then edit the alert's own number to be warned earlier.
   */
  function addAlertFor(row: InterruptRow): void {
    if (watches.length >= MAX_INTERRUPTS) return;
    const alertRow: InterruptRow = { id: makeId(), when: row.when, respond: "alert" };
    const at = watches.findIndex((w) => w.id === row.id);
    if (at < 0) return;
    watches = [...watches.slice(0, at), alertRow, ...watches.slice(at)];
  }
  /** True when this row already has an "alert me" twin (so we offer it once). */
  function hasAlertTwin(row: InterruptRow): boolean {
    return watches.some((w) => w.respond === "alert" && w.when.kind === row.when.kind);
  }
  function setWatchFraction(id: string, percent: number): void {
    watches = watches.map((w) => {
      if (w.id !== id || !("fraction" in w.when)) return w;
      return { ...w, when: { ...w.when, fraction: Math.min(fractionCap(w.when.kind), clampFraction(percent / 100)) } };
    });
  }
  function setWatchIsk(id: string, amount: number): void {
    const value = Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, Math.trunc(amount) || MIN_ISK_ARG));
    watches = watches.map((w) => (w.id === id && "isk" in w.when ? { ...w, when: { ...w.when, isk: value } } : w));
  }
  /** The pilot-count watch. ZERO is legal and means "anyone else at all". */
  function setWatchCount(id: string, raw: number): void {
    const value = Math.min(50, Math.max(0, Math.trunc(raw) || 0));
    watches = watches.map((w) => (w.id === id && "count" in w.when ? { ...w, when: { ...w.when, count: value } } : w));
  }
  function setWatchResponse(id: string, respond: InterruptResponse): void {
    watches = watches.map((w) => (w.id === id ? { ...w, respond } : w));
  }
  // ── Blocks (steps) ───────────────────────────────────────────────────────────
  /** A fresh step of this block, with the sensible starting args. Shared by the
   * palette and by the "add to this side" pickers inside a branch. */
  function newStepFor(macro: MacroID): MacroStep {
    const id = makeId();
    if (macro === "mine-at-belt") {
      return {
        id,
        kind: "macro",
        macro,
        args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
        until: { kind: "ore-hold-at-least", fraction: 0.9 },
      };
    }
    if (macro === "deliver-ore" || macro === "travel-to-station") {
      return { id, kind: "macro", macro, args: { station: { kind: "station", ref: startingStation() } } };
    }
    if (macro === "move-items") {
      // Sensible defaults: hangar -> cargo; the item stays to pick.
      return { id, kind: "macro", macro, args: { from: { kind: "place", place: "hangar" }, to: { kind: "place", place: "cargo" } } };
    }
    if (macro === "buy-item") {
      // Item stays to pick; quantity and price get starting values to edit.
      return {
        id,
        kind: "macro",
        macro,
        args: {
          item: { kind: "itemType", typeID: null, name: null },
          quantity: { kind: "qty", value: 100 },
          price: { kind: "isk", value: 1000 },
        },
      };
    }
    if (macro === "sell-item") {
      return { id, kind: "macro", macro, args: { item: { kind: "itemType", typeID: null, name: null }, price: { kind: "isk", value: 1000 } } };
    }
    if (macro === "invite-to-fleet") {
      return { id, kind: "macro", macro, args: { who: { kind: "character", charID: null, name: null } } };
    }
    if (macro === "set-destination") {
      // Unbound on purpose: there is no sensible default place to fly to, and the
      // validator asks for one before the bot can start.
      return {
        id,
        kind: "macro",
        macro,
        args: { destination: { kind: "destination", ref: { entity: "station", id: null, name: null, systemName: null } } },
      };
    }
    return { id, kind: "macro", macro, args: {} };
  }

  function addStep(macro: MacroID): void {
    // Adding a block means editing this list from here — drop any program that
    // was preserved verbatim (the flattened preview steps carry forward).
    advancedProgram = null;
    steps = [...steps, newStepFor(macro)];
  }
  /**
   * Copy another saved bot's steps onto the end of this one — a BY-VALUE insert,
   * not a live reference. Unlike [+ Saved bot] (which creates a `SubBotNode`
   * pointing at the other bot, is top-level only, and forces this bot to run
   * once), this appends independent copies of its steps right into the flat
   * list: the repeat control keeps working, and later edits to that saved bot
   * never change this one — because nothing here still points at it.
   *
   * The pure helper APPENDS and reserves every id already in the bot (steps +
   * watches), so repeated inserts cannot collide with each other or with a
   * loaded/imported branch. A source bot's repeating group (how the editor saves
   * any repeating bot) has its steps copied in once; this bot's own repeat
   * setting then governs them, and `insertNote` says so.
   */
  async function insertSavedBot(meta: BotScriptSummary): Promise<void> {
    try {
      const record = await getBotScript(meta.scriptID, botOpts());
      if (record === null) {
        insertNote = "That saved bot could not be found.";
        return;
      }
      const decoded = decodeScriptValue(record.doc);
      if (!decoded.ok) {
        insertNote = decoded.refusal;
        return;
      }
      advancedProgram = null;
      const result = insertSavedBotSteps(
        steps,
        decoded.doc,
        makeId,
        new Set(["main-loop", ...watches.map((row) => row.id)]),
      );
      steps = result.steps as EditorNode[];
      insertNote =
        result.left.length > 0
          ? `Copied “${decoded.doc.name}”’s steps to the end of this bot. ${result.left.join(" ")}`
          : `Copied “${decoded.doc.name}”’s steps to the end of this bot. Later changes to that saved bot will not change this one.`;
    } catch {
      insertNote = "Could not load that saved bot.";
    }
  }
  function moveStep(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) return;
    copy[i] = b;
    copy[j] = a;
    steps = copy;
  }
  function removeStep(i: number): void {
    steps = steps.filter((_, idx) => idx !== i);
  }
  function duplicateStep(i: number): void {
    const s = steps[i];
    if (s === undefined) return;
    const clone = { ...structuredClone($state.snapshot(s) as EditorNode), id: makeId() } as EditorNode;
    steps = [...steps.slice(0, i + 1), clone, ...steps.slice(i + 1)];
  }

  // ── Branches and sub-bots ───────────────────────────────────────────────────
  /** Add a fork: "if <check>, do these; otherwise do those." Starts with one
   * step on the THEN side so it is valid the moment it appears. */
  function addBranch(): void {
    advancedProgram = null;
    const branch: BranchBlock = {
      id: makeId(),
      kind: "branch",
      when: { kind: "shield-below", fraction: 0.5 },
      then: [{ id: makeId(), kind: "macro", macro: "repair-ship", args: {} }],
      else: [],
    };
    steps = [...steps, branch];
  }
  /** Add a "run another saved bot" step. */
  function addSubBot(): void {
    advancedProgram = null;
    steps = [...steps, { id: makeId(), kind: "sub-bot", scriptID: null, name: null }];
  }
  function updateBranch(i: number, fn: (b: BranchBlock) => BranchBlock): void {
    steps = steps.map((n, idx) => (idx === i && n.kind === "branch" ? fn(n) : n));
  }
  function setBranchWhenKind(i: number, kind: ConditionKind): void {
    updateBranch(i, (b) => ({ ...b, when: freshCondition(kind, b.when) }));
  }
  function setBranchWhenFraction(i: number, percent: number): void {
    updateBranch(i, (b) => {
      if (!("fraction" in b.when)) return b;
      return { ...b, when: { ...b.when, fraction: Math.min(fractionCap(b.when.kind), clampFraction(percent / 100)) } };
    });
  }
  function setBranchWhenIsk(i: number, amount: number): void {
    const value = Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, Math.trunc(amount) || MIN_ISK_ARG));
    updateBranch(i, (b) => ("isk" in b.when ? { ...b, when: { ...b.when, isk: value } } : b));
  }
  function addToBranchSide(i: number, side: Side, macro: MacroID): void {
    if (!macro) return;
    const step = newStepFor(macro);
    updateBranch(i, (b) => (side === "then" ? { ...b, then: [...b.then, step] } : { ...b, else: [...b.else, step] }));
  }
  function removeFromBranchSide(i: number, side: Side, j: number): void {
    updateBranch(i, (b) => {
      const list = (side === "then" ? b.then : b.else).filter((_, k) => k !== j);
      return side === "then" ? { ...b, then: list } : { ...b, else: list };
    });
  }
  function moveInBranchSide(i: number, side: Side, j: number, delta: number): void {
    updateBranch(i, (b) => {
      const list = [...(side === "then" ? b.then : b.else)];
      const k = j + delta;
      if (k < 0 || k >= list.length) return b;
      const a = list[j];
      const c = list[k];
      if (a === undefined || c === undefined) return b;
      list[j] = c;
      list[k] = a;
      return side === "then" ? { ...b, then: list } : { ...b, else: list };
    });
  }
  function setSubBot(i: number, scriptID: string): void {
    const selected = savedList.find((bot) => bot.scriptID === scriptID) ?? null;
    steps = steps.map((node, idx) =>
      idx === i && node.kind === "sub-bot"
        ? {
            ...node,
            scriptID: selected?.scriptID ?? null,
            name: selected?.name ?? null,
          }
        : node,
    );
  }

  // ── Editing one step, wherever it sits ──────────────────────────────────────
  // A step can be top of the list OR inside a branch side, so every arg editor
  // addresses it the same way: the list index, plus (for a branch) which side and
  // which position in it. The template's top-level calls pass just the index, so
  // they read exactly as before; the branch rows pass the extra two.
  type Side = "then" | "else";
  function updateStep(i: number, fn: (s: MacroStep) => MacroStep, side: Side | null = null, j = -1): void {
    steps = steps.map((node, idx) => {
      if (idx !== i) return node;
      if (side === null) {
        return node.kind === "macro" ? fn(node) : node;
      }
      if (node.kind !== "branch") return node;
      const list = side === "then" ? node.then : node.else;
      const next = list.map((s, k) => (k === j ? fn(s) : s));
      return side === "then" ? { ...node, then: next } : { ...node, else: next };
    });
  }
  function setStepStationRef(i: number, ref: WorldRef, side: Side | null = null, j = -1): void {
    updateStep(i, (s) => ({ ...s, args: { ...s.args, station: { kind: "station", ref } } }), side, j);
  }
  /** The destination slot: a station OR a system (the picker keeps which). */
  function destinationRef(step: MacroStep): WorldRef {
    const arg = step.args["destination"];
    return arg !== undefined && arg.kind === "destination"
      ? arg.ref
      : { entity: "station", id: null, name: null, systemName: null };
  }
  function setStepDestination(i: number, ref: WorldRef, side: Side | null = null, j = -1): void {
    updateStep(i, (s) => ({ ...s, args: { ...s.args, destination: { kind: "destination", ref } } }), side, j);
  }
  /** The mine block's rock order — absent means "nearest", the shipped default. */
  function rockPickValue(step: MacroStep): string {
    const arg = step.args["pick"];
    return arg !== undefined && arg.kind === "rockPick" ? arg.pick : "nearest";
  }
  function setStepRockPick(i: number, raw: string, side: Side | null = null, j = -1): void {
    updateStep(
      i,
      (s) => {
        if (raw !== "biggest") {
          // Back to the default: drop the arg entirely rather than storing the
          // default explicitly, so an unchanged block exports exactly as before.
          const { pick: _dropped, ...rest } = s.args;
          return { ...s, args: rest };
        }
        return { ...s, args: { ...s.args, pick: { kind: "rockPick", pick: "biggest" } } };
      },
      side,
      j,
    );
  }
  function setStepUntilKind(i: number, kind: ConditionKind, side: Side | null = null, j = -1): void {
    updateStep(i, (s) => ({ ...s, until: freshCondition(kind, s.until) }), side, j);
  }
  function setStepUntilFraction(i: number, percent: number, side: Side | null = null, j = -1): void {
    updateStep(
      i,
      (s) => {
        if (!s.until || !("fraction" in s.until)) return s;
        return { ...s, until: { ...s.until, fraction: Math.min(fractionCap(s.until.kind), clampFraction(percent / 100)) } };
      },
      side,
      j,
    );
  }
  function setStepUntilIsk(i: number, amount: number, side: Side | null = null, j = -1): void {
    const value = Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, Math.trunc(amount) || MIN_ISK_ARG));
    updateStep(i, (s) => (s.until && "isk" in s.until ? { ...s, until: { ...s.until, isk: value } } : s), side, j);
  }

  // ── The refit block's saved-fitting picker ─────────────────────────────────
  let savedFittings = $state<readonly { fittingID: number; name: string }[]>([]);
  let savedSpots = $state<readonly { bookmarkID: number; name: string }[]>([]);
  // The known-pilots roster (multibox onboarding records it) — the invite block's
  // picker. Names + ids only, from localStorage; no token, no live read.
  let knownPilots = $state<readonly { characterID: number; characterName: string }[]>([]);
  onMount(() => {
    knownPilots = loadKnownCharacters().map((k) => ({ characterID: k.characterID, characterName: k.characterName }));
  });
  onMount(() => {
    void flow
      .listSavedFittings()
      .then((rows) => {
        savedFittings = rows.map((f) => ({ fittingID: f.fittingID, name: f.name }));
      })
      .catch(() => {});
    void flow
      .listBookmarks()
      .then((rows) => {
        savedSpots = rows;
      })
      .catch(() => {});
  });
  function bookmarkArgID(step: MacroStep): number | null {
    const arg = step.args["bookmark"];
    return arg !== undefined && arg.kind === "bookmark" ? arg.bookmarkID : null;
  }
  function setStepBookmark(i: number, bookmarkID: number, side: Side | null = null, j = -1): void {
    const match = savedSpots.find((bm) => bm.bookmarkID === bookmarkID);
    if (match === undefined) return;
    updateStep(
      i,
      (s) => ({ ...s, args: { ...s.args, bookmark: { kind: "bookmark", bookmarkID: match.bookmarkID, name: match.name } } }),
      side,
      j,
    );
  }
  // ── The mine-at-belt block's belt picker ────────────────────────────────────
  // Belt ids are grid-local, not global (unlike a station — see
  // StationPicker.svelte's own note), so a galaxy-wide search makes no sense
  // here. Offer whatever belts are on the CURRENT grid right now, matched by
  // the same name regex the runtime uses to resolve "nearest" — picking one
  // here just pins that same name-match for later ticks.
  const beltsOnGrid = $derived(
    ($space.snapshot?.entities ?? [])
      .filter((e) => /belt/i.test(e.name ?? ""))
      .map((e) => ({ itemID: e.itemID, name: e.name ?? "Unnamed belt" })),
  );
  function beltArgMode(step: MacroStep): "nearest" | "chosen" {
    const arg = step.args["belt"];
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? "chosen" : "nearest";
  }
  function beltArgID(step: MacroStep): number | null {
    const arg = step.args["belt"];
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? arg.belt.ref.id : null;
  }
  function beltArgName(step: MacroStep): string | null {
    const arg = step.args["belt"];
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? arg.belt.ref.name : null;
  }
  function setStepBeltNearest(i: number, side: Side | null = null, j = -1): void {
    updateStep(i, (s) => ({ ...s, args: { ...s.args, belt: { kind: "belt", belt: { mode: "nearest" } } } }), side, j);
  }
  function setStepBeltChosen(i: number, itemID: number, side: Side | null = null, j = -1): void {
    const match = beltsOnGrid.find((b) => b.itemID === itemID);
    if (match === undefined) return;
    const systemID = $space.snapshot?.solarSystemID ?? null;
    const systemName = systemID !== null ? ($names.resolved[nameKey("system", systemID)] ?? null) : null;
    updateStep(
      i,
      (s) => ({
        ...s,
        args: {
          ...s.args,
          belt: {
            kind: "belt",
            belt: { mode: "chosen", ref: { entity: "belt", id: match.itemID, name: match.name, systemName } },
          },
        },
      }),
      side,
      j,
    );
  }
  // ── The mine-at-belt block's OPTIONAL equipment picker ──────────────────────
  // Which fitted modules are the miners — offered from the ACTIVE ship's fitted
  // slots (store.fitting.slots, the same live read the Fitting window shows),
  // deduplicated by GROUP so "two strip miners" offers one option, matching the
  // format's own EquipmentArg (a group, not a single module — see botScript.ts).
  // Left unset, the block runs every mining module fitted, so an empty ship
  // read is never a dead end: the picker offers a note rather than a blank list.
  const fittedEquipment = $derived.by<readonly { groupID: number; label: string }[]>(() => {
    const seen = new Map<number, string>();
    for (const slot of $fitting.slots) {
      const module = slot.module;
      if (module !== null && module.groupID !== null && !seen.has(module.groupID)) {
        const label = $names.resolved[nameKey("type", module.typeID)] ?? "Fitted equipment";
        seen.set(module.groupID, label);
      }
    }
    return [...seen.entries()].map(([groupID, label]) => ({ groupID, label }));
  });
  function equipmentArgGroupID(step: MacroStep): number | null {
    const arg = step.args["equipment"];
    return arg !== undefined && arg.kind === "equipment" ? arg.equipment.groupID : null;
  }
  function setStepEquipment(i: number, groupID: number, side: Side | null = null, j = -1): void {
    const match = fittedEquipment.find((e) => e.groupID === groupID);
    if (match === undefined) return;
    updateStep(
      i,
      (s) => ({ ...s, args: { ...s.args, equipment: { kind: "equipment", equipment: { groupID: match.groupID, label: match.label } } } }),
      side,
      j,
    );
  }
  /** Clear an optional arg entirely — back to the macro's own default. */
  function clearStepArg(i: number, key: string, side: Side | null = null, j = -1): void {
    updateStep(
      i,
      (s) => {
        const { [key]: _dropped, ...rest } = s.args;
        return { ...s, args: rest };
      },
      side,
      j,
    );
  }
  // ── The distribution/combat agent finders' OPTIONAL corporation picker ─────
  // No live corporation search exists anywhere in this app (unlike stations,
  // fittings, bookmarks or pilots), so this is the one arg picker that is a
  // plain text field — the NAME is all the finder filters on; an empty field
  // means "any corporation", the shipped default.
  function corpArgName(step: MacroStep): string {
    const arg = step.args["corporation"];
    return arg !== undefined && arg.kind === "corp" ? (arg.name ?? "") : "";
  }
  function setStepCorp(i: number, raw: string, side: Side | null = null, j = -1): void {
    const trimmed = raw.trim();
    updateStep(
      i,
      (s) => {
        if (trimmed.length === 0) {
          const { corporation: _dropped, ...rest } = s.args;
          return { ...s, args: rest };
        }
        return { ...s, args: { ...s.args, corporation: { kind: "corp", id: null, name: trimmed } } };
      },
      side,
      j,
    );
  }
  // ── request-mission's OPTIONAL agent picker ─────────────────────────────────
  // Sourced from the Agent Finder's own results (store.finder.agents) — the
  // live agent data this app already has, IF the player has searched there this
  // session. Left unset (the default), the step uses the agent the find block
  // published on the run's board, which is the common case.
  function agentArgID(step: MacroStep): number | null {
    const arg = step.args["agent"];
    return arg !== undefined && arg.kind === "agent" ? arg.ref.id : null;
  }
  function setStepAgent(i: number, raw: string, side: Side | null = null, j = -1): void {
    if (raw === "") {
      clearStepArg(i, "agent", side, j);
      return;
    }
    const match = $finder.agents.find((a) => a.agentID === Number(raw));
    if (match === undefined) return;
    updateStep(
      i,
      (s) => ({
        ...s,
        args: {
          ...s.args,
          agent: {
            kind: "agent",
            ref: { entity: "agent", id: match.agentID, name: match.name, systemName: match.solarSystemName },
          },
        },
      }),
      side,
      j,
    );
  }
  function fittingArgID(step: MacroStep): number | null {
    const arg = step.args["fitting"];
    return arg !== undefined && arg.kind === "fitting" ? arg.fittingID : null;
  }
  function whoArgID(step: MacroStep): number | null {
    const arg = step.args["who"];
    return arg !== undefined && arg.kind === "character" ? arg.charID : null;
  }
  function setStepWho(i: number, charID: number, side: Side | null = null, j = -1): void {
    const match = knownPilots.find((p) => p.characterID === charID);
    if (match === undefined) return;
    updateStep(
      i,
      (s) => ({ ...s, args: { ...s.args, who: { kind: "character", charID: match.characterID, name: match.characterName } } }),
      side,
      j,
    );
  }
  function setStepFitting(i: number, fittingID: number, side: Side | null = null, j = -1): void {
    const match = savedFittings.find((f) => f.fittingID === fittingID);
    if (match === undefined) return;
    updateStep(
      i,
      (s) => ({ ...s, args: { ...s.args, fitting: { kind: "fitting", fittingID: match.fittingID, name: match.name } } }),
      side,
      j,
    );
  }

  // ── The move block's pickers ────────────────────────────────────────────────
  // Items offered = what is visible in the hangar/cargo right now, by NAME.
  const knownItems = $derived.by<readonly { typeID: number; name: string }[]>(() => {
    const seen = new Map<number, string>();
    for (const row of [...$inventory.hangar.rows, ...$inventory.cargo.rows]) {
      if (row.typeID > 0 && !seen.has(row.typeID)) {
        const name = $names.resolved[nameKey("type", row.typeID)] ?? null;
        if (name !== null && name.length > 0) {
          seen.set(row.typeID, name);
        }
      }
    }
    return [...seen.entries()].map(([typeID, name]) => ({ typeID, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  function moveArg(step: MacroStep, key: string): string {
    const arg = step.args[key];
    if (arg === undefined) return "";
    if (arg.kind === "itemType") return arg.typeID === null ? "" : String(arg.typeID);
    if (arg.kind === "place") return arg.place;
    return "";
  }
  function setMoveItem(i: number, raw: string, side: Side | null = null, j = -1): void {
    const typeID = Number(raw);
    const match = knownItems.find((it) => it.typeID === typeID);
    if (match === undefined) return;
    updateStep(i, (s) => ({ ...s, args: { ...s.args, item: { kind: "itemType", typeID: match.typeID, name: match.name } } }), side, j);
  }
  function setMovePlace(i: number, key: "from" | "to", place: string, side: Side | null = null, j = -1): void {
    updateStep(i, (s) => ({ ...s, args: { ...s.args, [key]: { kind: "place", place: place as never } } }), side, j);
  }

  // ── Mission-block number args (agent level, max jumps) ─────────────────────
  function countArgValue(step: MacroStep, key: string): number | null {
    const arg = step.args[key];
    return arg !== undefined && arg.kind === "count" ? arg.value : null;
  }
  // The market blocks' number args: a quantity (qty) and a price (isk). One
  // reader for any numeric arg, one setter that stamps the right kind.
  function numericArgValue(step: MacroStep, key: string): number | null {
    const arg = step.args[key];
    if (arg === undefined) return null;
    return arg.kind === "count" || arg.kind === "isk" || arg.kind === "qty" ? arg.value : null;
  }
  function setStepNumericArg(
    i: number,
    key: string,
    raw: string,
    kind: "isk" | "qty",
    min: number,
    max: number,
    side: Side | null = null,
    j = -1,
  ): void {
    updateStep(
      i,
      (s) => {
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isSafeInteger(parsed)) {
          const { [key]: _dropped, ...rest } = s.args;
          return { ...s, args: rest };
        }
        const value = Math.min(max, Math.max(min, parsed));
        return { ...s, args: { ...s.args, [key]: { kind, value } as Arg } };
      },
      side,
      j,
    );
  }
  /** Set (or clear, on empty input) a bounded number arg on a step. */
  function setStepCountArg(
    i: number,
    key: string,
    raw: string,
    min: number,
    max: number,
    side: Side | null = null,
    j = -1,
  ): void {
    updateStep(
      i,
      (s) => {
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isSafeInteger(parsed)) {
          const { [key]: _dropped, ...rest } = s.args;
          return { ...s, args: rest };
        }
        const value = Math.min(max, Math.max(min, parsed));
        return { ...s, args: { ...s.args, [key]: { kind: "count", value } } };
      },
      side,
      j,
    );
  }

  // ── Arg editors GENERATED from the spec, for the args no hand-written branch
  // below already covers ─────────────────────────────────────────────────────
  //
  // `macroEditors` (in the template) is still a hand-written `{#if step.macro
  // === "..."}` chain for the arguments it already knew how to draw — moving
  // THOSE to a generic renderer would reflow every existing sentence's wording,
  // which this slice is not here to do. What it WAS missing is three widgets
  // that never existed at all: `equipment` (mine-at-belt), `corporation`
  // (find-distribution-agent / find-combat-agent) and `agent`
  // (request-mission) — `request-mission` had no editor branch whatsoever.
  //
  // `extraArgEditor` closes that gap STRUCTURALLY rather than by hand-adding
  // three more `{#if}` branches: it reads `MACRO_ARG_DESCRIPTORS[step.macro]`
  // (derived from `MACRO_SPECS`, so it can never itself go stale) and renders
  // whatever argument key is NOT already named in `HANDLED_ARG_KEYS` for that
  // macro, choosing its widget from `ArgDescriptor.widget` — the same
  // `ARG_KIND_WIDGET` table that makes a NEW arg kind fail to compile in
  // `editorOptions.ts` before it can reach here un-widgeted. Every arg this
  // complement ever renders is optional (`MACRO_SPECS` has no required arg left
  // uncovered), so it always sits behind "More options" — Apple's Shortcuts
  // action-summary rule cited in the design doc.
  const HANDLED_ARG_KEYS: Readonly<Partial<Record<MacroID, readonly string[]>>> = {
    "travel-to-station": ["station"],
    "travel-to-belt": ["belt"],
    "mine-at-belt": ["belt", "pick"],
    "deliver-ore": ["station"],
    "find-distribution-agent": ["level", "maxJumps"],
    "accept-mission": ["maxJumps"],
    "refit-ship": ["fitting"],
    "move-items": ["item", "from", "to", "amount"],
    "warp-to-bookmark": ["bookmark"],
    "find-combat-agent": ["level", "maxJumps"],
    "buy-item": ["item", "quantity", "price"],
    "sell-item": ["item", "price"],
    "invite-to-fleet": ["who"],
    "attack-player": ["only"],
    "hunt-player": ["only", "maxJumps", "range"],
    "send-chat": ["channel", "message"],
    "set-destination": ["destination"],
    "jettison-cargo": ["item"],
    "jettison-ore": ["item"],
    wait: ["seconds"],
  };
  function extraArgsFor(macro: MacroID): readonly ArgDescriptor[] {
    const handled = HANDLED_ARG_KEYS[macro] ?? [];
    return MACRO_ARG_DESCRIPTORS[macro].all.filter((arg) => !handled.includes(arg.key));
  }

  // ── Import / export ──────────────────────────────────────────────────────────
  function exportJson(): void {
    importText = encodeScriptDoc(builtDoc);
    importNote = "Copied this bot into the box below — copy it out to save or share.";
  }
  function importJson(): void {
    const result = decodeScriptText(importText);
    if (!result.ok) {
      importNote = result.refusal;
      return;
    }
    loadFrom(result.doc);
    currentSavedId = null; // an imported bot is a new, unsaved one
    currentRev = 0;
    importNote =
      result.warnings.length > 0
        ? `Loaded, with ${result.warnings.length} thing(s) tidied: ${result.warnings.join(" ")}`
        : "Loaded the bot from the box.";
  }
  function loadExample(example: ExampleBot): void {
    // Through the CODEC, exactly like an import — a bundled example must never
    // sidestep the gate a pasted file goes through.
    const result = decodeScriptValue(example.doc);
    if (!result.ok) {
      importNote = result.refusal;
      return;
    }
    loadFrom(result.doc);
    currentSavedId = null;
    currentRev = 0;
    importNote = `Loaded the "${example.label}" example - look it over, then Save and Start.`;
  }
  function loadFrom(doc: BotScript): void {
    name = doc.name;
    notes = doc.notes;
    home = doc.home;
    watches = [...doc.interrupts];
    const first = doc.program[0];
    if (doc.program.length === 1 && first !== undefined && first.kind === "loop") {
      // One loop = the list IS its body (steps and branches alike).
      advancedProgram = null;
      steps = [...first.body];
      if (first.repeat.kind === "forever") {
        repeatMode = "forever";
      } else {
        repeatMode = "times";
        repeatCount = first.repeat.count;
      }
    } else if (doc.program.every((n) => n.kind !== "loop")) {
      // No loop at all = a run-once list, which the editor holds directly
      // (steps, branches and sub-bots are all legal at the top level).
      advancedProgram = null;
      steps = doc.program.filter((n): n is EditorNode => n.kind !== "loop");
      repeatMode = "once";
    } else {
      // Several loops, or a loop beside loose steps — not a shape one list can
      // hold. Keep it VERBATIM so it still runs and round-trips, and show a
      // flattened read-only preview rather than silently dropping anything.
      advancedProgram = doc.program;
      steps = flattenProgram(doc.program);
      repeatMode = "once";
    }
    idSeed += 1000;
  }

  /** Every macro step of a program, in order, with loop bodies and branch sides
   * inlined — a display-only flattening (structure is not preserved). */
  function flattenProgram(program: readonly ProgramNode[]): MacroStep[] {
    return program.flatMap((n): MacroStep[] =>
      n.kind === "macro" ? [n] : n.kind === "loop" ? [...n.body] : [...n.then, ...n.else],
    );
  }

  // ── Saved bots (platform-wide, on the web server) ────────────────────────────
  // Saved-bot calls are made directly from this component, so carry the ACTIVE
  // flow's complete options — token, base URL and injected fetch — exactly like
  // calls made inside flow.ts. Reconstructing just the token broke multibox test
  // harnesses and any non-same-origin embedding.
  const botOpts = () => flow.requestOptions();
  async function refreshSaved(): Promise<void> {
    try {
      savedList = await listBotScripts(botOpts());
      libraryError = null;
    } catch {
      savedList = [];
      libraryError = "Could not reach the saved bots — are you still logged in?";
    }
  }
  async function saveBot(): Promise<void> {
    try {
      if (currentSavedId !== null) {
        const { rev } = await updateBotScript(currentSavedId, builtDoc, currentRev, botOpts());
        currentRev = rev;
        importNote = `Saved changes to "${name}".`;
      } else {
        const { scriptID, rev } = await createBotScript(builtDoc, botOpts());
        currentSavedId = scriptID;
        currentRev = rev;
        importNote = `Saved "${name}".`;
      }
      await refreshSaved();
    } catch (error) {
      importNote = error instanceof Error ? `Could not save: ${error.message}` : "Could not save.";
    }
  }
  async function loadSaved(id: string): Promise<void> {
    try {
      const record = await getBotScript(id, botOpts());
      if (record === null) {
        importNote = "That saved bot could not be found.";
        return;
      }
      const decoded = decodeScriptValue(record.doc);
      if (!decoded.ok) {
        importNote = decoded.refusal;
        return;
      }
      loadFrom(decoded.doc);
      currentSavedId = record.scriptID;
      currentRev = record.rev;
      importNote = "Loaded a saved bot.";
    } catch {
      importNote = "Could not load that bot.";
    }
  }
  async function deleteSaved(id: string): Promise<void> {
    try {
      await deleteBotScript(id, botOpts());
      if (currentSavedId === id) {
        currentSavedId = null;
        currentRev = 0;
      }
      await refreshSaved();
    } catch {
      importNote = "Could not delete that bot.";
    }
  }
  onMount(() => {
    void refreshSaved();
    // "Edit" on a Bot Manager library row: load exactly the bot that was clicked.
    return watchBuilderEdits(flow, (scriptID) => {
      void loadSaved(scriptID);
    });
  });
</script>

<section class="panel botbuilder">
  <div class="panel-head">
    <h2>Bot Builder</h2>
    <div class="controls">
      {#each EXAMPLE_BOTS as example (example.key)}
        <button class="minor" title={example.blurb} onclick={() => loadExample(example)}>{example.label}</button>
      {/each}
      {#if blockingCount === 0}
        <span class="badge good">Ready</span>
      {:else}
        <span class="badge warn">{blockingCount} thing{blockingCount === 1 ? "" : "s"} to fix</span>
      {/if}
    </div>
  </div>

  <p class="subnote">Build and save your bot here. Start it from the <strong>Bots</strong> tab (Station services).</p>

  <div class="field-row">
    <label for="bot-name">Name</label>
    <input id="bot-name" bind:value={name} />
  </div>
  {#each problemsByPath.get("name") ?? [] as p}<p class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</p>{/each}

  <div class="field-row">
    <label for="bot-notes">Notes</label>
    <textarea id="bot-notes" bind:value={notes} maxlength={MAX_NOTES_LEN} rows="2" placeholder="What this bot is for (optional)"></textarea>
  </div>

  <!-- Always watching -->
  <h3>Always watching</h3>
  <p class="subnote">Checked every moment. Add the ones you want — only one of each.</p>
  <div class="watch-buttons">
    {#each WATCH_CONDITION_KINDS as k (k)}
      <button onclick={() => addWatch(k)} disabled={hasWatch(k)}>{WATCH_BUTTON_LABEL[k]}</button>
    {/each}
  </div>
  <ul class="rows">
    {#each watches as row (row.id)}
      <li class="row watch">
        <span class="mark">◆</span>
        <div class="body">
          {#if row.when.kind === "hostile-on-grid"}
            <span class="sentence">If a pirate shows up</span>
            <span class="inline-edit">
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each HOSTILE_RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if "isk" in row.when}
            <span class="sentence">If your wallet {row.when.kind === "wallet-below" ? "drops below" : "rises above"}</span>
            <span class="inline-edit">
              <input class="isk-in" type="number" min={MIN_ISK_ARG} max={MAX_ISK_ARG} step="1000000" value={row.when.isk} oninput={(e) => setWatchIsk(row.id, Number(e.currentTarget.value))} /> ISK
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if row.when.kind === "targeted-by-player"}
            <span class="sentence">If another player locks onto your ship</span>
            <span class="inline-edit">
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each HOSTILE_RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if "count" in row.when}
            <span class="sentence">If more than</span>
            <span class="inline-edit">
              <input class="pct" type="number" min="0" max="50" value={row.when.count} oninput={(e) => setWatchCount(row.id, Number(e.currentTarget.value))} />
              other pilots are in this system
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each HOSTILE_RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if row.when.kind === "cargo-full"}
            <span class="sentence">If the cargo hold reaches</span>
            <span class="inline-edit">
              <input class="pct" type="number" min="5" max="90" value={pct(row.when.fraction)} oninput={(e) => setWatchFraction(row.id, Number(e.currentTarget.value))} />% full
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if row.when.kind === "ore-hold-at-least"}
            <span class="sentence">If the ore hold reaches</span>
            <span class="inline-edit">
              <input class="pct" type="number" min="5" max={pct(ORE_HOLD_FRACTION_MAX)} value={pct(row.when.fraction)} oninput={(e) => setWatchFraction(row.id, Number(e.currentTarget.value))} />% full
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if row.when.kind === "hold-empty"}
            <span class="sentence">If the hold is empty</span>
            <span class="inline-edit">
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {:else if "fraction" in row.when}
            <span class="sentence">{CONDITION_NOUN_LABEL[row.when.kind]} drop below</span>
            <span class="inline-edit">
              <input class="pct" type="number" min="5" max="95" value={pct(row.when.fraction)} oninput={(e) => setWatchFraction(row.id, Number(e.currentTarget.value))} />%
              →
              <select value={row.respond} onchange={(e) => setWatchResponse(row.id, e.currentTarget.value as InterruptResponse)}>
                {#each RESPONSE_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </span>
          {/if}
        </div>
        {#if row.respond !== "alert" && !hasAlertTwin(row) && watches.length < MAX_INTERRUPTS}
          <button class="tiny" title="Also let me know when this happens" onclick={() => addAlertFor(row)}>+ Alert me too</button>
        {/if}
        <button class="tiny danger" onclick={() => removeWatch(row.id)} aria-label="Remove this watch">✕</button>
      </li>
    {/each}
  </ul>
  {#if someWatchDocks}
    <div class="field-row">
      <span class="field-caption">Dock at</span>
      <StationPicker {flow} value={home} current={currentStation} onPick={(ref) => (home = ref)} />
      {#each problemsByPath.get("home") ?? [] as p}<span class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</span>{/each}
    </div>
  {/if}

  <!-- Steps -->
  <div class="steps-head">
    <h3>Steps</h3>
    <span class="repeat-control">
      {#if hasSubBot}
        <span class="repeat-note">Runs through once (a bot that runs other bots cannot repeat as a whole)</span>
      {:else}
        Repeat
        <select bind:value={repeatMode}>
          <option value="forever">forever</option>
          <option value="times">a set number of times</option>
          <option value="once">just once</option>
        </select>
        {#if repeatMode === "times"}
          <input class="count" type="number" min="1" max="500" bind:value={repeatCount} />
        {/if}
      {/if}
      <button class="tiny" onclick={addBranch} title="Do one thing or another, depending on a check">+ Branch</button>
      <button class="tiny" onclick={addSubBot} title="Run another saved bot here">+ Saved bot</button>
    </span>
  </div>
  {#each problemsByPath.get("program") ?? [] as p}<p class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</p>{/each}
  {#each problemsByPath.get("main-loop") ?? [] as p}<p class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</p>{/each}

  {#if advancedProgram !== null}
    <p class="note advanced-note">
      ⚠ This bot uses <strong>branch logic</strong>. It runs correctly and round-trips through the box below — the
      steps shown here are a flattened, read-only preview. Edit its branches in the <strong>Import / export</strong>
      box; adding a block turns it into a plain flat bot.
    </p>
  {/if}
  {#if steps.length === 0}
    <p class="empty">No blocks yet. Add one from the palette below.</p>
  {/if}
  <!-- Every block's own settings, in ONE place — rendered for a top-level block
       (side = null) and for a block inside a branch side (side + position), so a
       branch's steps are as editable as any other. -->
  {#snippet macroEditors(step: MacroStep, i: number, side: "then" | "else" | null, j: number)}
          {#if step.macro === "mine-at-belt"}
            <span class="inline-edit">
              stop when
              <select value={step.until?.kind ?? "ore-hold-at-least"} onchange={(e) => setStepUntilKind(i, e.currentTarget.value as ConditionKind, side, j)}>
                {#each UNTIL_CONDITION_KINDS as k}<option value={k}>{CONDITION_UNTIL_LABEL[k]}</option>{/each}
              </select>
              {#if step.until && "fraction" in step.until}
                <input class="pct" type="number" min="5" max={pct(step.until.kind === "ore-hold-at-least" ? ORE_HOLD_FRACTION_MAX : CONDITION_FRACTION_BOUNDS.max)} value={pct(step.until.fraction)} oninput={(e) => setStepUntilFraction(i, Number(e.currentTarget.value), side, j)} />%
              {:else if step.until && "isk" in step.until}
                <input class="isk-in" type="number" min={MIN_ISK_ARG} max={MAX_ISK_ARG} step="1000000" value={step.until.isk} oninput={(e) => setStepUntilIsk(i, Number(e.currentTarget.value), side, j)} /> ISK
              {/if}
            </span>
          {/if}
          {#if step.macro === "deliver-ore" || step.macro === "travel-to-station"}
            <span class="inline-edit">
              at
              <StationPicker {flow} value={stationArgRef(step)} current={currentStation} onPick={(ref) => setStepStationRef(i, ref, side, j)} />
            </span>
          {/if}
          {#if step.macro === "find-distribution-agent" || step.macro === "find-combat-agent"}
            <span class="inline-edit">
              level
              <input class="pct" type="number" min="1" max="5" placeholder="1" value={countArgValue(step, "level") ?? ""} oninput={(e) => setStepCountArg(i, "level", e.currentTarget.value, 1, 5, side, j)} />
              · within
              <input class="pct" type="number" min="1" max="50" placeholder="any" value={countArgValue(step, "maxJumps") ?? ""} oninput={(e) => setStepCountArg(i, "maxJumps", e.currentTarget.value, 1, 50, side, j)} />
              jumps
            </span>
          {/if}
          {#if step.macro === "accept-mission"}
            <span class="inline-edit">
              only if
              <input class="pct" type="number" min="1" max="50" placeholder="any" value={countArgValue(step, "maxJumps") ?? ""} oninput={(e) => setStepCountArg(i, "maxJumps", e.currentTarget.value, 1, 50, side, j)} />
              jumps or fewer
            </span>
          {/if}
          {#if step.macro === "refit-ship"}
            <span class="inline-edit">
              using
              <select
                value={fittingArgID(step) ?? ""}
                onchange={(e) => setStepFitting(i, Number(e.currentTarget.value), side, j)}
              >
                <option value="" disabled>pick a saved fitting…</option>
                {#each savedFittings as f (f.fittingID)}
                  <option value={f.fittingID}>{f.name}</option>
                {/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "move-items"}
            <span class="inline-edit">
              <select value={moveArg(step, "item")} onchange={(e) => setMoveItem(i, e.currentTarget.value, side, j)}>
                <option value="" disabled>pick an item…</option>
                {#each knownItems as it (it.typeID)}<option value={it.typeID}>{it.name}</option>{/each}
              </select>
              ×
              <input class="pct" type="number" min="1" max="500" placeholder="all" value={countArgValue(step, "amount") ?? ""} oninput={(e) => setStepCountArg(i, "amount", e.currentTarget.value, 1, 500, side, j)} />
              from
              <select value={moveArg(step, "from")} onchange={(e) => setMovePlace(i, "from", e.currentTarget.value, side, j)}>
                {#each PLACE_OPTIONS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
              </select>
              to
              <select value={moveArg(step, "to")} onchange={(e) => setMovePlace(i, "to", e.currentTarget.value, side, j)}>
                {#each PLACE_OPTIONS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "warp-to-bookmark"}
            <span class="inline-edit">
              to
              <select value={bookmarkArgID(step) ?? ""} onchange={(e) => setStepBookmark(i, Number(e.currentTarget.value), side, j)}>
                <option value="" disabled>pick a saved spot…</option>
                {#each savedSpots as bm (bm.bookmarkID)}<option value={bm.bookmarkID}>{bm.name}</option>{/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "wait"}
            <span class="inline-edit">
              for
              <input class="pct" type="number" min="1" max="500" placeholder="10" value={countArgValue(step, "seconds") ?? ""} oninput={(e) => setStepCountArg(i, "seconds", e.currentTarget.value, 1, 500, side, j)} />
              seconds
            </span>
          {/if}
          {#if step.macro === "buy-item"}
            <span class="inline-edit">
              buy
              <input class="pct" type="number" min={MIN_QTY_ARG} max={MAX_QTY_ARG} placeholder="how many" value={numericArgValue(step, "quantity") ?? ""} oninput={(e) => setStepNumericArg(i, "quantity", e.currentTarget.value, "qty", MIN_QTY_ARG, MAX_QTY_ARG, side, j)} />
              ×
              <select value={moveArg(step, "item")} onchange={(e) => setMoveItem(i, e.currentTarget.value, side, j)}>
                <option value="" disabled>pick an item…</option>
                {#each knownItems as it (it.typeID)}<option value={it.typeID}>{it.name}</option>{/each}
              </select>
              at up to
              <input class="isk-in" type="number" min={MIN_ISK_ARG} max={MAX_ISK_ARG} step="100" placeholder="ISK each" value={numericArgValue(step, "price") ?? ""} oninput={(e) => setStepNumericArg(i, "price", e.currentTarget.value, "isk", MIN_ISK_ARG, MAX_ISK_ARG, side, j)} />
              ISK each
            </span>
          {/if}
          {#if step.macro === "sell-item"}
            <span class="inline-edit">
              sell all
              <select value={moveArg(step, "item")} onchange={(e) => setMoveItem(i, e.currentTarget.value, side, j)}>
                <option value="" disabled>pick an item…</option>
                {#each knownItems as it (it.typeID)}<option value={it.typeID}>{it.name}</option>{/each}
              </select>
              at
              <input class="isk-in" type="number" min={MIN_ISK_ARG} max={MAX_ISK_ARG} step="100" placeholder="ISK each" value={numericArgValue(step, "price") ?? ""} oninput={(e) => setStepNumericArg(i, "price", e.currentTarget.value, "isk", MIN_ISK_ARG, MAX_ISK_ARG, side, j)} />
              ISK or more each
            </span>
          {/if}
          {#if step.macro === "invite-to-fleet"}
            <span class="inline-edit">
              invite
              {#if knownPilots.length === 0}
                <em>(no known pilots yet — add one from the login screen)</em>
              {:else}
                <select value={whoArgID(step) ?? ""} onchange={(e) => setStepWho(i, Number(e.currentTarget.value), side, j)}>
                  <option value="" disabled>pick a pilot…</option>
                  {#each knownPilots as p (p.characterID)}<option value={p.characterID}>{p.characterName}</option>{/each}
                </select>
              {/if}
            </span>
          {/if}
          {#if step.macro === "set-destination"}
            <span class="inline-edit">
              to
              <StationPicker
                {flow}
                value={destinationRef(step)}
                current={currentStation}
                allowSystems={true}
                onPick={(ref) => setStepDestination(i, ref, side, j)}
              />
            </span>
          {/if}
          {#if step.macro === "mine-at-belt"}
            <span class="inline-edit">
              working the
              <select value={rockPickValue(step)} onchange={(e) => setStepRockPick(i, e.currentTarget.value, side, j)}>
                <option value="nearest">nearest rock first</option>
                <option value="biggest">biggest rock first</option>
              </select>
              at
              <select
                class="belt-pick"
                value={beltArgMode(step) === "chosen" ? String(beltArgID(step) ?? "") : "nearest"}
                onchange={(e) => {
                  const v = e.currentTarget.value;
                  if (v === "nearest") {
                    setStepBeltNearest(i, side, j);
                  } else {
                    setStepBeltChosen(i, Number(v), side, j);
                  }
                }}
              >
                <option value="nearest">the nearest belt</option>
                {#if beltArgMode(step) === "chosen" && beltArgID(step) !== null && !beltsOnGrid.some((b) => b.itemID === beltArgID(step))}
                  <!-- The pinned belt isn't on the current grid right now — keep it
                       selectable/visible rather than silently blanking the picker.
                       Kept short: a native <select> popup sizes itself to its widest
                       option and cannot be constrained or resized from page CSS, so a
                       long suffix here was pushing the whole dropdown off-screen. -->
                  <option value={String(beltArgID(step))}>{beltArgName(step) ?? "Pinned belt"} (off grid)</option>
                {/if}
                {#each beltsOnGrid as b (b.itemID)}
                  <option value={String(b.itemID)}>{b.name}</option>
                {/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "travel-to-belt"}
            <span class="inline-edit">
              to
              <select
                class="belt-pick"
                value={beltArgMode(step) === "chosen" ? String(beltArgID(step) ?? "") : "nearest"}
                onchange={(e) => {
                  const v = e.currentTarget.value;
                  if (v === "nearest") {
                    setStepBeltNearest(i, side, j);
                  } else {
                    setStepBeltChosen(i, Number(v), side, j);
                  }
                }}
              >
                <option value="nearest">the nearest belt</option>
                {#if beltArgMode(step) === "chosen" && beltArgID(step) !== null && !beltsOnGrid.some((b) => b.itemID === beltArgID(step))}
                  <option value={String(beltArgID(step))}>{beltArgName(step) ?? "Pinned belt"} (off grid)</option>
                {/if}
                {#each beltsOnGrid as b (b.itemID)}
                  <option value={String(b.itemID)}>{b.name}</option>
                {/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "jettison-cargo"}
            <span class="inline-edit">
              <select value={moveArg(step, "item")} onchange={(e) => setMoveItem(i, e.currentTarget.value, side, j)}>
                <option value="">everything in the hold</option>
                {#each knownItems as it (it.typeID)}<option value={it.typeID}>{it.name}</option>{/each}
              </select>
            </span>
          {/if}
          {#if step.macro === "jettison-ore"}
            <span class="inline-edit">
              <select value={moveArg(step, "item")} onchange={(e) => setMoveItem(i, e.currentTarget.value, side, j)}>
                <option value="">everything in the ore hold</option>
                {#each knownItems as it (it.typeID)}<option value={it.typeID}>{it.name}</option>{/each}
              </select>
            </span>
          {/if}
  {/snippet}

  <!-- The GENERATED complement to macroEditors above: every arg on this step's
       macro that macroEditors does not already cover by hand, one widget per
       `ArgDescriptor.widget` — see HANDLED_ARG_KEYS / extraArgsFor. Today that
       is exactly `equipment`, `corporation` and `agent`, all optional, so this
       is always the step's "More options" disclosure. -->
  {#snippet extraArgEditor(step: MacroStep, i: number, side: "then" | "else" | null, j: number)}
    {@const extra = extraArgsFor(step.macro)}
    {#if extra.length > 0}
      <details class="more-options">
        <summary>More options</summary>
        {#each extra as arg (arg.key)}
          <span class="inline-edit">
            {arg.label}:
            {#if arg.widget === "equipment-picker"}
              <select
                value={equipmentArgGroupID(step) ?? ""}
                onchange={(e) => (e.currentTarget.value === "" ? clearStepArg(i, arg.key, side, j) : setStepEquipment(i, Number(e.currentTarget.value), side, j))}
              >
                <option value="">use everything fitted</option>
                {#each fittedEquipment as eq (eq.groupID)}<option value={eq.groupID}>{eq.label}</option>{/each}
              </select>
            {:else if arg.widget === "corp-picker"}
              <input
                type="text"
                placeholder="any corporation"
                value={corpArgName(step)}
                oninput={(e) => setStepCorp(i, e.currentTarget.value, side, j)}
              />
            {:else if arg.widget === "agent-picker"}
              <select value={agentArgID(step) ?? ""} onchange={(e) => setStepAgent(i, e.currentTarget.value, side, j)}>
                <option value="">use the agent your bot finds</option>
                {#each $finder.agents as a (a.agentID)}
                  <option value={a.agentID}>{a.name}{#if a.stationName} · {a.stationName}{/if}</option>
                {/each}
              </select>
              {#if $finder.agents.length === 0}<em>(no agents found yet — open Agent Finder first)</em>{/if}
            {/if}
          </span>
        {/each}
      </details>
    {/if}
  {/snippet}

  <ol class="rows program">
    {#each steps as node, i (node.id)}
      <li class="row node" class:is-branch={node.kind === "branch"}>
        <span class="num">{i + 1}</span>
        <div class="body">
          {#if node.kind === "macro"}
            <span class="sentence">{stepSentence(node)}</span>
            {@render macroEditors(node, i, null, -1)}
            {@render extraArgEditor(node, i, null, -1)}
          {:else if node.kind === "branch"}
            <!-- A FORK: the check, then the two sides. -->
            <span class="sentence">{branchSentence(node)}</span>
            <span class="inline-edit">
              if
              <select value={node.when.kind} onchange={(e) => setBranchWhenKind(i, e.currentTarget.value as ConditionKind)}>
                {#each UNTIL_CONDITION_KINDS as k}<option value={k}>{CONDITION_UNTIL_LABEL[k]}</option>{/each}
              </select>
              {#if "fraction" in node.when}
                <input class="pct" type="number" min="5" max={pct(node.when.kind === "ore-hold-at-least" ? ORE_HOLD_FRACTION_MAX : CONDITION_FRACTION_BOUNDS.max)} value={pct(node.when.fraction)} oninput={(e) => setBranchWhenFraction(i, Number(e.currentTarget.value))} />%
              {:else if "isk" in node.when}
                <input class="isk-in" type="number" min={MIN_ISK_ARG} max={MAX_ISK_ARG} step="1000000" value={node.when.isk} oninput={(e) => setBranchWhenIsk(i, Number(e.currentTarget.value))} /> ISK
              {/if}
            </span>
            {#each ["then", "else"] as const as side (side)}
              {@const sideSteps = side === "then" ? node.then : node.else}
              <div class="branch-side">
                <span class="side-label">{side === "then" ? "then" : "otherwise"}</span>
                {#if sideSteps.length === 0}
                  <span class="side-empty">do nothing</span>
                {/if}
                <ol class="side-list">
                  {#each sideSteps as sub, j (sub.id)}
                    <li class="side-row">
                      <div class="body">
                        <span class="sentence">{stepSentence(sub)}</span>
                        {@render macroEditors(sub, i, side, j)}
                        {@render extraArgEditor(sub, i, side, j)}
                        {#each problemsByPath.get(sub.id) ?? [] as p}<p class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</p>{/each}
                      </div>
                      <div class="ops">
                        <button class="tiny" onclick={() => moveInBranchSide(i, side, j, -1)} aria-label="Move up">↑</button>
                        <button class="tiny" onclick={() => moveInBranchSide(i, side, j, 1)} aria-label="Move down">↓</button>
                        <button class="tiny danger" onclick={() => removeFromBranchSide(i, side, j)} aria-label="Delete">✕</button>
                      </div>
                    </li>
                  {/each}
                </ol>
                <select
                  class="side-add"
                  value=""
                  onchange={(e) => {
                    addToBranchSide(i, side, e.currentTarget.value as MacroID);
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="">+ add a block…</option>
                  {#each MACRO_CATALOG_LIST as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
                </select>
              </div>
            {/each}
          {:else}
            <!-- Run another saved bot here — anyone's, since the library is shared. -->
            <span class="sentence">{subBotSentence(node)}</span>
            <span class="inline-edit">
              run
              {#if savedList.length === 0}
                <em>(no saved bots yet — save one first)</em>
              {:else}
                <select value={node.scriptID ?? ""} onchange={(e) => setSubBot(i, e.currentTarget.value)}>
                  <option value="" disabled>pick a saved bot…</option>
                  {#each savedList as meta (meta.scriptID)}<option value={meta.scriptID}>{meta.name}</option>{/each}
                </select>
              {/if}
            </span>
          {/if}
          {#each problemsByPath.get(node.id) ?? [] as p}<p class={p.severity === "blocking" ? "prob" : "note"}>{p.sentence}</p>{/each}
        </div>
        <div class="ops">
          <button class="tiny" onclick={() => moveStep(i, -1)} aria-label="Move up">↑</button>
          <button class="tiny" onclick={() => moveStep(i, 1)} aria-label="Move down">↓</button>
          <button class="tiny" onclick={() => duplicateStep(i)} aria-label="Duplicate">⧉</button>
          <button class="tiny danger" onclick={() => removeStep(i)} aria-label="Delete">✕</button>
        </div>
      </li>
    {/each}
  </ol>

  <div class="save-row">
    <button class="primary" onclick={saveBot} disabled={blockingCount > 0}>Save</button>
  </div>

  <!-- Copies another saved bot's steps onto the end of this one (never replaces
       it) — a one-time copy, not a live link: later edits to that saved bot do
       not change this one. That is the whole difference from [+ Saved bot]
       above, which links to the other bot instead of copying it. -->
  <h3>Insert steps from a saved bot</h3>
  <p class="subnote">
    Copy a saved bot's steps onto the end of the blocks you already have. This copies them once — later changes to
    that saved bot will not change this one.
  </p>
  {#if savedList.length === 0}
    <p class="empty">No saved bots yet. Save one below, then come back here to copy its steps.</p>
  {:else}
    <div class="snippet-grid">
      {#each savedList as meta (meta.scriptID)}
        <article class="snippet-card">
          <div class="snippet-name">{meta.name}</div>
          <p>Copy this bot's steps onto the end of the one you're editing.</p>
          <button class="primary tiny" onclick={() => insertSavedBot(meta)}>Insert steps</button>
        </article>
      {/each}
    </div>
  {/if}
  {#if insertNote}<p class="note snippet-note">{insertNote}</p>{/if}

  <!-- Palette -->
  <h3>Add a block</h3>
  <div class="palette-controls">
    <input
      class="block-search"
      type="search"
      placeholder="Search blocks…"
      bind:value={blockSearch}
      aria-label="Search blocks"
    />
    <div class="cat-chips" role="group" aria-label="Filter blocks by category">
      <button class="chip" class:active={activeCategory === "all"} onclick={() => (activeCategory = "all")}>
        All
      </button>
      {#each paletteCategories as cat (cat)}
        <button class="chip" class:active={activeCategory === cat} onclick={() => (activeCategory = cat)}>
          {CATEGORY_LABEL[cat]}
        </button>
      {/each}
    </div>
  </div>
  {#if filteredBlocks.length === 0}
    <p class="empty">No blocks match. Try a different word or category.</p>
  {:else}
    <div class="palette">
      {#each filteredBlocks as entry (entry.id)}
        <div class="macro-card">
          <div class="macro-name">{entry.name}</div>
          <div class="macro-cat">{CATEGORY_LABEL[entry.category]}</div>
          <div class="macro-does">{entry.does}</div>
          {#if entry.needs}<div class="macro-needs">Needs: {entry.needs}</div>{/if}
          <div class="macro-add">
            <button class="primary tiny" onclick={() => addStep(entry.id)}>Add</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Saved bots -->
  <h3>Saved bots</h3>
  <p class="subnote">Kept on the server and shared by every account — anyone can load, edit, or delete a bot saved here.</p>
  {#if libraryError}<p class="prob">{libraryError}</p>{/if}
  {#if savedList.length === 0}
    <p class="empty">No saved bots yet. Press Save above to keep one.</p>
  {:else}
    <ul class="rows">
      {#each savedList as meta (meta.scriptID)}
        <li class="row">
          <div class="body">
            <span class="sentence">{meta.name}</span>
            {#if meta.scriptID === currentSavedId}<span class="badge accent">open</span>{/if}
          </div>
          <div class="ops">
            <button class="tiny" onclick={() => loadSaved(meta.scriptID)}>Load</button>
            <button class="tiny danger" onclick={() => deleteSaved(meta.scriptID)}>Delete</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Import / export -->
  <h3>Import or export</h3>
  <p class="subnote">Paste a bot's JSON and load it, or export the current one to copy out.</p>
  <textarea class="io" bind:value={importText} placeholder="Paste a bot script (JSON) here…" rows="6"></textarea>
  <div class="controls">
    <button class="minor" onclick={importJson}>Load from box</button>
    <button class="minor" onclick={exportJson}>Export to box</button>
  </div>
  {#if importNote}<p class="note io-note">{importNote}</p>{/if}
</section>

<style>
  .botbuilder h3 {
    margin: 1.4rem 0 0.3rem;
    font-size: 0.95rem;
    color: var(--color-accent-bright);
  }
  .note {
    color: var(--color-muted);
    max-width: 60ch;
  }
  .advanced-note {
    color: var(--color-text);
    max-width: 70ch;
    border-left: 3px solid var(--color-accent);
    padding-left: 0.6rem;
  }
  .subnote {
    color: var(--color-muted);
    font-size: 0.85rem;
    margin: 0 0 0.5rem;
  }
  .field-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.8rem;
  }
  .field-row label,
  .field-row .field-caption {
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.8rem;
  }
  .field-row input {
    flex: 1;
    min-width: 12rem;
  }
  .steps-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.8rem;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--color-line);
    margin-top: 1.4rem;
  }
  .steps-head h3 {
    margin: 0 0 0.3rem;
  }
  .repeat-control {
    color: var(--color-muted);
  }
  .watch-buttons {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .rows {
    list-style: none;
    margin: 0.4rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    border: 1px solid var(--color-row-line);
    border-radius: 4px;
    background: var(--color-panel-3);
    padding: 0.5rem 0.6rem;
    min-height: 40px;
    flex-wrap: wrap;
  }
  .row .body {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .row .mark,
  .row .num {
    flex: none;
    color: var(--color-accent-dim);
    min-width: 1.2rem;
    text-align: center;
  }
  .row.watch {
    border-left: 3px solid var(--color-shield);
  }
  .sentence {
    color: var(--color-text-bright);
  }
  .inline-edit {
    color: var(--color-muted);
    margin-left: 0.4rem;
  }
  .inline-edit select,
  .inline-edit input,
  .repeat-control select,
  .repeat-control input {
    margin: 0 0.2rem;
  }
  input.pct,
  input.count {
    width: 4rem;
  }
  input.isk-in {
    width: 8rem;
  }
  select.belt-pick {
    max-width: 14rem;
  }
  /* A branch reads as one block with two indented sides. */
  .row.is-branch {
    border-left: 3px solid var(--color-accent-dim);
  }
  .branch-side {
    margin: 0.35rem 0 0 0.6rem;
    padding-left: 0.6rem;
    border-left: 1px dashed var(--color-line);
  }
  .side-label {
    color: var(--color-accent-bright);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    font-size: 0.72rem;
  }
  .side-empty {
    color: var(--color-muted);
    font-size: 0.85rem;
    margin-left: 0.4rem;
  }
  .side-list {
    list-style: none;
    margin: 0.2rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .side-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
    background: var(--color-panel-2);
    border-radius: 3px;
    padding: 0.3rem 0.4rem;
  }
  .side-row .body {
    flex: 1;
    min-width: 0;
  }
  select.side-add {
    margin-top: 0.15rem;
    font-size: 0.85rem;
  }
  .repeat-note {
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .ops {
    flex: none;
    display: flex;
    gap: 0.2rem;
  }
  button.tiny {
    min-height: 32px;
    padding: 0.1rem 0.5rem;
  }
  .prob {
    color: var(--color-danger);
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
  }
  .empty {
    color: var(--color-muted);
    background: var(--color-panel-3);
    border: 1px dashed var(--color-line);
    border-radius: 4px;
    padding: 0.8rem;
    text-align: center;
  }
  .snippet-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 0.6rem;
    margin: 0.4rem 0 0.7rem;
  }
  .snippet-card {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border: 1px solid var(--color-line);
    border-radius: 4px;
    background: var(--color-panel-3);
    padding: 0.65rem;
  }
  .snippet-name {
    color: var(--color-text-bright);
    font-weight: 600;
  }
  .snippet-card p {
    margin: 0;
    color: var(--color-text);
    font-size: 0.85rem;
    flex: 1;
  }
  .snippet-card button {
    align-self: flex-end;
  }
  .snippet-note {
    margin-top: 0.3rem;
  }
  .palette-controls {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.4rem 0 0.8rem;
  }
  .block-search {
    width: 100%;
    max-width: 22rem;
    min-height: 36px;
  }
  .cat-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .chip {
    min-height: 32px;
    padding: 0.2rem 0.7rem;
    border: 1px solid var(--color-line);
    border-radius: 999px;
    background: var(--color-panel-3);
    color: var(--color-muted);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .chip.active {
    border-color: var(--color-accent);
    color: var(--color-accent-bright);
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    font-weight: 600;
  }
  .macro-cat {
    color: var(--color-accent-dim);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 0.05rem;
  }
  .palette {
    display: grid;
    /* Strict grid: equal-width columns (auto-fill + 1fr keeps every column the
       same width and never stretches the last row), each card a FIXED height so
       every cell is identical regardless of how much text it holds. */
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0.6rem;
  }
  .macro-card {
    display: flex;
    flex-direction: column;
    height: 10rem;
    overflow: hidden;
    border: 1px solid var(--color-line);
    border-radius: 4px;
    background: var(--color-panel-3);
    padding: 0.6rem;
  }
  .macro-name {
    color: var(--color-text-bright);
    font-weight: 600;
  }
  .macro-does {
    color: var(--color-text);
    font-size: 0.85rem;
    margin: 0.2rem 0;
    flex: 1;
    overflow: hidden;
  }
  .macro-needs {
    color: var(--color-muted);
    font-size: 0.8rem;
    margin-bottom: 0.4rem;
  }
  /* Pin Add to the bottom-right of every card, so all cards read identically. */
  .macro-add {
    display: flex;
    justify-content: flex-end;
  }
  .save-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.8rem;
  }
  textarea.io {
    width: 100%;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.8rem;
  }
  .io-note {
    margin-top: 0.4rem;
  }
  button {
    min-height: 40px;
  }
</style>
