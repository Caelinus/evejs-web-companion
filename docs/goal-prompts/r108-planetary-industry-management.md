# Goal R108: Planetary Industry — managing and planning it, across every pilot

**Status:** Design spec, awaiting the operator's approval to build. **Client + bridge only.**

This is a design document, not a brief to start coding from. It says what to build,
in what order, and — as importantly — what was found already built, so no slice
re-invents a surface that is sitting there decoded and unused.

---

## 1. The ask

One place that manages planetary industry for every pilot at once:

1. Assign pilots to it, and see each one's colony status.
2. Dispatch a bot to handle the work a colony needs.
3. See planetary stock, including what sits in corporation hangars.
4. From the colonies as they stand, see what can be produced.
5. From the stock as it stands, see what can be produced.
6. Ask for a quantity of an advanced commodity and be told whether the current
   setup can make it, or exactly where the gaps are.
7. Roll all of that up across the whole fleet, not one pilot at a time.

## 2. What already exists

This was researched before designing. Every line below was read, not assumed.

### Reads that work today

| Surface | Route | Scope | Used by UI? |
|---|---|---|---|
| Colony snapshot | `GET /api/bridge/planets` | one held character | yes — `Planets.svelte` |
| Bound colony reads (7) | `GET /api/bridge/bound-planet` | one planet, session character | **no — plumbing only** |
| Personal assets | `GET /api/bridge/assets`, `…/assets/station` | one character | yes — `PersonalAssets.svelte` |
| Corp hangar contents | `GET /api/bridge/inventory/corp` | **docked at an office only** | yes — `StationPanel.svelte` |
| Corp-wide assets | `GET /api/bridge/corp-assets` | whole corp, station-independent | **no — plumbing only (R61)** |

The colony snapshot is richer than the panel shows. Per structure it already
carries contents, `usedM3`/`capacityM3`, what a factory makes, whether it received
inputs last cycle, last run and last launch instants, and for an extractor the
resource, quantity per cycle, cycle length, head count and expiry. Per colony it
carries the command centre level, the links and the routes. The envelope carries
`clockOffsetMs`, so every judgement is made against the server's clock.

`colonyAttention.ts` already turns that into findings, worst first, with an
urgency of *now* or *soon*: extractor expired, extractor expiring, extractor idle,
structure full, factory starved, command centre holding cargo. Its governing rule
is that silence is the default — a finding is only ever raised from something the
server actually stated, never from a null.

Among the bound reads that are decoded but wired to nothing:

- **`GetPlanetResourceInfo`** — the per-planet resource quality table. This is the
  answer to *"which of my planets can extract this?"*, and it is already decoded.
- **`GetProgramResultInfo`** — the emulator's own computed yield for a program
  (`qtyToDistribute`, `cycleTime`, `numCycles`). The server's arithmetic, not ours.

### Writes that work today

`POST /api/bridge/planet/network/update` reaches `UserUpdateNetwork`, whose command
vocabulary is complete and batched — the server applies an ordered list of
commands against one colony and commits once:

| # | Command | # | Command |
|---|---|---|---|
| 1 | create structure | 8 | **set what a factory makes** |
| 2 | remove structure | 9 | upgrade command centre |
| 3 | create link | 10 | add extractor head |
| 4 | remove link | 11 | remove extractor head |
| 5 | set link level | 12 | move extractor head |
| 6 | create route | 13 | install extraction program |
| 7 | remove route | | |

The companion emits **command 13 only**, from one hand-written function, one command
per call. There is no client-side type for the other twelve.

Also live: `POST /api/bridge/planet/commodities/launch` (used by the
`launch-commodities` macro) and `POST /api/bridge/planet/commodities/transfer`
(routed, confirm-gated, **no macro and no UI**). `POST /api/bridge/planet/abandon`
destroys a colony — see §8, it stays out.

Validation the server does for us, after the whole batch: exactly one command
centre, link bandwidth, route semantics, and CPU/power against the command centre
level. Validation it does **not** do: link range between two structures. A builder
UI cannot lean on the server to reject an overlong link.

Concurrency the client must honour: `expectedNetworkRevision` and an
`operationKey`/`editHash` receipt, refusing with `PlanetNetworkChanged` or
`IDEMPOTENCY_KEY_REUSED`.

### The recipe tree

`D:\evet\_local\gameStore\data\planetSchematics\data.json` — 68 rows, each with a
name, cycle time, the structure types that can run it, its inputs with quantities
and its output with quantity. **`src/staticData.js:756` already reads this table**
and throws everything but the name away before it reaches the wire.

The tier rule (raw resource, then the four commodity tiers) is a small static
group/category table living on the server. The companion already has each type's
group and category; it does not yet have the rule.

