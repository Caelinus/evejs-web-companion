# Fleet companion — handover

Where the work stands, what is decided, and what bites. **Self-contained, and
meant to be: a session picking this up needs no handover message, no scratchpad
file and no access to the conversation that produced it.** If something you had
to be told is not in here, put it in here.

**Read in this order.** This file first, for state and for what will bite.
Then [fleet-companion-plan.md](fleet-companion-plan.md) — what and why; note
that **decision 3 was amended 2026-09-11**, so read it rather than remembering
it. Then [fleet-companion-implementation.md](fleet-companion-implementation.md)
— order, branch, and the per-phase specs; ⚠ its phase 8 gateway-patch section is
CANCELLED and marked so at the top, and is a record of an investigation rather
than a plan.

⚠ **Then read `decideCompanionAction`'s own header in
`web/src/nav/fleetCompanionLoop.ts`**, which carries the full seven-rung ladder
and the reasoning behind each placement. Prefer it to any prose here or
anywhere else: every other description of the ladder in this repo has been left
behind by a phase at least once, including this document's own.

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
| Engage + chat | **COMPLETE** — a called target is SHOT, and local-chat commands feed the same rung |
| Phase 3 | **COMPLETE** — tank up: hardeners, per-layer self-rep, the cap inversion, both off-halves |
| Phase 4 | **COMPLETE** — the commander gate, canTag made real, two wrappers, three blocks |
| Phase 7 | **COMPLETE** — tackle → tag: the jam pushes decoded, and a tackled pilot letters what holds it |
| Phase 5 | **COMPLETE** — drones: launch, recall a hurt one, redeploy; and getting safe stops abandoning them |
| Phase 6 | **COMPLETE** — flee and return; the flee sits ABOVE the fleet rung, by the operator's decision |
| Phase 8 | **DONE** — chat commands, on LOCAL chat. The fleet-channel gateway patch is CANCELLED, not pending |
| Phase 9 | squad roles + Bot Manager badge — **IN PROGRESS** on `feat/fleet-companion-phase-9`; role presets and the shared readout are in, the badge and the squad half are not |

Gates at the last commit: `tsc` clean, `docker build --target web-build` clean,
full suite **5,215 tests with `ℹ fail 17`** — the same eight files with the same
per-file counts as the pre-work baseline.

| Gate | Command | Catches |
| --- | --- | --- |
| typecheck | `cd web && npx tsc --noEmit` | the `.ts` surface only |
| **compile** | `docker build --target web-build .` | **the only thing that typechecks `.svelte`** |
| tests | `npm test` | behaviour |

⚠ **`npm test` PASSES ON CODE THAT DOES NOT COMPILE.** `node --test` strips
types without checking them, and `tsc` does not see `.svelte` at all. A phase
that ran only the tests has verified less than it thinks: phase 6 committed a
type error that `node --test` reported 183 passes over, and only `tsc` caught it.
`svelte-check` has ~37 pre-existing errors and is NOT a gate — check only that the
component you touched is clean.

**The baseline is 17 locale failures** (the host formats `12 000`; the assertions
expect `12,000`) across exactly eight files:

| File | Failures |
| --- | --- |
| `test/marketBrowse.test.js` | 4 |
| `web/src/ui/planetsPanel.test.ts` | 3 |
| `web/src/ui/miningPanel.test.ts` | 3 |
| `web/src/ui/missionBotPanel.test.ts` | 2 |
| `web/src/nav/missionBotLoop.test.ts` | 2 |
| `web/src/ui/overviewActions.test.ts` | 1 |
| `web/src/bridge/contracts.test.ts` | 1 |
| `web/src/app/freeSkillPointsFlow.test.ts` | 1 |

⚠ **THERE IS A NINTH FILE, AND IT IS FLAKY RATHER THAN BROKEN.**
`test/eveGatewayStream.test.js` -- "a healthy stream survives the watchdog and
still delivers frames" -- failed once during phase 9 with `reason: 'ping
timeout'`, taking the count to 18 and putting a file outside the eight in the
list. It is a REAL WebSocket server with a wall-clock ping watchdog, so it loses
under load; phase 9 hit it on a run that followed a docker build. It passed 3/3
alone and the very next full run was back to 17 on the same commit. It imports
only `ws` and `src/eveGatewayClient`, so nothing in the companion tree can reach
it. **If you see 18 and the extra one is this file, re-run before you go
looking.** If the extra one is any OTHER file, it is yours.

⚠ **JUDGE BY THE NAMES AND BY THE COUNT, not either alone.** Phase 1 broke a
test called "defensive equipment starts with NOTHING ticked" — nothing in that
name matches a grep for companion/fleet/broadcast/tag, so a name filter said
clean while the count had gone 17 → 18. The reverse trap is the known one (a
fresh worktree reports 22 because `public/dist` is absent). Check both. Comparing
PER-FILE COUNTS, as the table above allows, catches what either alone misses.

## What exists

- `web/src/nav/fleetCompanionLoop.ts` — the loop. Types, the typed request, the
  controller, and the ladder. The rungs as they now stand: 1 warp
  yield, 2 supervision / abandonment, 3 tank up, 4 tackle → tag, 5 flee,
  6 drones, 7 obeying the fleet. ⚠ The flee went ABOVE the fleet rung, not
  beneath it as every earlier draft of this bullet predicted — the operator
  decided that in phase 6. `decideCompanionAction`'s own header now carries the
  full list with the reasoning, so prefer it to this bullet.
- `web/src/nav/fleetCompanionLoop.test.ts` — 196 tests, the ladder, the
  supervision gate, the abandonment protocol, the fleet-order rung, and the
  lifecycle.
- `web/src/bots/companionRunPolicy.test.ts` — 31 tests, the risk derivation and
  both codec doors.
- `web/src/app/companionFlow.test.ts` — 10 tests, the flow over a faked BFF:
  preflight, the exclusion pairs, and the notification drain.
- `web/src/bridge/fleetBroadcasts.ts` + test — 14 tests. The broadcast and
  target-tag decoders, the 15 names, and what each one's `itemID` means.
- `web/src/bridge/jamNotifications.ts` + test — the `OnJamStart` / `OnJamEnd`
  decoders, the tackle allowlist, the standing-jam fold and its read-time
  liveness check (phase 7).
- `web/src/store/spaceJamSlice.test.ts` — the space slice keeps the jams, and a
  snapshot poll does not wipe them.
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

## The companion ENGAGES what it is told to, 2026-09-11

Phase 1 shipped an honest partial: a called target got LOCKED and never shot,
and the live-QA table said a locked-and-not-firing pilot was the pass condition.
The operator read that as the feature being broken, which is the correct reading
of "I told it to shoot and it did not shoot". This closes it, and adds chat as a
second way to give the order.

