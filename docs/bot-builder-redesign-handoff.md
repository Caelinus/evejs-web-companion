# Handoff — the Bot Builder's visual redesign

Written 2026-09-02, at the end of the session that built everything below it. Self-contained: you should
not need to read the conversation that produced this.

## ✅ DONE — 2026-09-02, the session after this was written

The rebuild described below shipped. What changed from the plan, and what is left, is at the bottom
under **[What actually shipped](#what-actually-shipped)**. Everything above that heading is kept as
written, because it is still the reasoning behind the screen — read it before changing the screen.

## The job

Rebuild `web/src/ui/BotBuilder.svelte` (2155 lines) to the screen in
[bot-builder-interface.md](bot-builder-interface.md) §2 and the flow in §3. **This is a presentation
change.** The editor already *does* everything the format allows — the behaviour gaps were closed in a
previous slice. What is left is the layout the design settled on:

- the plan as numbered plain-English **sentence rows**, not rows that expand into forms
- a **step inspector** below (or, at ≤640px, a sheet that covers the plan)
- **watches in their own region**, never step zero of the list
- a **row action menu** (⋮): move up / down / to top / to bottom, duplicate, delete
- a **step picker** with search *and* category chips

A clickable prototype of the target is published at
https://claude.ai/code/artifact/7b0749ab-7d1d-477d-9dd8-246c89a801eb — it uses the app's real tokens and
the real 49-macro catalogue. Treat it as the reference for layout and copy, not as code to port.

## Read these first, in this order

1. [bot-builder-interface.md](bot-builder-interface.md) — the design and, more importantly, WHY. Every
   decision is tied to evidence or to a constraint in this codebase. §1 is the research, §5 the
   implications, §6 the questions already closed. Do not reopen a decision there without a reason the
   doc does not already answer.
2. [design-system.md](design-system.md) — binding. Shared `styles.css` classes only, no per-panel
   `<style>` block, targets ≥40px, no horizontal scroll at 360px, R7d (never render a raw numeric id),
   R9a (plain player language, no developer jargon).
3. [svelte-typecheck-gap.md](svelte-typecheck-gap.md) — read before you trust a green build. It will
   change how you verify.

## What is already built for this, and unused

**`web/src/bots/editorView.ts`** exists solely for this redesign and is currently **imported by
nothing**. It is the pure view model:

- `flattenProgram(program) -> readonly PlanRow[]` — rows with `nodeId`, `sentence`, `depth`,
  `branchSide`, `number`. Only top-level entries are numbered; loop bodies and branch sides are indented
  and unnumbered, exactly as the wireframe shows.
- `buildProblemIndex(problems) -> ProblemIndex`, `problemsForPath`, `pathHasBlockingProblem` — and a
  document-wide `hasBlocking` that is what disables Save. Advisories never disable anything; keeping
  those two apart is the point, not an implementation detail.
- `filterMacroPicker(query, category)` — searches name, `does`, `needs` and category label, and composes
  with the category chip. Both browse and search exist deliberately (the design cites Blockly shipping
  search rather than shrinking its palette).
- `findSelectedNode(program, id)` — resolves a node at top level, in a loop body, or in either branch
  side; returns `null` for a stale id rather than throwing.

**Everything else you need also already exists — use it, do not grow a rival:**

- `web/src/bots/scriptText.ts` — every player-facing sentence. This IS the R9a register. `editorView`
  renders through it; so must you.
- `web/src/bots/editorOptions.ts` — argument descriptors per macro (`MACRO_ARG_DESCRIPTORS`, split into
  required/optional), `UNTIL_CONDITION_KINDS`, `WATCH_CONDITION_KINDS`, and label tables typed
  `Record<ConditionKind, string>` and friends so a missing entry fails to COMPILE. The current component
  is already wired onto this; keep it that way.
- `web/src/bots/scriptEdit.ts` — the pure edit operations the row menu needs: `insertNode`, `removeNode`,
  `moveNode`, `duplicateNode`, `insertIntoLoop`, `removeFromLoop`, `moveInLoop`, `addInterrupt`,
  `removeInterrupt`, `setInterruptFraction`, `insertSavedBotSteps`.
- `web/src/bots/validateScript.ts` — `ScriptProblem` carries `severity: "blocking" | "advisory"`.

## What must not change

- The save path: `createBotScript` / `updateBotScript` with `currentRev` optimistic concurrency, and the
  conflict offering Reload or Save-as-copy.
- **Decode-on-read.** Every document reaching the editor goes through `decodeScriptValue` first. The
  server cannot run the codec (it is plain JS) — the browser is the only gate there is.
- The import/export box, the bundled examples, the saved-bot list, the station picker, sub-bot nodes, and
  "insert steps from a saved bot" (which copies steps by value — deliberately unlike a sub-bot, which is
  a live reference and disables the repeat control).
- The builder never starts a bot. Running belongs to the Bot Manager, in both directions.

## Verifying, which is not what you expect

**`docker build --target web-build` does NOT type-check Svelte props or templates.** `tsc` cannot parse
`.svelte`, there is no `svelte-check` (blocked on TypeScript 7 — see the gap doc), and `vite build`
compiles without checking. A required prop that no caller passes builds clean. This was proven, not
assumed.

So:

- **Pure modules run natively on the host** — `node --test web/src/bots/editorView.test.ts` — and there
  is no `node_modules` here, so anything importing Svelte needs Docker:
  ```
  docker build --target web-build -t evejs-check .
  docker run --rm evejs-check sh -c "node --test web/src/ui/botBuilderPanel.test.ts"
  ```
- **The SSR harness runs neither `$effect` nor `onMount`.** Every panel render is first-mount. A panel
  that loads its data in `onMount` never reaches its own child rows — `botManagerPanel.test.ts` renders
  the Bot Manager without ever reaching a pilot row, which is why `botManagerPilotRow.test.ts` exists
  and renders the row DIRECTLY. Do the same for anything the panel gates behind a load.

## Two traps this codebase has already sprung

Both passed their tests and built green. Neither would have been caught by any tool here.

1. **A test-only prop on a production component.** `BotManager.svelte` briefly took a `testSeed` prop so
   its empty/error states were reachable under SSR. Fixed by extracting the logic to a pure module
   (`libraryView.ts`) and testing that directly — which also revealed the template was duplicating the
   state machine. If you find yourself adding a seam, extract instead.
2. **Production defaults bent to fit a test.** To make an SSR test render the `corporation` and `agent`
   editors, two macros were added to the plan a NEW BOT STARTS WITH — every player's fresh bot would
   have opened as "undock, mine, deliver ore, find a distribution agent, request a mission". Reverted.
   The starter plan is player-facing content; if a test needs different content, the test is wrong.

The general shape: with no type safety on components, SSR renders are the only net, and bending the
component to fit the harness is a structural temptation rather than an occasional slip.

## Branch workflow

Never commit on `master` (pure vendor history) or directly on `tokeiito`. Cut a branch, merge into
`tokeiito` with `--no-ff`, push to `fork` (never `origin`, which is the vendor upstream). Ask before
opening an upstream PR.

Note this line of work branches from `tokeiito`, not `master`, because it depends on changes already
merged there — so it is not independently PR-able upstream the way a `fix/*` branch is.

## Also outstanding, if you want small wins first

- **Delete `web/src/bots/botLibrary.ts` and `botLibrary.test.ts`** — a complete, tested,
  localStorage-backed library that nothing imports, dead since the server-backed store shipped.
  [bot-manager-brainstorm.md](bot-manager-brainstorm.md) §7 called for this and it was never done.
- **The `serverBots` tab** is now largely redundant with the Bot Manager's pilots and recent-runs
  regions, but `ServerBots.svelte` is still needed by `CharacterSelect` pre-login. Removing the tab
  touches `tabs.ts`, `PanelHost.svelte`, `panelFirstMount.test.ts`, `tabModel.test.ts` and the
  `neocomIcons.ts` exhaustiveness guard (which makes a new tab a compile error until it has a glyph).
- **"Run this on all idle pilots"** in the manager's pilots region — recorded as open in
  bot-manager-brainstorm §9, and worth hesitating over: it is the fastest way to discover a script was
  never safe to run unattended on three hulls at once.

## What actually shipped

Written 2026-09-02, at the end of the session that carried the handoff out.

### The screen

`BotBuilder.svelte` went from 2155 lines to ~1000, and holds no display logic, no sentences, no widget
table and no edit operations of its own. `editorView.ts` is no longer imported by nothing: it is what
draws the plan.

- **Watches** are region one, with the cap (`3 of 8`) in the header and each row a sentence from
  `interruptSentence`. They can be reordered now — see `moveInterrupt` below.
- **The plan** is region two: numbered sentence rows from `flattenProgram`, branch sides indented and
  labelled `then` / `otherwise`, the top-level repeat in the region header, a `⚠` in the number column
  on any row with a blocking problem. Nothing expands in place.
- **The inspector** is region three, and is `BotInspector.svelte` — see below for why it is a component.
- The row `⋮` menu is move up / down / to top / to bottom, duplicate, delete, on plan rows and (as
  move / "also let me know" / delete) on watch rows. No drag anywhere.
- The step picker is a closed disclosure with a search field and category chips; the 49-macro grid no
  longer sits permanently under the plan.
- At ≤640px the inspector covers the plan and watches (`.botbuilder.sheet-open`), with a "Back to the
  plan" control that exists only there. **This is a `@container` query, not `@media`** — R85: the
  builder can sit in a floating window on a wide screen, so the question is how wide THIS panel is.

The per-panel `<style>` block is gone; every class lives in `styles.css`.

### The one structural decision this session took on its own

**The inspector is its own component, `BotInspector.svelte`.** The handoff's own trap #1 says to extract
rather than add a seam, and the inspector is only reachable after a click — which the SSR harness cannot
do. Left inside the builder, the largest and newest piece of template in the editor would have had zero
coverage, which is exactly the `BotManagerPilotRow.svelte` situation. It holds no state and no document:
it reads a node and reports what changed (`onArg`, `onCondition`, `onRespond`, `onAddToSide`,
`onSubBot`, `onClose`), and `botInspector.test.ts` renders it directly. No test-only prop was added
anywhere.

It also let the per-macro `{#if step.macro === "..."}` chain finally go: the inspector draws one field
per `ArgDescriptor`, switching on `ArgDescriptor.widget`. The wording objection recorded in
`editorOptions.ts` no longer applies, because the inspector's fields are LABELLED (`Belt`, `Stop when`)
rather than sentence fragments, so generating them reflows nothing a player reads.

### Moved into the pure layer, with tests

- `editorOptions.ts` gained `argBounds(macro, arg)` — the per-argument ranges the component used to
  hardcode (an agent level is 1–5, not the format's 1–500), including the per-macro override that keeps
  `hunt-player`'s leash shorter than a courier's trip; `untilOffered`, which decides whether a macro
  gets a "stop when" control at all; `freshCondition` and the condition clamps, which THREE pickers
  share and so must not live in a component; `CONDITION_PILOT_COUNT_HINT`.
- `scriptEdit.ts` gained `moveInterrupt`. Watches are first-match-wins at runtime, which is why the
  editor inserts a paired "let me know" row ABOVE its twin — a player who can see that order has to be
  able to change it, and there was no operation for it.

### Two things the design asked for that were not there before

- **The save conflict is two buttons**, not a sentence about a conflict. The server's refusal already
  said "Reload it, or save yours as a copy"; now Reload and Save-as-a-copy are controls.
- **Bounded number fields print their range** ("1 to 30", "% — from 5 to 90"). A bound a player cannot
  see is a rule they can only find by breaking it — the CodeStruct finding in §1, applied to bounds
  rather than to corrections.

### Verified

`docker build --target web-build` clean, and the full suite green in the image: **3210 tests, 0 fail**,
including 47 across `botBuilderPanel.test.ts` (rewritten for the new shape) and the new
`botInspector.test.ts`. The redesign was also rendered to a static page against the real compiled
stylesheet and looked at: no horizontal overflow at 360px (`scrollWidth === clientWidth === 360`), and
every control in the builder is ≥40px.

### Still outstanding

- **StationPicker's own `Change` button is 32px tall**, the one sub-40px target on the screen. It is
  pre-existing and belongs to `StationPicker.svelte`, which four other panels use, so it was left alone
  rather than changed from here.
- `botLibrary.ts` / `botLibrary.test.ts` **were deleted** — dead since the server-backed store shipped,
  as bot-manager-brainstorm §7 asked.
- The `serverBots` tab and "run this on all idle pilots" are untouched; both are Bot Manager work.
- Nothing here tests the builder's *interactions* — SSR renders once. The row menus, the pickers and the
  selection are proven only through the pure modules underneath them. A DOM test runner is still the
  gap, and it is the same gap `svelte-check` sits behind.