### Bots

A bot is a saved document: a name, a home, watch rows, and a small program tree of
macro steps with one level of loop and branch. Two planetary macros exist —
`restart-extractors` (colony risk, restart-safe) and `launch-commodities` (colony and
financial risk, **not** restart-safe, fires only once a command centre is 80% full and
past its launch cooldown). Both run either in the tab or on the server, and the
server host claims the hull exclusively: one hull, one driver.

`BotManagerPilotRow` already owns the vocabulary for "assign this pilot to this job,
see its status": a bot picker, a **Run here** and a **Run on server** button with a
runtime cap, a mode badge, a plain status line, a detail line and an alert line.
The in-flight `PilotHangar` work adds starting a companion for a pilot whose account
is not the tab's.

### The gaps, stated plainly

- **No cross-character aggregation exists anywhere in the app.** Every inventory and
  colony slice is single-character. A fleet-wide board is new ground.
- **Nothing in the app has a freshness indicator.** Merging several independently
  stale reads means introducing a read-at, because there is no convention to borrow.
- The recipe tree does not reach the client.
- Three of the four bound colony writes have never fired live; their shared ack
  decoder was written from server source, not captured bytes.

---

## 3. The one idea the whole system rests on

Asks 4, 5 and 6 look like three features. They are one question asked three ways.

Given a target commodity and a quantity, expand its recipe down to raw resources and
annotate every node with three facts: **what produces it**, **what is held**, and
**what is missing**. Read that tree upward and it answers "what can I make"; read it
downward from a target and it answers "can I make this, and where are the gaps";
ignore the target and walk colonies instead and it answers "what do my colonies
produce today".

So the spine is one pure module — call it the chain resolver — and the three views
are three renderings of its output. Build the resolver once, test it hard, and the
features fall out. Build three features separately and they will disagree with each
other within a month.

**The resolver does arithmetic on recipes, which are fixed facts. It does not
simulate a colony.** Recipe ratios and cycle times are static and ours to multiply.
Extractor yield decays across a program and is the emulator's to compute — where a
rate comes from an extractor, it is the server's `quantityPerCycle`, or
`GetProgramResultInfo`, labelled as being for the program currently installed. This
follows the existing panel's own rule, which is worth repeating verbatim because it
is what keeps this honest:

> NOTHING HERE SIMULATES A COLONY.

---

## 4. Where it lives on screen

**Keep `Planets` and add one panel beside it.** `Planets` is the per-colony reader;
it works, it is tested, and it is the right place for one colony in detail. The new
panel, **Planetary Industry**, is the fleet-wide board. Panels are floating windows
and several stay open side by side, so "the board on the left, the colony on the
right" is the native idiom here, not a compromise.

Selecting a colony on the board focuses it in the `Planets` window rather than
duplicating the detail view.

Registration, per the existing contract: a `TabID`, a hand-authored 24×24 neocom
glyph (exhaustive by construction — a missing one is a compile error), a
`PanelHost` branch, and the component name added to `panelFirstMount`.

### Board layout, top to bottom

```
┌ Planetary Industry ───────────────────────── [Refresh] ┐
│  ① Needs you            worst first, across all pilots │
│  ② Pilots and colonies  one row per colony             │
│  ③ What you hold        planetary stock, merged        │
│  ④ Make something       the planner                    │
└────────────────────────────────────────────────────────┘
```

Each is a `<section class="panel">` with its own `<header class="panel-head">`,
stacked — the shape `BotManager` already uses for Groups / Pilots / Recent runs.

---

## 5. The slices

Six, each shippable on its own. The operator values proven increments; slice 1 is
deliberately invisible and slice 2 is deliberately small, because everything after
them depends on the recipe tree being right.

### Slice 1 — the recipe tree reaches the client *(no UI)*

One accessor beside `getPlanetSchematic`, returning the whole table. One BFF route
mirroring the existing static-data routes (`requireAuth` only, no session, no
gateway call). The tier rule ported as a named constant with its source cited.
One pure client module decoding it, plus the chain resolver §3 with no UI attached.

Classification is **by group**, never by an enumerated list of item ids: every
inventory row already carries its raw group, and the app already classifies
containers this way. A hand-picked id list is wrong the day the table changes.

Done when: the resolver, given a target and a quantity, returns the full expansion
with per-node input quantities, and the tests drive it from the real table rather
than a hand-written fixture.

### Slice 2 — what a factory makes, on the colony already shown

The smallest visible payoff. In the `Planets` detail, a factory currently reads
"Making Superconductors". With slice 1 it reads what goes in, what comes out, and
how long a run takes — and whether the inputs are arriving, which the snapshot
already states.

