# The Station Panel — the right-hand dock panel while docked

Built 2026-09-06 from the `design_handoff_station_panel` handoff. Self-contained: you should not need
the handoff or the conversation that produced this to change the screen.

## What it is

Everything a docked pilot reaches for, in the fixed panel down the right of the workspace: the bays
of the hull they have open, the ships in the hangar, the item hangar, the corporation's divisions,
any container they opened, and the station's own services and guests. One location at a time, from a
tab row — or a dropdown when the panel is narrow.

It replaced a grid of large picture tiles. Tiles are right for a phone and wrong for a 1200px column
on a desktop, where they showed about eight things and the player scrolled past four screens of
whitespace to find a stack of Tritanium. The panel is a table now, and it earns columns as the
column it lives in gets wider.

> ## ⚠ It is DOCKED ONLY, and that is load-bearing
>
> **The same frame shows the compact Overview while in space.** `DockPanel.svelte` branches on
> `isDocked`: this panel on one side, `Overview` on the other. And `InventoryShip.svelte` — the panel
> this one replaced in the dock — is **still mounted in space**, as the Neocom's floating "Inventory
> & Ship" window and as a mobile panel. The two coexist on purpose.
>
> So `StationPanel.svelte` is mounted only from branches already guarded by `isDocked`, and the proof
> that a change here cannot reach an undocked pilot is a grep rather than an argument.
> `dockPanelStates.test.ts` is the net: it fails if the panel ever appears in the in-space render, if
> the shared frame CSS or the global design tokens move, or if a rule that hides the desktop stops
> requiring a docked-only class.

## The files

| File | What it owns |
| --- | --- |
| `web/src/ui/StationPanel.svelte` | the screen: header, location row, groups, rows, the action bar, the two popovers, services |
| `web/src/ui/inventoryModel.ts` | **pure.** where a stack may go, what a bay is called, how full it is in words, how much of it fits, sorting, filtering, the short destination label |
| `web/src/ui/DockPanel.svelte` | the frame, and the branch: this panel docked, the Overview in space |
| `web/src/ui/Workspace.svelte` | the expand preference and the derived flag that gates it |
| `web/src/ui/desktop.ts` | the per-character layout, including `stationExpanded` |
| `web/src/ui/MobileWorkspace.svelte` | the docked home, at the panel's narrowest tier |
| `web/src/styles.css` § 6 | the whole look, under `.stn-panel` |
| `web/station-panel-harness.html` + `src/stationPanelHarness.ts` | **dev only.** the real panel against a fabricated world, so its interactions can be driven without a server |

The rules live in `inventoryModel.ts` and not in the component **because `InventoryShip.svelte` calls
them too**. Two panels that disagreed about where a stack may go would move the same stack two
different ways depending on which one you were looking at.

## Where the data comes from

Everything is read off the store's `inventory` and `station` slices — the same reads
`InventoryShip` has always used. The panel calls `flow.loadInventory()`, `flow.loadCorpHangar()` and
`flow.openShipBays(activeShipID)` on mount, and the header's ↻ re-runs those plus
`flow.refreshStationPanel()` for the station's own row and its guests.

A bay is an **inventory flag**, and the flag numbers never reach the browser: the BFF enumerates a
hull's bays and hands over a key and a label (R7d/R9a). This file has no idea 134 is the ore hold,
exactly as it has no idea 4, 5 or 115–121 exist.

### ⚠ Four states, not two

The invariant this screen exists to keep, and the one this codebase has broken before
(`worldHasNoContracts`). A bay can be:

| `present` | `items` | What it is | What is drawn |
| --- | --- | --- | --- |
| `false` | — | the hull does not have it | **nothing at all** |
| `true` | `[]` | we looked, it is empty | the bay, "Empty — move things here from the hangar." |
| `true` | `null` / `error` | we could not look inside | the bay, "What is in here could not be read" |
| `null` | — | nobody could check whether it exists | not a bay; **named out loud** in a trailing note |

Plus a fifth: `openShip.error` means the whole hull's read failed, which is emphatically not "this
ship has no bays".

