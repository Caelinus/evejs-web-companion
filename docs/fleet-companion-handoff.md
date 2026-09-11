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
| Branch commits | phase 0 through `ee5b31b`, then 18 more for phase 1 (see the git log; `git log --oneline ee5b31b..` is the phase 1 set) |
| Working tree | clean |
| Phase 0 | **COMPLETE** — grant derivation, headless runs, and a start control |
| Phase 0b | **COMPLETE** — the supervision gate and the abandonment protocol |
| Phase 1 | **COMPLETE** — broadcasts and target tags, decoded, stored and obeyed |
| Phase 2 | **COMPLETE** — no watch and no macro decides into a warp, on any tank |
| Everything else | not started; phases 3, 4 and 5 are independent and make good filler |

Gates at the last commit: `tsc` clean, `docker build --target web-build` clean,
full suite 4,982 tests with `ℹ fail 17` — the same 17 locale failures by NAME as
the pre-work baseline, which was 4,860 tests with the same 17.

⚠ **JUDGE BY THE NAMES AND BY THE COUNT, not either alone.** Phase 1 broke a
test called "defensive equipment starts with NOTHING ticked" — nothing in that
name matches a grep for companion/fleet/broadcast/tag, so a name filter said
clean while the count had gone 17 → 18. The reverse trap is the known one (a
fresh worktree reports 22 because `public/dist` is absent). Check both.

## What exists

- `web/src/nav/fleetCompanionLoop.ts` — the loop. Types, the typed request, the
  controller, and a ladder with two rungs: the warp yield and the supervision
  gate. Its ORDINARY work still decides `wait` and issues nothing, on purpose —
  every call it can make belongs to the abandonment protocol.
- `web/src/nav/fleetCompanionLoop.test.ts` — 72 tests, the ladder, the
  supervision gate, the abandonment protocol, the fleet-order rung, and the
  lifecycle.
- `web/src/bots/companionRunPolicy.test.ts` — 31 tests, the risk derivation and
  both codec doors.
- `web/src/app/companionFlow.test.ts` — 10 tests, the flow over a faked BFF:
  preflight, the exclusion pairs, and the notification drain.
- `web/src/bridge/fleetBroadcasts.ts` + test — 14 tests. The broadcast and
  target-tag decoders, the 15 names, and what each one's `itemID` means.
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

## Phase 1 is COMPLETE, 2026-09-11

Eighteen commits. The companion hears its fleet and obeys it; so does the older
bot-script DSL.

| Piece | Where |
| --- | --- |
| The decoders, the 15 names, what each `itemID` means, the 30s TTL | `web/src/bridge/fleetBroadcasts.ts` |
| `lastBroadcast` + `targetTags` on the EXISTING fleet slice | `store/types.ts`, `feed.ts`, `clientStore.ts` |
| Dispatch, the `__MultiEvent` unwrap, both observation build sites | `app/flow.ts` |
| Tag ranking, above class and distance | `nav/targetPriority.ts` |
| The companion's fleet-order rung | `decideFleetOrders`, `fleetCompanionLoop.ts` |
| The DSL's three-source resolver | `calledOnGrid`, `nav/scriptMacros.ts` |
| What the fleet is saying, in the panel | `ui/FleetCompanion.svelte` |

### The prerequisite that was not in the spec

⚠ **A HEADLESS COMPANION RECEIVED NO PUSHED NOTIFICATION AT ALL, and phase 1
would have been dead on the bot host without fixing it.**
`applyPushedNotification` had exactly one caller — the SSE branch — and
`botHost.js` hands every headless bot `stubEventSource()`, a channel that is
never live. The BFF already drains notifications onto every response for exactly
this case (`server.js`, above `STREAM_RETRY_MS`); nothing on the client side ever
consumed that drain, so only half the fallback existed.

It went unnoticed because almost every push consumer is an INVALIDATION that
schedules a re-read, so a missed push costs a little freshness. A broadcast has
no re-read to fall back on — there is no "what is the current broadcast" route —
so a push that never arrives is an order lost for good.

### Three findings from the review sweep, all real

- **A gateway blip silently stopped the pilot obeying its commander.** An
  "unavailable" fleet read carries a null `fleetID`, so comparing ids read a
  blip as a fleet switch and wiped the tags. ⚠ **The first fix for this was
  wrong and its test passed anyway:** refusing to clear ON the blip does nothing
  about the blip having already destroyed the id the NEXT read compares against,
  so the recovery wiped them one tick later. The basis is now an explicit
  `authoritativeFleetID` that only an authoritative read may move.
- **The panel rendered a `Target` call as "shoot this".** The companion has no
  weapons rung; answering a `Target` means LOCKING. The loop's own comment
  already warned against that wording and the panel said it anyway.
- **Eight player-facing strings carried em-dashes**, against the plain-ASCII
  rule. ⚠ The existing ASCII test could not have caught them: it renders the
  panel against hand-written fixture stores, so it proves the FIXTURES are clean
  and never sees a `why` the ladder actually produces. There is now a
  source-scanning guard in `fleetCompanionLoop.test.ts`, verified to fail when an
  em-dash is reintroduced.

### Things phase 1 deliberately did NOT do

- **The companion LOCKS a called target; it does not shoot.** No weapons rung,
  no weapon-module field on the request. A locked-and-not-firing pilot is
  correct behaviour, and the live-QA table in the implementation doc now says so.