| Piece | Where |
| --- | --- |
| `weaponModuleIDs` on the request, and its fifth panel picker | `fleetCompanionLoop.ts`, `companionRunPolicy.ts`, `ui/FleetCompanion.svelte` |
| `lockThenEngage` (was `lockOrHold`), `decideOpenFire`, `cyclingWeapons` | `nav/fleetCompanionLoop.ts` |
| `lastFireTargetID` / `lastFireModuleIDs` on the ladder memory | same |
| The chat grammar, the link reader, the sender gate | `nav/chatCommands.ts` + test |
| `resolveNamedOrder` -- one set of branches, two sources | `nav/fleetCompanionLoop.ts` |
| The gated local-chat read, and `liveCompanionRequest` | `app/flow.ts` |

### Decided by the operator, 2026-09-11 -- do not re-litigate

- **A `Target` BROADCAST opens fire**, not only a tag. The alternative on the
  table was to fire only on a tag or a roster-verified commander, because
  `sendBroadcast` checks fleet MEMBERSHIP and nothing else -- any member may
  broadcast `Target`. That risk was put to the operator explicitly and the
  answer was the broadcast. So the fire gate is the same gate as the lock gate,
  and the roster read is NOT a prerequisite for this feature.
- **It shoots whatever is called**, player or rat. No NPC/player distinction,
  no opt-in flag. ⚠ Note this cuts directly across `fightTheRats`'s comment
  that "Players on grid are FRIENDLY in this world" -- that assumption belongs
  to the ratting block and does not hold here.
- **Chat commands ride LOCAL chat.** Fleet chat is unreachable without the
  gateway patch, and the parser is channel-agnostic, so the patch becomes a
  one-line channel swap rather than the thing everything waits on.

### Five things worth knowing

- **Engaging needed no new plumbing.** There is no "fire" action anywhere in
  this codebase: weapons go through the SAME generic
  `{kind: "activate", moduleID, targetID}` with `repeat: -1` that drives miners,
  hardeners and repairers, and `api.activateModule`'s own header says so ("a
  later combat goal drives a turret through the same five unchanged"). The
  companion's `issue` already had that case, wired for remote reps. What was
  missing was a decision, not a route.
- ⚠ **A NEW CALL MUST RE-AIM THE WHOLE RACK, and `activeModuleIDs` cannot tell
  you that.** A snapshot says a module is cycling; it never says what it is
  cycling AT. So a gun still chewing on the target the commander has moved off
  looks identical to one obeying the current call, and an idle-check alone would
  leave the rack shooting the wrong ship forever. `lastFireTargetID` +
  `lastFireModuleIDs` are the memory that knows the target, reset the moment the
  call names a different ship -- the same pair, for the same reason, as
  `lastHealTargetID` / `lastHealModuleIDs` right above them.
- ⚠ **WEAPON BANKS WOULD HAVE STALLED THE WHOLE LADDER.** Activating a banked
  SLAVE fires the bank through its MASTER and `activeModuleIDs` then names only
  the master, so a naive idle-check picks the same slave every tick forever --
  and since this loop issues one call per tick, that slave eats the action slot
  every rung beneath it needs. `cyclingWeapons` counts a slave as running when
  its master is. **The same gap is LIVE in the DSL** (`fightTheRats`,
  `engagePrey`); nothing under `nav/` reads `weaponBanks` at all. It costs them
  less because their tick has nowhere else to be, so it reads as wasted calls
  rather than a stall. Not fixed from here.
- ⚠ **THIS RUNG PARKS THE TICK, and that now matters.** The "already locked"
  branch returns a wait rather than falling through like `decideHealOrder`, so
  while a target call stands every rung BELOW it is starved. Harmless when the
  branch meant "locked, nothing more to do"; load-bearing now that it means
  "locked and shooting". Kept parked for the readout -- a pilot fighting the
  FC's primary should say "Obeying fleet", not "Standing by" with its guns
  running -- but **phase 6 must not put its flee beneath this rung**, and phase
  5's drone recall has the same problem. The planned ladder puts both below.
  That ordering has to be revisited when they are built, not inherited.
- ⚠ **AN OFF-GRID BROADCAST WAS STARVING AN ACTIONABLE CHAT ORDER**, against
  this rung's own header. The header has always said an off-grid call is skipped
  "falling through to the NEXT SOURCE", which was trivially true while the only
  thing under a broadcast was "Standing by". Choosing the broadcast first and
  only THEN finding it unactionable fell through to nothing. `isOrderActionable`
  now runs while the source is being CHOSEN. Caught by a review sweep, not by
  the tests, which all passed.

### One set of branches, two sources

`resolveNamedOrder` picks the source once and branches c-f serve both, rather
than chat getting its own copy of Target/AlignTo/TravelTo/JumpTo. The JumpTo
branch alone is thirty lines of carefully-argued honest partial, and a second
copy is the thing that drifts.

⚠ **The refactor dropped a case, and it is worth knowing how it was caught.**
`step.kind === "closing"` went missing, so a ship already closing on a called
gate fell through to `warp` and re-warped. One test failed -- on WORDING, not on
the re-warp -- and chasing that wording found the missing branch. The four
`decideCloseIn` steps now have a chat-order test that walks all of them.

### What this deliberately did NOT do

- **No stand-down.** Nothing ever issues `deactivate` for a gun -- the DSL does
  not either, and a module stops server-side when its target dies. The
  companion's action vocabulary has no `deactivate` kind at all yet; **phase 3
  adds it**, and that is the phase that should decide whether guns stand down
  too.
- **No roster read.** It was a prerequisite only under the fire-gate the
  operator did not choose. `obs.canTag` is still hard-coded `null` and phase 7
  still needs the read.
- **No weapon range check.** Neither does the DSL: `hostilesInReach` gates the
  LOCK on targeting range, and guns are activated with no distance test at all.
  The server rules on it.

## Phase 3 is COMPLETE, 2026-09-11

Tank up: hardeners on while a fight is on, each layer's own repairer cycled
while that layer is hurt, and both off-halves. It is rung 3 -- ABOVE obeying the
fleet, which is now rung 4.

| Piece | Where |
| --- | --- |
| The rung, the per-layer thermostat, both off-halves | `decideTankUp` / `decideLayerRepairer`, `nav/fleetCompanionLoop.ts` |
| `TANK_LAYER_HURT_THRESHOLD` = 0.75 | same |
| The three self-repair lists, and their panel pickers | `fleetCompanionLoop.ts`, `companionRunPolicy.ts`, `ui/FleetCompanion.svelte` |
| The `deactivate` action, self-targeted `activate`, the exhaustiveness guard | `FleetCompanionAction`, `app/flow.ts` |
| `lastTankUpModuleIDs` -- what this rung is holding ON | `CompanionLadderMemory` |

