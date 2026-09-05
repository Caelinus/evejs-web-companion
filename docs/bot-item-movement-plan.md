# Bot item movement — the remaining work

Plans for the five defects found alongside the two already fixed in
`fix(bots): route loot to the bays a hull actually has, and unload every one`.

## What this is a plan about

A running bot answered **227 consecutive `NotEnoughCargoSpace` refusals over
twelve hours**, in bursts of five ~6.3 s apart separated by gaps of ~3 min or
~26 min. Two defects caused it and are now fixed. Five more were found while
tracing it, and every one of them is a reason the bot *kept going* rather than
stopping — the bug was survivable for twelve hours because nothing in the stack
is able to notice a refusal, count it, or act on it.

That is the thread running through items 1–3 below, and they are best done in
that order because each subsumes part of the next.

The arithmetic worth keeping: `SCRIPT_CADENCE_MS = 2000` with `SETTLE_TICKS = 2`
(`web/src/nav/scriptRunner.ts:46`) retries a refused action 3 ticks later — 6.0 s,
the observed 6.3 s once observe latency is added. `MAX_BLOCK_ATTEMPTS = 5`
(`scriptMacros.ts:817`) gives the burst length. The 3 min / 26 min gaps are the
rest of the bot's lap, not a constant.

---

## 1. Refusals are invisible (was finding 3)

### The gap

`web/src/nav/scriptRunner.ts:194-215` wraps `deps.issue(result.action)` in a
try/catch, checks for session loss, and **discards everything else**:

```ts
} catch (error) {
  if (deps.isSessionLost(error)) { setError(SESSION_LOST); return; }
  // A refusal is not a crash — the next tick re-reads and decides again.
}
```

No counter, no store event, no status change. The bot's own status line read
"Taking what's inside." for the entire twelve hours; the refusals existed only
in the BFF's log. Two aggravating details:

- `memory = result.memory` is assigned at `scriptRunner.ts:181`, **above** the
  try. The decider's bookkeeping commits whether or not the call then threw —
  which is how `lootWrecks` marks a wreck `looted` after a failed transfer.
- On the failure path `settle` still evaluates to `SETTLE_TICKS`, identical to
  success. There is no backoff of any kind.
- The bot's `unloadOre` dispatch (`flow.ts`, `case "unloadOre"`) calls
  `api.unloadMiningHolds` raw and throws the `MiningActionResult` away, bypassing
  the `runMiningAction` wrapper that raises `mining/silent-decline` for the UI.
  So bot-driven unloads have no partial-move signal at all.

Meanwhile `web/src/bridge/refusals.ts` already contains a carefully written,
exhaustively sourced player-language table — including `NotEnoughCargoSpace`,
"There isn't enough room in that hold" — that the bot path never reaches.

### The plan

**A new pure module, `web/src/nav/refusalLedger.ts`.** Run-scoped, owned by the
runner, not by any macro. Keyed by `${stepPath}:${action.kind}` plus an optional
object id (the container/wreck being addressed):

```ts
interface RefusalRecord {
  readonly key: string;
  readonly count: number;        // consecutive, reset by the first success
  readonly firstAt: number;
  readonly lastAt: number;
  readonly words: string;        // from describeRefusal — never a raw code
  readonly kind: "refused" | "gone";
}
```

`note(ledger, key, error)` / `clear(ledger, key)` / `consecutive(ledger, key)`.
Pure, directly testable, no I/O — the same shape as `scriptCapabilities.ts`.

**Wire it into the runner** at the existing catch. Three consequences fall out
of one change:

1. **Visible.** `ScriptRunSnapshot` gains `refusals: readonly RefusalRecord[]`,
   so the Bot panel can render "Ore hold: there isn't enough room in that hold —
   5 times in the last minute". The words come from `describeRefusal`, honouring
   the rule that `refusals.ts` is the only place a refusal becomes language.
2. **Bounded.** Past a threshold the run pauses with the refusal's own words as
   the pause reason. This is the bound that item 2 shows macro memory cannot
   provide, because the ledger lives on the run, not on the step.
3. **Backed off.** `settle` grows with `consecutive(ledger, key)` — a capped
   linear or geometric step. Five refusals 6 s apart is defensible; 227 over
   twelve hours is not.

**Separately, make the bot's `unloadOre` consume its result** the way the UI path
does: `moved.length === 0 && requested > 0` should throw, so the ledger sees a
silent decline and not just a hard refusal.

