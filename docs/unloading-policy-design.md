# What stays aboard — a design for unload/jettison policy

Design doc. **Part 1 and Part 1b are implemented**; Parts 2 and 3 are not. It exists because the current behaviour is only
safe by accident, and the accident is about to end.

## The problem

Four blocks move "everything" out of a ship, and "everything" is the wrong unit,
because a hold carries two different kinds of thing:

- **freight** — what the trip was for: ore, ice, gas, loot, PI commodities.
- **kit** — what the ship needs in order to keep working: mining crystals,
  ammunition, spare drones, scripts, jump fuel, spare modules. On an Orca, also
  whatever a fleet-mate has left in the fleet hangar.

| Block | What it moves today | Risk |
| --- | --- | --- |
| `deliver-ore` | every mining hold **and the whole cargo hold** | crystals into the hangar every lap |
| `unload-cargo` | the whole cargo hold + every freight bay | same |
| `jettison-cargo` | the whole cargo hold, **into space**, when no item is picked | crystals into a can that despawns |
| `jettison-ore` | the ore hold | low — an ore hold holds ore |

It works right now only because the ships in use carry nothing but freight in
cargo. Fly an Orca, or carry a spare set of crystals, and it stops working.

`deliver-ore` sweeps cargo for an unglamorous reason: the BFF's `MINING_HOLDS`
table carries the cargo hold as a **fallback** for hulls with no specialised
hold (`src/server.js:16147`), and `holdItemIDs`
(`web/src/nav/miningBotLoop.ts:351`) flattens every hold without filtering on
`present`. Nobody decided this. It is a missing filter.

## What is already handled

Worth stating plainly, because it narrows the work. After
`fix(bots): route loot to the bays a hull actually has`, `FREIGHT_BAYS`
(`web/src/bridge/bayRouting.ts`) already excludes the ship's kit bays from both
filling and emptying:

> excluded: `fuel`, `fleet`, `shipMaintenance`, `ammo`, `drone`, `fighter`,
> `subsystem`, `ship*`, `booster`, `corpse`, `quafe`, `mobileDepot`

So on an **Orca**, `unload-cargo` today empties the **ore hold and the cargo
hold**; the fleet hangar, ship-maintenance bay and drone bay are already left
alone. The fuel bay and fleet hangar named in the request are already safe.

What is *not* handled, and cannot be handled by any bay-level rule:

1. **The cargo hold mixes kit and freight.** It is the one place where "which
   bay" carries no information about "keep or unload".
2. **`deliver-ore` sweeps cargo regardless**, because it uses `MINING_HOLDS`,
   not `FREIGHT_BAYS`.

## A constraint found while checking

`GET /api/bridge/ship/ore-hold` deliberately strips `groupID` and `categoryID`
from its rows (`src/server.js:16210`) — only `itemID`, `typeID`, `quantity`
survive. So `deliver-ore` **cannot currently tell ore from a crystal even if we
ask it to.**

`GET /api/bridge/ship/:id/bays` sends both (`src/server.js:16455`), under the
same R7d rule, because a stack's category is part of *what it is*. Adding the
two fields to the mining-holds route is therefore consistent with the existing
policy rather than a loosening of it — but it is a BFF change, and it is only
needed for the narrow case in Part 1 below.

---

# The proposal, in three parts

## Part 1 — `deliver-ore` should deliver ore ✅ DONE

The largest share of the problem needs **no configuration at all**, because it
is a bug rather than a policy.

> **Shipped as `freightHoldItemIDs` in `nav/miningBotLoop.ts`.** It covers FOUR
> call sites, not one: `deliver-ore`, the fixed mining ladder's own unload
> (`miningBotLoop.ts:486`), and the two haul-completion checks that ask whether
> the hold is empty yet. Those last two had to move together with the unload —
> they measure "is it empty", so leaving them on `holdItemIDs` would have meant
> a haul was never counted complete while anything sat in the cargo hold.
>
> One thing the implementation found that this design had not: the mining-holds
> route computes `present` as `reading !== null && capacity > 0`, so a hold
> whose CAPACITY read failed is reported exactly like a hold the hull does not
> have — unlike `/bays`, which is strictly three-valued. A hull whose ore-hold
> capacity read blipped would have been demoted to "no ore hold" and had its
> cargo shipped out. `isSpecialisedHold` therefore takes contents as a second
> witness: a hold that listed a stack demonstrably exists.