Done when: a factory row shows its recipe, and a factory that received no inputs
last cycle says so in the same breath.

### Slice 3 — the fleet board, read-only

Sections ① and ② of §4.

**The multi-pilot read, and its one real constraint.** The colony route answers for
the *held* character. Each pilot signed in to this tab has its own session token, so
the board reads each of them directly, in parallel, with that pilot's own token —
the pattern the multibox work already established.

For a pilot **not** signed in to this tab, reading their colonies means signing in as
that account for the length of the call. That is a real action with a real cost: a
sign-in can disturb a session, and pilots dropping out of a fleet on re-login is a
failure this project has already paid for.

So: **the board never signs anyone in by itself.** A pilot with no session here shows
their last reading and how old it is, beside a **Check now** button that does the
sign-in for one call, explicitly, once. No polling, no background sweep, no automatic
refresh of absent pilots. The condition is stated continuously on the row rather than
raised as a dialog at click time.

This forces the freshness work the app has never had: every colony row carries the
instant it was read, and a merged view is never presented as if it were one moment.

Done when: colonies for every pilot with a session here appear in one list, worst
first; absent pilots show their age and a Check now; and the four outcomes the
existing panel distinguishes — loading, read failed, genuinely no colonies, and the
server carried no colony table — are distinguished **per pilot**, not collapsed into
one message for the whole board.

### Slice 4 — dispatch

Each attention finding maps to the work that clears it:

| Finding | What clears it |
|---|---|
| extractor expired, extractor idle | `restart-extractors` |
| command centre holding cargo, command centre full | `launch-commodities` |
| storage or launchpad full | **needs a transfer macro** — the route exists, the macro does not |
| factory starved | no single action; it is a routing or supply problem — say so, do not offer a button |

The row's action reuses the existing dispatch vocabulary exactly: the same two
run modes, the same runtime cap, the same status, detail and alert lines. It does
not invent a second way to start a bot.

`launch-commodities` carries financial risk and is not restart-safe. That is a
property of the work, and the row says so before it is started — not in a modal
afterwards.

Optional within this slice: a `transfer-commodities` macro over the existing route,
which is what actually clears a full launchpad.

Done when: a finding can be cleared from the board by the pilot that owns it, and a
finding with no safe automatic answer offers none.

### Slice 5 — stock, and the planner

Sections ③ and ④.

**Stock** merges three sources per pilot: colony structure contents (already named on
the wire), personal assets, and corporation holdings. Corp hangar *contents* need a
pilot docked at an office, so the corp-wide asset read — decoded, routed, and
unused since R61 — is the right source for a board that must answer without a
pilot standing in the right station. Wiring it is this slice's one piece of
plumbing-to-UI work.

Every merged row carries which pilot and place it came from and when it was read.
Stock from a colony's own storage is shown apart from stock in a hangar, because
they are not interchangeable: goods in a colony are already where they are needed.

**The planner** takes a commodity and a quantity and renders the resolver's tree:

- what the target needs, expanded to raw resources
- against each node: produced by *(colony, at a rate)*, held *(quantity, where)*,
  and the shortfall
- a verdict sentence, and beneath it the gaps, each one named as an action

Gap kinds, in the order they are worth telling someone:

1. **Nothing you own makes this.** No colony has a factory producing it.
2. **A factory could make this but is making something else.** Name the colony and
   what it makes now — this is the gap that slice 6 can close in one click.
3. ~~**It is made too slowly.**~~ Dropped when built (2026-09-24): slow only means
   something against a deadline, and the operator chose not to plan against one. Each
   row says instead how long its current producers take to cover the shortfall.
4. **It is extracted nowhere you own.** For a raw resource with no extractor — and
   here `GetPlanetResourceInfo` earns its keep, naming which of the pilot's planets
   carries that resource and at what quality.
5. **You hold enough; nothing needs to change.**

Done when: a target quantity of an advanced commodity yields a verdict and a gap
list, every number traceable to a server-stated fact or to recipe arithmetic, and
the extractor rates are labelled as being for the currently installed program.

### Slice 6 — the one write worth having *(optional)*

**Set what a factory makes** (command 8). It is the direct answer to gap kind 2, it
is a single command, and it needs no spatial placement.

It must honour the network revision, send the batch the server expects, and render
its refusals through the existing seam without paraphrasing them.

---

## 6. States, copy and edge cases

The existing panel's discipline is the standard: loading, read failed, genuinely
empty, and *the server carried no colony table* are four different facts and get
four different sentences. On a board spanning pilots each of those is **per pilot**.

Draft copy, in the established voice — plain, situational, never naming machinery:

