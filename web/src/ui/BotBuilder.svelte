<script lang="ts">
  // THE BOT BUILDER — three stacked regions: the watches that run all the time,
  // the numbered plan, and an inspector for whichever row is selected
  // (docs/bot-builder-interface.md §2/§3).
  //
  // THE ROW IS THE SUMMARY. Nothing expands in place: every row prints one
  // sentence from `scriptText.ts`, and every edit happens in the inspector
  // beside it. That is the shape change from the previous editor, which put an
  // inline widget strip inside each row and grew a hand-written
  // `{#if step.macro === "..."}` chain to draw them.
  //
  // WHAT THIS FILE IS NOT ALLOWED TO HOLD:
  //  • display logic — `bots/editorView.ts` flattens the plan into rows,
  //    indexes problems, filters the picker and resolves a selection;
  //  • sentences — `bots/scriptText.ts` is the one R9a register;
  //  • which widget an argument gets — `bots/editorOptions.ts` derives that
  //    from the format, and `BotInspector.svelte` draws it;
  //  • edit operations — `bots/scriptEdit.ts` owns the pure array transforms
  //    the row menus call.
  // Each of those has a `node --test` file that runs without a DOM, which
  // matters more here than usual: Svelte components are NOT type-checked by
  // this project's build (docs/svelte-typecheck-gap.md), so a mistake in a
  // template is only ever caught by an SSR render.
  //
  // Running a bot is not here and never will be: the builder edits, the Bot
  // Manager launches.

  import {
    type Arg,
    type BotScript,
    type Condition,
    type ConditionKind,
    type InterruptResponse,
    type InterruptRow,
    type MacroID,
    type MacroStep,
    type ProgramNode,
    type WorldRef,
    MAX_INTERRUPTS,
    MAX_NAME_LEN,
    MAX_NOTES_LEN,
    MAX_REPEAT_TIMES,
    MIN_REPEAT_TIMES,
  } from "../bots/botScript.ts";
  import { CATEGORY_LABEL, categoriesInUse, type BlockCategory } from "../bots/macroCatalogView.ts";
  import {
    newBranch,
    newEditorState,
    newStepFor,
    newSubBot,
    toEditorState,
    toScript,
    hasSubBot as planHasSubBot,
    type RepeatMode,
  } from "../bots/editorDoc.ts";
  import {
    CONDITION_NOUN_LABEL,
    WATCH_CONDITION_KINDS,
    freshCondition,
  } from "../bots/editorOptions.ts";
  import {
    buildProblemIndex,
    filterMacroPicker,
    findSelectedNode,
    flattenProgram,
    pathHasBlockingProblem,
    problemsForPath,
  } from "../bots/editorView.ts";
  import {
    duplicateNode,
    insertNode,
    insertSavedBotSteps,
    moveInterrupt,
    moveNode,
    removeInterrupt,
    removeNode,
    type FlatProgramNode,
  } from "../bots/scriptEdit.ts";
  import { EXAMPLE_BOTS, type ExampleBot } from "../bots/exampleBots.ts";
  import { interruptSentence } from "../bots/scriptText.ts";
  import { validateScript } from "../bots/validateScript.ts";
  import { decodeScriptText, decodeScriptValue, encodeScriptDoc } from "../bots/scriptCodec.ts";
  import {
    createBotScript,
    deleteBotScript,
    getBotScript,
    listBotScripts,
    updateBotScript,
    type BotScriptSummary,
  } from "../app/api.ts";
  import BotInspector, { type InspectorTarget } from "./BotInspector.svelte";
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

  // ── The document being edited ───────────────────────────────────────────────
  // The list the player sees is what a LOOP BODY may hold (steps and branches),
  // plus sub-bot nodes, which are legal only at the top level — so one list
  // builds either a looping bot or a run-once one, and `repeatMode` decides.
  type EditorNode = FlatProgramNode;

  // The document itself lives in `editorDoc.ts`, not here: `toScript` and
  // `toEditorState` are what decide the JSON a bot is saved as, and inside a
  // component nothing could test them. These fields are that state, spread into
  // runes so the template can bind to them.
  const initial = newEditorState();
  let name = $state(initial.name);
  let notes = $state(initial.notes);
  let repeatMode = $state<RepeatMode>(initial.repeatMode);
  let repeatCount = $state(initial.repeatCount);
  let home = $state<WorldRef>(initial.home);
  let watches = $state<InterruptRow[]>([...initial.watches]);
  let steps = $state<EditorNode[]>([...initial.steps]);

  // A program the one-list editor cannot hold — several loops, or a loop beside
  // loose steps — is kept VERBATIM here so it still runs and round-trips
  // unmangled, and the plan renders it read-only rather than silently dropping
  // the parts it cannot edit.
  let advancedProgram = $state<readonly ProgramNode[] | null>(initial.advancedProgram);
  // The outer loop's own id and stop condition, carried so that opening a bot
  // and saving it does not rename its loop or drop the only thing that could
  // stop it early. Neither has a control; both are part of the document.
  let loopID = $state<string | null>(initial.loopID);
  let loopUntil = $state<Condition | undefined>(initial.loopUntil);
  const readOnlyPlan = $derived(advancedProgram !== null);

  // ── What is selected, and what is open ──────────────────────────────────────
  // ONE selection drives the inspector, and it can be a plan row OR a watch
  // row: a watch is a sentence in its own region (§2 "Region 1"), so its
  // threshold and its response have nowhere else to be edited.
  type Selection = { readonly kind: "step"; readonly id: string } | { readonly kind: "watch"; readonly id: string };
  let selection = $state<Selection | null>(null);
  /** Which row's ⋮ menu is open — at most one, and never on first render. */
  let menuFor = $state<string | null>(null);
  let stepPickerOpen = $state(false);
  let watchPickerOpen = $state(false);
  let pickerQuery = $state("");
  let pickerCategory = $state<BlockCategory | null>(null);

  let importText = $state("");
  let importNote = $state<string | null>(null);
  let insertNote = $state<string | null>(null);
  let saveConflict = $state<string | null>(null);

  let savedList = $state<BotScriptSummary[]>([]);
  let currentSavedId = $state<string | null>(null);
  let currentRev = $state(0);
  let libraryError = $state<string | null>(null);

  const pickerCategories = categoriesInUse();

  // ── Derived ─────────────────────────────────────────────────────────────────
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
  const hasSubBot = $derived(planHasSubBot(steps));

  const builtDoc = $derived<BotScript>(buildScript());
  const problems = $derived(validateScript(builtDoc));
  const problemIndex = $derived(buildProblemIndex(problems));
  // The header badge counts what a player has to go and fix; Save reads
  // `hasBlocking`. An advisory is in neither — it never stops a save.
  const blockingCount = $derived(problems.filter((p) => p.severity === "blocking").length);

  // The rows of "the plan". A preserved advanced program renders its real
  // structure — loop headers and branch sides — rather than a flattened guess.
  const planRows = $derived(flattenProgram(advancedProgram ?? (steps as readonly ProgramNode[])));

  /** What the inspector is looking at, or null when the region collapses. */
  const inspectorTarget = $derived.by<InspectorTarget | null>(() => {
    if (selection === null) {
      return null;
    }
    if (selection.kind === "watch") {
      const row = watches.find((w) => w.id === selection.id);
      return row === undefined ? null : { kind: "watch", watch: row };
    }
    const found = findSelectedNode(steps as readonly ProgramNode[], selection.id);
    if (found === null) {
      // A stale id — the row was deleted between the click and this render.
      return null;
    }
    const node = found.node;
    if (node.kind === "macro") return { kind: "step", step: node };
    if (node.kind === "branch") return { kind: "branch", branch: node };
    if (node.kind === "sub-bot") return { kind: "sub-bot", subBot: node };
    return null; // a loop header is never selectable
  });
  const selectedProblems = $derived(selection === null ? [] : problemsForPath(problemIndex, selection.id));
  const pickerResults = $derived(filterMacroPicker(pickerQuery, pickerCategory));

  /** The document as it would be saved right now — one call into the tested
   * pure builder, so what Save writes is what `editorDoc.test.ts` proves. */
  function buildScript(): BotScript {
    return toScript({
      name,
      notes,
      repeatMode,
      repeatCount,
      home,
      watches,
      steps,
      advancedProgram,
      loopID,
      loopUntil,
    });
  }

  // ── Finding a row in the list ───────────────────────────────────────────────
  // The format's nesting is exactly two deep here (a branch's sides hold plain
  // steps and nothing else), so a row is either a top-level entry or one step
  // inside one side of one branch. Every row menu dispatches on this.
  type Spot =
    | { readonly scope: "top"; readonly index: number }
    | { readonly scope: "side"; readonly branchIndex: number; readonly side: "then" | "else"; readonly index: number };

  function locate(id: string): Spot | null {
    for (let i = 0; i < steps.length; i += 1) {
      const node = steps[i];
      if (node === undefined) continue;
      if (node.id === id) {
        return { scope: "top", index: i };
      }
      if (node.kind === "branch") {
        const then = node.then.findIndex((s) => s.id === id);
        if (then >= 0) return { scope: "side", branchIndex: i, side: "then", index: then };
        const other = node.else.findIndex((s) => s.id === id);
        if (other >= 0) return { scope: "side", branchIndex: i, side: "else", index: other };
      }
    }
    return null;
  }

  /** Replace one branch side's steps, leaving the rest of the list untouched. */
  function withSide(branchIndex: number, side: "then" | "else", next: readonly ProgramNode[]): void {
    const list = [...(next as readonly MacroStep[])];
    steps = steps.map((node, i) =>
      i === branchIndex && node.kind === "branch"
        ? side === "then"
          ? { ...node, then: list }
          : { ...node, else: list }
        : node,
    );
  }

  // ── The row menu (§3 "Reorder") ─────────────────────────────────────────────
  // Move up / down / to top / to bottom, Duplicate, Delete — the tested
  // Atlassian shape, and no drag anywhere (WCAG 2.2 SC 2.5.7 makes a drag-only
  // reorder a failure, and the one study with usability data found buttons
  // FASTER than dragging and needing no instruction). Every one of these is a
  // pure transform from `scriptEdit.ts`; "to top"/"to bottom" are a remove plus
  // an insert rather than a new operation, so there is still one idea of what
  // moving a node means.
  //
  // A branch's sides are `MacroStep[]`, and a `MacroStep` IS a `ProgramNode`,
  // so the same four operations serve both lists without a second copy of them.
  type Move = "up" | "down" | "top" | "bottom";

  function reorder(list: readonly ProgramNode[], index: number, move: Move): readonly ProgramNode[] {
    if (move === "up" || move === "down") {
      return moveNode(list, index, move === "up" ? -1 : 1);
    }
    const node = list[index];
    if (node === undefined) {
      return list;
    }
    const without = removeNode(list, index);
    return insertNode(without, node, move === "top" ? 0 : without.length);
  }

  function moveRow(id: string, move: Move): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (spot.scope === "top") {
      steps = reorder(steps as readonly ProgramNode[], spot.index, move) as EditorNode[];
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(spot.branchIndex, spot.side, reorder(spot.side === "then" ? branch.then : branch.else, spot.index, move));
  }

  function duplicateRow(id: string): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (spot.scope === "top") {
      steps = duplicateNode(steps as readonly ProgramNode[], spot.index, makeId) as EditorNode[];
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(
      spot.branchIndex,
      spot.side,
      duplicateNode(spot.side === "then" ? branch.then : branch.else, spot.index, makeId),
    );
  }

  function deleteRow(id: string): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (selection !== null && selection.kind === "step" && selection.id === id) {
      selection = null;
    }
    if (spot.scope === "top") {
      steps = removeNode(steps as readonly ProgramNode[], spot.index) as EditorNode[];
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(spot.branchIndex, spot.side, removeNode(spot.side === "then" ? branch.then : branch.else, spot.index));
  }

  function selectRow(id: string): void {
    menuFor = null;
    selection = selection !== null && selection.kind === "step" && selection.id === id ? null : { kind: "step", id };
  }
  function selectWatch(id: string): void {
    menuFor = null;
    selection = selection !== null && selection.kind === "watch" && selection.id === id ? null : { kind: "watch", id };
  }
  function toggleMenu(id: string): void {
    menuFor = menuFor === id ? null : id;
  }

  // ── Adding to the plan ──────────────────────────────────────────────────────
  /** Append a node, select it, and open the inspector on it (§3 "Add a step"). */
  function appendNode(node: EditorNode): void {
    advancedProgram = null;
    steps = insertNode(steps as readonly ProgramNode[], node) as EditorNode[];
    selection = { kind: "step", id: node.id };
  }

  function addStep(macro: MacroID): void {
    appendNode(newStepFor(macro, makeId));
    stepPickerOpen = false;
    pickerQuery = "";
  }
  function addBranch(): void {
    appendNode(newBranch(makeId));
  }
  function addSubBot(): void {
    appendNode(newSubBot(makeId));
  }

  // ── Watches ─────────────────────────────────────────────────────────────────
  function hasWatch(kind: ConditionKind): boolean {
    return watches.some((w) => w.when.kind === kind);
  }
  function addWatch(kind: ConditionKind): void {
    if (hasWatch(kind) || watches.length >= MAX_INTERRUPTS) return;
    // Sensible first responses: money, a full hold and an empty one are not
    // dangers, so they just stop; a pirate launches drones; being targeted or
    // joined by players is news rather than damage, so it tells you; anything
    // about health heads home.
    const respond: InterruptResponse =
      kind === "hostile-on-grid"
        ? "launch-drones"
        : kind === "targeted-by-player" || kind === "players-in-system-above"
          ? "alert"
          : kind === "wallet-below" ||
              kind === "wallet-above" ||
              kind === "cargo-full" ||
              kind === "ore-hold-at-least" ||
              kind === "hold-empty"
            ? "pause"
            : "dock-and-pause";
    const row: InterruptRow = { id: makeId(), when: freshCondition(kind), respond };
    watches = [...watches, row];
    watchPickerOpen = false;
    selection = { kind: "watch", id: row.id };
  }
  function removeWatch(id: string): void {
    menuFor = null;
    if (selection !== null && selection.kind === "watch" && selection.id === id) {
      selection = null;
    }
    watches = [...removeInterrupt(watches, id)];
  }
  function moveWatch(id: string, delta: number): void {
    menuFor = null;
    watches = [...moveInterrupt(watches, id, delta)];
  }
  /**
   * Pair an existing watch with an "alert me" row for the SAME check — the
   * "tell me, and also do the thing" combination.
   *
   * ⚠ THE NEW ROW GOES ABOVE THE ONE IT PAIRS WITH, and that is not cosmetic.
   * Watches are first-match-wins: below, the dock row would fire first and the
   * alert would never speak. Above, the alert speaks once, marks itself spent,
   * and from then on the scan skips it and reaches the dock row underneath.
   */
  function addAlertFor(row: InterruptRow): void {
    menuFor = null;
    if (watches.length >= MAX_INTERRUPTS) return;
    const at = watches.findIndex((w) => w.id === row.id);
    if (at < 0) return;
    const alertRow: InterruptRow = { id: makeId(), when: row.when, respond: "alert" };
    watches = [...watches.slice(0, at), alertRow, ...watches.slice(at)];
  }
  /** True when this row already has an "alert me" twin (so we offer it once). */
  function hasAlertTwin(row: InterruptRow): boolean {
    return watches.some((w) => w.respond === "alert" && w.when.kind === row.when.kind);
  }

  // ── Applying what the inspector reports ─────────────────────────────────────
  // The inspector holds nothing: it reads a node and says what changed. These
  // four put that back into the document, addressed by the SELECTION rather
  // than by an index, so a step edits the same way wherever it sits — top
  // level, or inside one side of a branch.
  function updateStepById(id: string, fn: (step: MacroStep) => MacroStep): void {
    steps = steps.map((node) => {
      if (node.id === id) {
        return node.kind === "macro" ? fn(node) : node;
      }
      if (node.kind !== "branch") {
        return node;
      }
      return {
        ...node,
        then: node.then.map((s) => (s.id === id ? fn(s) : s)),
        else: node.else.map((s) => (s.id === id ? fn(s) : s)),
      };
    });
  }

  /** Set one argument, or drop it entirely when `value` is undefined — back to
   * the macro's own default. A default is never stored explicitly, so an
   * untouched step exports exactly as it was imported. */
  function applyArg(key: string, value: Arg | undefined): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "step") return;
    updateStepById(target.step.id, (s) => {
      if (value === undefined) {
        const { [key]: _dropped, ...rest } = s.args;
        return { ...s, args: rest };
      }
      return { ...s, args: { ...s.args, [key]: value } };
    });
  }

  function applyCondition(condition: Condition | undefined): void {
    const target = inspectorTarget;
    if (target === null) return;
    if (target.kind === "step") {
      updateStepById(target.step.id, (s) => {
        if (condition === undefined) {
          const { until: _dropped, ...rest } = s;
          return rest as MacroStep;
        }
        return { ...s, until: condition };
      });
      return;
    }
    if (condition === undefined) {
      // Only a step's `until` is ever optional; a branch and a watch always
      // have a condition, so there is nothing to clear.
      return;
    }
    if (target.kind === "branch") {
      const id = target.branch.id;
      steps = steps.map((node) => (node.id === id && node.kind === "branch" ? { ...node, when: condition } : node));
      return;
    }
    if (target.kind === "watch") {
      const id = target.watch.id;
      watches = watches.map((row) => (row.id === id ? { ...row, when: condition } : row));
    }
  }

  function applyRespond(respond: InterruptResponse): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "watch") return;
    const id = target.watch.id;
    watches = watches.map((row) => (row.id === id ? { ...row, respond } : row));
  }

  function applyAddToSide(side: "then" | "else", macro: MacroID): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "branch") return;
    const spot = locate(target.branch.id);
    if (spot === null || spot.scope !== "top") return;
    const branch = steps[spot.index];
    if (branch === undefined || branch.kind !== "branch") return;
    const step = newStepFor(macro);
    withSide(spot.index, side, insertNode(side === "then" ? branch.then : branch.else, step));
    selection = { kind: "step", id: step.id };
  }

  function applySubBot(scriptID: string): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "sub-bot") return;
    const id = target.subBot.id;
    const chosen = savedList.find((bot) => bot.scriptID === scriptID) ?? null;
    steps = steps.map((node) =>
      node.id === id && node.kind === "sub-bot"
        ? { ...node, scriptID: chosen?.scriptID ?? null, name: chosen?.name ?? null }
        : node,
    );
  }

  // ── What the inspector's pickers can offer ──────────────────────────────────
  let savedFittings = $state<readonly { fittingID: number; name: string }[]>([]);
  let savedSpots = $state<readonly { bookmarkID: number; name: string }[]>([]);
  // The known-pilots roster (multibox onboarding records it) — names and ids
  // only, from localStorage; no token, no live read.
  let knownPilots = $state<readonly { characterID: number; characterName: string }[]>([]);
  onMount(() => {
    knownPilots = loadKnownCharacters().map((k) => ({ characterID: k.characterID, characterName: k.characterName }));
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
    void refreshSaved();
  });

  // Belt ids are grid-local, not global (unlike a station), so a galaxy-wide
  // search makes no sense: offer whatever belts are on the CURRENT grid, matched
  // by the same name test the runtime uses to resolve "nearest".
  // The system name rides along because it is written into the SAVED document
  // (see `setBelt` in BotInspector.svelte): a belt id means nothing outside the
  // grid it was read on, and this library is shared across accounts.
  const beltsOnGrid = $derived.by<readonly { itemID: number; name: string; systemName: string | null }[]>(() => {
    const systemID = $space.snapshot?.solarSystemID ?? null;
    const systemName = systemID !== null ? ($names.resolved[nameKey("system", systemID)] ?? null) : null;
    return ($space.snapshot?.entities ?? [])
      .filter((e) => /belt/i.test(e.name ?? ""))
      .map((e) => ({ itemID: e.itemID, name: e.name ?? "Unnamed belt", systemName }));
  });
  // Which fitted modules are the miners — from the ACTIVE ship's slots,
  // deduplicated by GROUP, because the format's equipment argument is a group
  // and not a single module. Left unset, the step runs every mining module
  // fitted, so an empty read is never a dead end.
  const fittedEquipment = $derived.by<readonly { groupID: number; label: string }[]>(() => {
    const seen = new Map<number, string>();
    for (const slot of $fitting.slots) {
      const module = slot.module;
      if (module !== null && module.groupID !== null && !seen.has(module.groupID)) {
        seen.set(module.groupID, $names.resolved[nameKey("type", module.typeID)] ?? "Fitted equipment");
      }
    }
    return [...seen.entries()].map(([groupID, label]) => ({ groupID, label }));
  });
  // Items offered = what is visible in the hangar/cargo right now, by NAME.
  const knownItems = $derived.by<readonly { typeID: number; name: string }[]>(() => {
    const seen = new Map<number, string>();
    for (const row of [...$inventory.hangar.rows, ...$inventory.cargo.rows]) {
      if (row.typeID > 0 && !seen.has(row.typeID)) {
        const label = $names.resolved[nameKey("type", row.typeID)] ?? null;
        if (label !== null && label.length > 0) {
          seen.set(row.typeID, label);
        }
      }
    }
    return [...seen.entries()].map(([typeID, name]) => ({ typeID, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  // ── Import / export ─────────────────────────────────────────────────────────
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
    importNote = `Loaded the "${example.label}" example — look it over, then save it.`;
  }
  /** Open a decoded document. Which of the three shapes it is — one loop, no
   * loop, or something the flat list cannot hold — is `toEditorState`'s call,
   * and it is tested there. */
  function loadFrom(doc: BotScript): void {
    const state = toEditorState(doc);
    name = state.name;
    notes = state.notes;
    home = state.home;
    watches = [...state.watches];
    steps = [...state.steps];
    repeatMode = state.repeatMode;
    repeatCount = state.repeatCount;
    advancedProgram = state.advancedProgram;
    loopID = state.loopID;
    loopUntil = state.loopUntil;
    selection = null;
    menuFor = null;
    saveConflict = null;
    idSeed += 1000;
  }

  // ── The saved-bot library (platform-wide, on the web server) ────────────────
  // Saved-bot calls are made directly from this component, so carry the ACTIVE
  // flow's complete options — token, base URL and injected fetch — exactly like
  // calls made inside flow.ts.
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
    saveConflict = null;
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
      const message = error instanceof Error ? error.message : "Could not save.";
      // A stale revision is refused by design (optimistic concurrency), and it
      // is the one save failure a player can actually resolve — so it gets the
      // two real choices rather than a sentence about a conflict.
      if (currentSavedId !== null && /save yours as a copy/i.test(message)) {
        saveConflict = message;
      } else {
        importNote = `Could not save: ${message}`;
      }
    }
  }
  /** The conflict's first choice: throw this draft away for the saved one. */
  async function reloadAfterConflict(): Promise<void> {
    if (currentSavedId === null) return;
    const id = currentSavedId;
    saveConflict = null;
    await loadSaved(id);
  }
  /** The conflict's second choice: keep this draft as a NEW saved bot, so the
   * other tab's version survives untouched. */
  async function saveAsCopy(): Promise<void> {
    saveConflict = null;
    currentSavedId = null;
    currentRev = 0;
    name = `${name} (copy)`;
    await saveBot();
  }
  async function loadSaved(id: string): Promise<void> {
    try {
      const record = await getBotScript(id, botOpts());
      if (record === null) {
        importNote = "That saved bot could not be found.";
        return;
      }
      // DECODE ON READ. The server cannot run this codec (it is plain JS and
      // says so), so the browser is the only gate there is.
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
  /**
   * Copy another saved bot's steps onto the end of this one — a BY-VALUE
   * insert, not a live reference. Unlike "+ Saved bot" (which creates a
   * sub-bot node pointing at the other bot, is top-level only, and forces this
   * bot to run once), this appends independent copies: the repeat control keeps
   * working, and later edits to that saved bot never change this one.
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
</script>

<!-- The per-row action menu (§3): move up / down / to top / to bottom,
     duplicate, delete. Buttons, never drag. -->
{#snippet rowMenu(id: string, label: string)}
  <div class="row-menu">
    <button
      type="button"
      class="minor row-menu-toggle"
      aria-expanded={menuFor === id}
      aria-label={`Actions for ${label}`}
      onclick={() => toggleMenu(id)}
    >
      ⋮
    </button>
    {#if menuFor === id}
      <div class="row-menu-items">
        <button type="button" class="minor" onclick={() => moveRow(id, "up")}>Move up</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "down")}>Move down</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "top")}>Move to top</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "bottom")}>Move to bottom</button>
        <button type="button" class="minor" onclick={() => duplicateRow(id)}>Duplicate</button>
        <button type="button" class="danger" onclick={() => deleteRow(id)}>Delete</button>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet problemNotes(path: string)}
  {#each problemsForPath(problemIndex, path) as problem (problem.sentence)}
    <p class={problem.severity === "blocking" ? "note error" : "note"}>{problem.sentence}</p>
  {/each}
{/snippet}

<div class="botbuilder" class:sheet-open={inspectorTarget !== null}>
  <!-- ─── The bot itself ───────────────────────────────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Bot builder</h2>
      <div class="controls">
        {#if blockingCount === 0}
          <span class="badge good">Ready</span>
        {:else}
          <span class="badge warn">{blockingCount} thing{blockingCount === 1 ? "" : "s"} to fix</span>
        {/if}
        <button type="button" class="primary" disabled={problemIndex.hasBlocking} onclick={saveBot}>Save</button>
      </div>
    </header>
    <p class="note">
      Build and save your bot here. Starting one is the Bot Manager's job, in the
      <strong>Bots</strong> tab — this window never flies anything.
    </p>

    <div class="controls">
      <label>
        Name
        <input id="bot-name" type="text" maxlength={MAX_NAME_LEN} bind:value={name} />
      </label>
      <label>
        Notes
        <textarea
          id="bot-notes"
          rows="2"
          maxlength={MAX_NOTES_LEN}
          bind:value={notes}
          placeholder="What this bot is for (optional)"
        ></textarea>
      </label>
    </div>
    {@render problemNotes("name")}

    {#if someWatchDocks}
      <div class="controls">
        <label>
          Home station — where a watch docks
          <StationPicker {flow} value={home} current={currentStation} onPick={(ref) => (home = ref)} />
        </label>
      </div>
      {@render problemNotes("home")}
    {/if}

    {#if saveConflict !== null}
      <!-- The optimistic-concurrency refusal, as the two choices it actually
           offers rather than as a sentence about a conflict. -->
      <div class="save-conflict">
        <p class="note error">{saveConflict}</p>
        <div class="controls">
          <button type="button" onclick={reloadAfterConflict}>Reload the saved one</button>
          <button type="button" class="primary" onclick={saveAsCopy}>Save mine as a copy</button>
        </div>
      </div>
    {/if}
    {#if importNote !== null}<p class="note">{importNote}</p>{/if}

    <div class="controls">
      <span class="example-label">Start from an example</span>
      {#each EXAMPLE_BOTS as example (example.key)}
        <button type="button" class="minor" title={example.blurb} onclick={() => loadExample(example)}>
          {example.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- ─── Region 1: always watching ────────────────────────────────────────────
       Its own region, never step zero of the plan — Home Assistant and Kodu
       both separate always-on rules from the sequence, and so does the format:
       an interrupt row is not a program node. -->
  <section class="panel builder-watches">
    <header class="panel-head">
      <h2>Always watching</h2>
      <div class="controls">
        <span class="badge">{watches.length} of {MAX_INTERRUPTS}</span>
      </div>
    </header>
    <p class="note">Checked every moment, from the top down — the first watch that matches is the one that acts.</p>
    {@render problemNotes("watches")}

    {#if watches.length === 0}
      <p class="empty">No watches yet. Nothing will interrupt this bot once it starts.</p>
    {:else}
      <ul class="plan-list">
        {#each watches as row, i (row.id)}
          <li class="plan-row" class:selected={selection?.kind === "watch" && selection.id === row.id}>
            <span class="plan-mark" aria-hidden="true">!</span>
            <button type="button" class="plan-sentence" onclick={() => selectWatch(row.id)}>
              {interruptSentence(row)}
            </button>
            <div class="plan-ops">
              <div class="row-menu">
                <button
                  type="button"
                  class="minor row-menu-toggle"
                  aria-expanded={menuFor === row.id}
                  aria-label={`Actions for the watch: ${interruptSentence(row)}`}
                  onclick={() => toggleMenu(row.id)}
                >
                  ⋮
                </button>
                {#if menuFor === row.id}
                  <div class="row-menu-items">
                    <button type="button" class="minor" disabled={i === 0} onclick={() => moveWatch(row.id, -1)}>
                      Move up
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={i === watches.length - 1}
                      onclick={() => moveWatch(row.id, 1)}
                    >
                      Move down
                    </button>
                    {#if row.respond !== "alert" && !hasAlertTwin(row) && watches.length < MAX_INTERRUPTS}
                      <button type="button" class="minor" onclick={() => addAlertFor(row)}>Also let me know</button>
                    {/if}
                    <button type="button" class="danger" onclick={() => removeWatch(row.id)}>Delete</button>
                  </div>
                {/if}
              </div>
            </div>
            {@render problemNotes(row.id)}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="plan-add">
      <button
        type="button"
        aria-expanded={watchPickerOpen}
        disabled={watches.length >= MAX_INTERRUPTS}
        onclick={() => (watchPickerOpen = !watchPickerOpen)}
      >
        + Watch
      </button>
      {#if watchPickerOpen}
        <div class="picker">
          <p class="note">One of each. A watch you already have is greyed out.</p>
          <div class="picker-results">
            {#each WATCH_CONDITION_KINDS as kind (kind)}
              <button type="button" class="picker-item" disabled={hasWatch(kind)} onclick={() => addWatch(kind)}>
                <span class="picker-item-name">{CONDITION_NOUN_LABEL[kind]}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- ─── Region 2: the plan ───────────────────────────────────────────────────
       Numbered sentence rows. The row IS the summary; the top-level repeat sits
       in the region header because it wraps everything below it. -->
  <section class="panel builder-plan">
    <header class="panel-head">
      <h2>The plan</h2>
      <div class="controls">
        {#if hasSubBot}
          <span class="note">Runs through once — a bot that runs other bots cannot repeat as a whole.</span>
        {:else}
          <label>
            Repeat
            <select bind:value={repeatMode}>
              <option value="forever">forever</option>
              <option value="times">a set number of times</option>
              <option value="once">just once</option>
            </select>
          </label>
          {#if repeatMode === "times"}
            <label>
              How many times
              <input
                class="num-in"
                type="number"
                min={MIN_REPEAT_TIMES}
                max={MAX_REPEAT_TIMES}
                bind:value={repeatCount}
              />
            </label>
          {/if}
        {/if}
      </div>
    </header>
    {@render problemNotes("program")}
    {@render problemNotes("main-loop")}

    {#if readOnlyPlan}
      <p class="note error">
        This bot repeats more than one group of steps, which this list cannot hold. It is kept exactly as
        written, so it still runs and still exports unchanged — the rows below are a read-only view. Edit it in
        the <strong>Import or export</strong> box; adding a step here turns it into a plain flat bot.
      </p>
    {/if}

    {#if planRows.length === 0}
      <p class="empty">No steps yet. Add the first one below.</p>
    {:else}
      <ol class="plan-list">
        {#each planRows as row, i (row.nodeId)}
          {@const previous = planRows[i - 1]}
          {#if row.branchSide !== null && (previous?.branchSide ?? null) !== row.branchSide}
            <li class="plan-side-label" style={`--depth: ${row.depth}`}>
              {row.branchSide === "then" ? "then" : "otherwise"}
            </li>
          {/if}
          <li
            class="plan-row"
            style={`--depth: ${row.depth}`}
            class:selected={selection?.kind === "step" && selection.id === row.nodeId}
            class:blocking={pathHasBlockingProblem(problemIndex, row.nodeId)}
          >
            <span class="plan-number">
              {#if pathHasBlockingProblem(problemIndex, row.nodeId)}
                <span class="plan-warn" aria-label="needs something before this bot can start">⚠</span>
              {:else if row.number !== null}
                {row.number}
              {:else if row.kind === "branch"}
                <span aria-hidden="true">⑂</span>
              {/if}
            </span>
            {#if readOnlyPlan || row.kind === "loop"}
              <span class="plan-sentence plan-sentence-static">{row.sentence}</span>
            {:else}
              <button type="button" class="plan-sentence" onclick={() => selectRow(row.nodeId)}>{row.sentence}</button>
            {/if}
            {#if !readOnlyPlan && row.kind !== "loop"}
              <div class="plan-ops">
                {@render rowMenu(row.nodeId, row.sentence)}
              </div>
            {/if}
            {@render problemNotes(row.nodeId)}
          </li>
        {/each}
      </ol>
    {/if}

    <div class="plan-add">
      <button type="button" aria-expanded={stepPickerOpen} onclick={() => (stepPickerOpen = !stepPickerOpen)}>
        + Step
      </button>
      <button type="button" onclick={addBranch}>+ Branch</button>
      <button type="button" onclick={addSubBot}>+ Saved bot</button>

      {#if stepPickerOpen}
        <!-- Browse AND search, not a smaller catalogue: Google's own answer to a
             large Blockly toolbox was a search plugin, and visible categories
             beat hidden navigation for discoverability. Both narrow the SAME
             list, so a query composes with a chip rather than replacing it. -->
        <div class="picker">
          <div class="controls">
            <label>
              Search steps
              <input type="search" placeholder="What do you want it to do?" bind:value={pickerQuery} />
            </label>
          </div>
          <div class="picker-chips" role="group" aria-label="Filter steps by category">
            <button type="button" class:active={pickerCategory === null} onclick={() => (pickerCategory = null)}>
              All
            </button>
            {#each pickerCategories as category (category)}
              <button
                type="button"
                class:active={pickerCategory === category}
                onclick={() => (pickerCategory = category)}
              >
                {CATEGORY_LABEL[category]}
              </button>
            {/each}
          </div>
          {#if pickerResults.length === 0}
            <p class="empty">Nothing matches. Try a different word, or pick All.</p>
          {:else}
            <div class="picker-results">
              {#each pickerResults as entry (entry.id)}
                <button type="button" class="picker-item" onclick={() => addStep(entry.id)}>
                  <span class="picker-item-name">{entry.name}</span>
                  <span class="picker-item-does">{entry.does}</span>
                  {#if entry.needs}<span class="picker-item-needs">Needs: {entry.needs}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <!-- ─── Region 3: the inspector ──────────────────────────────────────────────
       Empty means GONE, not a hollow frame. At or below 640px it becomes a
       sheet that covers the plan (`.sheet-open` in styles.css): a genuine
       two-pane layout cannot honour "no sideways scrolling at 360px". -->
  {#if inspectorTarget !== null}
    <BotInspector
      target={inspectorTarget}
      {flow}
      {currentStation}
      belts={beltsOnGrid}
      equipment={fittedEquipment}
      items={knownItems}
      pilots={knownPilots}
      agents={$finder.agents}
      fittings={savedFittings}
      spots={savedSpots}
      savedBots={savedList}
      problems={selectedProblems}
      onArg={applyArg}
      onCondition={applyCondition}
      onRespond={applyRespond}
      onAddToSide={applyAddToSide}
      onSubBot={applySubBot}
      onClose={() => (selection = null)}
    />
  {/if}

  <!-- ─── Reuse: copy another saved bot's steps in ─────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Insert steps from a saved bot</h2>
    </header>
    <p class="note">
      Copy a saved bot's steps onto the end of the plan you already have. This copies them once — later changes
      to that saved bot will not change this one.
    </p>
    {#if libraryError !== null}
      <p class="note error">{libraryError}</p>
    {:else if savedList.length === 0}
      <p class="empty">No saved bots yet. Save one first, then come back here to copy its steps.</p>
    {:else}
      <div class="picker-results">
        {#each savedList as meta (meta.scriptID)}
          <button type="button" class="picker-item" onclick={() => insertSavedBot(meta)}>
            <span class="picker-item-name">{meta.name}</span>
            <span class="picker-item-does">Copy this bot's steps onto the end of the plan.</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if insertNote !== null}<p class="note">{insertNote}</p>{/if}
  </section>

  <!-- ─── The shared library ───────────────────────────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Saved bots</h2>
    </header>
    <p class="note">
      Kept on the server and shared by every account — anyone here can load, edit or delete a bot saved here.
    </p>
    {#if libraryError !== null}
      <p class="note error">{libraryError}</p>
    {:else if savedList.length === 0}
      <p class="empty">No saved bots yet. Press Save above to keep one.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Name</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each savedList as meta (meta.scriptID)}
              <tr>
                <td data-label="Name">
                  {meta.name}
                  {#if meta.scriptID === currentSavedId}<span class="badge accent">open</span>{/if}
                </td>
                <td data-label="Actions">
                  <span class="row-actions">
                    <button type="button" onclick={() => loadSaved(meta.scriptID)}>Load</button>
                    <button type="button" class="danger" onclick={() => deleteSaved(meta.scriptID)}>Delete</button>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- ─── Import / export ──────────────────────────────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Import or export</h2>
    </header>
    <p class="note">Paste a bot and load it, or export this one to copy out.</p>
    <label class="io-label" for="bot-io">
      The bot, as text
      <textarea id="bot-io" class="io" rows="6" bind:value={importText} placeholder="Paste a bot here…"></textarea>
    </label>
    <div class="controls">
      <button type="button" class="minor" onclick={importJson}>Load from box</button>
      <button type="button" class="minor" onclick={exportJson}>Export to box</button>
    </div>
  </section>
</div>