**It was a PORT, and the spec said so.** The `repair` interrupt response was
already a per-layer self-repair thermostat with a capacitor floor; the work was
carrying it into a loop that cannot reach it. The three things that genuinely
blocked that are now gone: the companion had no `deactivate` action at all, its
`activate` case could not self-target, and it had no module lists to cycle.

### Why the tank goes up before the guns

The DSL's fight-back branch already said it: "THE TANK GOES UP FIRST. A hardener
is instant and self-targeted ... the same thing a player reaches for before they
reach for the guns." So this rung sits above the fleet-order rung. It costs at
most a tick or two of not obeying, because it only has something to do while a
module is off and falls through the moment the rack is up.

### Four things worth knowing

- ⚠ **THE CAPACITOR FLOOR INVERTS THE RUNG, and its REASON is not the obvious
  one.** Below `request.capacitorFloor` a RUNNING repairer switches off, even
  though the layer is still hurt. The floor is not "can this ship still warp" --
  warp costs no capacitor on this server -- it is that an empty capacitor
  repairs nothing, so a repairer cycling below the floor spends capacity that
  heals nobody. `capacitorFloor` existed since phase 0b and this rung is its
  first consumer; no second constant was invented.
- ⚠ **THE RECOVERED OFF-HALF WAS MISSING FROM THE SPEC, and the rung is wrong
  without it.** The spec listed a four-step ladder and step "layer heals back up
  mid-fight, switch its repairer off" was not one of them; the implementer built
  what was specified and flagged the omission rather than quietly widening
  scope. It matters because without it the ONLY way this rung ever stops
  repairing is by hitting the capacitor floor -- and the floor is the safety
  net, not the normal off-switch. A rung that only stops by hitting it has
  arranged to spend every fight at the one capacitor level the floor exists to
  keep the ship away from. The DSL has `repairShutdown` for exactly this.
- **One threshold serves both directions**, exactly as a `shield-below` watch
  and its `repairShutdown` share one. A layer sitting right on the line can
  chatter. That was chosen over a second hysteresis number tuned by nobody.
- ⚠ **HARDENERS ARE NOT CAP-GATED, and the old rung-2 table said to gate them.**
  That advice existed because the DSL's fit classifier cannot tell a free Damage
  Control from a cap-hungry active hardener -- one regex, `/hardener|damage
  control|resistance/i`, for both. This rung reads the OPERATOR'S OWN PICK, so
  there is nothing to be unsure about, and delaying a free cycle for a floor
  that protects repair throughput is a cost with no matching benefit.

### The tripwire that was not there

⚠ **ADDING AN ACTION KIND DID NOT BREAK THE BUILD.** The companion's `issue:`
switch had no `default:` and no `never` check, so `deactivate` landed, compiled
clean, and would have been a silent no-op at runtime -- on a loop that flies an
unattended ship. There is now an exhaustiveness guard, copied from
`scriptCodec.ts`'s existing idiom and confirmed to bite by deleting the case and
watching `tsc` fail. The DSL's own switch already had equivalent coverage
(`unhandledScriptAction`); the companion's was the only one missing it.

### Stand-down rules

- **Only what this rung lit**, one module per tick, and only while it is still
  seen cycling. `lastTankUpModuleIDs` is a statement of what the rung is holding
  ON right now, not a log -- a module switched off for either reason leaves it.
- ⚠ **NEVER ON A BLIND READ.** `hostileOnGrid === false` stands down;
  `hostileOnGrid === null` keeps the tank UP. `standDownAfterFight` says why:
  "standing down blind is the worst possible moment to drop the tank."

### How the tests were made to earn their keep

The rung's 19 tests were mutation-checked: the source was copied, each of the
four sharp behaviours (the cap-floor inversion, the recovered off-half, the
blind-read guard, and the rung ORDER against the fleet-order rung) was neutered
in turn on the copy, and each test was confirmed to fail for the right reason
and pass unmutated. Worth repeating for any rung whose whole value is that it
does the counter-intuitive thing.

## Phase 4 is COMPLETE, 2026-09-11

The commander gate, two `api.ts` wrappers, and three new bot-script blocks.

| Piece | Where |
| --- | --- |
| The commander gate, three-state | `web/src/bridge/fleetCommand.ts` + test |
| `canTag`, for the companion AND the DSL | `makeFleetCompanionDeps` / `makeScriptRunnerDeps`, `app/flow.ts` |
| `setFleetTargetTag`, `jumpThroughFleet` | `app/api.ts` + `beyonceWriteApi.test.ts` |
| `orbit-fleet-mate`, `follow-fleet-mate`, `fleet-tag-target` | `nav/scriptMacros.ts` and the checklist below |

### `canTag` was a pipe with nothing in it

Every consumer was already built and honest: the observation field, the ladder
memory, the progress event, the store slice, and a panel badge that renders
"not known" / "yes" / "no - not a fleet commander". It had shown **"not known"
to every player since phase 0b** because the source was a literal `null`. Phase
4 did not build that readout; it filled it.

It is answered from the roster read the loop ALREADY makes every tick -- the
decoded snapshot is now held past its try/catch rather than a second HTTP call
being made to ask about rows the first read already contains.

### Why the gate is client-side, and why that is not a preference

`setFleetTargetTag` (`fleetRuntime.js:1310-1326`) returns a bare `false` for a
non-commander, and its ONLY caller (`beyonceService.js:3320`) **discards that
boolean and returns null unconditionally**. So `{ok: true, applied: true}` comes
back whether the tag landed or was silently dropped. There is no answer to read.
The roster is the only place the truth exists.

⚠ **THE CONSTANTS ARE A TRAP AND A PREVIOUS DRAFT FELL IN TWICE.**
`FLEET_JOB_SCOUT` is `1`, `FLEET_ROLE_LEADER` is ALSO `1`, and
`FLEET_JOB_CREATOR` is `2` -- two unrelated enums on two unrelated fields that
both start at 1. `job` is a BITMASK tested with `&`; `role` is a hierarchy seat
tested against a set. Get it wrong and scouts gain tagging while the fleet
CREATOR loses it -- and because the refusal is silent, **that bug can never
surface from the client**. Verified against `fleetConstants.js:1-9`.