**Rule: `deliver-ore` unloads the specialised mining holds. It falls back to the
cargo hold only when the hull has no specialised mining hold present.**

That is what the `MINING_HOLDS` cargo entry was *for* — its own comment says so:
"a hull with no specialised hold mines straight into cargo". The bug is that the
fallback is unconditional.

This needs no new data: `/ore-hold` already reports `present` per hold. It is a
filter on `holdItemIDs`, or better a new `freightHolds(holds)` helper so
`holdItemIDs`'s other callers are not disturbed.

It fixes every barge, exhumer, Venture and Orca outright — all of them have an
ore hold, so their cargo stops being swept and the crystals stay put.

**Residual case:** a hull with *no* ore hold at all (a mining cruiser, a
destroyer) genuinely mines into cargo, so cargo must still be swept there — and
crystals in that cargo are still exposed. Two ways to close it:

- **1a (cheap, no BFF change):** accept the residual and let Part 3's keep-list
  cover it. The affected hulls are unusual.
- **1b (small BFF change):** add `groupID`/`categoryID` to the `/ore-hold` rows
  and filter the cargo fallback to the ore category, so `deliver-ore` delivers
  ore even out of a mixed cargo hold.

**Both shipped.** ✅ 1b added the two fields to the route — the same pair
`/bays` already publishes, while `flagID`/`locationID` stay behind — and
`freightHoldItemIDs` now filters the cargo fallback to the Asteroid category.

Two rules the implementation had to settle that this design had not:

- **An unclassifiable row is LEFT ABOARD.** Unknown is never a verdict, the same
  rule `refine-ore` applies. It costs a stack of ore staying in the hold; the
  other way round costs the crystals, silently, every lap.
- **A hold in which NOT ONE row carries a category is delivered whole.** That is
  not a cargo bay full of mysteries, it is a bridge that does not publish the
  field — and filtering on it there would deliver nothing at all and leave a
  miner mining into a hold that never empties. One classified row is enough to
  trust the filter. The check is `typeof x === "number"`, not `!== null`,
  because a row from a source that omits the field reads as `undefined`.

> ⚠ **This is a behaviour change and must be announced.** A mining bot that also
> loots, and relies on `deliver-ore` to empty the loot out of cargo, will now
> leave it aboard. The fix for such a script is one extra `unload-cargo` block.
> This is the only part of this design that alters an existing bot's behaviour.

## Part 2 — bays the bot must not touch

For the cases a static set cannot know: the operator says which bays are
off-limits.

### ⚠ The rule that makes this safe: exclusion is both directions

If a bay is excluded from unloading, it **must also be excluded from being
filled**. Otherwise the operator's own exclusion recreates the exact failure this
whole effort started from: a bay that fills up and is never emptied refuses every
later pickup, forever.

So "exclude" means **do not touch**, not "do not unload". That reading also
matches the motivating case — an Orca's fleet hangar holds other people's
things, and the bot should neither empty it nor put loot in it.

A per-block argument cannot enforce that on its own, because the loot router is
a different block. What holds the line instead is that the DEFAULT fill-set is
static and unchanged: `exceptBays` only narrows unloading, so the two sets can
only be pulled apart deliberately — and the validator says so when they are.
See the hazard section below.

### Vocabulary

Bay keys are already a closed, stable, browser-visible vocabulary (`"ore"`,
`"fleet"`, …) with labels supplied by `/bays`. No flag numbers involved, so
nothing here breaches the "the browser never learns 134 exists" rule.

## Part 3 — items that stay aboard

The cargo hold needs item-level granularity. A match should be expressible at
two levels:

| Level | Example | Why |
| --- | --- | --- |
| exact type | "Simple Veldspar Mining Crystal II" | precise |
| kind (groupID) | "everything like this" | one entry covers all crystal variants |

Rows carry `typeID`, `groupID` and `categoryID`, so both are matchable from data
already on the wire.

