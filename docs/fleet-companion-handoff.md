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
| Branch commits | `d844988`, `6ca4c49`, `0f2e9ca`, then the decisions and phase 0's completion |
| Working tree | clean |
| Phase 0 | **COMPLETE** — grant derivation, headless runs, and a start control |
| Phase 0b | **COMPLETE** — the supervision gate and the abandonment protocol |
| Everything else | not started; phase 1 is the one to start with |

Gates at the last commit: `tsc` clean, `docker build --target web-build` clean,
full suite 4,899 tests with `ℹ fail 17` — the same 17 locale failures by NAME as
the pre-work baseline, which was 4,860 tests with the same 17.

## What exists

- `web/src/nav/fleetCompanionLoop.ts` — the loop. Types, the typed request, the
  controller, and a ladder with two rungs: the warp yield and the supervision
  gate. Its ORDINARY work still decides `wait` and issues nothing, on purpose —
  every call it can make belongs to the abandonment protocol.
- `web/src/nav/fleetCompanionLoop.test.ts` — 40 tests, the ladder, the
  supervision gate, the abandonment protocol, and the lifecycle.
- `web/src/bots/companionRunPolicy.test.ts` — 28 tests, the risk derivation and
  both codec doors.
- `web/src/app/companionFlow.test.ts` — 8 tests, the flow over a faked BFF:
  preflight, and the exclusion pairs.
- `flow.ts` — `makeFleetCompanionDeps()`, `startFleetCompanion` and the
  pause/resume/stop trio, `fleetCompanionReads`, `stopCompanionController`.
- `botRegistry.ts` — `"companion"` in `BotID`, its requirements, its catalogue
  row.
- The `companion` store slice, its four events, and its reset wiring.

## Phase 0 is COMPLETE, 2026-09-11

| Piece | Where |
| --- | --- |
| The grant's risk derivation, and the codec door for a persisted request | `web/src/bots/companionRunPolicy.ts` |
| Headless runs: `record.kind`, the persisted request, the route branch | `src/botHost.js`, `src/server.js`, `web/src/app/api.ts` |
| The browser start control | `web/src/ui/FleetCompanion.svelte`, wired in `Bots.svelte` |

Gates: `tsc` clean, `docker build --target web-build` clean, whole suite 4860 tests
with `ℹ fail 17` and the failing-NAME set byte-identical to the baseline measured
before the work began. The grant is machinery with no dialog, exactly as decided.

⚠ **The sentinel lives in the shared layer, not the host.** A companion grant's
`scriptRev` is `COMPANION_GRANT_SCRIPT_REV` in `companionRunPolicy.ts`, and the
host reads it off the loaded stack. It was briefly a constant private to
`botHost.js` whose comment told future callers to send "this exact value" — two
copies of a bare `1` in two languages with nothing to fail if one drifted, and a
drift would have surfaced to a player as "this bot changed after its run was
approved" with nothing changed. A fake stack in a test must carry it too.

### Two bugs the work uncovered, both fixed

- **`Bots.svelte` showed the MISSION bot's checklist and status for the
  companion.** `rowsFor` and `statusOf` were two-way ternaries keyed on
  `"mining"`, so the already-registered `"companion"` `BotID` fell through to the
  mission branch. It would have looked, in live QA, like a companion bug.
- **`stop()` and `finalize()` could not stop a companion.** Both called
  `flow.stopCustomBot()` unconditionally, and `stopCustomController`
  (`flow.ts:5678`) reaches the script runner and the shared autopilot but NEVER
  `fleetCompanion` — `stopCompanionController` right beneath it is the real
  switch. So a stopped or time-expired headless companion kept flying while
  `finalize()` logged its bridge session out from under it. Both sites now branch
  on `record.kind`.

⚠ **Both of those are the `BotID`-union tripwire's BLIND SPOT, and it is worth
knowing.** The union breaks a `Record<BotID, …>` and an exhaustive `switch`, which
is why the handoff calls it a feature. It cannot see a two-way ternary, and it
cannot see a call to the wrong same-shaped function. Adding a `BotID` member does
not flush those out; only reading the call sites does.

## Phase 0b is COMPLETE, 2026-09-11

Decision 5, built: a companion does no unsupervised work, checked every tick.