**Distinguish gone from refused — and see 5b before implementing it.** A
`FakeItemNotFound` on `bindObject` is NOT simply "the object is gone": the same
code is thrown for an object that is merely out of range or off-scene. Those
want opposite handling, so the ledger needs three states rather than two:

| state | cause | handling |
| --- | --- | --- |
| `refused` | the transfer was declined | count it, back off, bound it |
| `unreachable` | out of range / off-grid at bind time | re-approach; NEVER retire |
| `gone` | the id matches no inventory target at all | retire for the run |

The client cannot tell `unreachable` from `gone` on the error code alone — both
arrive as `FakeItemNotFound`. It can tell them apart from what it already knows:
if the entity is still on the grid in this tick's snapshot, treat it as
`unreachable` and close the distance; if it has left the snapshot too, it is
`gone`. Retiring on the bare code would strand a bot that merely drifted.

### Tests

Pure ledger tests (count, reset-on-success, distinct keys). One flow test that a
repeatedly refused loot surfaces in the snapshot and eventually pauses the run
rather than looping — the test that would have caught the original bug in
minutes rather than twelve hours.

---

## 2. Macro memory resets, so the retry bounds don't hold (was finding 4)

### The gap

`web/src/nav/scriptDecide.ts:844` and `:902` both drop a step's scratch on
leaving it:

```ts
macroMem = omit(macroMem, step.id); // leaving the step — its memory resets
```

That is *correct* for most of what lives there — a fresh visit should re-approach,
re-lock, re-read. But it also wipes the bounds:

| Macro | State | Consequence of the reset |
| --- | --- | --- |
| `lootContainers` | `tries`, `skipped` | a permanently refusing can gets a fresh 5-attempt budget every lap |
| `unloadCargo` | `attempts` | same |
| `moveItems` | `attempts` | same |
| `lootWrecks` | `looted` | a wreck is re-looted next lap (mostly harmless — wrecks despawn) |

`MAX_BLOCK_ATTEMPTS` is therefore a **per-visit** bound, not a per-run one. That
is precisely why the log shows repeating bursts of five instead of one burst and
then silence.

### The plan

**Do item 1 first, then delete most of this.** The refusal ledger is run-scoped
by construction, so it *is* the missing store. Once it exists:

- `lootContainers` loses `tries`/`skipped` entirely and asks the ledger instead.
- `unloadCargo` and `moveItems` keep `attempts` only as a bound on *silent*
  non-progress (a 200 that moved nothing), which is a different failure the
  ledger does not see. See item 3.

**Then make the split explicit rather than incidental.** The distinction the
codebase currently leaves implicit is:

- **step scratch** — approach targets, lock waits, issued flags. Resets on
  leaving. Correct today.
- **run-scoped judgement** — "this object will not cooperate". Must survive.

Write that distinction into the comment at `scriptDecide.ts:844`, so the next
person adding a counter knows which kind they are adding.

**Decay is required, not optional.** A can that refused while the hold was full
must be retried once the hold is emptied, or a hauler sets aside every can on the
belt and never comes back. Tie expiry to a signal that conditions changed — the
cleanest is *any* successful transfer by this run — rather than to a wall-clock
timer alone.

**Also close the wreck/container asymmetry.** `lootWrecks` marks a wreck looted
the instant it issues (`scriptMacros.ts:1512`), which the comment block at
`:1532` explicitly describes as the rejected old behaviour that `lootContainers`
was built to avoid. `lootWrecks` was never brought along. It should ask the
ledger like its neighbour.

---

## 3. `deliver-ore` has no bound at all (was finding 5)

### The gap

`scriptMacros.ts:709` issues `unloadOre` with `tick(action, why, phase, ACTING)`
— four arguments, no memory. There is no attempt counter, unlike `unload-cargo`.
If the station's `invbroker.Add` silently declines every stack, `deliver-ore`
retries forever reporting "Unloading the ore into the hangar." and never reaches
`blocked`.

This is not hypothetical: "a 200 is not proof" is the single most repeated
warning in this codebase, and the BFF's transfer route exists because
`invbroker` declines silently in several branches.

### The plan

The right measure is **not** "did the call succeed" — the ledger covers that. It
is **did the quantity fall**. A silent decline returns 200 and moves nothing, and
only the re-read can tell.

Add a small shared helper rather than a fourth bespoke counter:

```ts
// nav/blockProgress.ts
noProgress(mem, measure: number | null): { stalled: number; mem: MacroMemory }
```

It records the last measure and increments `stalled` when a fresh reading has not
improved. `null` (unreadable) is never progress and never a stall — it is
skipped, per the house rule.

Apply it to every block that repeats until a measurable quantity falls:

| Block | Measure |
| --- | --- |
| `deliver-ore` | `holdItemIDs(obs.holds).length` |
| `unload-cargo` | total rows across cargo + freight bays |
| `move-items` | quantity of the item still at the source |
| `refine-ore` | ore rows left in the station hangar |

Past a threshold each reports `blocked` with a reason that names the stall, not
a refusal it never saw.

---

## 4. `move-items` counts what it *asked for*, not what moved (was finding 6)

Two distinct defects in one macro.

### 4a. Optimistic counting

`scriptMacros.ts` set-amount branch:

```ts
{ ...mem, attempts, moved: movedSoFar + take }
```

`moved` is incremented **at issue time**, so a refused split still counts against
`remaining`. The block then declares "The move is finished." having moved
nothing — directly contradicting its own docstring, "Confirmed by re-read: done
only when the FROM place shows the job finished". The move-everything branch
(`remaining === null`) is correct and does rely on the re-read; only the
set-amount branch is wrong.

**Plan.** Count from the world, not from intent — the same "the source is the
authority" rule the BFF's transfer route already applies
(`src/server.js`, `gaveUpAtSource`). Record the source total on the first tick;
thereafter `moved = startingTotal - currentTotalAtSource`. Delete
`moved: movedSoFar + take`. This also makes the block correct across a
mid-move restart, which the current counter is not.

### 4b. It reads one bay and writes to another

`movePlaceRows` resolves the `"ore-hold"` place as *the first present non-cargo
hold*:

```ts
const ore = holds.find((hold) => hold.key !== "cargo" && hold.present) ?? null;
```

while `asPlace` (`flow.ts`) writes to a hard-coded bay:

```ts
: { kind: "shipBay", bay: "ore" };
```

On a hull whose first present specialised hold is not the ore hold — a gas or
ice hauler — the block lists rows out of one bay and asks the server to move them
out of a different one, yielding `409 ITEMS_NOT_AT_SOURCE`.

**Plan.** Make the bay key real end to end, which is also what delivers "any
movement respects bay type" for the manual block and not just for loot:

1. Widen the `place` argument from the three-value `{hangar, cargo, ore-hold}` to
   any bay key. The editor offers exactly the bays the hull reports `present`,
   read through the same `/bays` call the loot router now uses — so the picker
   cannot offer a bay the ship does not have.
2. Generalise `asPlace` to `{kind: "shipBay", bay: key}` for any key that is not
   `hangar` or `cargo`, instead of collapsing every third case to `"ore"`.
3. `movePlaceRows` selects by that same key. One key, both directions — the
   invariant `bayRouting.ts` already pins for the loot path.

Keep `"ore-hold"` accepted as a legacy alias so saved scripts keep working, and
resolve it to the `"ore"` key.

---

## 5. The smaller ones (was finding 7)

### 5a. Loot blocks cannot see how full they are

`loot-wrecks` and `loot-containers` are absent from `CARGO_MACROS`
(`flow.ts:5649`), so `obs.cargo` is `null` while looting. The deciders are
structurally unable to check for room before scooping.

Worse, the condition a hauler loop is *designed* to stop on measures the wrong
thing: `cargo-full` reads `obs.cargoFraction`, sourced only from
`panel.cargo.capacity` (`scriptConditions.ts:320`). A hauler whose freight goes
to the ore hold never trips it.

**Plan.** The per-hull bay cache added by the fix already has the numbers.

- Add `freightFraction` to `ScriptObservation`: the fullest **freight** bay,
  cargo included, computed from the cached bays plus a cheap capacity refresh
  while a loot block is active.
- Add a **new** condition `freight-full` rather than redefining `cargo-full`.
  Changing what `cargo-full` means would silently alter every saved script that
  uses it, which is exactly the kind of invisible correction this codebase
  refuses elsewhere. Leave it alone; have the editor recommend `freight-full`
  for loot and hauler loops, and say why in the picker's help text.
- Once the condition exists, `loot-containers` can stop scooping when there is no
  room instead of discovering it one refusal at a time.

