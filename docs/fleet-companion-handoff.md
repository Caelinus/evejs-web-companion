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

   ⚠ **The launch grant is DECIDED** — see "Answered by the operator" below and
   decision 4 in the plan. Keep the grant struct, derive `riskClasses` from the
   request, no review dialog, cap editable on the start control.

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

## Answered by the operator, 2026-09-10

All three are now decided; the plan doc carries the reasoning as decisions 4 and
5. Recorded here because this file is the one the next session reads first.

1. **The headless launch grant: machinery, no dialog.** Derive `riskClasses` from
   the request, default the cap to `DEFAULT_SERVER_BOT_RUNTIME_MINUTES`, make the
   cap editable on the start control, and show the player nothing to approve. The
   operator's objection was to a consent step and it was right — what the grant is
   actually carrying here is the deadline, which is the only thing that ends an
   unattended run.

2. **Drone recall/redeploy: keep it, relaunch condition-gated.** The recall still
   gets a damaged drone out of danger, which was always the half that worked.
   `droneRedeployHoldOffSeconds` stays a FLOOR on the wait and never the thing
   that makes the relaunch safe; the trigger is another entity holding the rat's
   aggro. Exactly as the request field already documents it.

3. **Extend `botHost`.** Browser-only was rejected: a closed tab dropping the
   squad defeats the feature. The script-shaped fields are concentrated in six
   places — `persistRoster`, `publicBot`, `readRosterRow`, `start()`, `resume()`
   and the single `flow.startCustomBot` call at `botHost.js:506`.

   ⚠ **One divergence to make deliberately.** A script doc is NOT persisted
   (`botHost.js:177`), because the library is the authority and `loadScript` is
   injected at `server.js:85` so a restart re-binds to the exact stored revision.
   A companion request has no library. **The roster row must BE the authority:**
   persist the flat request and hash it, rather than inventing a
   `loadCompanionRequest` injection for a store that does not exist.

**And a fourth thing the operator added, which is now the most important
constraint in the feature:** a companion does no unsupervised work, continuously
and not merely at launch. See decision 5 in the plan — the check is "at least one
fleet member this host is not driving", and failing it runs a dock / drop fleet /
bounded 30-minute wait / invite-gated rejoin protocol. Two things there will
surprise you: a human leaving a two-member fleet leaves the companion in a fleet
of one and **promotes it to boss**, and **the sun cannot be warped to** — there is
no celestial in the scene or in any read, so the safe spot is a bookmark.

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
