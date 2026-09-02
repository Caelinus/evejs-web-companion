# Bot Builder — interface and flow

Design only. No implementation. Supersedes the editor half of
[bot-builder-brainstorm.md](bot-builder-brainstorm.md) §5; the manager half lives in
[bot-manager-brainstorm.md](bot-manager-brainstorm.md).

Every decision below is tied to evidence or to an existing constraint in this codebase. Where the
literature does not settle something, that is said plainly rather than dressed up.

## 1. What the research settled

**No canvas. Structured list.** Godot removed VisualScript in 4.0 after measuring 0.5% adoption, and
said users "found out GDScript was a great fit and they pretty much ended up preferring it"
([blog](https://godotengine.org/article/godot-4-will-discontinue-visual-scripting/)). They kept visual
*shader* graphs — the failure is domain-specific. Node canvases demonstrably win in pure dataflow
domains (shaders, Houdini, Max/MSP) where intermediate values are visually inspectable at each node.
**Our model has no dataflow between steps at all**: every argument binds to a world object — a station,
an item type, a fitting — never to a prior step's result. The property that makes canvases pay for
themselves is exactly the one we lack.

Two unrelated communities also put the canvas ceiling at the same place: the
[Deutsch limit](https://en.wikipedia.org/wiki/Deutsch_limit) (~50 visual primitives on screen) and the
[Allar UE5 style guide](https://github.com/Allar/ue5-style-guide) ("No function should have more than 50
nodes"). Our caps are 32 top-level nodes and 64 total steps — a canvas would enter its documented danger
zone immediately. A list has no comparable collapse point.

**And a canvas would cost us something we currently have.** Every graph format surveyed — Unreal
`.uasset`, Node-RED JSON, n8n JSON — suffers positional diff noise: canvas coordinates and node GUIDs
sit in the same document as the logic, so "I dragged a node" and a real logic change are
indistinguishable in a diff, and none of them has working three-way merge. Our documents have no x/y at
all. Order is the only spatial fact. That is what makes them hand-editable in the import/export box and
safely mergeable under `rev`-based optimistic concurrency. Adopting a canvas would forfeit it.

**Closest living analogue: Home Assistant's automation editor.** Its **When** (triggers) / **And if**
(conditions) / **Then do** (sequential actions) split is a first-class structural separation, and maps
almost exactly onto our watches-plus-steps model
([docs](https://www.home-assistant.io/docs/automation/editor/)). Kodu's rule-based condition→response
model is the closest published precedent for always-on watches, and its designers likewise treat it as
architecturally distinct from sequential scripting. **Decision: watches are their own region, never
step zero of the list.**

**Closest commercial precedent for the body: Construct's event sheet**, described in its own manual as
"pretty much a spreadsheet with two columns." Flat, ordered, row-based; shipped for over a decade to a
large non-programmer audience. Vendor documentation, not peer-reviewed — but a genuine existence proof
at this exact grain.

**Sentence rendering is evidence-backed, not fashion.** Bau et al.,
[Learnable Programming: Blocks and Beyond](https://arxiv.org/pdf/1705.09413), argue blocks "forgo the
punctuation that text code uses to denote structure and use explanatory words instead", shifting the
user from *recall* to *recognition*. Weintrop & Wilensky
([ACM TOCE 2017](https://dl.acm.org/doi/10.1145/3089799)) found the largest block-vs-text difference was
on **comprehension** questions (p=0.002). The evidence is about chunking and recognition-over-recall,
not about English grammar being magic — which is precisely what our R9a house rule already asks for, and
what `scriptText.ts` already produces.

**Structural prevention, but keep the constraint visible.**
[CodeStruct](https://arxiv.org/pdf/2302.05708) (2023) measured 4.6× fewer syntax errors and 1.9× fewer
type errors from AST-level structured editing. The same paper found a real failure mode: where the
editor *silently auto-corrected*, students regressed 4× worse, because an invisible constraint teaches
nothing. Our codec already clamps out-of-range numbers **with spoken warnings** rather than silently —
that is the correct behaviour and must survive the redesign.

**Typed pickers over free text.** Blockly's own block-design guidance: choose the most restrictive input
the task allows, and explicitly "Don't blindly convert your entire API into blocks." Nearly all our arg
kinds have a fixed domain (station, itemType, fitting, place, bookmark, character, rockPick,
chatChannel) — those get pickers, never text entry.

**Reordering: buttons win; drag is a WCAG failure on its own.** SC 2.5.7 Dragging Movements is AA in
WCAG 2.2, and reordering a list is the
[Understanding document's](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) own
worked example, with "adjacent controls for moving the element up or down" given as the conforming
alternative; [F108](https://www.w3.org/WAI/WCAG22/Techniques/failures/F108) names drag-only lists as a
failure. GOV.UK's production reorderable list **disables drag below a viewport-width breakpoint** to stop
scroll being misread as drag — that regime is the 360px we target. The one source with actual usability
testing ([Senneff](https://www.darins.page/articles/designing-a-reorderable-list-component)) found
buttons *fastest* and needing no instruction. **The recorded "all buttons, zero drag-drop" decision
stands, now on better grounds than when written.**

**Correction to an option floated earlier in design discussion:** a "move to position N" numeric field
tested *worse* than buttons in that same study, because it forces a keyboard/pointer switch mid-task.
Atlassian, after testing at Jira/Trello scale, recommends a per-row **action menu** (Move up / down / to
top / to bottom) and explicitly advises against arrow-key drag modes, since JAWS users must switch
virtual-cursor modes to use arrows at all. Use the menu, not the number field.

**Palette: visible categories *and* search — not a smaller catalog.** There is no defensible number in
the literature for "how many categories"; Miller's 7±2 is widely misapplied to what is a recognition,
not recall, task. Google's own answer to a large toolbox was to ship a
[search plugin](https://google.github.io/blockly-samples/plugins/toolbox-search/README), not a size
rule. NN/g finds visible category structure beats hidden navigation for discoverability. Browse serves
"I don't know what I want yet"; search serves "I know the name, I can't find it." Both, not either.

## 2. Screen

One window, `botBuilder`, opened and focused from a Bot Manager library row's **Edit**. Three stacked
regions in the house `section.panel` idiom, shared `styles.css` only — no per-panel `<style>` block.

```
┌ BOT BUILDER — "Mining day" ───────────────── [Ready] [Save] ┐
│                                                              │
│ ┌ ALWAYS WATCHING ───────────────────────────── 3 of 8 ──┐   │
│ │ ! Shields below 50%      → Turn on repairers      ⋮ ✕ │   │
│ │ ! Hostiles on grid       → Launch drones          ⋮ ✕ │   │
│ │ ! Hull below 50%         → Dock and stop          ⋮ ✕ │   │
│ │ [+ Watch ▾]                                           │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌ THE PLAN ─────────────────── Repeat: [forever ▾] ─────┐   │
│ │  1  Undock.                                      ⋮ ✕ │   │
│ │  2  Fly to the nearest belt.                     ⋮ ✕ │   │
│ │ ▸3  Mine the biggest rocks until the ore hold    ⋮ ✕ │   │
│ │     is nearly full.                                   │   │
│ │  4  Haul it to Jita IV-4 and unload.             ⋮ ✕ │   │
│ │  5  ⚠ Refine the ore. — needs a station               │   │
│ │  6  ⑂ If shields below 60%                       ⋮ ✕ │   │
│ │       then  Repair the ship.                          │   │
│ │       else  Refine the ore.                           │   │
│ │ [+ Step ▾] [+ Branch] [+ Saved bot] [+ Group ▾]      │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌ STEP 3 — Mine at a belt ──────────────────────────────┐   │
│ │ Which belt?      [ the nearest one          ▾ ]       │   │
│ │ Which rocks?     [ biggest first            ▾ ]       │   │
│ │ Stop when?       [ the ore hold is nearly full ▾ ]    │   │
│ │                  [ 90 ] %                             │   │
│ │ ▸ More options                                        │   │
│ │     Mining lasers  [ all of them            ▾ ]       │   │
│ └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Region 1 — Always watching.** Independent of the plan, as Home Assistant and Kodu both separate them.
Count against the cap of 8 is visible. Each row is a sentence, not a form.

**Region 2 — The plan.** Numbered sentence rows from `scriptText.ts`. The row *is* the summary; nothing
expands in place. Branch bodies indent one level and are the only nesting the format permits. The
top-level repeat sits in the region header, since it wraps everything.

**Region 3 — Step inspector.** Edits the selected row. Following Apple's published action-summary rules,
**required arguments are visible; optional ones sit behind "More options."** Empty when nothing is
selected — the region collapses rather than showing a hollow frame.

**At ≤640px** the inspector is not a third region but a sheet that covers the plan when a step is
selected, with a back control. This is forced: no horizontal page scroll at 360px is a house rule, and
a genuine two-pane layout cannot honour it.

## 3. Flow

**Create.** Bot Manager → New bot. Opens the builder with one empty plan, the name field focused, and
zero watches. No safety floor is injected — the codec stopped doing that, and the UI must not pretend
otherwise (see §5).

**Add a step.** `[+ Step ▾]` opens the picker: a search field, then category chips, then results as
sentences with their "what it needs" line. Categories stay visible; search filters across name, does,
and needs. A step is appended at the end, selected, and the inspector opens on it.

**Configure.** Inspector only. Every argument with a fixed domain gets a picker; numbers get bounded
inputs that show their range. Nothing is free text except `send-chat`'s message and the bot name.

**Reorder.** Per-row `⋮` menu: Move up / Move down / Move to top / Move to bottom / Duplicate / Delete.
No drag. The menu is the tested pattern for long-distance moves.

**Validate.** Continuous, as today, but with a severity split borrowed from Power Automate's Flow
Checker: **blocking** problems (a required argument unset) mark the row `⚠` and disable Save; **advisory**
ones (a mining bot with no watches; a plan that never returns to a station) show as notes and do not.
The header badge aggregates — "Ready" or "2 things to fix" — so nobody hunts row by row through 64 steps.

**Save.** To the platform-wide library, `rev`-checked. A conflict offers Reload or Save as copy.

**Run.** Not here. The builder never starts a bot; the manager does. This keeps the "launcher, not
editor" separation the codebase already asserts, in both directions.

## 4. What this fixes from the audit

- **Arg editors generated from `MACRO_SPECS.params` by kind**, not a hand-written `{#if step.macro ===
  …}` chain. This is the root cause of the missing `equipment`, `corporation`, and `agent` widgets, and
  of `request-mission` having no editor at all. A new macro then costs no UI work.
- **Condition lists derived** from `CONDITION_KINDS` filtered through `conditionAllowedAt`, not two
  hardcoded arrays. Restores `wallet-below`, `wallet-above`, `cargo-full` as `until`/branch conditions,
  and `health-below`, `ore-hold-at-least`, `hold-empty` as watches.
- **Label tables typed `Record<ConditionKind, …>`** so the compiler catches the next divergence, as it
  already does for `Record<MacroID, …>`.
- **`notes` gets a field** instead of being pinned to `""` and silently discarded on save.
- **`RESPONSE_OPTIONS` / `PLACE_OPTIONS` derived** from `INTERRUPT_RESPONSES` / `ITEM_PLACES`.

## 5. Implications worth deciding before building

1. **Sentence rows need `scriptText.ts` unchanged — inline editable chips would not.** Apple's Shortcuts
   model puts tappable parameter chips *inside* the sentence, which requires the generator to emit
   segments rather than a flat string. `scriptText.ts` returns strings today, and it is a
   compile-exhaustive safety module. **Recommend: read-only sentence rows plus an inspector now**
   (Zapier/Power Automate shape); revisit chips later if the inspector proves clumsy. Flagged because it
   is the one place this design knowingly takes the cheaper option.
2. **The safety floor stays removed, and its leftover machinery gets stripped. — DECIDED.**
   The removal itself was decided on 2026-07-23 from live feedback
   ([bot-builder-progress.md:148](bot-builder-progress.md:148)): "watches are the player's now — the
   codec no longer injects one." What did not go with it was the `builtIn: "safety-floor"` field, which
   is not inert:
   - `scriptConditions.ts:348` — only a `builtIn` row can set `safetyBlind`, which seeds the cannot-tell
     streak at `scriptDecide.ts:393`. Nothing creates such a row, so that input is permanently off.
   - `scriptDecide.ts:368` — labels the safety-override pause with `safetyFloorID(script)`, which now
     always returns `null`.
   - `hasSafetyFloor` / `safetyFloorRow` (`botScript.ts:754,759`) have no non-test callers.
   - **The import box can still create one.** The codec accepts the flag and
     `scriptEdit.removeInterrupt` refuses to delete such a row — so a hand-written import can produce an
     undeletable watch with privileged runtime behaviour that the editor can neither create nor remove.

   **Strip all of it**: the field from the format, the branch in `scriptConditions`, `safetyFloorID` and
   its call site, both dead helpers, and the `removeInterrupt` guard. The codec ignores the key on old
   imports rather than preserving it.

   **What must survive**: the *unconditional* acute override at `scriptConditions.ts:352` — hostile on
   grid with unreadable health pauses the ship regardless of any floor row. That is the real safety net
   and it never depended on `builtIn`.
3. **13 categories for 49 macros, four of them singletons** (Flow, Industry, Planets, Chat & Social).
   The literature gives no defensible category count, so this is a judgement call, not an evidence call.
   With search present, singletons cost little; merging them into a "Other" or folding Industry into
   Mining would trade discoverability for tidiness. **Recommend leaving as-is** and letting search carry
   the load, per Blockly's precedent.
4. **Validation gets two severities. — DECIDED.** `ScriptProblem` gains
   `severity: "blocking" | "advisory"`; `validateScript.ts` returns it and existing callers keep
   working by treating everything as blocking until updated.
   - **Blocking** — a required argument unset, an empty program, an out-of-range repeat count, a loop
     with an empty body, `move-items` with `from === to`. Marks the row amber, disables Save.
   - **Advisory** — a `mine-at-belt` with no `until`, a bot with zero watches, a plan that never docks
     or unloads, a `forever` loop with no watch that can stop it. Grey note on the row, never blocks.

   Advisories stay in the builder rather than moving to the run dialog: they are authoring mistakes, and
   the moment to see them is while the plan is in front of you. The run-approval dialog keeps its own
   separate job — risk classes and the grant — which is why risk chips were dropped from the inspector.
5. **`cloneWithFreshIds` must be fixed before Duplicate ships in a menu** — it does not re-id branch
   sides, so duplicating a branch produces colliding step ids. `subBots.ts:209` has correct recursive
   re-idding to reuse.

## 6. Open

- ~~Whether the inspector should show the step's *risk class* inline.~~ **Decided: no.** Risk stays in
  the run-approval dialog, where the decision to fly is actually made; repeating it while editing adds
  noise to every step for a consequence that is not yet being committed to.
- ~~Whether `[+ Group ▾]` still earns its place.~~ **Decided: fold the six `blockSnippets` sequences
  into the platform-wide library as starter bots**, alongside the nine examples, so a saved bot is the
  only unit of reuse. `blockSnippets.ts` goes away.

  **Insert them by value, not by reference.** Inserting a saved bot today creates a `SubBotNode`, and
  those are top-level only (`scriptCodec.ts:625`); `BotBuilder.svelte` sets `hasSubBot`, which disables
  the repeat control outright. A starter bot inserted that way would silently make the whole bot
  non-repeatable and could never sit inside a branch — a regression against today's groups, which append
  plain steps that stay in the loop. So the insert action **copies the starter's steps into the list**
  with fresh ids. Sub-bot *references* remain a separate feature for genuine composition.
- No peer-reviewed study evaluates a pure structured-list editor head-to-head against blocks or text —
  the strongest evidence for this specific form is Construct's commercial track record plus the absence
  of the failure modes Bau names. Our own use is the primary evidence; treat the first built version as
  something to test, not a settled answer.