The same rule governs capacity. A capacity the ship did not report reads **"not known"**, never `0` —
a confident "0 of 0 m³" tells the player a bay is unusable when in truth nobody asked. The group's
bar goes flat and unfilled rather than empty, because an empty bar reads as "there is room".

### ⚠ Volume is usually not known

`InventoryItemRow.volume` is m³ **per unit** from the static tables, attached to the hangar and cargo
reads — and **absent on ship-bay contents**, because that read does not carry it. So the panel's two
headline m³ columns are empty for every row in every bay. That is the normal case, not an error.

Unknown renders as `—` in a cell and "not known" in a sentence. The action bar's selected-volume is
all-or-nothing (`sumVolume` returns `null` if *any* row is unknown): summing only the rows we happen
to know would put a confident, too-small number in front of somebody about to fill a hold. A row with
an unknown volume sorts **last** under Total m³ in both directions — it has no place on a scale it is
not on.

## Decisions worth not re-opening

**Icons come from `/icon-cache`, never an image server.** The handoff specifies
`images.evetech.net/types/{id}/icon`. `web/src/ui/typeIcons.ts` is explicit that icons are local
only: the browser never touches an external host, so the client works offline and leaks nothing about
what the player is flying. The same rule killed the handoff's ship *renders* — there is no local
render cache, so a hull shows its icon.

**Barlow Semi-Condensed and Barlow Condensed, self-hosted.** The handoff asks for Google Fonts
Barlow; it also allows substituting the app's existing pair, which is what happened. No new webfont
and no external font host.

**The palette is scoped, not global.** Every handoff colour is a `--stn-*` custom property declared on
`.stn-panel` and nowhere else — the same shape `.hangar` uses. That is what lets the panel match the
handoff exactly without repainting the Overview, the HUD, the tactical view and every other panel.

**The width tiers are `@container`, never `@media`.** The panel lives in a column the player drags,
so "is there room for the m³ columns" is a question about *this panel*. Asking the viewport is the
bug R85 fixed — a four-column table in a 320px panel on a 1440px screen kept its wide layout and
crushed every cell to 50px. `station` is the container name. There are four tiers: the base rules,
then ≥330px, ≥560px and ≥900px.

**Both popovers are `position: absolute` inside the panel, not `fixed`.** `container-type: inline-size`
makes an element a **containing block for its `position: fixed` descendants**, so a menu positioned
against the viewport would silently land against the panel instead. Positioning against the panel on
purpose is also what keeps a menu attached while the dock column is being dragged. They are rendered
at the panel's root rather than inside the scrolling list, so opening one can never make the list
taller.

**`.stn-panel` takes `width: 100%` from its parent.** Not tidiness. `inline-size` containment stops
the *content* contributing to the element's own width, so a host that makes the panel a flex **item**
sizes it from content that containment has just removed — measured at **0px wide**. `.table-wrap`
carries the same rule for the same reason.

**The panel cancels the app's element dressing once, with `:where()`.** The base and component layers
style bare elements for a page of panels: a `section` is a bordered card with a gradient and an
accent hairline, a `button` is a 40px gradient control, `p` / `h3` / `dl` carry their own rhythm. The
first build of this screen was a stack of nested cards. `:where()` contributes no specificity, so
each reset rule weighs `.stn-panel` alone and every `.stn-*` class below wins on source order. Reset
first, dress after — the other order needs defensive selectors everywhere.

**No `class:active`, and no other bare name the stylesheet claims.** `button.active` is a filled
accent control in the components layer and out-specifies a plain `.stn-tab`; the first build had a
solid blue tab where an underline belonged. The panel's state classes are `on`, `picked`, `flying`,
`armed`, `nolimit` — and a test sweeps the stylesheet for bare state names and fails if the panel
starts using one.

**Move targets are per PLACE, not per location.** The bays view is several places at once. One
shared list offered a row in the ore hold a move *to the ore hold*, and offered the item hangar a
move to itself. Each group asks `targetsFrom(its own place)`, which is also what makes the quick-move
button read correctly before anything is ticked: out of a bay it says "to Station hangar", out of the
hangar it says "to Ship cargo".