| Piece | Where |
| --- | --- |
| The check — fleet members this host is NOT flying | `supervisorsInFleet`, `fleetCompanionLoop.ts` |
| The protocol — get safe, drop fleet, bounded wait, gated rejoin | `decideAbandonment` / `getSafe`, same file |
| Who this host drives | `AppFlowOptions.botDrivenCharacterIDs`, injected by `App.svelte` and unioned with `/api/bots/active` |
| The persisted 30-minute clock | `CompanionAbandonmentRecord` → the companion slice → `botHost.js`'s roster row |
| Its codec door | `decodeCompanionAbandonmentValue`, `companionRunPolicy.ts` |
| The safe spot | `FleetCompanionRequest.safeSpotBookmarkID`, picked in `FleetCompanion.svelte` |

**The ladder now takes the request and threads memory**:
`decideCompanionAction(request, obs, memory, nowMs)` returns `{action, phase,
why, memory, stop?}`. Later phases add rungs the same way; the memory is pure in
and pure out, and `tick()` stores it BEFORE anything else can return.

### Six things worth knowing

- **The gate SUBTRACTS, it never counts.** Four companions plus an operator is
  still four members after the operator logs off. `supervisorsInFleet` removes
  the host's bots and this pilot, and what is left is the human.
- **`null` and `[]` are different answers and the whole gate rests on it.** `[]`
  is "looked, nobody there" and starts the protocol; `null` is "could not look"
  and FAILS OPEN, because a transient roster failure must not dock a live fleet
  op. What bounds a read that stays broken is `maxRuntimeMinutes`, which is
  still the only thing that ends an unattended run.
- **Nothing on the server can tell a companion's session from a human's.** Both
  are ordinary held bridge sessions; `isCharacterHeld` cannot separate them.
  That is why the driven set is INJECTED. The BFF host's claim map is exact;
  `App.svelte` answers for the tab; `/api/bots/active` is unioned in so a
  browser companion can see the headless ones. A companion on ANOTHER account
  still reads as human — decision 5 accepts that.
- **Safety is confirmed by a READING, never a timer.** "Issued the warp" is not
  "left the grid" — the POST returns before `shipMode` flips — so
  `safeSpotWarpSeen` is set only by a tick that actually observed `inWarp`, and
  rung 1 is the only place that can observe it. Dropping fleet on the issue
  alone would leave the ship in space with no fleet, which is the one ordering
  mistake decision 5 calls out.
- **The persisted clock deliberately does NOT carry the get-safe flags.** They
  describe a warp that is over the moment the process dies; persisting them
  would let a resumed run believe it had already reached safety.
- **An undecodable persisted clock is DROPPED, not fatal.** A fresh thirty
  minutes is still bounded; refusing the start would leave a pilot flying with
  no host to stop it. A clock dated in the FUTURE is refused for the same
  reason — it would never expire.

### What 0b did NOT do, on purpose

- **No fleet-chat announcement before leaving.** It is not in decision 5, and
  `companionRunPolicy.ts`'s header previously justified the unconditional
  "social" class by claiming the rejoin protocol sends chat. It does not; that
  comment is corrected, and the class is now justified forward-looking on phase
  8 instead. Worth asking the operator whether they want the announcement.
- **No drone recall in the get-safe warp.** Nothing in the companion launches a
  drone yet, so there is nothing to abandon — `getSafe` says so in a ⚠, and
  **phase 5 must add one** or that warp starts costing drones.

### What is next

1. **Phase 1** — the broadcast decoders, the store slice with TTL, and the
   `follow-the-fleet` behaviour. The largest single chunk, entirely in-repo, and
   everything interesting depends on it.
2. **The headless launch UI is NOT phase 0's, and was deliberately not built.** A
   per-pilot request is a value on a Pilot Hangar squad, which makes the launch UI
   part of phase 9's squad launcher. The plumbing is finished and waiting:
   `api.startServerCompanion` exists, and the script path it mirrors runs through
   `web/src/bots/startRun.ts` into `BotManagerPilotRow.svelte` — including the
   ordering subtlety that the run must start BEFORE the session is released.
3. The `issue:` switch lift and the private-helper exports are still speculative,
   EXCEPT that 0b needs `continueHeadingHome` to dock. That is the behaviour the
   handoff said would come and claim them.

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

**`onProgress` is not decoration, and 0b gave it a second job.** The store's
`botStatus` record reads the loop's status to decide who holds the hull — AND
the abandonment clock reaches the BFF's durable roster row along the same
channel (`FleetCompanionProgress.abandonment` → the companion slice →
`applySnapshot`). A readout that dropped it would hand the companion a fresh
thirty minutes on every restart. A loop that stops without reporting
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
