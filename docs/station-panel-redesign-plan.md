# Plan: the Station Panel redesign (docked dock panel)

Written 2026-09-06 against `design_handoff_station_panel`. The handoff redesigns **the right-hand
dock panel while docked**: bays / ship hangar / item hangar / corp hangar / station services, as
table rows instead of tiles, with a pinned action bar and width tiers.

This plan exists because the docked panel and the **in-space** panel are the same frame and, today,
partly the same component. The whole of section 1 is about why that is dangerous and how the change
is shaped so it cannot reach space.

---

## 1. The blast radius, measured

### 1.1 What actually renders on the right, and when

| Where | Docked | In space |
| --- | --- | --- |
| `Workspace.svelte` -> `DockPanel.svelte` | `<InventoryShip dock>` | `<Overview compact>` |
| `MobileWorkspace.svelte` home | `<InventoryShip dock>` | `ShipHud` + `ModuleRack` + `TargetBracket` + `<Overview>` |
| `PanelHost.svelte` (`tab === "inventory"`) | (Neocom de-dupes to the dock panel) | **`<InventoryShip>` as a floating window** |

**The trap.** `InventoryShip.svelte` is not a docked component. It is mounted **in space** too, as
the Neocom's "Inventory & Ship" floating window and as a mobile panel. It already knows this —
`isDockedNow` drops the Station Services tab in space, and `ships` synthesises the active hull when
there is no station hangar to read. A rewrite of that file is a rewrite of the in-space inventory
window, whether or not that was the intent.

### 1.2 What is shared, and what is not

Grepped, not assumed:

* `.item-grid`, `.item-tile*`, `.inv-*` are used by **`InventoryShip.svelte` only**.
* `.dock-panel*`, `.dock-inventory`, `.dock-overview` are used by **`DockPanel.svelte` only**.
* `StationPanel.svelte` is **dead code** — imported by nothing except the `panelFirstMount` panel
  list. R60 folded its content into the Station Services tab and nobody deleted the file.

So the CSS is already well contained. The genuinely shared surfaces are:

1. **`DockPanel.svelte`'s frame** — `.dock-panel-head` (title + collapse `>`), `.dock-panel-body`
   (`overflow:auto` + `0.6rem 0.7rem` padding), `.dock-resize`, `MIN_W = 240`, `MAX_W = 900`.
   The new panel wants `grid-template-rows: auto auto 1fr auto` with only the content row scrolling
   and its own header — i.e. it wants the frame's head and body **gone**. The Overview wants them
   kept exactly as they are.
2. **`.mobile-main`** — `overflow-y:auto` + padding + flex column. A panel with a pinned action bar
   needs a `height:100%; min-height:0; overflow:hidden` host. That host is shared with the in-space
   mobile home.
3. **Global tokens in `styles.css`** (`--color-*`, `--radius-*`, `--font-display`). The handoff's
   palette is close to but not the same as the app's. Editing the tokens repaints the entire client,
   in space included.
4. **`desktop.ts` layout persistence** and `Workspace.svelte`'s `work-main` layout, if the
   expand/dock toggle is implemented.

### 1.3 The shape that makes space untouchable

> **Build a new component. Do not rewrite `InventoryShip.svelte`.**

`InventoryShip.svelte` stays byte-identical and keeps serving the in-space floating window and the
in-space mobile panel. The new `StationPanel.svelte` is mounted **only** on branches already guarded
by `isDocked`:

* `DockPanel.svelte`, the `{#if isDocked}` arm;
* `MobileWorkspace.svelte`, the `{:else if isDocked}` home arm.

There is then no code path from an undocked pilot to a single line of new markup, and the proof is a
grep, not an argument.

The cost is duplicated behaviour (selection, destinations, fit maths, refusal handling), which is
why Phase 0 extracts that behaviour into a pure module both components call. The extraction is
verified by the existing suite: `InventoryShip` must keep rendering exactly what it renders today.