| Situation | Words |
|---|---|
| Board loading | `Looking at your colonies…` |
| No colonies anywhere | `None of your pilots has built on a planet yet.` |
| One pilot's read failed | `{Pilot}'s colonies could not be read just now.` |
| Pilot not signed in here | `Last looked {age} ago.` beside **Check now** |
| Nothing needs attention | *(the section is absent — an empty space says it without being read)* |
| Planner, no target chosen | `Choose something to make and this will work out whether you can.` |
| Planner, can be made | `You can make {n} {name} from what you have.` |
| Planner, cannot | `You are short {n} {name}.` then the gap list |
| Nothing produces an input | `Nothing you own makes {name}.` |
| Resource extracted nowhere | `None of your planets is extracting {name}.` |
| Stale merge | `Read at different times — the oldest is {age} old.` |

Edge cases to specify rather than discover:

- **A colony with no command centre reading** — capacity is null, never zero; never
  divide by it. The existing fill helper already refuses to.
- **An unknown volume** nulls the whole structure's used volume. A fill bar must not
  render a fraction it cannot compute.
- **A launchpad that has never launched** arrives as *never*, not as an instant at
  the epoch.
- **Very long names** — planetary commodity names are long; the reflow to cards
  already handles the narrow case, and names must wrap with their icon as one unit.
- **A pilot with many colonies** and **a fleet with one pilot** must both look
  deliberate; there is no minimum-content assumption to lean on.
- **A recipe whose output type resolves to no name** renders as the fallback tile,
  which is the normal case, not the exception.

---

## 7. Tokens, responsive behaviour and accessibility

Tokens are the existing ones. No new colour is introduced.

| Token | Use here |
|---|---|
| `--color-warn` | attention accent, expiring soon |
| `--color-danger` | expired, a gap that blocks the target |
| `--color-good` | a target that can be met |
| `--color-muted` | captions, the read-at age |
| `--color-cpu`, `--color-powergrid` | the colony's CPU and power budget, if shown |
| `--color-panel-3`, `--color-line` | card and rule surfaces |
| `--radius-frame` | frames (it is 0 — the app is square) |

Responsive behaviour follows the container-query contract, not a viewport media
query, because panels are resizable windows: every table sits in a `.table-wrap`,
carries `class="guests reflow"` and a `data-label` on every cell, and collapses to
labelled cards at a container width of 640px. Controls stack and buttons go full
width. Touch targets stay at or above 40px. The page never scrolls sideways.

Accessibility: the attention list is a list, not a table, because it is read
sequentially; the colony roll-up is a table with real headers. Every icon tile
already carries its name as its label. Focus order runs attention → pilots →
stock → planner, matching reading order. The planner's verdict is the first thing
after its input, so a screen reader reaches the answer before the tree. Buttons are
buttons; nothing actionable is a styled div.

---

## 8. Out of scope, and why

- **The full colony builder** — placing structures, drawing links, laying routes.
  The commands exist, but placement is spatial: retail does it on a globe, and this
  app has no precedent for that editor. The server also does not range-check links,
  so the client would have to own a rule it cannot verify. This is a goal of its own,
  not a section of this one.
- **Abandoning a colony.** The route exists and it destroys the colony. It stays out
  of the UI entirely. A destructive action with no undo does not belong on a board
  whose purpose is a quick look.
- **Changing what `/` serves.** Untouched, as every planetary goal has left it.
- **Any eve.js change.** Everything above is reachable from the surface that exists.
  If something turns out not to be, that closes the feature and gets reported — it
  does not open a patch.

---

## 9. Risks

- **Signing in as an absent pilot to read their colonies can disturb their session.**
  Mitigated by never doing it automatically (§ slice 3). This is the single most
  likely way this feature could do harm.
- **Three of the four bound colony writes have never fired live.** Slice 6 fires one
  of them for the first time; expect the ack decoder to be wrong and plan to verify
  against real bytes rather than the existing fixture.
- **The recipe table is a build's worth of data.** It matches the server's own copy
  today; if they drift, the planner lies confidently. Read it from the same file the
  server reads, never from a second copy.
- **Merged staleness is easy to get wrong** and the app has no prior art for it. If
  the read-at is not on every row from the first slice, it will never be added.

## 10. Test obligations

Beyond the usual: every new test is watched failing first, and an id sweep carries a
companion test proving its pattern matches a string that does contain the id. The
resolver is the piece to mutation-test — it is pure, it is the spine, and a wrong
ratio is invisible in a fixture written with the same wrong assumption. That exact
failure has happened here before, when a cycle time was carried across in the wrong
unit and every test agreed with it.

Fixtures come from the real recipe table and from captured colony bytes, never from
imagination.
