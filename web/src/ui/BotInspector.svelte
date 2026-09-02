<script lang="ts">
  // REGION 3 of the Bot Builder — the inspector for whichever row is selected
  // (docs/bot-builder-interface.md §2). A plan row, or a watch row: a watch is
  // a sentence in its own region, so its threshold and response have nowhere
  // else to be edited, and giving the two their own inspectors would mean two
  // condition editors that could drift apart.
  //
  // ⚠ WHY THIS IS ITS OWN COMPONENT, AND NOT PART OF BotBuilder.svelte.
  // Svelte components are not type-checked by this project's build
  // (docs/svelte-typecheck-gap.md), so an SSR render is the only net a
  // template has — and the SSR harness cannot click. Inside the builder this
  // region is only reachable after a selection, so nothing would ever render
  // the widget switch below: the exact shape of the gap that made
  // `BotManagerPilotRow.svelte` a component of its own. Everything it draws
  // arrives as a prop, so `botInspector.test.ts` renders it directly, with no
  // test-only seam anywhere in it.
  //
  // It holds no state and no document. It reads a node and reports what the
  // player changed; `BotBuilder.svelte` owns the document and applies it.

  import {
    type Arg,
    type BranchBlock,
    type Condition,
    type ConditionKind,
    type InterruptResponse,
    type InterruptRow,
    type MacroID,
    type MacroStep,
    type SubBotNode,
    type WorldRef,
    MAX_ISK_ARG,
    MAX_TEXT_ARG_LEN,
    MIN_ISK_ARG,
  } from "../bots/botScript.ts";
  import {
    MACRO_ARG_DESCRIPTORS,
    CONDITION_PILOT_COUNT_HINT,
    MAX_CONDITION_PILOT_COUNT,
    argBounds,
    clampConditionCount,
    clampConditionFraction,
    clampConditionIsk,
    conditionFractionCap,
    conditionPercent,
    freshCondition,
    type ArgDescriptor,
    CONDITION_FRACTION_BOUNDS,
    CONDITION_NOUN_LABEL,
    CONDITION_UNTIL_LABEL,
    PLACE_OPTIONS,
    RESPONSE_OPTIONS,
    UNTIL_CONDITION_KINDS,
    WATCH_CONDITION_KINDS,
  } from "../bots/editorOptions.ts";
  import { MACRO_CATALOG_LIST, macroEntry } from "../bots/macroCatalogView.ts";
  import { interruptSentence } from "../bots/scriptText.ts";
  import type { ScriptProblem } from "../bots/validateScript.ts";
  import type { AppFlow } from "../app/flow.ts";
  import StationPicker from "./StationPicker.svelte";

  /** What the inspector is looking at. A branch and a sub-bot get their own
   * small forms; a loop header is never selectable, so there is no case for it. */
  export type InspectorTarget =
    | { readonly kind: "step"; readonly step: MacroStep }
    | { readonly kind: "branch"; readonly branch: BranchBlock }
    | { readonly kind: "sub-bot"; readonly subBot: SubBotNode }
    | { readonly kind: "watch"; readonly watch: InterruptRow };

  let {
    target,
    flow,
    currentStation = null,
    belts = [],
    equipment = [],
    items = [],
    pilots = [],
    agents = [],
    fittings = [],
    spots = [],
    savedBots = [],
    problems = [],
    onArg,
    onCondition,
    onRespond,
    onAddToSide,
    onSubBot,
    onClose,
  }: {
    target: InspectorTarget;
    flow: AppFlow;
    currentStation?: { id: number; name: string } | null;
    belts?: readonly { itemID: number; name: string }[];
    equipment?: readonly { groupID: number; label: string }[];
    items?: readonly { typeID: number; name: string }[];
    pilots?: readonly { characterID: number; characterName: string }[];
    agents?: readonly { agentID: number; name: string; stationName?: string | null; solarSystemName?: string | null }[];
    fittings?: readonly { fittingID: number; name: string }[];
    spots?: readonly { bookmarkID: number; name: string }[];
    savedBots?: readonly { scriptID: string; name: string }[];
    problems?: readonly ScriptProblem[];
    /** One argument changed. `undefined` clears it back to the macro's default. */
    onArg: (key: string, value: Arg | undefined) => void;
    /** The condition changed — a step's "stop when", a branch's fork, or a
     * watch's check, according to `target.kind`. `undefined` only ever comes
     * from a step whose `until` is optional. */
    onCondition: (condition: Condition | undefined) => void;
    onRespond: (respond: InterruptResponse) => void;
    onAddToSide: (side: "then" | "else", macro: MacroID) => void;
    onSubBot: (scriptID: string) => void;
    onClose: () => void;
  } = $props();

  // ── Reading an argument back out for its widget ─────────────────────────────
  function argOf(step: MacroStep, key: string): Arg | undefined {
    return step.args[key];
  }
  function numberValue(step: MacroStep, key: string): number | string {
    const arg = argOf(step, key);
    if (arg === undefined) return "";
    return arg.kind === "count" || arg.kind === "isk" || arg.kind === "qty" ? arg.value : "";
  }
  function textValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "text" ? arg.text : "";
  }
  function itemTypeValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "itemType" && arg.typeID !== null ? String(arg.typeID) : "";
  }
  function placeValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "place" ? arg.place : "";
  }
  /** The world ref a station-shaped or destination-shaped argument points at. */
  function worldRefValue(step: MacroStep, key: string): WorldRef {
    const arg = argOf(step, key);
    if (arg !== undefined && arg.kind === "station") return arg.ref;
    if (arg !== undefined && arg.kind === "destination") return arg.ref;
    return { entity: "station", id: null, name: null, systemName: null };
  }
  function beltChosenID(step: MacroStep, key: string): number | null {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? arg.belt.ref.id : null;
  }
  function beltChosenName(step: MacroStep, key: string): string | null {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? arg.belt.ref.name : null;
  }
  function beltSelectValue(step: MacroStep, key: string): string {
    const id = beltChosenID(step, key);
    return id === null ? "nearest" : String(id);
  }
  function characterValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "character" && arg.charID !== null ? String(arg.charID) : "";
  }
  function equipmentValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "equipment" ? String(arg.equipment.groupID) : "";
  }
  function agentValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "agent" && arg.ref.id !== null ? String(arg.ref.id) : "";
  }
  function fittingValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "fitting" ? String(arg.fittingID) : "";
  }
  function bookmarkValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "bookmark" ? String(arg.bookmarkID) : "";
  }
  function corpValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "corp" ? (arg.name ?? "") : "";
  }
  function channelValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "chatChannel" ? arg.channel : "local";
  }
  function rockPickValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "rockPick" ? arg.pick : "nearest";
  }

  // ── Turning what a widget reports back into an argument ─────────────────────
  /** Set (or clear, on an empty or unparseable input) a bounded number. */
  function setNumber(step: MacroStep, arg: ArgDescriptor, raw: string): void {
    const bounds = argBounds(step.macro, arg);
    const parsed = Number(raw);
    if (bounds === null || raw.trim() === "" || !Number.isSafeInteger(parsed)) {
      onArg(arg.key, undefined);
      return;
    }
    onArg(arg.key, { kind: arg.kind, value: Math.min(bounds.max, Math.max(bounds.min, parsed)) } as Arg);
  }
  function setBelt(key: string, raw: string): void {
    if (raw === "nearest") {
      onArg(key, { kind: "belt", belt: { mode: "nearest" } });
      return;
    }
    const match = belts.find((b) => b.itemID === Number(raw));
    if (match === undefined) return;
    // A belt ref carries no system name here: the picker only ever offers
    // belts on the CURRENT grid, and the builder stamps the system it knows.
    onArg(key, {
      kind: "belt",
      belt: { mode: "chosen", ref: { entity: "belt", id: match.itemID, name: match.name, systemName: null } },
    });
  }
  function setItemType(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = items.find((it) => it.typeID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "itemType", typeID: match.typeID, name: match.name });
  }
  function setCharacter(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = pilots.find((p) => p.characterID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "character", charID: match.characterID, name: match.characterName });
  }
  function setEquipment(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = equipment.find((e) => e.groupID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "equipment", equipment: { groupID: match.groupID, label: match.label } });
  }
  function setAgent(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = agents.find((a) => a.agentID === Number(raw));
    if (match === undefined) return;
    onArg(key, {
      kind: "agent",
      ref: { entity: "agent", id: match.agentID, name: match.name, systemName: match.solarSystemName ?? null },
    });
  }
  function setFitting(key: string, raw: string): void {
    const match = fittings.find((f) => f.fittingID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "fitting", fittingID: match.fittingID, name: match.name });
  }
  function setBookmark(key: string, raw: string): void {
    const match = spots.find((bm) => bm.bookmarkID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "bookmark", bookmarkID: match.bookmarkID, name: match.name });
  }
  /**
   * The one argument picker that is a plain text field: no live corporation
   * search exists anywhere in this app (unlike stations, fittings, bookmarks
   * or pilots), and the NAME is all the agent finders filter on. An empty
   * field means "any corporation", the shipped default.
   */
  function setCorp(key: string, raw: string): void {
    const trimmed = raw.trim();
    onArg(key, trimmed.length === 0 ? undefined : { kind: "corp", id: null, name: trimmed });
  }
  function setRockPick(key: string, raw: string): void {
    // Back to the default: drop the argument rather than storing "nearest",
    // so an untouched step exports exactly as it was imported.
    onArg(key, raw === "biggest" ? { kind: "rockPick", pick: "biggest" } : undefined);
  }
  function setWorldRef(arg: ArgDescriptor, ref: WorldRef): void {
    onArg(arg.key, arg.kind === "destination" ? { kind: "destination", ref } : { kind: "station", ref });
  }

  // ── Which arguments are visible, and which sit behind "More options" ────────
  /**
   * Apple's action-summary rule, cited in the design doc: the required
   * arguments, plus any optional one the player has ALREADY set — a choice
   * already made must not hide itself behind a disclosure the next time the
   * step is opened.
   */
  function summaryArgs(step: MacroStep): readonly ArgDescriptor[] {
    return MACRO_ARG_DESCRIPTORS[step.macro].all.filter((arg) => arg.required || step.args[arg.key] !== undefined);
  }
  function moreArgs(step: MacroStep): readonly ArgDescriptor[] {
    return MACRO_ARG_DESCRIPTORS[step.macro].all.filter((arg) => !arg.required && step.args[arg.key] === undefined);
  }
  function offersUntil(step: MacroStep): boolean {
    return MACRO_ARG_DESCRIPTORS[step.macro].untilOffered || step.until !== undefined;
  }
  function untilRequired(step: MacroStep): boolean {
    return MACRO_ARG_DESCRIPTORS[step.macro].untilRequired;
  }

  // ── Condition edits, reported whole ─────────────────────────────────────────
  function conditionOf(): Condition | undefined {
    if (target.kind === "step") return target.step.until;
    if (target.kind === "branch") return target.branch.when;
    if (target.kind === "watch") return target.watch.when;
    return undefined;
  }
  function changeKind(raw: string): void {
    onCondition(raw === "" ? undefined : freshCondition(raw as ConditionKind, conditionOf()));
  }
  function changeFraction(percent: number): void {
    const current = conditionOf();
    if (current === undefined || !("fraction" in current)) return;
    onCondition({ ...current, fraction: clampConditionFraction(percent / 100, current.kind) });
  }
  function changeIsk(raw: number): void {
    const current = conditionOf();
    if (current === undefined || !("isk" in current)) return;
    onCondition({ ...current, isk: clampConditionIsk(raw) });
  }
  function changeCount(raw: number): void {
    const current = conditionOf();
    if (current === undefined || !("count" in current)) return;
    onCondition({ ...current, count: clampConditionCount(raw) });
  }

  const heading = $derived(
    target.kind === "step"
      ? macroEntry(target.step.macro).name
      : target.kind === "branch"
        ? "A fork in the plan"
        : target.kind === "sub-bot"
          ? "Another saved bot"
          : `Watch — ${CONDITION_NOUN_LABEL[target.watch.when.kind]}`,
  );
