# Plan: the in-space workspace redesign

Written 2026-09-06 against `design_handoff_space_panel` (direction **1C** desktop, **1D** mobile). It
follows `docs/station-panel-redesign-plan.md`, whose docked work is done — this package explicitly
reuses that one's tokens, type, scrollbar and button styles verbatim.

⚠ **This is not a panel redesign. It is a workspace redesign.** The station package replaced the
contents of one frame. This one changes the shape of the whole in-space work area, splits the
largest component in the codebase into five, and asks for two features that do not exist at any
layer. Sized honestly it is several times the station panel.

---

## 1. The blast radius, measured

### 1.1 What the in-space workspace is today

```
.workspace                    grid: neocom | work
  .work                       flex column
    WorkspaceHeader           where you are + Dock
    CustomBotReadout
    .work-main                flex ROW
      .desktop                flex:1 — floating windows, with Tactical as an inset:0 BACKDROP
      .dock-panel             fixed 22rem, collapsible, resizable  -> <Overview compact>
      TargetsPanel            absolute, z 400, over both
    HudBar                    grid: ShipHud | ModuleRack | shots | nav buttons
```

The handoff wants:

```
.work-main                    grid  minmax(0,1fr) / minmax(320px,34%)
                              rows  minmax(0,1fr) / 270px
  radar                       top-left      — floating windows live ONLY in here
  hud                         bottom-left   — gauge + racks, 270px
  overview                    right, spanning both rows, resizable, min 320px
```

So: the HUD moves *into* the work area as a grid cell, the radar stops being the whole left side,
and the windows' bounds stop being the desktop and become the radar.

### 1.2 `Overview.svelte` is 2788 lines and holds sixteen sections

This is the centre of the work. In document order:

| # | Section | Handoff sends it to |
| --- | --- | --- |
| 1 | panel header | the overview panel's own 32px header |
| 2 | flight strip (where / doing / wrong · Undock **or Stop**) | split: the HUD footer sentence + Stop, and Flight's Status grid |
| 3 | "Undock to see…" | n/a |
| 4 | **threat block** (hostiles, "You are taking damage", arrival banner, per-threat Lock / Send drones) | **nowhere — see 2.7** |
| 5 | ship condition + hold strip | the HUD gauge |
| 6 | selection bar (name, verbs, per-concern errors, mine reports) | the selected-item + icon action row |
| 7 | Search / Category / Group / Sort controls | the filter row |
| 8 | preset tabs (R79) | the ALL / MINING / TRAVEL / COMBAT tabs — an exact match |
| 9 | the row list | the rows |
| 10 | flight + gate-link errors | ? |
| 11 | locked-targets table | dropped; a `⌖` on the row instead — **but see 2.8** |
| 12 | equipment table (power up / switch on / off / down) | the HUD's module racks |
| 13 | "Flying distances" `<details>` | the per-action `▾` range popovers |
| 14 | drones `<details>` | the Drones window |
| 15 | shots fired | the Shots window |
| 16 | RadialMenu | keep |

**The `compact` prop is dead.** `Overview.svelte:1614` sets `class:overview-compact`, and no
`.overview-compact` rule exists anywhere in the repo. The docked-panel trimming is really done by
`.dock-overview .ov-ship-condition, .ov-locked-targets, .ov-equipment, .ov-shots { display: none }`
(`styles.css:3365-3370`). Everything still computes and renders into the DOM. Delete the prop.

### 1.3 What is genuinely shared, and what is not

* **`space/rowActions.ts` is already the verb set as DATA** — warp, approach, orbit, keepAtRange,
  align, dock (by kind), jump (only with a gate link), mine, lock/unlock, haul — each with a
  `concern` and a `unavailable` sentence. `space/rowActionRunner.ts` is the single dispatch site.
  The handoff's icon action row is a **re-skin of an existing model**, not new logic. This is the
  largest single piece of luck in the package.
* **`space/overviewPresets.ts` already is ALL / MINING / TRAVEL / COMBAT**, classified through
  `bracketRole` so the list and the radar agree, and `presetAllows` force-includes anything hostile.
  The handoff's filter tabs are the same four.
* **`space/overview.ts` already formats distance** and caps at `ROW_CAP = 200` with the preset
  applied *before* the cap.