⚠ **THREE-STATE, AND ONLY `false` MAY BE REMEMBERED.** `null` is "could not
look", `false` is "looked, and no". Both mean do not write. A caller that
collapses this to a boolean and caches it freezes a transient roster outage into
a permanent "not a commander" -- which is the exact bug class the gate exists to
prevent. The flow tests pin it: a mutant using `!!canTagInFleet(...)` fails the
roster-unreadable test and nothing else.

### The build-breaker checklist, CORRECTED

Adding a `MacroID` breaks all of these (the doc's older list was wrong twice):

1. `bots/botScript.ts` -- the `MacroID` union **and** `MACRO_IDS`
2. `bots/macroSpecs.ts` -- `MACRO_SPECS`
3. `bots/editorOptions.ts` -- `MACRO_ARG_DESCRIPTORS`
4. `bots/runPolicy.ts` -- `MACRO_RUN_POLICY`
5. `bots/macroCatalogView.ts` -- `ENTRIES` (what the palette renders)
6. `bots/scriptText.ts` -- `macroName` AND `macroPhrase`, two switches
7. `nav/scriptMacros.ts` -- the decider and `SCRIPT_MACROS`
8. `bots/editorDoc.ts` `newStepFor` -- not enforced, but `editorDoc.test.ts` has
   a golden fixture that catches it

⚠ **`MACRO_IDS` IS HAND-MAINTAINED, NOT DERIVED FROM THE TYPE.** It is the only
entry above that the COMPILER DOES NOT ENFORCE. Miss it and the build stays
green while the block vanishes from the palette and from every test that
iterates the list.

⚠ **`validateScript.ts` needs NO edit.** The older doc lists it. It only reads
`MACRO_SPECS[step.macro]`, so it is downstream of item 2 -- listing it sends
somebody editing a file that does not need editing.

⚠ **ADDING A `ScriptAction` KIND IS A SEPARATE LIST, and it was missing
entirely.** Found during this phase: `nav/botLog.ts`'s `describeAction` is a
second exhaustive switch with no default (the flight recorder), with its own
golden fixture `EVERY_ACTION` in `botLog.test.ts`. `tsc` catches the switch; the
fixture catches the entry. Both must be updated alongside the DSL runner's
`issue:` case in `flow.ts`.

### What the tag block honestly is

⚠ **SINGLE-LETTER, SINGLE-PILOT.** Nothing can tell whether the FC or another
companion already lettered a ship, so the only thing preventing a re-tag is
memory of this block's OWN writes. It is safe only when exactly one pilot in a
squad runs it, and the catalogue entry says so in plain language. Do not call it
smart tagging anywhere a player reads.

It tags `"1"`, the top-ranked stock tag by `targetPriority.ts`'s own ordering
(digits outrank letters because a digit reads as an ordinal kill order). It
confirms by **seeing the tag in the next tick's `targetTags`**, never by the
write's ack, and gives up after `MAX_FLEET_TAG_ATTEMPTS` rather than re-sending
forever. Its three states: `null` waits, `false` SKIPS (never blocks -- a
rank-and-file pilot keeps fighting and looting, it just never fires the write),
`true` proceeds.

### Deviations the implementer flagged rather than hid

- `orbit-fleet-mate` / `follow-fleet-mate` are pure escorts and carry NO
  remote-repairer requirement, unlike the logistics-specific `orbit-and-boost`
  they borrow their shape from. A general-purpose block was judged more useful
  than a second logi block.
- `fleet-tag-target` ranks over the NPC hostile pool (`hostileRows`), the same
  pool `fight-the-rats` uses. No PvP-player pool is wired in, because none
  exists to reuse.
- `FLEET_MATE_ESCORT_RANGE_M = 2000` is a NEW constant rather than a reuse of
  `ORBIT_BOOST_RANGE_M`, which holds the same value for a different reason.

## Phase 7 is COMPLETE, 2026-09-11

**Tackle → tag.** A pilot that is scrambled or disrupted letters the ship
holding it, so the whole fleet can call the thing that is pinning them.
`attemptsTagging` stops being dead config — it shipped with a panel checkbox and
no reader anywhere, exactly as `chatCommandSenders` did before the chat work.

Five commits: the decoder, the store slice, the push wire-up, the observation,
the rung.

### The read the phase was gated on, and where it actually was

The spec table had phase 7 as "unblocked: the tackle read exists". What it did
NOT say is that the read was not built: nothing in the repo had ever decoded a
jam. The build was therefore a small phase-1 in shape — decoder, slice, push,
observation — with the rung on top.

- **`OnJamStart` / `OnJamEnd` go to the VICTIM'S OWN SESSION**
  (`space/runtime.js:13127`, reached only through
  `notifyHostileHudStateToSession(targetSession, …)`). So the aggressor NAMES
  ITSELF on this ship's own wire. Nothing in a space snapshot carries it; an
  earlier pass looked only at `space.ts`, found nothing, and concluded wrongly
  that only the reactive warp refusal existed.
- Wire: `OnJamStart` is `[sourceBallID, moduleID, targetBallID, jammingType,
  fileTime, durationMs]`; `OnJamEnd` is the same first four and no more.
- **It already reaches the browser.** The gateway's notification stub suppresses
  exactly one method, `DoDestinyUpdate`
  (`evejsWebGatewayRuntime.js:4031,4357`). No BFF route, no gateway patch —
  unlike phase 8, this one is entirely in-repo.
- `args[4]` is a SERVER FILETIME, not a client clock. Nothing reads it; a jam is
  stamped with the moment the browser received it, so every freshness answer in
  this client still comes from one clock.

### Six things worth knowing

- **THE RUNG SITS ABOVE OBEYING THE FLEET, and that is the whole reason it
  works.** `decideFleetOrders` PARKS the tick once a called target is locked, so
  everything beneath it is starved while a primary stands — and a standing FC
  primary is exactly the situation a fleet fight is in while this pilot is being
  scrambled. The fleet-order rung is therefore renumbered **4 → 5** throughout,
  comments and test headings included; tackle → tag is the new rung 4. The cost
  of the placement is bounded: at most three writes per tackler, then it falls
  through for good.
- **It never returns a `wait`.** Every other rung has branches that park to keep
  the readout honest. This one has none, because a rung that parks starves the
  ladder beneath it. "Nothing to tag" and "cannot tag" both read as falling
  through.
- **It returns its memory even on a tick that decides nothing** — the shape
  `decideTankUp` already has. Giving up on a ship happens on a tick that issues
  NO action, so a signature that dropped the memory on `null` could never record
  the give-up and the rung would re-pick the same unconfirmable ship for ever.
  Give-up is remembered **per ship**, capped: a single "stop tagging" flag works
  right up until a second tackler arrives.
- **⚠ CANDIDATES ARE RESOLVED AGAINST `snapshot.entities`, NOT `hostileRows` —
  and the spec said `hostileRows`.** Its point (this pilot's own LOCK RANGE must
  not suppress a tag a ship further out could use) stands and is honoured. But
  `hostileRows` filters on `isHostile`, and `isHostile` is `entity.isNpc &&
  npcEntityType !== "concord"` — it answers NPC-or-not, so **every PLAYER
  tackler fails it**. Filtering through it would have silently dropped exactly
  the case this feature exists for, a fleet fight against players, with no error
  anywhere. A ship running a scrambler on you has classified itself. Ranking is
  still `pickPrimary`'s, so a host that populates `targetGroupNames` gets class
  priority and one that does not collapses to nearest-first.
  ⚠ **This is the same trap phase 4's `fleet-tag-target` block is still in** —
  see "Deviations the implementer flagged rather than hid": that block ranks
  over `hostileRows` and so cannot tag a player either. Deliberately left alone
  here; a DSL block quietly changing which ships it will tag is its own change.
- **Letters, never digits.** The stock menu offers `0-9` AND `ABCDEFGHIJXYZ`
  (`menusvc.py:1945-1946`). The DSL's `fleet-tag-target` writes `"1"`; keeping
  this rung on letters means a squad running both never fights over one tag —
  which matters, because `setFleetTargetTag` DELETES any other item holding the
  same letter before it sets one (`fleetRuntime.js:1343`). The first FREE letter
  is used, compared case-insensitively: the server normalizes a tag by TRIMMING
  it and nothing else, so writing `"A"` over somebody's `"a"` would steal their
  ship.
- **No tag dict, no write.** `fleetTargetTags` being `null` means the client
  cannot tell which letters are free, and guessing would steal the FC's own
  mark. An EMPTY map is a real answer and DOES write. This is the caller the
  null-versus-empty contract in `fleetBroadcasts.ts` was written for, and it is
  now exercised both ways.

### Where the jams live, and why

On the **space** slice, not the fleet one: they describe what is happening to
this ship on this grid, and `space/cleared` — which fires on a dock — is exactly
the right moment to drop them, because a docked ship is not being scrambled by
anything.

⚠ **They are CARRIED FORWARD across `space/snapshot`, and not for the reason
`gateLinks` is.** Jams arrive as pushes on their own schedule while the snapshot
poll runs about once a second. Rebuilding them from the snapshot event would
wipe a live scram every poll and leave the rung looking at an empty set on most
ticks. There is a test for exactly that.

Nothing expires in the slice. It keeps what the wire said; `isJamLive` answers
when a reader asks — the same split `lastBroadcast` and `isFleetBroadcastFresh`
already make. The client-side expiry is only a safety net for a LOST push:
`OnJamEnd` is authoritative and prompt (the destiny tick's own expiry sweep
sends it), and every cycle of a running module re-sends `OnJamStart` with a
fresh duration, which is why the grace exists at all.

**Every jam type is kept on the slice** — webs, paints, damps, neuts. Narrowing
to the two tackle types (`warpScramblerMWD` = scram, `warpScrambler` =
disruptor, and yes they read backwards from how a player says them) is a
READ-time job, so a later reader that wants to know it is being neuted does not
have to re-plumb the wire. The narrowing is an **allowlist**: a blacklist would
silently start lettering ships the fleet is not pinned by the day a new ewar
type shipped.

### What phase 7 deliberately did NOT do

- **No untagging.** Nothing ever removes a letter — not when the tackler dies,
  not when it lets go. A tag is fleet state and the FC owns it; a companion that
  tidied up would be deleting a human's marks.
- **No re-tagging.** A ship already in `targetTags` is left alone, whatever
  letter it holds. That is what keeps the fleet's letters stable.
- **The panel says nothing new.** `attemptsTagging` already had its checkbox;
  the readout gets the phase "Tagging" and its sentence, and nothing else was
  added.
- **`fleet-tag-target`, the DSL block, is untouched** — including its
  `hostileRows` limitation above.

## Phase 5 is COMPLETE, 2026-09-11

**Drone recall and redeploy**, plus the parking fix the operator asked for
alongside it. Six commits.

`useDrones` and `droneRedeployHoldOffSeconds` stop being dead config. Before
this, `useDrones` had exactly one reader in the whole repo — the risk classifier
that labels a run before it launches — and `droneRedeployHoldOffSeconds` had
none at all. `dronesOut` was computed for the companion on every tick and read
by no rung.

### The parking fix — DECIDED BY THE OPERATOR, do not re-litigate

The fleet-order rung's "already locked" branch returned an ordinary `wait`,
which ENDED the ladder: while a target call stood, every rung beneath it was
starved. The operator's instruction was "put the rung above the fleet rung and
fix the parking", so both were done.

The branch now returns a decision MARKED `standing`. `decideCompanionAction`
holds it aside, runs every rung beneath it, and falls back to it only if none of
them acted — so the readout still says "Obeying fleet" while the guns run, which
is the reason it was parked in the first place and was worth keeping.

⚠ **A standing decision's action must be `wait`.** It is only ever a readout;
holding a real call aside and then not issuing it would silently drop it. There
is a test.

⚠ **The fix is preparation and the tests say so.** Nothing sits beneath the
fleet rung yet — the drone rung went ABOVE it, per the same instruction — so what
is proved here is the mechanism. **Phase 6's flee is the first real beneficiary,
and the test that matters ("a pilot obeying a standing target call still flees
when it drops through its floor") can only be written once that rung exists.**

### ⚠ Two things the docs had WRONG about recall, both settled from the server

- **The plan doc said "a recalled drone leaves the scene immediately
  (`droneRuntime.js:4305`)". It does not.** That line is inside
  `recallDronesToShipBay`, which is the COMMIT — reached only once the drone has
  flown to within 2500 m of the ship. `CmdReturnBay` just sets it moving at full
  speed. `api.ts`'s own comment was the correct one all along: they stay visibly
  "coming home" for the length of the trip. **Gone-from-the-grid is therefore a
  reliable confirmation that the recall committed**, and the rung uses it.
- **The spec said "a recall can merge into an existing stack and the original
  ids may never resurface". It cannot.** `buildDroneRecoveryItemPatch` forces
  `singleton: 1, quantity: 1`, so a recalled drone is always its own row and
  keeps its itemID. The only id churn is on the FIRST launch out of a genuine
  multi-quantity stack, which mints a new one. Relaunching from the current bay
  listing is still right — but for simplicity and because a drone may have died,
  not because ids move.

### ⚠ What a recall actually buys on this server, which nobody had written down

**A free, full shield repair.** `buildDroneRecoveryItemPatch`
(`droneRuntime.js:4060`) stamps `charge: 1, shieldCharge: 1` onto the item as it
enters the bay, with the server's own comment: shields and capacitor recharge on
their own, and **only armour and hull damage survives being stowed**.

So a drone pulled while it is still losing shields comes back whole; one chewed
into armour comes back with full shields and the same armour hole. That is the
real justification for the feature, and it is a different one from the original
ask.

It is **not** a lock-break — the plan doc is right that this server has no
target-loss memory and no drone cooldown, and nothing here should be described
to a player as shaking anything off. `droneHealthFloor` defaults to 0.5 of the
worst layer precisely because in a fight that layer is the shield, and a recall
at a half shield gives everything back where waiting for armour damage does not.

### Five things worth knowing

- **The trigger extinguishes itself, so the rung is driven by a RECORD.** The
  instant the recall lands the drones are not in space, `lowestDroneHealth` reads
  `null`, and the condition that fired is no longer true. A rung that re-derived
  its state each tick would fire once and forget it was ever in a cycle. This is
  `standDownAfterFight`'s shape, for the reason its own header gives.
- **Holding off issues nothing and returns nothing**, so the rungs below keep
  their turn. A pilot that went quiet for ten seconds every time a drone got shot
  would be worse than one with no drones at all. Tested.
- **Drones are watched PER RECORDED ID**, never off the coarse `dronesOut` flag:
  this ship may launch others mid-cycle, and a flag would call the recall
  finished the moment one unrelated drone came home.
- **`myDroneIDs` is `canMyShipOrderDrone === true`, never `isMyDrone`.** An
  ABANDONED drone still belongs to this character and still shows on grid, but no
  hull controls it — a recall aimed at one answers 200 and the drone does not
  move, observed live. Counting it would make the rung wait for a recall that can
  never land.
- **The bay read is gated on `useDrones`**, with the same three tests the chat
  read has, including the stale-capture pair. It is a whole extra round trip per
  tick and the snapshot already carries everything else for free.

### Two bounds, both for failures the server does not report

- **A recall that never completes is given up on after 15 ticks.** A drone that
  reaches scoop range to find a FULL BAY is refused by `recallDronesToShipBay`,
  and the tick-driven path throws that refusal away (`droneRuntime.js:7570`) —
  nothing reaches the client. The drone circles at 2500 m for ever, still on
  grid, with no error anywhere. Re-issuing cannot fix a bay with no room in it.
- **Three cycles per run.** Armour damage survives a recall, so once the damage
  is in armour every later cycle returns the same hurt drone, re-trips the floor
  at once, and spends two calls and a hold-off achieving nothing.

The hold-off is counted in TICKS, not against a wall clock: the loop sleeps at
least its cadence, so N ticks is always a lower bound on elapsed time, and
undershooting is the only failure mode that matters for a hold-off.

### Getting safe no longer gives the drones away

The gap `getSafe` has carried a comment about since phase 0b is closed, and it
was worse than the comment said.

⚠ **`handleControllerLost` (`droneRuntime.js:5735`) only attempts a bay recovery
when the lifecycle reason is a disconnect or a logoff.** A normal warp, jump or
dock passes neither, so the recovery branch is skipped outright however close the
drones are. `abandonDroneInSpace` then leaves them in space with `controllerID`
cleared, and `scoopDrone` checks only that a drone is uncontrolled — **not who
owns it**. So leaving without a recall hands this pilot's drones to whoever is
still on the grid.

Bounded at eight ticks and then the pilot leaves regardless — shorter than rung
5's own wait, because that one is a pilot spending time on its drones during a
fight it is still in, and this one is a pilot with nobody left to fly with.
Drones are worth a few seconds and are not worth the ship.

Only the two WARP branches are gated; docking and approaching are not departures.

### What phase 5 deliberately did NOT do

- **No `engageDrones`.** Launched drones auto-engage whatever shoots the ship
  they came from — the server's own behaviour, on by default, and `api.ts` says
  so. Picking a victim is a separate decision and no rung asked for it.
- **No scoop call.** The server flies them home and scoops them itself inside
  2500 m; a scoop would only duplicate what it is already doing.
- **No salvage or mining drone roles.** The DSL splits drones by role; the
  companion launches the bay and lets the server sort it out.
- **Nothing reads `dronesOut` even now.** `myDroneIDs` supersedes it for this
  loop — it answers the same question and names the drones — and the coarse flag
  was left alone rather than removed, because the DSL still reads it.

## Phase 6 is COMPLETE, 2026-09-11

Flee and return. `fleeHealthFloor`, `maxFleeAttempts` and a new
`repairsAtStation` all stop being dead config; the ladder gains rung 5 and the
numbering moves drones to 6 and obeying the fleet to 7.

### The decision the operator made, and what it cost

The written precedence and `decideFleetOrders`'s own header contradicted each
other about whether a target call outranks a pilot's own flee. **Put to the
operator before anything was built; they chose the flee.** Decision 3 in the
plan doc is amended, not left standing.

⚠ **Only one of the two acceptance tests discriminates, and this was found by
moving the rung rather than by reasoning.** With the flee beneath the fleet rung,
"a pilot obeying a *standing* target call still flees" still passes — phase 5's
parking fix already covers it. The case that fails is **a pilot mid-lock on a
fresh primary**: the fleet rung has a real `lock` to issue, a real call wins
outright, and the hurt pilot locks instead of leaving.

⚠ **So the standing mechanism now has no behavioural consumer.** It was built in
phase 5 so a flee could sit below the fleet rung; the flee went above instead.
Keep it: the readout it protects is still correct -- a pilot whose guns are
running must not report "Standing by".

⚠ **AND NOTHING IS EVER LIKELY TO SIT THERE NOW.** That sentence used to name
phase 8's chat rung as the next candidate. There is no such rung: chat commands
feed the fleet rung itself, and the operator has closed the fleet-chat channel
work for good (see "Fleet chat is not happening" below). Phase 9 is roles and a
badge, not a rung. So the hold-aside half of the mechanism has no consumer and
probably never will -- but the fallback readout at the end of the ladder is live
on every standing tick, which is why this is a note and not a deletion.

### Two prerequisites that were not in the spec

**The tank-up rung spun forever on an unreadable module map.**
`activeModuleIDs` has three states and rung 3 read it with `?? []`, so a read
that COULD NOT ANSWER looked identical to an idle rack. Step 1's search consults
only that set, never the record of what it already lit, so it re-picked the same
hardener every tick and grew `lastTankUpModuleIDs` without bound. The cost is not
the wasted call — a rung that returns a decision every tick **starves every rung
beneath it**, and a partial snapshot is likeliest during a fight. A flee rung
underneath that is not a flee rung. Fixed first, with the unknown case falling
back to what the rung knows it lit; three of its four tests fail against the old
read.

**flow.ts's rung comments were two renumbers behind** — the drone reads called
themselves rung 6, and obeying the fleet called itself rung 3 in three places.
Corrected to today's truth BEFORE the phase-6 shift, because a shift applied on
top of a stale number is wrong twice rather than merely out of date.

### ⚠ Docking is not a repair, and that is the shape of the whole phase

`topOffShipShieldAndCapacitorForDockingTransition`
(`/d/evet/server/src/space/transitions.js:242`) writes `charge: 1.0` and
`shieldCharge: 1.0` and leaves `damage` and `armorDamage` exactly as they were.
Confirmed by reading it, not assumed.

So a **shield** flee is whole the moment it arrives, and an **armour** flee never
will be without paying the station. That is why `repairsAtStation` exists: the
alternative was a pilot that docks once and sits there for the rest of the run.

**The operator was asked about this too, because it spends their ISK.** They
chose an opt-in field, default off. It earns `financial` and `inventory` in the
risk derivation, matching what the DSL's own `repair-ship` and `dock-and-repair`
already claim rather than arguing the question twice.

⚠ **A free full repair exists that nothing here uses.**
`repairEntityOnTetherEngage` (`space/runtime.js:11885`) sets
`damage: 0, armorDamage: 0, shieldCharge: 1, charge: 1` on tethering to a
friendly Upwell structure — server-automatic, no client call, no ISK. The
companion cannot deliberately pick a tether, so nothing is built against it, but
it explains a hurt ship coming back whole and nobody had written it down.

### Five things worth knowing

- **The safety ladder is now shared.** `getSafe` became `runToSafety` over a
  `SafetyLeg` seam; rung 2 and rung 5 fly identical code and differ only in
  their phase string and one sentence fragment. The one branch that genuinely
  differs — NOWHERE TO GO — returns null and is answered by each caller. Rung 2
  stops the run (decision 5). Rung 5 falls through and fights on: a hurt pilot
  still has guns, and stopping would take a shooting ship away from a fleet that
  still has a use for it.
- **Coming back needs MORE than the floor that sent it away.** Without a margin a
  return is a commute — back at exactly the trigger number, the next tick reads
  the same number and leaves again, so one fight eats the whole budget without a
  shot fired. `FLEE_RETURN_MARGIN` is 0.2, capped at 1. Six tests fail if it is
  removed.
- **"A return that holds resets the budget"** is made checkable by counting quiet
  ticks (`fleeRecoveryTicks`, 15 of them), and the reset demands the same harder
  threshold — a pilot limping just above its floor has not recovered from
  anything. The half that makes the bound mean something is tested too: a pilot
  sent home repeatedly never reaches the reset and eventually stays home.
- **The latch is run-local, not persisted**, unlike `CompanionAbandonment`. That
  one keeps a thirty-minute clock somebody waits on. This one keeps no clock: a
  companion that comes back up reads its own health on the first tick and leaves
  again within one tick if it still needs to.
- **Option A, "remember the grid", is a SYSTEM and not a spot.** Nothing flies
  the pilot back to the exact place it left. That is not laziness: there is no
  read anywhere that says whether a grid is clear — confirmed absent from the
  server, the BFF and this repo — so a precise return would be no safer, only
  more code. The attempt budget is what bounds the blindness.

### The trap that nearly shipped

**The first draft of the acceptance tests was vacuous.** `fleeObs`'s default grid
carries a station and nothing else, so the called ship was off-grid, the fleet
rung fell through of its own accord, and the tests passed with the flee rung
moved to the wrong place. Caught by mutation, not by review. The grid now carries
both the station and the called ship, and a healthy-pilot control proves the
fleet rung still works on it.

⚠ **Mutation-test every ordering claim in this file.** A test that asserts a
phase name will happily pass because the rung it was meant to outrank never ran.

### What phase 6 deliberately did NOT do

- **No bookmark written at the moment of leaving.** The spec's own correction
  notes `beyonce.BookmarkLocation` is reachable, so this is a missing wrapper and
  not missing plumbing — but option A was chosen and a return point is a feature
  rather than a step.
- **No "is the grid clear" read**, because none exists. `hostileOnGrid` counts
  NPCs only (`overview.ts:244`) and is scoped to the grid the ship is already on,
  so a hostile *player* is invisible to it and a docked pilot has no read at all.
- **No repair of anything but what the shop's quote names.** No guess at a ship
  item id, ever.

### Two pre-existing gaps found while reading, NOT fixed here

Both are fields the companion's `observe()` never populates, so the type promises
something the runtime does not deliver:

- **`targetedByPlayer`** — rung 3's fight test reads
  `obs.hostileOnGrid === true || obs.targetedByPlayer === true`, and the second
  half is dead for a companion. A test passes it by hand, which is why the
  divergence is invisible.
- **`targetGroupNames`** — rung 4 reads it and silently degrades to nearest-first.

Neither is in phase 6's scope. Both are worth a look before phase 9 claims the
ladder is finished.

## Fleet chat is not happening -- DECIDED BY THE OPERATOR, 2026-09-11

**We do not modify upstream, and we work with what we have.** The `/d/evet`
gateway patch that would have published fleet chat to a browser session is
CANCELLED, along with the upstream PR the implementation doc proposed alongside
it. Do not re-open it, do not "just add the room to `roomNamesForEntry`", and do
not treat the procedure still written in the implementation doc as a plan -- it
is kept only as a record of what was investigated.

**Phase 8 is therefore FINISHED AS SHIPPED, not blocked.** Its parser was always
channel-agnostic and its commands ride LOCAL chat, which works today. The
gateway patch was the only outstanding item, so closing it closes the phase.

**What that costs, stated plainly so nobody rediscovers it as a bug:** an
operator's chat commands go out on Local, where everyone in the system can read
them. That is the accepted trade, not an oversight.

**Phase 9 is unblocked** -- it was waiting on 8 and has nothing left to wait for.

## Decided, so do not re-litigate

- **The companion is a sibling decide-loop, not a bot script.** It is the next
  instance of the `autopilotLoop` / `miningBotLoop` / `missionBotLoop` pattern.
  Nothing touches `MacroID`, `Condition`, `InterruptResponse`, or the editor
  files. Configuration is a typed request, never text.
- **Precedence, AMENDED 2026-09-11:** server fleet warp > own flee rule > FC
  broadcast > chat command > own ladder. A bot being fleet-warped does not flee,
  re-target, or answer chat until it lands -- that half was never in dispute.
  What changed is the flee, which the operator moved ABOVE the FC broadcast when
  phase 6 was built; see decision 3 in the plan doc for the old order, why it
  could not stand, and which of the two acceptance tests actually proves it.
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

**⚠ MUTATION-TEST EVERY ORDERING CLAIM, and do not trust one that merely
passes.** This is the sharpest lesson of phase 6. Its first acceptance tests for
where the flee rung sits were **vacuous**: the grid helper carried a station and
nothing else, so the called ship was off-grid, `bestTaggedEntity` found nothing,
the fleet rung fell through of its own accord — and every test passed with the
flee rung moved to the wrong place. A test that asserts a phase name will happily
pass because the rung it was meant to outrank never ran at all. **Move the rung,
watch the test fail by name, move it back.** The same applies to any guard: the
ASCII guard and the tank-up three-state fix were both confirmed this way, and the
return margin turned out to be load-bearing for six tests rather than the two its
author expected.

**A test that passes both ways is worth keeping, but say so.** Phase 6's two
acceptance tests do not both discriminate: with the flee beneath the fleet rung
the STANDING case still passes, because phase 5's parking fix already covers it.
Only the mid-lock case fails. Both are kept and the comment says which is which —
otherwise the next reader assumes both are load-bearing and deletes the wrong one.

**Renumbering the ladder is a chore every phase.** A rung inserted anywhere but
the bottom shifts every `rung N` comment below it, across
`fleetCompanionLoop.ts`, its test file AND `flow.ts` — 37 references in phase 6.
Do it BEFORE writing new code, with a plain descending rewrite (7→8 first, then
6→7): nothing freshly written can then be caught by the second pass, and no
sentinel is needed. Phases 5 and 7 renumbered afterwards and both needed one.
⚠ A pattern matching `Rung`/`rung` misses the ALL-CAPS `RUNG N` references in
the ladder header, and phase 6 found FOUR comments in `flow.ts` that were already
two renumbers stale — a shift applied on top of a stale number is wrong twice
rather than merely out of date, so correct them to today's truth first.

**Adding a request field is eight sites and one migration trap.** The type, the
default, `REQUEST_KEYS`, a `SAY.` refusal string, the decode, the reconstructed
literal, the risk derivation, and the Svelte panel (a `$state` plus the one
assembly literal). Tests: `validPayload()` and the full-shape `assert.deepEqual`
in "a well-formed request round-trips". ⚠ **Make absence TOLERATED and
defaulted, not refused.** `botHost.js` re-decodes a persisted roster row on every
BFF restart, and a strictly-required new field refuses every row written before
it existed — stranding every companion that was running when it shipped.

**The Bash tool mangles larger heredocs** ("unexpected EOF while looking for
matching"). Never root-caused; an earlier session theorised unbalanced
apostrophes and was wrong. Small heredocs are fine. The workaround that has never
failed: Write the content to a scratchpad file, then splice it in with python.

**Line endings.** The working copy is CRLF and `git diff` emits LF, so `git
apply` cannot round-trip its own patch. Edit with EOL-preserving python
(`newline=""`) or the Edit tool, never by patch. ⚠ Have every splice script
ASSERT its match count before writing — phase 6's aborted twice on ambiguous
anchors that would otherwise have patched the wrong one of two identical-looking
sites in `flow.ts`, and because the assert fires before the write, the file was
left untouched both times.

## Live QA: what actually needs a pilot — the operator's position

**They will not test every feature live, and they are right not to.** Stated
2026-09-11, after phase 6 proposed live QA for its repair path: *"just compare
how it is done in bot scripts. if it is similar, same path, then we are good
without live. i will not test every single nitty gritty feature live."*

**The rule that follows: where a new call resolves to the same shared `api.*`
wrapper an existing live-proven caller uses, it is proven by inheritance. Check
the path before asking for a pilot.** Phase 6's two new actions both passed that
test:

| | Companion | Already live-proven |
| --- | --- | --- |
| `repairItems` | `flow.ts` issue switch | the DSL's `repair-ship` — **byte-identical dispatch line** — and the station panel's own repair button |
| `undock` | `flow.ts` issue switch | two other bot loops, the DSL runner, and the flight panel's Undock button |

One `quoteShipRepair()`, one `api.repairItems`, one `api.undock`. The only
companion-specific code was the decision logic and the observe gate, and both are
unit-tested and mutation-verified. Neither needed a pilot.

**The same argument retires most rung-ordering QA.** Rung 1's warp yield is a
single early return at the top of `decideCompanionAction`; it returns before any
lower rung runs. Six rungs already sit behind it and are live-proven, so the
seventh is not a new interaction.

**What genuinely cannot be proven by inheritance**, and still needs a hand on the
controls:

- anything MULTI-PILOT — SSR and unit tests cannot see two pilots at once, and
  almost every behaviour in this plan is multi-pilot by definition
- anything depending on MOUNT/REMOUNT
- a composition whose timing the unit tests fake rather than exercise

⚠ **Do not ask for a pilot as a reflex at the end of a phase.** Name the
specific thing inheritance cannot cover, or do not ask.

## Delegating: what works, and what has broken

**Read-only research sweeps in parallel are safe and pay for themselves.** Three
earned their tokens in phase 5 and two more in phase 6 — one mapped every site a
new request field touches and was right about all eight; another found a rung-3
bug that would have starved the flee rung.

**⚠ But verify their sharper claims, always.** Every sweep so far has been
valuable AND wrong somewhere:

- a phase 5 sweep reported the observation "inherits the drone fields for free;
  no extra plumbing needed" — true of the TYPE, false at runtime, because
  `observe()` builds its own literal and set none of them. Acting on it would
  have shipped a rung reading `undefined` every tick.
- a phase 6 sweep reported rung 3's starvation bug. Real — and WORSE than
  reported once the code was read directly: it re-picked the same module for
  ever and grew an unbounded array, neither of which the sweep mentioned.
- another framed a doc-versus-code contradiction as unresolvable when phase 5's
  parking fix had already half-dissolved it.

**Do not run implementation subagents against this tree.** A subagent once
overwrote in-progress `flow.ts` edits that had to be restored from backup, and
subagent verification runs hang on torn files. Subagents run only their own test
file, never repo-wide gates, never backgrounded. **The coordinator owns
`flow.ts`.**

⚠ **Grep a subagent's output for real identifiers before it reaches a commit.**
They do not know what came from a live session and will lift a real character id
out of a transcript and make it a test constant. Use the documented synthetic
family (`90000001` and siblings).

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