</script>

<!-- A condition is edited in three places — a watch, a step's "stop when" and a
     branch's fork — and the three must never drift apart in what they offer or
     in how a threshold reads, so they are ONE block driven by `target.kind`. -->
{#snippet conditionEditor(id: string, label: string, kinds: readonly ConditionKind[], labels: Readonly<Record<ConditionKind, string>>, noneLabel: string | null)}
  {@const condition = conditionOf()}
  <label class="inspector-field" for={`${id}-kind`}>
    <span class="inspector-label">{label}</span>
    <select id={`${id}-kind`} value={condition?.kind ?? ""} onchange={(e) => changeKind(e.currentTarget.value)}>
      {#if noneLabel !== null}
        <option value="">{noneLabel}</option>
      {/if}
      {#each kinds as kind (kind)}
        <option value={kind}>{labels[kind]}</option>
      {/each}
    </select>
  </label>
  {#if condition !== undefined && "fraction" in condition}
    <label class="inspector-field" for={`${id}-fraction`}>
      <span class="inspector-label">How far</span>
      <span class="inspector-unit">
        <input
          id={`${id}-fraction`}
          class="num-in"
          type="number"
          min={conditionPercent(CONDITION_FRACTION_BOUNDS.min)}
          max={conditionPercent(conditionFractionCap(condition.kind))}
          value={conditionPercent(condition.fraction)}
          oninput={(e) => changeFraction(Number(e.currentTarget.value))}
        />
        <span class="inspector-suffix">
          % — from {conditionPercent(CONDITION_FRACTION_BOUNDS.min)} to {conditionPercent(conditionFractionCap(condition.kind))}
        </span>
      </span>
    </label>
  {:else if condition !== undefined && "isk" in condition}
    <label class="inspector-field" for={`${id}-isk`}>
      <span class="inspector-label">How much</span>
      <span class="inspector-unit">
        <input
          id={`${id}-isk`}
          class="num-in wide"
          type="number"
          min={MIN_ISK_ARG}
          max={MAX_ISK_ARG}
          step="1000000"
          value={condition.isk}
          oninput={(e) => changeIsk(Number(e.currentTarget.value))}
        />
        <span class="inspector-suffix">ISK</span>
      </span>
    </label>
  {:else if condition !== undefined && "count" in condition}
    <label class="inspector-field" for={`${id}-count`}>
      <span class="inspector-label">How many other pilots</span>
      <span class="inspector-unit">
        <input
          id={`${id}-count`}
          class="num-in"
          type="number"
          min="0"
          max={MAX_CONDITION_PILOT_COUNT}
          value={condition.count}
          oninput={(e) => changeCount(Number(e.currentTarget.value))}
        />
        <span class="inspector-suffix">{CONDITION_PILOT_COUNT_HINT}</span>
      </span>
    </label>
  {/if}
{/snippet}

<!-- One argument, drawn from its DESCRIPTOR rather than from a chain of
     `{#if step.macro === "..."}` branches. `ArgDescriptor.widget` comes from
     `ARG_KIND_WIDGET`, a `Record` over every `Arg["kind"]`, so a new argument
     kind is a compile error in `editorOptions.ts` before it can ever arrive
     here with no control to draw. That is the whole point of this switch: it
     is the last hand-written thing, and it is written once for all 49 macros. -->
{#snippet argField(step: MacroStep, arg: ArgDescriptor)}
  {@const fieldId = `arg-${step.id}-${arg.key}`}
  {@const bounds = argBounds(step.macro, arg)}
  {#if arg.widget === "station-picker" || arg.widget === "destination-picker"}
    <div class="inspector-field">
      <span class="inspector-label">{arg.label}</span>
      <StationPicker
        {flow}
        value={worldRefValue(step, arg.key)}
        current={currentStation}
        allowSystems={arg.widget === "destination-picker"}
        onPick={(ref) => setWorldRef(arg, ref)}
      />
    </div>
  {:else}
    <label class="inspector-field" for={fieldId}>
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> — optional</span>{/if}
      </span>
      {#if arg.widget === "belt-picker"}
        <select id={fieldId} value={beltSelectValue(step, arg.key)} onchange={(e) => setBelt(arg.key, e.currentTarget.value)}>
          <option value="nearest">the nearest belt</option>
          {#if beltChosenID(step, arg.key) !== null && !belts.some((b) => b.itemID === beltChosenID(step, arg.key))}
            <!-- The pinned belt is not on this grid right now — keep it
                 selectable rather than silently blanking the picker. Kept
                 short: a native select popup sizes itself to its widest option
                 and cannot be constrained from page CSS. -->
            <option value={String(beltChosenID(step, arg.key))}>
              {beltChosenName(step, arg.key) ?? "Pinned belt"} (off grid)
            </option>
          {/if}
          {#each belts as belt (belt.itemID)}
            <option value={String(belt.itemID)}>{belt.name}</option>
          {/each}
        </select>
      {:else if arg.widget === "equipment-picker"}
        <select id={fieldId} value={equipmentValue(step, arg.key)} onchange={(e) => setEquipment(arg.key, e.currentTarget.value)}>
          <option value="">use everything fitted</option>
          {#each equipment as eq (eq.groupID)}<option value={String(eq.groupID)}>{eq.label}</option>{/each}
        </select>
      {:else if arg.widget === "agent-picker"}
        <select id={fieldId} value={agentValue(step, arg.key)} onchange={(e) => setAgent(arg.key, e.currentTarget.value)}>
          <option value="">use the agent your bot finds</option>
          {#each agents as agent (agent.agentID)}
            <option value={String(agent.agentID)}>{agent.name}{#if agent.stationName} · {agent.stationName}{/if}</option>
          {/each}
        </select>
        {#if agents.length === 0}
          <span class="inspector-suffix">No agents found yet — open the Agent Finder first to pick one by hand.</span>
        {/if}
      {:else if arg.widget === "fitting-picker"}
        <select id={fieldId} value={fittingValue(step, arg.key)} onchange={(e) => setFitting(arg.key, e.currentTarget.value)}>
          <option value="" disabled>pick a saved fitting…</option>
          {#each fittings as f (f.fittingID)}<option value={String(f.fittingID)}>{f.name}</option>{/each}
        </select>
      {:else if arg.widget === "bookmark-picker"}
        <select id={fieldId} value={bookmarkValue(step, arg.key)} onchange={(e) => setBookmark(arg.key, e.currentTarget.value)}>
          <option value="" disabled>pick a saved spot…</option>
          {#each spots as bm (bm.bookmarkID)}<option value={String(bm.bookmarkID)}>{bm.name}</option>{/each}
        </select>
      {:else if arg.widget === "item-type-picker"}
        <select id={fieldId} value={itemTypeValue(step, arg.key)} onchange={(e) => setItemType(arg.key, e.currentTarget.value)}>
          {#if arg.required}
            <option value="" disabled>pick an item…</option>
          {:else}
            <option value="">everything in the hold</option>
          {/if}
          {#each items as it (it.typeID)}<option value={String(it.typeID)}>{it.name}</option>{/each}
        </select>
      {:else if arg.widget === "place-select"}
        <select id={fieldId} value={placeValue(step, arg.key)} onchange={(e) => onArg(arg.key, { kind: "place", place: e.currentTarget.value as never })}>
          {#each PLACE_OPTIONS as place (place.value)}<option value={place.value}>{place.label}</option>{/each}
        </select>
      {:else if arg.widget === "character-picker"}
        <select id={fieldId} value={characterValue(step, arg.key)} onchange={(e) => setCharacter(arg.key, e.currentTarget.value)}>
          {#if arg.required}
            <option value="" disabled>pick a pilot…</option>
          {:else}
            <option value="">any player</option>
          {/if}
          {#each pilots as pilot (pilot.characterID)}
            <option value={String(pilot.characterID)}>{pilot.characterName}</option>
          {/each}
        </select>
        {#if pilots.length === 0}
          <span class="inspector-suffix">No known pilots yet — add one from the login screen.</span>
        {/if}
      {:else if arg.widget === "chat-channel-select"}
        <select
          id={fieldId}
          value={channelValue(step, arg.key)}
          onchange={(e) => onArg(arg.key, { kind: "chatChannel", channel: e.currentTarget.value === "corp" ? "corp" : "local" })}
        >
          <option value="local">local chat</option>
          <option value="corp">corp chat</option>
        </select>
      {:else if arg.widget === "rock-pick-select"}
        <select id={fieldId} value={rockPickValue(step, arg.key)} onchange={(e) => setRockPick(arg.key, e.currentTarget.value)}>
          <option value="nearest">the nearest rock first</option>
          <option value="biggest">the biggest rock first</option>
        </select>
      {:else if arg.widget === "corp-picker"}
        <input
          id={fieldId}
          type="text"
          placeholder="any corporation"
          value={corpValue(step, arg.key)}
          oninput={(e) => setCorp(arg.key, e.currentTarget.value)}
        />
      {:else if arg.widget === "text-input"}
        <input
          id={fieldId}
          type="text"
          maxlength={MAX_TEXT_ARG_LEN}
          placeholder="write the message…"
          value={textValue(step, arg.key)}
          oninput={(e) => onArg(arg.key, { kind: "text", text: e.currentTarget.value.slice(0, MAX_TEXT_ARG_LEN) })}
        />
      {:else}
        <!-- count / isk / qty. The range is SHOWN, not merely enforced: a bound
             a player cannot see is a rule they can only find by breaking it. -->
        <span class="inspector-unit">
          <input
            id={fieldId}
            class="num-in wide"
            type="number"
            min={bounds?.min}
            max={bounds?.max}
            value={numberValue(step, arg.key)}
            oninput={(e) => setNumber(step, arg, e.currentTarget.value)}
          />
          {#if bounds !== null}
            <span class="inspector-suffix">
              {bounds.min} to {bounds.max}{#if !arg.required} · leave it empty for the usual{/if}
            </span>
          {/if}
        </span>
      {/if}
    </label>
  {/if}
{/snippet}

<section class="panel builder-inspector">
  <header class="panel-head">
    <h2>{heading}</h2>
    <div class="controls">
      <button type="button" class="minor inspector-back" onclick={onClose}>Back to the plan</button>
    </div>
  </header>

  {#if target.kind === "step"}
    {@const step = target.step}
    <p class="note">{macroEntry(step.macro).does}</p>
    {#each summaryArgs(step) as arg (arg.key)}
      {@render argField(step, arg)}
    {/each}
    {#if offersUntil(step)}
      {@render conditionEditor(
        `until-${step.id}`,
        "Stop when",
        UNTIL_CONDITION_KINDS,
        CONDITION_UNTIL_LABEL,
        untilRequired(step) ? null : "when the step is done",
      )}
    {/if}
    {#if moreArgs(step).length > 0}
      <details class="more-options">
        <summary>More options</summary>
        {#each moreArgs(step) as arg (arg.key)}
          {@render argField(step, arg)}
        {/each}
      </details>
    {/if}
  {:else if target.kind === "branch"}
    {@const branch = target.branch}
    <p class="note">Runs one set of steps or the other, depending on a check made when the plan reaches it.</p>
    {@render conditionEditor(`branch-${branch.id}`, "If", UNTIL_CONDITION_KINDS, CONDITION_UNTIL_LABEL, null)}
    {#each ["then", "else"] as const as side (side)}
      <label class="inspector-field" for={`branch-${branch.id}-${side}`}>
        <span class="inspector-label">Add a step to “{side === "then" ? "then" : "otherwise"}”</span>
        <select
          id={`branch-${branch.id}-${side}`}
          value=""
          onchange={(e) => {
            onAddToSide(side, e.currentTarget.value as MacroID);
            e.currentTarget.value = "";
          }}
        >
          <option value="">pick a step…</option>
          {#each MACRO_CATALOG_LIST as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
        </select>
      </label>
    {/each}
  {:else if target.kind === "sub-bot"}
    {@const subBot = target.subBot}
    <p class="note">
      Runs another saved bot from here, as that bot is saved right now. This is a live link, not a copy — and a
      bot that runs another bot cannot repeat as a whole.
    </p>
    <label class="inspector-field" for={`sub-${subBot.id}`}>
      <span class="inspector-label">Which bot</span>
      {#if savedBots.length === 0}
        <span class="inspector-suffix">No saved bots yet — save one first, then come back.</span>
      {:else}
        <select id={`sub-${subBot.id}`} value={subBot.scriptID ?? ""} onchange={(e) => onSubBot(e.currentTarget.value)}>
          <option value="" disabled>pick a saved bot…</option>
          {#each savedBots as meta (meta.scriptID)}<option value={meta.scriptID}>{meta.name}</option>{/each}
        </select>
      {/if}
    </label>
  {:else}
    {@const watch = target.watch}
    <p class="note">{interruptSentence(watch)}</p>
    {@render conditionEditor(`watch-${watch.id}`, "Watch for", WATCH_CONDITION_KINDS, CONDITION_NOUN_LABEL, null)}
    <label class="inspector-field" for={`watch-${watch.id}-respond`}>
      <span class="inspector-label">Then</span>
      <select
        id={`watch-${watch.id}-respond`}
        value={watch.respond}
        onchange={(e) => onRespond(e.currentTarget.value as InterruptResponse)}
      >
        {#each RESPONSE_OPTIONS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
    </label>
  {/if}

  {#each problems as problem (problem.sentence)}
    <p class={problem.severity === "blocking" ? "note error" : "note"}>{problem.sentence}</p>
  {/each}
</section>
