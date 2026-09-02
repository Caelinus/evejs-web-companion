# Handoff — the Bot Builder's visual redesign

Written 2026-09-02, at the end of the session that built everything below it. Self-contained: you should
not need to read the conversation that produced this.

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