**A narrow panel gets a one-word destination.** "to Station hangar" pushed the quantity column into
`123 75`. A wrong number is worse than a short name, so below 900px the button says "to Hangar" —
with the full name on its `title`, in the ▾ menu and in the move bar. `shortLabel` takes the *last*
word unless it is generic ("hold", "bay"), so "Ship cargo" → Cargo, "Ore hold" → Ore.

**Every move is confirmed.** The action bar's controls are replaced by "Move N stacks · x m³ to
{target}? {room free}" with Confirm / Cancel. Trash is the same shape and says it cannot be undone.
A repair is *also* two presses, but a different two: the first only asks the shop for a quote, and
the priced press appears with the answer, because a repair charges the wallet.

**A single stack into a ship hold is clamped to what fits.** A transfer is all-or-nothing per stack,
so asking for a stack bigger than the free space is refused outright — the whole thing, not the part
that would have fitted. `moveQuantityFor` sends `unitsThatFit`, unless the player typed a quantity,
in which case they asked for a specific amount and get it. Unknown volume or unread capacity hands
the whole stack over and lets the server draw the line; it never invents a smaller number from
missing data.

**The ship hangar's third column is the cargo hold, not the handoff's "Hull" and "Bays used".**
"Hull" would print the ship's own name twice — hulls have no custom names here, so a row's name *is*
its type. "Bays used" cannot be answered: the slice holds the bays of one ship at a time
(`openShip`), and reading every hull's bays would be a bound-object call per hull on every refresh.
So the column shows the cargo hold's fill for the hull whose bays have actually been read, and a dash
for the rest — never a number the panel worked out for itself.

**Stack-all lives in the group header, not the location row.** The handoff puts one "Stack all" at
the top right of the item hangar. `flow.stackContainer` knows exactly two places, "hangar" and
"cargo", so it is offered in exactly those two groups, beside the thing it acts on — which also gives
the ship's cargo hold back a control the handoff had dropped.

**Every location renders; the inactive ones carry `hidden`.** Switching a tab never remounts, so
icons do not reload and a selection made in one place survives being looked away from.

**Expanding hides the desktop; it does not unmount it.** A floating window keeps its own state — a
half-written bot script, a market search, a scroll position — and remounting would throw all of it
away for what is only a change of view.

**The expand flag is DERIVED, not reset.** `Workspace` remembers a *preference* and renders
`stationExpanded = isDocked && expandPreferred`. A pilot who undocked into a hidden desktop would also
have no HUD and no locked-target panel, and no control left to bring any of them back — so that is
made impossible by construction rather than by cleanup. There is no stored flag that could go stale
and no effect whose ordering could be wrong. Both CSS rules that hide the desktop require a class
bound to that derived flag.

**Opening a window gives the work area back.** A window opened into a hidden desktop would appear
nowhere and the launcher rail would look broken. `open()` clears the preference; the docked Neocom
pick that folds *into* the dock panel deliberately does not, or choosing "Inventory & Ship" would
throw the expansion away.

**The panel carries its own header, and the frame's is dropped while docked.** The two arms of
`DockPanel` are deliberately asymmetrical: the station panel brings a header (title, station hint,
refresh, expand, collapse) and a pinned action bar and takes the whole frame, while the Overview
keeps `.dock-panel-head` and the padded, scrolling `.dock-panel-body` it has always had. That
asymmetry is what stops a change made for the docked panel being made by editing them.

**The station hint is back in the panel header.** `DockPanel` had deliberately dropped the station
name from the docked title because the workspace header directly above already spells out station +
system. The handoff puts a small, secondary, ellipsised hint back, and it reads well; it is a
reversal of an earlier decision and was made knowingly.

## How it sits with the design system

`docs/design-system.md` is still binding for panels. This is not a panel — it is a dense inventory
table that has to stay readable in a 260px column and use the room in a 1200px one — and the
divergences are deliberate and bounded, in the same shape as § 5's Pilot Hangar:

- Every rule is under `.stn-panel`, so nothing leaks into a panel or into the Overview.
- The palette is declared once as `--stn-*`, in one place, on `.stn-panel`.
- The `:where()` reset is load-bearing (see above).
- Corners are square, which is the app's rule (R53) and the handoff's too. A test sweeps § 6 for a
  non-zero `border-radius`.

**Where it does not diverge.** Nothing is conveyed by colour alone: a full bay's bar turns red *and*
its numbers are beside it, the selected count is a word, every state prints. No numeric ID is
rendered (R7d) — the sweep covers item, type, station, character, corporation and flag numbers. No
horizontal scroll at the frame's 240px floor: the narrowest tier's fixed tracks plus gaps and
padding are asserted to fit inside it, and the name column is the one that gives.

**The known tension is R8's ≥40px targets**, and it is resolved behaviourally, as the hangar resolves
it. The per-row move buttons are 26px, so below 560px the whole Move column is **removed**: the row
itself becomes a 46px tap target that toggles selection, and moving is done from the action bar,
whose controls are 32px. The small controls are never on the critical path on a touch-sized panel.

## Verification

- `web/src/ui/inventoryModel.test.ts` — **46 tests**, fixtures built through the real reducer. This
  is where the rules that decide *where a player's stack ends up* are tested, because a server render
  cannot reach them: `selectionPlace` is component state, so SSR sees the grid and the bays and never
  the move bar, the destination list, the merge ordering or the fit clamp.
- `web/src/ui/stationPanel.test.ts` — **46 tests**: the four bay states as four different strings,
  unknown volume, every capability the panel it replaced had, R7d, R9a, R8, R53, and a grep proving
  the panel is mounted only behind `isDocked`.
- `web/src/ui/dockPanelStates.test.ts` — **18 tests**, the in-space net. What the in-space branch
  renders, the shared frame CSS by content hash, the global `@theme` block by content hash, the
  frame's width limits, and the whole expand-toggle gating.
- `web/src/ui/desktop.test.ts` — the layout round-trip, including a layout saved before the expand
  toggle existed reading as un-expanded.
- `web/src/ui/inventoryCards.test.ts` — unchanged, and now the **in-space** window's contract.

Read `docs/svelte-typecheck-gap.md` before trusting a green run: `tsc` does not parse `.svelte`, so a
component's props are checked by the SSR tests and nothing else. Verify with
`docker build --target web-build .` — it has already caught two type errors this work introduced that
`node --test` could not see.

**Driven, through the harness.** `npm run dev:web`, then `/station-panel-harness.html`. It mounts
the real component against a fabricated world and a flow stub that actually moves things, with every
flow call logged beside it. Same reasoning as `tactical-harness.html`: the only other way to press a
button in this panel is to bring up the BFF, bring up the gateway, sign a pilot in and dock, which is
too much ceremony to pay when a column moves — so in practice the interactions would never be driven
at all.

Driven this way: row selection and select-all, the quick move, the ▾ menu (including its flip-up near
the panel's bottom), the inline confirm and a completed move, sort on Name and Qty in both
directions, the filter down to "No matches.", collapsing and re-opening a bay, boarding a hull from
the ship hangar, the repair quote, and a full drag → drop → confirm → move between two bays.

That found four things the SSR suite could not: a completed move left "1 selected · 0 m³" in the
action bar, a drop with nothing ticked opened a confirm whose button did nothing, the quantity column
said "assembled" beside a State column that said it again, and truncated names had no hover. Each is
fixed and pinned.

**Still not driven against a real server.** The harness proves the panel; it does not prove the BFF
wiring, which is the flow's own tests and the shared model.

## Out of scope, still

Driving it against a live pilot. Adopting the same panel for the in-space floating "Inventory & Ship" window and
retiring `InventoryShip.svelte` — deliberately last, because it is the change that can reach a pilot
in space. Per-bay collapse is remembered for the session only, not stored. The handoff's "Stack all"
at the location row, its "Hull" and "Bays used" columns, and its ship *renders* are not coming back
for the reasons above.