* **The dock frame** (`.dock-panel*`) is shared with the docked Station panel. Once the in-space
  content also brings its own header, `.dock-panel-head` and `.dock-panel-body` are dead in both
  arms — which is a simplification, but it retires the CSS that `dockPanelStates.test.ts` currently
  hashes.
* **`.desktop`, `desktop.ts`, `DesktopWindow.svelte`** are shared with the *docked* desktop. Every
  window change lands on the docked workspace too.

### 1.4 The mirror net

The station work built `dockPanelStates.test.ts` to stop a docked change reaching space. This work
needs the **mirror**: a net that stops an in-space change reaching the docked workspace. Same
technique — render `DockPanel` and `Workspace` docked, pin what must not appear, hash the shared
frame CSS — plus, because the windows are shared, a pin that the docked desktop still opens,
drags and persists windows exactly as it does now.

---

## 2. Where the handoff has to bend

### 2.1 Icons and fonts — settled already

`images.evetech.net` is out for the same reason as last time (`web/src/ui/typeIcons.ts`: icons are
local only; the browser never touches an external host). Fonts are the bundled Barlow pair. The
handoff's action-bar glyphs are described as "swap for the app's icon set" — `ui/actionIcons.ts`
already exists and is the place.

### 2.2 ⚠ Rack heat has no data. None.

The handoff asks for a per-rack heat bar with a percentage, and a per-module heat wedge sized
`6 + dmg×10` px in three colour bands.

**There is no heat model in this client at any layer** — not in the store, not in the bridge, not on
the BFF. Greps for `heatState|heatLevel|rackHeat|heatCapacity|heatAttenuation` across `web/src` and
`src/server.js` return nothing. What exists is:

* `SpaceShip.moduleDamage` — per module, `0..1`, where 1 is burnt out. This is the **consequence** of
  heat, not heat.
* `overloadedModuleIDs` — a boolean per module.

So:

* The **per-module wedge can be built**, off `damage`. It is honest: it is what heat did.
* The **per-rack heat bar cannot**, and inventing one by averaging module damage would be a
  fabricated reading of a quantity the server never sent. Either drop it, or relabel it as what it
  is (worst damage in the rack), or add a bridge read — and nothing suggests the emulator exposes
  one. **Recommendation: drop the bar, keep the damage wedge, and say why in the doc.**

⚠ `types.ts:1611`: "`{}` AND `null` ARE DIFFERENT. `{}` is 'every module is intact'; `null` is 'we
could not read the fit'. Overloading is what causes this damage, so a page that treated the second as
the first would hide the cost of the very feature that produces it."

### 2.3 Press-and-hold overload replaces shift-click

Overload exists end to end: `flow.setModuleOverload` → `POST /api/bridge/dogma/module/overload`,
verified against the snapshot rather than the 200. `repairModule` is its complement and is wired.

Today the guard is **shift-click**, with a stated reason: "the retail modifier, and deliberately
behind one: overloading damages the module, so it must not share the plain click that fires it."
The handoff's 600 ms hold is a different guard for the same reason and is fine — it also works on
touch, which shift-click never did. Two things must survive the swap:

* an **offline** module is inert to both press and hold (`rackClickAction` returns null);
* **unknown** overload state (`overloadedModuleIDs === null`) says nothing about heat either way, and
  must not render as "not hot".

Unused capability worth reaching for while here: the BFF already has rack-level
`/module/overload-rack`, `/stop-overload-rack` and `/repair/start-many` (`src/server.js:9300, 9319,
9337`). Nothing in `web/src` exposes them.

### 2.4 ⚠ The capacitor: discrete segments vs a dashed arc

The handoff draws the capacitor as a dashed arc (`6 3`). Today it is **12 counted segments**, and
that is a documented decision:

> ⚠ DISCRETE IS THE POINT. EVE's capacitor has never been a smooth bar, and a pilot counts remaining
> segments rather than reading a percentage — "three left" is a decision, "24%" is a number you then
> have to convert. — `shipHudArcs.ts:123`

A dash pattern is a texture, not a count: `6 3` does not divide into a fixed number of segments as
the ratio changes, so you cannot count what is left. **Recommendation: keep discrete segments, drawn
at the handoff's radius and stroke.** It looks nearly identical and keeps the property the note is
about. Flag it; it is a deliberate divergence from a "high fidelity, colours and behaviour final"
package.

