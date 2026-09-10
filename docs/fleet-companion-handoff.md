# Fleet companion — handover

Where the work stands, what is decided, and what bites. Self-contained: you
should not need the conversation that produced this.

**Read in this order.** [fleet-companion-plan.md](fleet-companion-plan.md) —
what and why. [fleet-companion-implementation.md](fleet-companion-implementation.md)
— order, branch, gates, and the per-phase specs. Then this, for state.

## State

| | |
| --- | --- |
| Branch | `feat/fleet-companion`, cut from `tokeiito` |
| Base | `tokeiito` at `7488415` (three docs commits) |
| Branch commits | `d844988`, `6ca4c49`, `0f2e9ca` |
| Working tree | clean |
| Phase 0 | ~70% — the loop lives, starts, stops and holds the ship |
| Everything else | not started |

Gates at the last commit: `tsc` clean, `docker build --target web-build` clean,
full suite identical to baseline (17 locale failures, no new names).

## What exists

- `web/src/nav/fleetCompanionLoop.ts` — the loop. Types, the typed request, the
  controller, and a ladder whose only rung is the warp yield. It decides `wait`
  and issues nothing, on purpose.
- `web/src/nav/fleetCompanionLoop.test.ts` — 13 tests, the ladder and lifecycle.
- `web/src/app/companionFlow.test.ts` — 8 tests, the flow over a faked BFF:
  preflight, and the exclusion pairs.
- `flow.ts` — `makeFleetCompanionDeps()`, `startFleetCompanion` and the
  pause/resume/stop trio, `fleetCompanionReads`, `stopCompanionController`.
- `botRegistry.ts` — `"companion"` in `BotID`, its requirements, its catalogue
  row.
- The `companion` store slice, its four events, and its reset wiring.

## What is left in phase 0

1. **`src/botHost.js` — headless.** The one substantial piece. It drives exactly
   one entry point, `flow.startCustomBot(doc)` at `botHost.js:506`. A companion
   needs `flow.startFleetCompanion(request)` beside it, plus a `record.kind`
   branch through `persistRoster()`, `resume()`, `applySnapshot()` and
   `publicBot()`, and the request persisted and hashed the way a script's
   revision already is. Session minting, the one-hull-one-driver claim, the
   durable roster and the ended-run ring are all behaviour-agnostic and need
   nothing.

   ⚠ **Open, and deliberately not decided:** does a headless companion need a
   launch grant? The existing one exists because a player-composed script can
   call arbitrary risky macros. The companion's surface is fixed at build time,
   which argues for reusing only `maxRuntimeMinutes` — but that fixed surface
   still includes a tag write, a chat send, and yielding the ship to a fleet
   warp. Decide before building it.

2. **A start control**, so live QA has something to click. Smallest viable, not
   the squad launcher.

Two commits the spec listed are **deliberately not done**: lifting the `issue:`
switch out of `makeScriptRunnerDeps`, and exporting the private helpers. Phase 0
issues nothing, so both would be speculative. They land when a behaviour needs
them.

## Decided, so do not re-litigate

- **The companion is a sibling decide-loop, not a bot script.** It is the next
  instance of the `autopilotLoop` / `miningBotLoop` / `missionBotLoop` pattern.
  Nothing touches `MacroID`, `Condition`, `InterruptResponse`, or the editor
  files. Configuration is a typed request, never text.
- **Precedence:** server fleet warp > FC broadcast > chat command > own flee
  rule > own ladder. A bot being fleet-warped does not flee, re-target, or
  answer chat until it lands.
- **Only a fleet commander can tag**, and the server drops a non-commander's
  write *silently while answering ok*. The gate is client-side, off the roster.
  The check is `(job & 2) !== 0 || [1,2,3].includes(role)` — `FLEET_JOB_CREATOR`
  is **2**, not 1; 1 is `FLEET_JOB_SCOUT`; and `job` is a bitmask.
- **The tag alphabet is ours.** No vocabulary exists server-side. Our writer
  picks letters; our reader must rank an unrecognised tag rather than drop it.
- **Squad membership picks the pilots**, and a role is a value on the squad —
  not a reference into an account-scoped script library, because squads
  routinely span accounts.

## Things that will bite you

**The `BotID` union is a tripwire, and that is the feature.** Adding a member
breaks `createShipClaim`'s stopper record, the store's `botStatus` readers, and
the catalogue, all at once. Fill them in; do not widen the types to make the
errors go away.

**`observe(hint)` is not reusable and you will be tempted.** The script runner's
builder gates nearly every read on which macro is active. The companion has no
macro, so every gate reads nothing, and threading a fake macro id through would
couple it to the DSL it exists not to be part of. Reuse the *decoders*
underneath; `makeFleetCompanionDeps` already does.

**The helpers the plan calls reusable are private.** `scriptMacros.ts` is 4,600
lines and exports three things. `fleetMatesOnGrid`, `hostilesInReach`,
`recallBeforeLeaving`, `fightTheWayOut` and `continueHeadingHome` are all
module-local. Exporting them is trivial but it is a commit, and it means
touching the two files the DSL owns.

**`onProgress` is not decoration.** The store's `botStatus` record reads the
loop's status to decide who holds the hull. A loop that stops without reporting
leaves the store believing it still holds the ship, so the next bot's claim
looks like it stopped nothing. This was a real bug, caught by
`companionFlow.test.ts`; the test says so in a comment. Do not weaken it.

**Faked `sleep` starves the event loop.** A `run()` test with an instant `sleep`
never reaches the timer phase, so a `setTimeout`-driven stop never fires and the
test *hangs* rather than fails. End such a run from inside the loop's own await
chain.

**Line endings.** The working copy is CRLF. Normalise after any scripted edit,
or you will commit mixed endings.

## Two things the server does not do

Both were previously asserted in these docs and are now corrected. See the plan
doc for the full write-up.

- **Warp costs no capacitor here.** No reference to capacitor anywhere under
  `space/destiny/`. So a cap floor does not protect an escape; the floor that
  earns its place is `REPAIR_CAP_FLOOR = 0.2`, already shipped, already reused.
- **Recall does not break an NPC's lock.** No target-loss memory, no drone
  cooldown; the AI re-scores by distance every 100-500 ms, and ~40% of profiles
  can relock the relaunched drone on the very next tick. **A requested feature
  cannot be built as described.** The recall still saves a damaged drone; the
  relaunch trigger must be an observable condition, never a timer. Worth
  confirming the operator still wants it on those terms.

## Open questions for the operator

1. The headless launch grant (above).
2. Whether drone recall/redeploy is still wanted given it cannot break lock.
3. Whether to accept browser-only execution instead of extending `botHost` —
   the plan assumes extending it.

## The method that kept paying

Three questions were parked as "needs a live capture". **None did.** Every one
was answerable by reading a local authority:

- the eve.js server at `/d/evet/server/src`, or in the running container via
  `docker exec evejs-server-1 …`
- the decompiled client at
  `/d/eveoffline/ClientCodeGrabber/3396210/`
- the SDE under `/d/evet/_local/sde`

The client settled the broadcast semantics, the chat link format, and what each
broadcast's `itemID` actually means. The server settled the capacitor question
and the NPC AI. Reach for those before scheduling a stopwatch — and note that
this applies to behaviour and timing, not only to constants.