**Ergonomics.** The picker should offer what is actually aboard rather than a
type database — `BotBuilder.svelte` already assembles `knownItems` from the
hangar and cargo rows, so no new read is needed. For a group match there is no
group-*name* lookup in the client, so label it by an exemplar — *"items like
Simple Veldspar Mining Crystal II"* — rather than inventing a name.

**Unknown classification cuts differently for the two verbs**, and this should be
deliberate:

- **unloading** an unclassifiable row: move it. It lands in the station hangar,
  which is recoverable, and refusing to move it would stall the block's "done".
- **jettisoning** an unclassifiable row: keep it. A can despawns; a mistake is
  unrecoverable. "Cannot tell" must not put a stack into space.

## The two argument shapes

Modelled on `oreList`/`OreFamilyArg` (`botScript.ts:266,276`) — a stable key
plus a display-hint name, bounded, deduped on load:

```ts
// A closed vocabulary: bay keys the BFF already publishes with labels.
| { readonly kind: "bayList"; readonly bays: readonly string[] }

// Matched at either level; `name` is a display hint, never the match key.
| { readonly kind: "itemList"; readonly items: readonly ItemMatchArg[] }

type ItemMatchArg =
  | { readonly match: "type";  readonly typeID: number;  readonly name: string }
  | { readonly match: "group"; readonly groupID: number; readonly name: string };
```

Bounded like `MAX_ORE_LIST = 10`; over-long lists are truncated with a warning
rather than refused, matching the codec's existing `oreList` behaviour. An empty
or absent list means "exclude nothing" — today's behaviour — so no existing
script changes.

Wired onto two macros in `macroSpecs.ts`:

| Macro | Args added |
| --- | --- |
| `unload-cargo` | `exceptBays: bayList`, `keepItems: itemList` |
| `jettison-cargo` | `keepItems: itemList` |

`jettison-cargo` gets no `exceptBays` — it only ever reads the cargo hold, so
there is no bay to exclude. `jettison-ore` and `deliver-ore` get neither; see
Part 1 and the open questions.

---

# Where the policy lives — DECIDED: per-block arguments

Two options were weighed. **Decision: per-block arguments.**

`unload-cargo` and `jettison-cargo` each gain optional `exceptBays` and
`keepItems` arguments. The rejected alternative was a script-level
`cargoPolicy` field on `BotScript`.

**Why this is cheap.** There is a precedent to copy exactly: `oreList`
(`botScript.ts:266`) is already a list-valued arg with a working multi-select
widget (`"ore-list-picker"` — the only multi-select in the editor), bounded by
`MAX_ORE_LIST = 10`, with codec round-trip and clamp tests already written. An
optional arg needs **no script-format version bump**: an absent key on an
existing script is simply absent. That matters, because `scriptCodec.ts` has no
migration scaffolding — `version > SCRIPT_VERSION` refuses outright, so a bump
would have to be built from nothing.

The two blocks also have genuinely different risk profiles — you may well want
to jettison things you would never unload — so separate lists are arguably
better than one shared policy.

## ⚠ The hazard this choice carries, and how it is contained

A per-block argument is invisible to other blocks. So this is expressible:

> `loot-containers` keeps routing ore into the ore hold,
> while `unload-cargo` is told not to empty the ore hold.

That is the fills-but-never-empties trap that produced the original
227-refusal, twelve-hour loop — reachable again, this time by configuration
rather than by a bug. Three things contain it, in order of how much they cost:

1. **The default fill-set does not change.** `FREIGHT_BAYS` stays the static
   set the loot router fills, and `exceptBays` only ever NARROWS what a block
   unloads. It can never widen a block into a kit bay, so the dangerous
   configuration is reachable only deliberately, never by accident or by
   default.

2. **A validator advisory, and this is the load-bearing mitigation.**
   `validateScript.ts` already has an `advisory` severity (`:47`) that renders
   as a grey note on the row, and it already walks the whole program, so a
   cross-step check is natural:

   > *"This bot loots into the ore hold but never empties it — the hold will
   > fill up and later pickups will be refused."*

   Fires only when a script contains **both** a block that fills bay X **and**
   an `unload-cargo` whose `exceptBays` names X. That precision matters:
   `validateScript.ts:93` warns that "an advisory that cries wolf on a good bot
   is how a player learns to stop reading advisories", so this must not fire on
   a script that merely lacks an unload block.