**The one shell change that can still reach space** is the expand/dock toggle (Phase 4), because it
hides `<Desktop>`. It gets its own guard and its own test — see 5.4.

---

## 2. What the handoff gets right, and where it must bend

Fidelity is "high" and the colours/type/spacing are called final, so the default is to match. These
are the places where matching would break something the app already guarantees.

### 2.1 Hard deviations (non-negotiable, project rules)

| Handoff says | This app does | Why |
| --- | --- | --- |
| Item icons from `images.evetech.net/types/{id}/icon` | `TypeIcon.svelte` -> `/icon-cache/types/64/icon/{id}.png` | `web/src/ui/typeIcons.ts`: **icons are local only**. The browser never touches an external host — the client works offline and leaks nothing about what the player is flying. `getRemoteTypeIconUrl` exists and "must not be wired to the browser without an explicit, off-by-default opt-in". |
| Ship renders from `.../render?size=64` | there is no local render cache | Same rule. Use `TypeIcon` for hulls too; add a size step if 44px is wanted. |
| Google Fonts Barlow + Barlow Condensed | `@fontsource/barlow-semi-condensed` (body) + `@fontsource/barlow-condensed` (display), already bundled | No new webfont, no external font host. The handoff explicitly allows "substitute the app's existing sans/condensed pair". |
| Raw hex colours inline | a scoped token block | See 2.2. |
| Tier from `ResizeObserver` | CSS container queries | See 2.3. |
| Row `>` popover as `position: fixed` | absolute inside the panel | See 2.3. |

### 2.2 Colours: a scoped `--stn-*` block, not new globals

Precedent exists: `PilotHangar` carries its own `--hangar-*` palette under `.hangar` /
`.hangar-chrome` (`styles.css` ~5050). Do the same — declare every handoff colour as `--stn-*` on
`.stn-panel` and reference the tokens from there down.

This gets the handoff's exact palette without touching `--color-*`, so the Overview, the HUD, the
tactical view and every other panel are provably unaffected. Radius is already 0 everywhere (R53),
which is what the handoff wants; `squareCorners.test.ts` keeps it that way.

### 2.3 Tiers and popovers: two technical traps

**Container queries, not `ResizeObserver`.** Every guardrail test in this repo renders components
with `svelte/server` — `$effect` and `onMount` never run, and there is no DOM. A tier computed from
a measured width would render at a fallback tier in every test and could not be asserted. Container
queries put the whole DOM in the output and hide columns per tier in CSS, which is exactly how
`reflowContract.test.ts` already reasons (it reads `styles.css` off disk). It is also the lesson
that goal already learned the hard way: a **media** query asked how wide the *viewport* was and
crushed a four-column table inside a 320px panel on a 1440px screen. This panel lives in that same
resizable column.

**`container-type: inline-size` establishes a containing block for `position: fixed` descendants.**
The handoff's row `>` menu is `position: fixed` with coordinates from `getBoundingClientRect()`
against the viewport. Inside a container that silently becomes "relative to the panel" and the menu
lands in the wrong place. Fix: keep the menu at the panel root but `position: absolute`, with
coordinates computed from the panel's own rect, clamped to the panel and flipped up near its bottom.
This is better anyway — a viewport-fixed menu detaches visually from a panel the user is dragging.

**A micro tier below 320px.** The handoff's narrow grid is `20px 28px minmax(0,1fr) 64px 112px`,
i.e. 224px of fixed track + 32px of gaps + 22px padding = **278px minimum**. `DockPanel`'s `MIN_W`
is **240**. The handoff assumes a 320px floor, which we would have to impose on the Overview too.
Don't: keep `MIN_W = 240` and add a tier under ~330px that drops the Move column (the action bar
still moves things) and the per-row checkbox (the row click already toggles). R8 says the body must
never scroll sideways; this is how that stays true at every width the frame allows.

### 2.4 Content the handoff does not know about — none of it may be dropped