- **`JumpTo` holds at the gate and never jumps.** `api.jump` needs the gate on
  both sides and the broadcast carries one; the far gate lives only in the
  asynchronously-loaded route graph, which this pure synchronous ladder does not
  carry. Inventing the second id would risk the wrong system.
- **A known gap, recorded not closed:** `TravelTo` hands off to the shared
  autopilot, which runs at its own cadence. Rung 1's warp yield covers transit
  but not the pauses between hops, so a fleet order arriving while the ship sits
  at a gate can issue a call alongside the autopilot's navigation.

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

1. **Phase 3 (tank-up), 4 (keep-at-range / fleet tag / jump-through-fleet) and 5
   (drone recall)** are all independent of each other and of phase 1, and make
   good filler work. **Phase 2 is now COMPLETE** — the companion's warp yield was
   always rung 1, and the DSL half (the guard over every interrupt) landed
   2026-09-11; see its own section below.
2. **Phase 7 needs a roster role/job read**, and two other things are waiting on
   the same read: verifying that a `Target` broadcast came from a commander (see
   the plan doc's note on why a tag outranks one), and `obs.canTag`, which is
   hard-coded `null` today. Build them together rather than the read twice.
3. **The headless launch UI is NOT phase 0's, and was deliberately not built.** A
   per-pilot request is a value on a Pilot Hangar squad, which makes the launch UI
   part of phase 9's squad launcher. The plumbing is finished and waiting:
   `api.startServerCompanion` exists, and the script path it mirrors runs through
   `web/src/bots/startRun.ts` into `BotManagerPilotRow.svelte` — including the
   ordering subtlety that the run must start BEFORE the session is released.
3. The `issue:` switch lift and the private-helper exports are still speculative,
   EXCEPT that 0b needs `continueHeadingHome` to dock. That is the behaviour the
   handoff said would come and claim them.

## Phase 2 is COMPLETE, 2026-09-11

One commit. `decideScriptAction` now waits out a warp instead of deciding
through it.

| Piece | Where |
| --- | --- |
| The guard, and why it sits where it does | top of `decideScriptAction`, `nav/scriptDecide.ts` |
| `SAY.inWarp` | same file |
| The tank-layer table, and five more cases | `nav/scriptDecide.test.ts`, "In warp, nothing is decided" |

Gates: `tsc` clean, `docker build --target web-build` clean, suite 4,982 tests
with `ℹ fail 17` — the same 17 locale failures by NAME as the baseline, which
was 4,976 with the same 17.

**The companion's rung 1 was already built; this is the OTHER half the phase
always was.** The spec called phase 2 "one guard, and it is also a bug fix", and
the bug half was the whole of the remaining work: the macros carry seventeen
copies of `obs.inWarp === true` (the spec said fifteen) and `fireInterrupt`
carried none, so a watch could fire in mid-flight and issue a module, drone or
lock call against a grid the ship had already left. It bites a solo miner with a
repair watch, today, with no fleet anywhere near it.

### Three things worth knowing

- **The bug was demonstrated, not inferred.** Stashing the guard fails four of
  the six new tests, one of them showing a `repair` watch returning
  `{kind: "activate", moduleID: …}` on a tick where `inWarp` is `true`. A guard
  whose tests pass without it is a guard nobody has tested.
- ⚠ **THE TANK LAYER IS THE POINT OF PUTTING IT THAT HIGH.** `repairersFor`
  (`scriptDecide.ts`) is already symmetric across `shieldRepairerIDs`,
  `armorRepairerIDs` and `hullRepairerIDs`, and a ship may tank with any of the
  three. A guard proven against `shield-below` alone would have looked correct
  on every fixture anybody happened to write while leaving the armour-tanked
  hull firing repairer calls into warp. The test is a TABLE over the three
  layers plus `capacitor-below` and `drone-health-below`, and every case asserts
  the watch DOES fire out of warp first — without that half the warp half proves
  nothing at all.
- **It is placed AFTER the `done` check, and the spec said before.** A
  deliberate divergence, commented in place: `done()` issues nothing, so a warp
  cannot make it unsafe, and going first would hold a finished run `"running"`
  for the length of a warp it has no stake in.

### Two corrections to the implementation doc, both found from the code

⚠ **These matter because phase 3 is specced on top of both of them.**

- **"Nothing in the codebase self-reps" is WRONG.** The rung-2 table says
  shield/armour/hull booster cycling is "entirely new" and that capacitor
  awareness is too. The `repair` interrupt response is already a per-layer
  self-repair thermostat: `repairersFor(row.when.kind, obs)` picks the layer's
  own repairers, the response switches one idle module on per tick, the
  capacitor floor switches one OFF below `REPAIR_CAP_FLOOR` even while the layer
  is hurt, and `repairShutdown` is the off-half when the condition recovers.
  **Phase 3 is substantially smaller than its table claims** — the question is
  what the COMPANION reuses, not what has to be written.
- **The cap rule's stated reason is the one already retracted elsewhere.** The
  rung-2 section still says the floor is "can I still afford to warp out". Warp
  costs no capacitor on this server — the handoff's "Two things the server does
  not do" says so and `FleetCompanionRequest.capacitorFloor` carries the full
  write-up. The floor earns its place because an empty capacitor REPAIRS
  nothing, not because it strands the ship.

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