3. **The refusal ledger** (`bot-item-movement-plan.md`, item 1) makes the
   failure loud at runtime if it happens anyway. Independent of this work, but
   it is the backstop.

**Deferred, not dismissed:** if the same two lists end up copied across every
script, promote them to a script-level default with the per-block arg as an
override. The arg shape below is designed so that promotion is additive.

# Enforcement — one place, not four

Whichever option is chosen, the filtering belongs in `bridge/bayRouting.ts`,
which already owns the freight/kit split, as two pure functions:

```ts
planUnloadGroups(cargoRows, bays, policy): readonly BayGroup[]
planBayTransfers(rows, bays, policy):      readonly BayGroup[]   // extend existing
```

Every mover calls one of them. A new mover then cannot forget the policy, and the
existing invariant test — *"every bay the router can FILL is a bay the unload
block can EMPTY"* — extends from the static set to the runtime policy, which is
what keeps Part 2's rule honest.

# Cost

Per-block, following the `oreList` blast radius exactly:

| File | Change |
| --- | --- |
| `bots/botScript.ts` | two `Arg` union members + `ItemMatchArg`, two `MAX_*` bounds |
| `bots/macroSpecs.ts` | the arg entries on `unload-cargo` and `jettison-cargo` |
| `bots/scriptCodec.ts` | a `readArg` branch each + an `orderArg` case each — the `never` default at `:1145` **fails the build** until both exist |
| `bots/scriptText.ts` | "…except Mining Crystals" in the two sentences |
| `bots/editorOptions.ts` | two `WidgetKind`s + `ARG_KIND_WIDGET` entries (a `Record<Arg["kind"],…>`, so also compile-forced) + labels |
| `ui/BotInspector.svelte` | two widget branches; the bay one is a checkbox group over a closed set, the item one mirrors `ore-list-picker` (~80–100 lines) |
| `ui/BotBuilder.svelte` | thread reference data; `knownItems` (`:596`) already holds hangar+cargo rows, so no new flow call |
| `bots/validateScript.ts` | **the cross-step advisory** — the mitigation, not optional |
| `bridge/bayRouting.ts` | `planUnloadGroups(rows, bays, { exceptBays, keepItems })` |
| `nav/scriptMacros.ts` | `unloadCargo` and `jettisonCargo` read their args |
| `nav/miningBotLoop.ts` | `freightHolds` for Part 1 |
| `src/server.js` | Part 1b only: two fields on the `/ore-hold` rows |

Tests: codec round-trip/clamp/dedupe, the two sentences, the planner, the two
deciders, the validator advisory (both that it fires and that it does **not**
fire on a script with no unload block), and Part 1's `freightHolds`.

**No format version bump.** An absent arg key on an existing script is simply
absent, and `scriptCodec.ts` has no migration scaffolding to build on
(`version > SCRIPT_VERSION` refuses outright), so avoiding the bump is worth
real money here.

# Suggested order

1. **Part 1** alone — a bug fix, no schema, removes the sharpest edge for every
   hull actually in use. Shippable on its own.
2. **`keepItems` on both blocks** — the cargo hold is the real gap, and this is
   the half that protects crystals.
3. **`exceptBays` on `unload-cargo`, together with the validator advisory.**
   These two ship *together*: the advisory is what contains the hazard the arg
   introduces, so shipping the arg without it would be the wrong order.
4. **Part 1b** if the holdless-hull residual turns out to matter.

# Open questions

- **Should the lists eventually be per-ship?** Crystals belong to a hull, and one
  script may run on several pilots (`pilotRoster.ts`), so a per-ship policy would
  follow the hull rather than the program. Deferred, not dismissed — and the arg
  shapes above are additive, so a later script-level or ship-level default can
  sit underneath them without changing what is built now.
- **`deliver-ore` gets no `keepItems`** on the strength of Part 1: once it stops
  sweeping cargo, there is nothing there to protect. If Part 1b is skipped and a
  holdless hull turns out to matter, the same arg goes on that block too.
- **Partial stacks** ("keep 1,000 rounds, unload the rest") are deliberately out
  of scope; matching is whole-stack.
- **`jettison-ore`** is left alone — an ore hold holds ore. Revisit only if a
  hull turns up whose mining hold carries kit.