`inventoryCards.test.ts` is explicit that "a prettier grid that dropped them would be a regression".
Each of these is a live capability with a test behind it:

| Capability | Where it is today | Where it goes |
| --- | --- | --- |
| **Absent / empty / unknown are three states** | `shownBays` vs `uncheckedBays` vs `items === null` vs `openShip.error` | the group header and body must render four distinct things; see 2.5 |
| Drag and drop between places (R78) | `dragDrop.ts` + `itemGrid` | rows become drag sources; group bodies become drop targets |
| Opened container | `$inventory.container`, "Back to the hangar" | an extra location that appears in the tab row / select only while a container is open |
| Merge two same-type stacks | `mergeable` + bulk bar button | action bar, shown when exactly two mergeable stacks are selected |
| Repair shop **two-step** (quote, then a priced press) | Station Services tab | keep both presses; a repair costs ISK and must never be one click |
| Trash **two-step** | `trashArmed` | the handoff's inline confirm is the same shape; keep the "cannot be undone" wording |
| Stack all for **ship cargo** as well as the hangar | cargo bay footer | cargo group header at wide, or the action bar |
| Move quantity, blank = whole stack, clamped to what fits | `moveQty` + `unitsThatFit` in `moveSelectionTo` | the handoff's "Qty" field, same semantics; **keep the fit clamp** — the server refuses an overflowing move outright rather than partially filling |
| Refusal surfaces: `lastOutcome`, `actionError`, local `error` | three lines above the tabs | the handoff has no slot for these. Add a message strip between the location row and the content. `stationPanelActions.test.ts` pins that a refused ship action's words appear on this panel |
| Read-only bays of a hull you are not flying | `bayIsActionable` | same: no checkboxes, no Move cell, and the "Board this ship to move things in and out of it" note |
| Corp division "empty or not visible to you" | `<select>` option text | the chip must carry it; the server filters a division you lack the role for down to nothing, and an empty read is indistinguishable from an empty division |

### 2.5 The four bay states, spelled out

This is the invariant the codebase has broken before and the one `inventoryCards.test.ts` guards
first. The redesign must render all four differently:

1. **Absent** — `present === false`: the bay is **not drawn at all**.
2. **Present and empty** — `items === []`: drawn, "Empty - move items here from the hangar."
3. **Present but unreadable** — `items === null` or `bay.error`: drawn, "What is in here could not
   be read." Never the empty text.
4. **Not checkable** — `present === null`: not drawn as a bay, but **named out loud** in the
   trailing note "These bays could not be checked, so we cannot say whether this ship has them: ...".

Plus `openShip.error` — the whole hull failed, which is emphatically not "this ship has no bays".

Same rule for capacity: a capacity the ship did not report reads **"not known"**, never `0`. The
handoff's group header always draws a filled bar; for an unknown capacity it must draw the no-cap
variant (track `#2a4360`, no fill) and the "not known" text.

### 2.6 Data gaps: columns the store cannot fill

**`volume` is absent on ship-bay rows.** `store/types.ts` is explicit: `volume` is "m3 PER UNIT,
from static reference data (attached to the hangar/cargo read ...). `null`/absent means the static
tables do not know the type **OR the row came from a read that does not carry volume (ship-bay
contents)**".

Consequences for the handoff's headline columns, **in the ship-bays view only**:

* `m3 / unit` and `Total m3` are unknown for every row -> render `-`, never `0`.
* The `Total m3` sort must be well-defined with unknowns (unknown sorts last, both directions) or
  the header must not offer it in that view.
* The action bar's "N SELECTED - x m3" must say the volume is not known rather than print `0 m3`.
  `inventoryCards.test.ts` asserts the panel invents no capacity; a `0` here would be an invention.

**Ship hangar "Hull" and "Bays used".** The store holds bays for **one** ship at a time
(`openShip`). Filling "Bays used" for three ships means three bound-object reads per refresh.
Recommendation: fill it for the active hull and the currently-opened hull, `-` for the rest. Do not
fetch every hull's bays; do not compute a number.