### 5b. A despawned — or merely distant — can burns a full retry budget

**Confirmed, no longer inference.** `FakeItemNotFound` is thrown by eve.js's
`Handle_GetInventoryFromId` in `invBrokerService.js`, the handler behind the
`invbroker.GetInventoryFromId` bind that `containerBindSpec` uses
(`src/server.js:2111`, and see `docs/loot-can.md`). Read from a copy of the
emulator source outside this repo, so treat the line numbers as version-specific
and the handler name as the durable reference.

It throws from **two guards that matter here**, and this is the part that
changes the plan:

1. the itemID matches no known inventory target at all — the container has
   genuinely stopped existing (**gone**);
2. `_getSpaceContainerScopeAccessError` is truthy — the same-scene and
   transfer-range check the loot-can design already described — so a container
   that fell off-grid or out of range between the snapshot tick and the bind
   call throws the **identical code** (**unreachable**).

`openContainer` binds straight from a snapshot that may be a tick stale, so both
are ordinary races rather than faults.

**Plan.** Item 1's ledger, with the three-state table there rather than a flat
`gone`. A bare `FakeItemNotFound` must NOT retire a target: a can the bot simply
drifted away from would be abandoned for the rest of the run, and on a jetcan
hauling loop that is most of the cans. Split on the snapshot — still on grid
means close the distance, absent from the grid means retire.

Note this is a *different* failure point from `NotEnoughCargoSpace`, which comes
from the `Add`/`MultiAdd` transfer after a successful bind. Both land on the same
`lootWreck`/`lootContainer` action and both are swallowed identically at
`scriptRunner.ts:194-215`.

### 5c. Every mover needs a refused-transfer test

`lootDispatchFlow.test.ts` had no refusal case at all before the fix, which is
why none of this was caught. Each flow test file rebuilds its own
`makeFakeFetch`.

**Plan.** Lift the fake-BFF harness into a shared test helper that can be told to
refuse a named destination (`refuse({ kind: "shipBay", bay: "ore" })`), then give
every mover — `deliver-ore`, `unload-cargo`, `move-items`, `jettison-cargo`,
`load-mission-cargo` — a refused case. The loot path now has two; the pattern is
in `lootDispatchFlow.test.ts` and is worth copying rather than reinventing.

### 5d. RESOLVED — it was a bug after all

`deliver-ore` unloads via `holdItemIDs(obs.holds)`, and the BFF's `MINING_HOLDS`
table always includes the cargo hold as a fallback entry
(`src/server.js:16147`) — `holdItemIDs` does not filter on `present`. So on a
hull that *has* an ore hold, `deliver-ore` also empties the ordinary cargo hold
into the station hangar every lap, taking spare ammo, crystals and anything else
stowed there with it.

That may well be wanted. It is not obviously wanted. **This needs an operator
decision before any code changes**, and the options are:

1. Leave it — "deliver everything" is a reasonable reading of the block.
2. Restrict it to freight, matching `unload-cargo` after the fix.
3. Add an argument, defaulting to today's behaviour so nothing changes silently.

**Resolved 2026-09-05: option 2, restrict it to freight.** On the evidence it
was not a policy choice at all — the `MINING_HOLDS` cargo entry is documented as
a fallback for hulls with no specialised hold, and the filter implementing that
was simply missing. `deliver-ore` now sweeps cargo only when the hull has no
specialised mining hold. See `docs/unloading-policy-design.md` Part 1.

The behaviour change is real and narrow: a mining bot that also loots, and
relied on `deliver-ore` to empty that loot out of cargo, now leaves it aboard.
The fix for such a script is one extra `unload-cargo` block.

---

## Suggested order

1. **Item 1 (refusal ledger).** Everything else is cheaper afterwards, and it is
   the one that turns a twelve-hour silent failure into a visible one.
2. **Item 2 (memory split).** Mostly deletion once item 1 lands.
3. **Item 3 (`noProgress`).** Small, shared, closes the silent-decline hole that
   the ledger cannot see.
4. **Item 4b (bay keys end to end).** The user-visible half of "respect bay
   type"; item 4a rides along in the same file.
5. **Item 5a (`freight-full`).** Needs 4b's editor work for the bay picker.
6. **Item 5c (shared refusal harness).** Do it alongside whichever of the above
   comes first and let the rest reuse it.
7. **Item 5d.** Ask, then act.

Items 5b falls out of item 1 for free.