### 2.5 The gauge's angles move, and they are pinned by test

Today: start 135°, sweep 270°, gap centred on the bottom (`shipHudArcs.ts:36`), three radii
45/38/31 plus a 22 cap ring, in a 0–100 viewBox. The handoff: start 210°, sweep 240°, radii
66/57/48/37 in a 150×150 box, stroke 7.

`shipHudArcs.test.ts` pins 135/270 **by test, not just by constant** ("the gauges start at the bottom
left", "the gauges leave a gap centred on the bottom"). Changing them is a deliberate test change,
not a break. Everything else in that suite is geometry that still holds: clockwise, the 359.999
clamp, concentric radii, and — most importantly — **an unknown reading draws nothing and is not the
same as empty**.

### 2.6 ⚠ The Shots window's totals cannot be a fight total

`damageLog` is a bounded **40-event tail** (`DAMAGE_LOG_LIMIT`), fed by a push channel that is
explicitly allowed to drop and resynchronise. The current panel says so out loud:

> This is a running commentary, not a tally: the live channel is allowed to drop and pick up again,
> so shots can be missing from this list.

The handoff's header wants **Dealt · Received · Shots · Hit rate**. Summed over that tail those are
not the fight's totals and must not be presented as if they were. **Recommendation: keep the header,
label it for what it is** ("in the last 40 shots"), or drop Dealt/Received and keep Shots + Hit rate
over the visible window. Either way the sentence above stays.

**And "crit" is not available.** The handoff colours a critical hit. `DamageEvent.quality` exists,
but: "NOT translated to retail's 'Grazes'/'Wrecks' wording here: the mapping is not sourced from this
server, and inventing it would be fabricated detail." Colouring a band we cannot name is the same
invention with the label removed. **Recommendation: drop the crit colour; keep `miss` for a real 0,
which is a value the server does send.**

### 2.7 ⚠ The threat block is not in the handoff, and must not be lost

`Overview.svelte:1695-1759` reads the **whole snapshot, uncapped and unfiltered**, and gives:
hostiles by name and kind, a "You are taking damage" banner, an arrival banner, and per-threat Lock /
Release lock / Send drones. `overviewPresets.ts` exists partly to serve it — "⚠ NO PRESET CAN HIDE
SOMETHING THAT IS SHOOTING AT YOU", and the hostile clause is first and unconditional.

The handoff's overview has hostile *names* in `#e0a39a` and nothing else. Dropping the block would
remove the only place the client tells a pilot they are under attack, and the only per-threat lock
that bypasses the row cap.

**Recommendation: it survives as its own strip above the overview list**, styled to the new
language, still uncapped and still unfiltered. This is a deliberate addition to the handoff and
should be called out to its author.

### 2.8 The locked-targets table and TargetsPanel overlap

Today `locked` is shown twice: as a six-column reflow table inside Overview, and as the floating
`TargetsPanel` of round bracket cards. The handoff drops the table (a `⌖` on the row instead) and
never mentions the panel. Keeping all three would be three places for one fact.

**Recommendation: the table goes** (the handoff is right), `TargetsPanel` stays as the at-a-glance
condition read it was built for (R71), and the row gets its `⌖`. Note `TargetsPanel` currently
clamps to `.work-main`; under the new grid it should clamp to the radar like every other floater.

### 2.9 Orbit and keep-at-range distances: one source of truth, not two

Today: **one** `orbit` and **one** `hold` value, in `ui/flyingDistances.ts`, persisted to
`localStorage`, chosen in **Settings**, with fixed menus (`WARP_RANGES` 0/10/20/30/50/70/100 km,
`HOLD_RANGES` 500 m/1/2.5/5/10/20/30 km). `Tactical.svelte` and the runner read the same three.

The handoff wants a `▾` on each of Orbit and Keep, presets 1/5/10/20 km plus a custom field,
remembered **per action, for the session**, defaults orbit 5 km and keep 10 km.

Three conflicts: the storage (localStorage vs session), the presets (different ladders), and where
they are chosen (Settings vs the action). **Recommendation: the action's `▾` becomes the one place
they are chosen and it writes through to `flyingDistances`** — so Settings, the radial menu and the
radar keep agreeing with the overview. Keep localStorage: a distance that forgets itself every
session is worse, not better. Merge the ladders rather than replacing one with the other.

### 2.10 Minimize and the window strip do not exist

`desktop.ts` has `collapsed` (shade to the title bar) and nothing else — no minimize, no taskbar. The
Neocom rail is the only open-window indicator today (`class:open` / `class:active` per entry).

The handoff wants **minimize** (hidden entirely) plus a **strip** of chips at the radar's bottom-left.
That is a second, different hide beside `collapsed`, and two shade-like states on one window will
confuse. **Recommendation: add `minimized` to `WinState` and keep `collapsed`; the strip lists every
open window and a chip's dot distinguishes visible from minimized.** The rail keeps meaning "open".
Both must be persisted through `DesktopLayout`, whose validator has to learn the field the way it
just learned `stationExpanded` — an absent field reads `false`.

### 2.11 Drones and Shots have to become windows

They are sections of `Overview.svelte` today, not tabs. `tabs.ts` has no `drones` or `shots` id, and
`desktop.ts` treats only `overview` as chrome. Making them floating windows means two new `TabID`s,
two Neocom entries (in-space only), and two new panels. Flight and Mining are already in-space window
tabs, so those two only change their default position and their content.

### 2.12 Compress and jettison are not on the flow, and compress cannot be aimed

The Mining window wants **Compress** and **Jettison…**. `api.jettisonItems` and
`api.compressOreInSpace` exist and are used by the bot action switch, but neither is an `AppFlow`
method — so no panel can call them. Worse, `compressOreInSpace(itemID, facilityID)` needs a
**facility**, and the UI has no way for a player to pick one. Either the picker is designed (out of
scope for this handoff) or Compress does not ship in Phase 4. **Recommendation: ship Jettison, defer
Compress, and say so.**

### 2.13 Raw ID inputs go, and that is a real fix

`Flight.svelte` currently asks the player to type `"stargate / celestial ID"`, `"source stargate ID"`,
`"destination station ID"`. The handoff replaces all three with searchable pickers filtered from the
overview. That is the last place in the client where a player handles a raw id by hand — worth
calling out as a correctness win, not just a visual one.

---

## 3. Files

| File | Change |
| --- | --- |
| `web/src/ui/SpaceOverview.svelte` | **new.** the right-hand panel: header, selected item + icon actions, filter tabs, columns, rows, threat strip |
| `web/src/ui/spaceRanges.ts` | **new, pure.** the orbit/keep ladders, the custom value, and the write-through to `flyingDistances` |
| `web/src/ui/DronesPanel.svelte` | **new.** lifted out of `Overview.svelte` |
| `web/src/ui/ShotsPanel.svelte` | **new.** lifted out of `Overview.svelte` |
| `web/src/ui/ShipHud.svelte`, `shipHudArcs.ts` | new geometry; the cap stays discrete |
| `web/src/ui/ModuleRack.svelte`, `moduleRack.ts` | slot redraw, press-and-hold overload, damage wedge |
| `web/src/ui/Flight.svelte` | the three pickers replace the id inputs |
| `web/src/ui/Mining.svelte` | in-space holds + jettison; window chrome |
| `web/src/ui/HudBar.svelte` | becomes the `hud` grid cell; loses shots and the nav buttons |
| `web/src/ui/Overview.svelte` | **shrinks to nothing and is deleted** once every section has a home |
| `web/src/ui/desktop.ts`, `DesktopWindow.svelte`, `Desktop.svelte` | `minimized`, the strip, clamp to the radar rect |
| `web/src/ui/Workspace.svelte`, `styles.css` | the grid; a `§ 7` section under `.spc-*` |
| `web/src/ui/tabs.ts` | `drones`, `shots` |
| `web/src/ui/spaceWorkspaceStates.test.ts` | **new.** the mirror net |

---

## 4. Phases

Each leaves the app working and the suite green. A patch branch off the integration branch per
phase, merged with `--no-ff`.

**Phase 0 — the mirror net, and the model.** Pin the *docked* workspace against everything that
follows: the station panel still renders, the dock frame CSS and global tokens are unchanged, the
docked desktop still opens/drags/persists windows. Add `spaceRanges.ts` with its tests. No visual
change.

**Phase 1 — the shell.** `.work-main` becomes the handoff's grid; `HudBar` moves into the `hud`
cell; the radar becomes a sized area rather than the whole left side; windows clamp to the radar;
`minimized` + the window strip land in `desktop.ts` and `DesktopWindow`. Panel *contents* do not
change — this is the structural half, verified on its own.

**Phase 2 — the overview panel.** `SpaceOverview.svelte`: header, selected item + the icon action
row (over the existing `rowActions` data), the range `▾` popovers, filter tabs, sortable columns,
rows, and the threat strip. Mounted in the dock frame's in-space arm. `Overview.svelte` keeps
everything not yet moved, hidden by the wrapper as it is today.

**Phase 3 — the HUD.** New gauge geometry, the module slot redraw, press-and-hold overload, the
damage wedge. `chromeRender.test.ts`'s `hud-readout` / `hud-modules-h` anchors move deliberately.

**Phase 4 — the windows.** `DronesPanel` and `ShotsPanel` lifted out of `Overview.svelte`; `Flight`
gets its pickers; `Mining` gets its in-space half. `Overview.svelte` is deleted at the end of this
phase, and that deletion is the phase's real deliverable.

**Phase 5 — mobile.** The 1D stacked collapsible cards in `MobileWorkspace`.

---

## 5. Verification

**The suites that will deliberately break, and must be rewritten rather than deleted.**
`overviewActions.test.ts` is the big one: it greps `Overview.svelte` for literal comment banners
(`R30 slice D — THE SELECTION BAR`), exact per-verb call-site counts, the **document order** of
sections, and "exactly 2 `<details class="collapsible">`". Every one of those assertions is guarding
a real rule; each has to be re-anchored to whichever new file now owns the rule. The same goes for
`flightStrip.test.ts` (**"STOP IS NEVER DISABLED"** — carry it to the HUD footer), `dronePanel.test.ts`
(30 tests, including "a hostile is marked in the ordinary overview list too"), and
`tacticalMount.test.ts` (matches the literal strings `class="desktop has-view"` and `class="tactical"`).

**The nets that must stay green untouched.** `dockPanelStates.test.ts`, `stationPanel.test.ts`,
`inventoryModel.test.ts`, `desktop.test.ts`, `squareCorners.test.ts`, `reflowContract.test.ts`,
`space/tactical.test.ts` (~55 pure-geometry tests), `space/rowActions.test.ts`,
`space/overviewPresets.test.ts`, `space/selection.test.ts`.

**New guards, one per bent rule in section 2.** The heat bar is absent and the damage wedge reads
from `moduleDamage`; an unknown overload state says nothing; the capacitor is still counted
segments; the shots header names its own window; a hostile still reaches the pilot through the threat
strip whatever preset is chosen; the range `▾` writes through to `flyingDistances` so Settings and
the radar cannot disagree; a window that is minimized is still listed in the strip.

**Driving it.** The station panel's harness pattern works here and is cheaper than it was: a
`space-workspace-harness.html` mounting the real panels against a fabricated snapshot, plus — now
that the in-client browser can be authenticated — the live client for the parts a harness cannot
fake (a real snapshot, a real lock, a real overload).

**Baseline.** Whole repo, per file, over `web/src src test`: **4246 tests, 24 failing**, all of them
the host's locale formatting. Run it in the main checkout, not a fresh worktree.

---

## 6. Open questions

1. **The threat block** (2.7). It is not in the handoff and it is the only "you are under attack"
   surface in the client. My recommendation is a strip above the list; the handoff's author should
   confirm, because it changes the panel's top.
2. **Rack heat** (2.2). There is no data. Drop the bar, or relabel it as worst module damage?
3. **The capacitor** (2.4). Keep counted segments against the handoff's dashed arc?
4. **Shots totals** (2.6). Scope the header to the visible window, or drop Dealt/Received?
5. **Compress** (2.12). Needs a facility picker that no handoff covers — defer?
6. **`Overview.svelte`'s deletion.** It is the honest end state, and it is also a 2788-line component
   that six suites render. Phase 4 is where it dies; if that is too much in one step, it can linger
   as an unmounted file for a release, but then nothing proves the new panels cover it.