**Corp division chips.** The handoff hardcodes seven names. Real chips come from
`$inventory.corp.divisions` (`name`, or "Division N" when never renamed), with `available: false`
("Your corporation has no office at this station.") as an ordinary state, not an error. Counts are
available because `loadCorpHangar` returns rows for every division at once.

---

## 3. Files

| File | Change |
| --- | --- |
| `web/src/ui/inventoryModel.ts` | **new, pure.** selection places, `rowsIn`, destinations, move-fit maths, capacity/room text, bay ordering, merge ordering. Unit-tested without a DOM. Phase 1 adds the sort comparators and the tier column sets. |
| `web/src/ui/InventoryShip.svelte` | **behaviour-preserving refactor only** — call the model instead of its private copies. No markup change. Its whole existing suite must stay green. |
| `web/src/ui/StationPanel.svelte` | **rewritten from scratch** (the file is dead today) as the docked panel. |
| `web/src/ui/StationPanelRow.svelte` (optional) | one row, if the file gets long. |
| `web/src/ui/DockPanel.svelte` | the `{#if isDocked}` arm mounts `StationPanel` **outside** `.dock-panel-head` / `.dock-panel-body`; the `{:else}` arm is untouched. |
| `web/src/ui/MobileWorkspace.svelte` | docked home mounts `StationPanel`; add a host modifier class so `.mobile-main` keeps its current layout for every other case. |
| `web/src/styles.css` | a new `.stn-*` section with its own `--stn-*` token block. **No edit to `@theme`.** |
| `web/src/ui/stationPanel.test.ts` | replaces `stationPanelActions.test.ts`, carrying its assertions forward. |
| `web/src/ui/dockPanelStates.test.ts` | **new.** the in-space regression net; see 5.1. |
| `web/src/ui/panelFirstMount.test.ts` | `StationPanel` needs docked props in its fixture. |
| `docs/station-panel.md` | the self-contained "how this screen works" doc, in the shape of `docs/pilot-hangar.md`. |

---

## 4. Phases

Each phase is independently mergeable and leaves the suite green. Per the branch workflow: a patch
branch off the integration branch, merged back with `--no-ff`.

**Phase 0 - make the shared behaviour shareable.** Extract `inventoryModel.ts`; point
`InventoryShip.svelte` at it; delete the dead `StationPanel.svelte`; land
`dockPanelStates.test.ts` capturing the **current** in-space render as the baseline. No visual
change anywhere. This phase is the safety net for every phase after it.

**Phase 1 - the whole panel. DONE.** New `StationPanel.svelte`, mounted in `DockPanel`'s docked arm
and `MobileWorkspace`'s docked home.

⚠ Phase 1 was widened during the work, deliberately. The original split (frame + inventory views
now, ship hangar and services next, the handoff's omissions after that) would have left the docked
panel with **no way to board a ship or go offline** between phases. A phase that is green and
unusable is not a phase. So Phase 1 carries every location and every capability the panel it
replaces had: the five locations, all four bay states, unknown-volume rendering, sort, filter,
selection, the action bar with its inline confirm, drag and drop, the container location, merge,
stack-all, the repair two-step and the session controls.

**Phase 2 - expand/dock toggle. DONE.** The docked panel can take the whole work area; the desktop
is hidden, not unmounted, so every floating window keeps its own state.

Two things settled differently from 5.4:

- **The flag is DERIVED, not reset.** `Workspace` keeps a remembered *preference* and renders
  `stationExpanded = isDocked && expandPreferred`. There is no stored flag that could be stale and
  no effect whose ordering could be wrong — undocking cannot leave anybody in space with the
  desktop, the HUD and the target panel hidden, by construction rather than by cleanup.
- **The preference lives in `DesktopLayout`, not a new key.** 5.4 warned off widening it because
  `loadLayout` would silently drop an unknown field; the answer was to update the validator, which
  is one storage key and one place instead of two. A layout saved before the toggle existed reads
  as un-expanded, and `desktop.test.ts` pins that — an absent field that read as anything else
  would hide the desktop for every existing player.

One trap found while building it: opening a window from the launcher rail while expanded would put
it behind a hidden desktop. `open()` now gives the work area back, while the docked Neocom pick that
folds *into* the dock panel deliberately does not.

**Phase 3 - optional, a separate decision.** Adopt the same panel for the in-space floating
"Inventory & Ship" window and retire `InventoryShip.svelte`. Deliberately last: it is the change the
user asked to be careful about, and by then the panel has been exercised while docked for a while.

### What the build changed from the plan

Six things the drawing could not have shown, each found by looking at the rendered panel:

1. **`.stn-panel` must take `width: 100%` from its parent.** `container-type: inline-size` stops the
   CONTENT contributing to the element's own width, so a host that makes it a flex ITEM sizes it
   from content that containment has removed — measured at 0px wide. It is the same rule
   `.table-wrap` already carries.
2. **The panel cancels the app's element dressing, once, with `:where()`.** A `section` is a
   bordered card here, a `button` a 40px gradient control; the first build was a stack of nested
   cards. `:where()` contributes no specificity, so the reset weighs `.stn-panel` alone and every
   component class beats it on source order.
3. **No `class:active`.** `button.active` is a filled accent control in the components layer and
   outranks a plain `.stn-tab` — the tab came out solid blue. The panel's state classes now avoid
   every bare name the stylesheet claims, and a test pins that.
4. **Move targets are per PLACE, not per location.** The bays view is several places at once; one
   shared target list offered a row in the ore hold a move to the ore hold, and offered the item
   hangar a move to itself.
5. **A narrow panel gets a one-word destination** on the per-row move button ("to Hangar", "to
   Ore"). "to Station hangar" pushed the quantity column into "123 75" — a wrong number is worse
   than a short name, and the full name is on the button's title, the ▾ menu and the move bar.
6. **The ship hangar's third column is the cargo hold, not "Bays used".** The handoff's "Hull"
   column would repeat the ship's own name (hulls have no custom names here), and a full bay
   summary does not fit a column. One reading that fits, or a dash - never a number worked out
   locally. Stack-all likewise moved from the location row into the group header, beside the thing
   it acts on, which also restores it for the ship's cargo hold.

---

## 5. Verification

### 5.1 The in-space net (`dockPanelStates.test.ts`)

Landed in Phase 0, before anything changes:

1. Render `DockPanel` with `isDocked: false` and store the exact body as the expected string.
   Every later phase asserts the in-space render is **unchanged**.
2. Render with `isDocked: false` and assert **none** of `stn-panel`, `STATION`, or any `--stn-`
   token appears.
3. Render with `isDocked: false, collapsed: true` and assert the strip still says "Around Your Ship".
4. Render `MobileWorkspace` in space and assert the same.

### 5.2 The station panel's own suite (`stationPanel.test.ts`)

Carry over every assertion from `stationPanelActions.test.ts` (corvette / leave ship / repair /
guests present when docked; a refused action's words surface). Add, in the order
`inventoryCards.test.ts` ranks them:

1. **Absent / empty / unreadable / uncheckable render four different ways**, and a capacity the ship
   did not report reads "not known", never 0.
2. **No lost capability** — selection, bulk move, merge, trash arming, stack-all, container,
   corp hangar, read-only hull, move quantity.
3. **Unknown volume** shows `-`, and the selected-volume readout does not print `0 m3`.
4. **R7d** — no itemID / typeID / stationID / flag is ever visible text (reuse the existing sweep,
   including its non-vacuous counter-test).
5. **R9a** — player language, not developer language.
6. **R8** — tiers are container queries (grep `styles.css` for `@container` against `.stn-panel`,
   and assert no `@media` tier crept in beside it); no fixed px width can exceed the frame's
   `MIN_W`; the guests table keeps the `.reflow` + `.table-wrap` contract.
7. The panel invents no capacity (reuse the "estimate/predict/guess" source sweep).

### 5.3 Suites that must stay green untouched

`inventoryCards.test.ts` (all of it - it is now the in-space window's contract),
`reflowContract.test.ts`, `squareCorners.test.ts`, `chromeRender.test.ts`, `panelFirstMount.test.ts`,
`desktop.test.ts`, `dockTransition.test.ts`.

### 5.4 The expand toggle's guard (Phase 4)

* The toggle only exists inside `StationPanel`, which only mounts when docked - so the button cannot
  be reached in space by construction.
* `Workspace.svelte` holds the flag and **forces it false when `isDocked` goes false**, so undocking
  can never leave the pilot in space with `<Desktop>`, the HUD and the targets panel hidden.
* Test: set expanded, flip `isDocked` to false, assert the desktop and HUD render.
* The flag persists (if at all) through a **new** key, not by widening `DesktopLayout` -
  `loadLayout` validates a fixed shape and would silently drop an unknown field.

### 5.5 Baseline and how to run it

**Host baseline recorded 2026-09-06**, whole repo, `node --test` per file over
`web/src src test`: **4128 tests, 24 failing**, every one of them locale
(`toLocaleString(undefined)` renders `12 375,2` where the test expects `12,375.2`). They are
pre-existing, unrelated, and pass under the container's `C`/en-US locale. Do not read them as
regressions; do not "fix" them in this work.

    test/marketBrowse.test.js                4    web/src/ui/inventoryCards.test.ts    5
    test/serverBots.test.js                  2    web/src/ui/miningPanel.test.ts       3
    web/src/app/freeSkillPointsFlow.test.ts  1    web/src/ui/missionBotPanel.test.ts   2
    web/src/bridge/contracts.test.ts         1    web/src/ui/overviewActions.test.ts   1
    web/src/nav/missionBotLoop.test.ts       2    web/src/ui/planetsPanel.test.ts      3

⚠ Run the baseline in the MAIN checkout, not a fresh `git worktree`: `test/staticAppServing` and
`test/staticAssetsFailClosed` need a built `public/dist` and fail (5 more) in a worktree that has
none. That is the worktree, not the branch.

**After Phase 0: 4183 tests, the same 24 failing** — 45 new model tests, 11 new dock-state tests,
one first-mount test removed with the dead panel.

* Fast loop: `node --test web/src/ui/<file>.test.ts`.
* Typecheck + Svelte compile: `docker build --target web-build .` (the host has no reliable
  `tsc -p` path for `.svelte`, and `tsc` does not parse them anyway - `panelFirstMount` is the
  substitute).
* Live: docked pilot, drag the dock panel through ~250 / 400 / 700 / 1200px and confirm no
  horizontal scroll at any width; then **undock and confirm the Overview is exactly as before**;
  then 375px mobile, docked and in space.

---

## 6. Open questions

1. **Scope.** This plan assumes docked-only, with the in-space floating window keeping the current
   tile UI until a separate decision (Phase 5). The alternative - one panel everywhere, immediately
   - is a bigger single change and is precisely the shape that risks space.
2. **"Bays used" in the ship hangar.** Recommended: fill it only for hulls whose bays are already
   read, `-` otherwise. The alternative is N bound-object reads per refresh.
3. **Collapsed-bay persistence.** Recommended: component state for now. If it must survive a reload,
   a small `stationPanelPrefs.ts` in the shape of `hangarPrefs.ts`, never `desktop.ts`.
4. **Station hint in the panel header.** `DockPanel` deliberately dropped the station name from the
   docked title because the workspace header directly above already spells out station + system.
   The handoff puts a "{station} - {system}" hint back in the panel header. It is small, ellipsised,
   secondary line and reads fine in the screenshots, but it is a reversal of an explicit earlier
   decision and should be a conscious one.
