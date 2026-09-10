# Fleet companion — implementation

Companion to [fleet-companion-plan.md](fleet-companion-plan.md). That doc says
**what** and **why**; this one says **in what order, on which branch, and how we
know it works**. Read the plan first — nothing here re-argues a decision made
there.

Status: **not started, phases 1-6 specified.** Specs for phases 1, 2, 4,
5 and 6 are below and have been checked against the code. Two of the three live
unknowns are answered (see the plan doc); the chat-link shape remains open and
needs a capture, not a code read.

## Branch and commit strategy

Work happens on `feat/fleet-companion`, cut from `tokeiito`, never from
`master`. Merge back into `tokeiito` with `--no-ff` so the phase reads as one
unit in the history, and push to `fork`. No vendor PR.

Each phase in the table below is a **branch**, not a commit — phases are big
enough that a single commit would be unreviewable, and small enough that a
long-lived branch is unnecessary. Within a phase, one commit per step of that
phase's spec.

The gateway patch (phase 8) does **not** live here. It lands in `/d/evet`, and
this repo's phase 8 branch depends on it being applied to the running container
first. Sequence that deliberately: a companion branch that cannot run because
the gateway underneath it has not been patched is a branch nobody can review.
The procedure is below.

### The phase 8 gateway patch, in `/d/evet`

`/d/evet` is a vendor-tracking repo: `vendor` is the pristine upstream drop
(currently v0.12.7.1), each local change is a branch based on `vendor`, and
`main` is `vendor` with every patch branch merged in. `main` is the tree the
image is built from. The full rules are in `/d/evet/CLAUDE.md`; the ones that
bite here:

```bash
# in /d/evet — branch from VENDOR, never from main
git switch -c feat/fleet-chat-channel vendor
# edit server/src/_secondary/express/evejsWebGatewayRuntime.js
git commit -m "feat(web-gateway): publish fleet chat so a companion can read it"
git switch main && git merge feat/fleet-chat-channel
# then add a row to PATCHES.md — a patch not in the manifest is lost on the next drop
```

⚠ **Branch from `vendor`, not `main`.** A patch ships as a diff against the
pristine tree. Branch from `main` and `git diff vendor feat/...` hands back
every local patch in the fork instead of the one you wrote.

⚠ **Keep it surgical.** `evejsWebGatewayRuntime.js` is a vendor file that
upstream actively develops, and replay pain on the next drop is proportional to
how much of it we touch. Add the fleet room to `roomNamesForEntry` and widen the
channel allowlist. Do not tidy anything nearby, do not reformat, do not reorder
imports — a whitespace-only change turns every future upstream edit to that file
into a conflict.

**The server source is on disk at `/d/evet/server/src`.** Reading it out of the
running container (`docker exec evejs-server-1 …`) is fine for investigation and
is what proves what is actually running, but the patch is written against the
repo.

**This one is probably upstream-shaped.** It fixes a real gap in eve.js's own
web gateway — the gateway publishes Local and Corp to a browser session and
simply never considered Fleet — and it benefits every consumer, not just us.
`/d/evet/CLAUDE.md` has a "Delivering a fix upstream" section and there is
precedent in the manifest: the `fleet-apply-autoaccept` patch, which came out of
this very companion's fleet work, went upstream as a PR and carried its tests
there. Plan on a local patch branch to unblock phase 8 now **and** a PR, rather
than treating the local patch as the destination.

⚠ No AI attribution in any commit message, PR body or manifest row, here or in
`/d/evet`.

⚠ Before any `git commit` or forge post, grep the staged diff for character
ids, character names and account names used while driving the live server. A
capture session's identifiers must not reach source, tests, fixtures, comments,
commit messages or recorded observations. Where a fixture needs an id, use the
documented synthetic one (`90000001`).

## Verification gates

Three different things get called "testing" on this project and they catch
different failures. All three are required per phase.

**1. `node --test` — on the host, directly.** `node_modules` is present on the
host and the TypeScript modules run under Node's type-stripping, so unit tests
need no container.

```bash
npm test
```

⚠ **Judge this by failure NAMES, never by the count.** The host baseline is not
green. A green run is not the target; the target is *no failure whose name is
not already on the baseline list below*.

### Baseline, captured 2026-09-10

**17 failing tests across 8 files, and every one is locale.** The host formats
thousands with a space (`12 000`); the assertions expect a comma (`12,000`).
Noise for this feature — ignore wholesale, and judge a phase only by whether a
failure name appears that is not on this list.

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

**Resolved the same day: the two `test/serverBots.test.js` failures are gone**
(`dcd13b8`). They were harness drift, not a product bug. `90e42fa` had dropped
the account argument from `botScriptStore.get` when the script library went
platform-wide; the test's fake still expected the two-argument shape, so it
received `("s1", undefined)`, matched neither branch and returned null — and the
route answered `BOTSCRIPT_NOT_FOUND` as a 404 before either test reached what it
exists to pin.

**This matters for phase 9 as good news.** `POST /api/bots/start` was never
broken — every production caller already passed the one-argument form. The
bot-start path phase 9 launches squad pilots through is sound, and needs no
investigation before that phase begins.

Also sound, from the same run: **every `squadBoard` test passes**, including
call/lapse, per-fleet isolation and the string-vs-number fleet key. Phases 1 and
7 build directly on that file.

Regenerate the failure list with:

```bash
npm test 2>&1 | grep -B1 "^✖" | grep -A1 "^test at" | grep "^✖"
```

**2. `docker build --target web-build` — the compile and typecheck gate.** This
is the only thing that actually typechecks the Svelte and TypeScript surface.
`npm test` will happily pass on code that does not compile.

```bash
docker build --target web-build -t evejs-web-typecheck .
```

Run it at the end of every phase, and specifically after any change to
`web/src/store/types.ts`, `web/src/bots/botScript.ts` or
`web/src/nav/scriptConditions.ts` — the three files whose types fan out
furthest.

**3. Live QA — drive the actual app.** Non-negotiable for this feature, and the
reason is structural: **SSR and unit tests cannot see mount/remount bugs, and
they cannot see anything that depends on two pilots existing at once.** Almost
every behaviour in this plan is multi-pilot by definition.

```bash
docker compose up --build --detach
```

⚠ **Merged is not live.** Check `docker ps` first. In docker mode nothing you
merged is running until that command rebuilds — a passing branch and a stale
container look identical from the browser.

⚠ **The Browser pane suppresses `confirm()`.** Several write routes here are
confirm-gated (`requireWriteConfirmation`). A confirm-gated button silently does
nothing when driven from the pane; patch `window.confirm` for the one click, or
the test looks like a broken feature.

## Live QA plan

Per phase, the smallest scenario that could fail. These need **two pilots online
and a real fleet** — one companion pilot plus one pilot issuing orders. Where the
order must come from a fleet commander, the ordering pilot must actually hold
the role (see the tagging constraint in the plan doc).

| Phase | The scenario | What proves it |
| --- | --- | --- |
| 1 | FC broadcasts `Target` on a rat; FC tags a rat `A` | the follower shoots that rat, and the tag ranks above its own ladder |
| 2 | FC fleet-warps while the follower is mid-approach | the follower stops issuing orders and does not produce refusals |
| 3 | rats aggress a companion pilot | hardeners come on, booster cycles, capacitor does not flatline |
| 4 | order each of the four new calls by hand | each lands; the tag one is run BOTH as a commander and as a plain member |
| 5 | let a drone take damage | recall fires, and the relaunch happens after the drone is in the bay, not before |
| 6 | drop a pilot below its flee threshold | it leaves, and it comes back; then repeat it while the FC is fleet-warping, and confirm it does NOT flee |
| 7 | tackle a companion pilot | targets get lettered, and an already-lettered rat is not re-lettered |
| 8 | type each chat command in fleet chat | each is obeyed; then type one from a non-commander and confirm it is refused |
| 9 | launch a squad with per-pilot roles | each pilot starts on its own script; exactly one pilot tags |

The phase-4 and phase-8 rows have a negative case deliberately. Both features
have a **silent** failure mode — a dropped tag write, an unauthorised command —
and a test that only ever exercises the happy path cannot tell success from
silence.

## Phase dependency graph

```
        ┌─ 3  tank-up ────────────────┐
        │                             │
        ├─ 4  the four wired routes ──┤
        │        │                    │
        ├─ 5  drone recall/redeploy ──┤
        │                             │
  1  broadcast + tag decode           │
        │   │                         │
        │   └──── 2  yield to warp ───┤
        │              │              │
        │              └─ 6  flee ────┤
        │                             │
        └──── 7  tackle → tag ────────┤   (also needs 4, and unknown #2)
                                      │
  8  gateway patch → chat commands ───┤   (independent; needs /d/evet first)
                                      │
                                      └─ 9  squad roles + Bot Manager badge
```

Reading it:

- **1 is the keystone.** It is also entirely in-repo and touches no gateway. Start
  here.
- **3, 4 and 5 are genuinely independent** of 1 and of each other. They are the
  filler work — pick one up whenever 1 is blocked on a question.
- **7 needs both 1 and 4**, plus an answer to whether a positive tackle read
  exists. It is the most likely phase to be descoped.
- **8 is independent of everything in this repo** but gated on a patch landing in
  another one. Start the `/d/evet` patch early precisely because it is not on
  the critical path here.
- **9 is last** because it is the only phase whose job is to make the other eight
  usable together, and it cannot be designed against features that do not exist.

## Where the specs land

Each phase's file-level spec is being produced separately and will be folded in
below as it arrives. A spec is not merged into this document until its claims
have been spot-checked against the code — a spec that names a function that does
not exist is worse than no spec, because it reads as authority.

| Phase | Spec | State |
| --- | --- | --- |
| 1 | broadcast + tag decode, store slice, observation, script surface | **below, verified** |
| 4 | keep-at-range / orbit-a-mate / fleet tag / jump-through-fleet | **below, verified** |
| 5 | drone recall-and-redeploy | **below, verified** |
| 6 | flee and return | **below, verified** |
| 2 | one inWarp guard | **below, verified** |
| 3 | tank-up block | small enough to spec inline when started |
| 7 | tackle -> tag | unblocked: the tackle read exists; spec when started |
| 8 | blocked on the chat-link wire shape | blocked |
| 9 | blocked on 1-8 | blocked |

## Open questions being investigated

Carried from the plan doc's Unknowns section. Each is a fact about the running
world, not a design choice, and each is currently out with an investigation:

1. Whether a **positive "I am scrambled" read** exists, or only the reactive warp
   refusal. Decides whether phase 7 is buildable as specified, descoped to the
   reactive path, or dropped.
2. Whether `OnFleetBroadcast` / `OnFleetStateChange` can arrive wrapped in
   `__MultiEvent`, and whether the server has already filtered on scope and
   range by the time a member receives a broadcast. Decides how defensive the
   phase-1 decoder must be.
3. The **wire shape of a pasted in-game link** in a chat backlog entry. Decides
   whether `destination: <link>` is buildable at all, or whether the chat
   command must take a system name instead.

Answers get written into the plan doc's Unknowns section — not here — so there
stays exactly one place where a fact about the world is recorded.

## Phase 1 — the spec

Seven commits. Steps 1-3 are independent of 4-6; 5 and 6 both need 4 but not
each other.

| # | Commit | Files |
| --- | --- | --- |
| 1 | the decoder, pure and standalone | `web/src/bridge/fleetBroadcasts.ts` + test (new) |
| 2 | the store slice | `store/types.ts`, `store/feed.ts`, `store/clientStore.ts`, `store/fleetSlice.test.ts` |
| 3 | the push wire-up | `app/flow.ts` (`applyPushedNotification`), `app/fleetFlow.test.ts` |
| 4 | the observation | `nav/scriptConditions.ts`, `app/flow.ts` (build site ~`:7073`) |
| 5 | the script condition | `bots/botScript.ts`, `nav/scriptConditions.ts`, `bots/scriptCodec.ts`, `bots/scriptText.ts`, `bots/editorOptions.ts` + all five tests |
| 6 | precedence + tag ranking | `nav/scriptMacros.ts`, `nav/targetPriority.ts` + tests |
| 7 | doc debt | `src/squadBoard.js:18` comment, plan doc Unknowns |

⚠ **Commit 5 is atomic and cannot be split.** `ConditionKind` is consumed by
exhaustive `switch`es and two `Record<ConditionKind, string>` maps. Adding one
kind breaks the build in five files at once; there is no half-done state that
compiles.

### Decisions worth keeping

**Extend the existing `fleet` slice; do not add a new one.** `fleet.set(
INITIAL_FLEET)` already fires on `character/offline`, `session/logged-out` and
`fleet/cleared`, so the reset wiring comes free. A new slice would need those
three call sites added by hand and would drift the first time one was missed.

**The TTL is applied at observation build, not in the reducer.** The store keeps
the raw broadcast until the next one overwrites it; the freshness check happens
where the bot reads it. This matches `src/squadBoard.js`, which drops a lapsed
entry when asked rather than on a timer, and the existing `BELT_MEMORY_CACHE_MS`
read-time check in `flow.ts`. Define the 30 s constant once, in the decoder
module, so a future Fleet Center panel cannot re-derive a different "stale".

**Tags do not expire; broadcasts do.** A tag is fleet *state*, authoritative
until the next `OnFleetStateChange`. A broadcast is a call, and a call goes
stale in seconds. Different lifetimes, deliberately.

**Clear both on a fleet switch.** `targetTags` are per-fleet, and a stale dict
from the old fleet read as current — in the window before the new fleet's first
state change arrives — would point the guns at nothing. Key the clear on the
`fleetID` changing, not merely on availability.

**`null` and `[]` mean different things** for `targetTags`: never received,
versus received and nothing is tagged. Same convention
`fleetMemberCharacterIDs` already uses.

**Do not add the two methods to `fleetSnapshotNotifications`.** That set
triggers a full bound-fleet re-read. These are not roster changes — they *are*
the payload, and a re-read would neither produce nor invalidate them.

**Do not add a fourth `SquadRoleArg`.** The precedence change lives inside the
existing `"follow"` behaviour: in-game tag, then `Target` broadcast, then the
squad board, then the pilot's own ladder. The player still just picks "follow".

### Corrections to the spec as written

**`calledOnGrid` has two call sites, not one** (`scriptMacros.ts:2136` and
`:3499`). The spec called it "the one and only hook" feeding `engagePrey`. The
conclusion survives and is in fact stronger — changing that one function means
both `attack-player`/`hunt-player` and the `fight-the-rats` path inherit the new
precedence automatically — but anyone verifying the change must check both.

**The `__MultiEvent` defensiveness is no longer speculative, and it is needed
for a different reason.** The spec left a TODO to unwrap defensively pending a
capture. Settled since: our two notifications are *never* wrapped, so they need
no defensive branch — but `OnFleetMemberChanged` batches **are** wrapped and are
being dropped today (see the plan doc's Unknown 4). Commit 3 should add a real
`__MultiEvent` unwrap-and-redispatch step, not a TODO, and it fixes that bug on
the way past.

**`scope` needs no filtering, and that is now confirmed rather than assumed.**
The spec's instinct to keep it an opaque passthrough was right. The server
filters on scope and range before any session is notified.

**`itemID` can arrive as a bare numeric string.** The spec reasoned these ids sit
under 2^53 and need `unwrapLong` only for the wrapper case. True as far as it
goes, but the sharper reason is that `itemID`/`typeID` skip server-side
normalisation entirely, and a bigint is stringified bare by the gateway. The
`positiveSafeID` idiom the spec chose (`unwrapLong`, then a `/^\d+$/` fallback)
handles this correctly — keep it, and keep the test for the string case
specifically.

**The tag alphabet is a decision, not an unknown.** The spec flagged `TAG_ORDER`
as needing a live capture. There is nothing to capture: `normalizeFleetTag`
accepts **any** non-empty trimmed string and no tag vocabulary exists anywhere
in the server. So the ordering is ours to define. Two consequences: our writer
picks its own letters, and our reader must rank an unrecognised tag rather than
drop it, because a human FC in the real client can type anything at all.

### Phase 4 — the spec

⚠ **The four are not one size of work.** An earlier draft of this document, and
the plan doc's route table, implied all four routes had "no browser caller".
That is wrong for two of them:

| Route | `api.ts` wrapper | Manual UI caller | bot `issue:` case | bot block |
| --- | --- | --- | --- | --- |
| `keep-at-range` | **exists** (`api.ts:2364`) | **exists** (Space Overview) | missing | missing |
| `orbit` | **exists** (`api.ts:2375`) | **exists** | **exists** (`flow.ts:7105`) | missing |
| `fleet-tag-target` | missing | none | missing | missing |
| `jump-through-fleet` | missing | none | missing | missing |

So `orbit-fleet-mate` is the smallest commit in the whole project — no new API
call, no new action, no new `issue:` case. It is purely a block that resolves a
*named* fleet-mate instead of the nearest one. `follow-fleet-mate` needs a new
action kind and `issue:` case but no new wrapper.

**Reuse `orbit-and-boost` as the template** (`scriptMacros.ts:3091`). It already
does the whole chain: `fleetMatesOnGrid` → pick an anchor → emit once, gated on
a memory key so it does not re-issue every tick. The new blocks differ in one
line: `friendlies.find(e => e.characterID === who.charID)` instead of
`nearest(...)`. The `character` arg kind is fully built already — reuse it.

⚠ **Add the new macros to `FLEET_SUPPORT_MACROS`** (`flow.ts:6102`) or
`obs.fleetMemberCharacterIDs` is never fetched and every block waits forever.

**No `range` argument.** The `count` arg kind clamps at 500, far below a useful
follow range. The codebase's own precedent is to hardcode the distance in the
decider (`ORBIT_BOOST_RANGE_M`, `ORBIT_RANGE_M`). Follow it; a player-editable
range is a separate, later change.

#### The tag gate — get this right or it silently does nothing

`dispatchBoundBeyonceWrite` answers `{ok: true, applied: true}` whether the tag
landed or the server dropped it for lack of a commander role. **The HTTP
response cannot detect a dropped tag.** The gate must run client-side, before
the call, off the roster the browser already reads. `boundFleet.ts` already
decodes `role` and `job` per member and nothing consumes them yet — this is the
first consumer.

⚠ **The spec's proposed role check was wrong twice, and the corrected form is:**

```ts
const FLEET_JOB_CREATOR = 2;              // NOT 1 — 1 is FLEET_JOB_SCOUT
const FLEET_CMDR_ROLES = new Set([1, 2, 3]);
// job is a BITMASK tested with &, not compared with ===
return (me.job & FLEET_JOB_CREATOR) !== 0 || FLEET_CMDR_ROLES.has(me.role);
```

Verified against `fleetConstants.js:1-9` and the real check at
`fleetRuntime.js:1319`. The spec guessed `FLEET_JOB_CREATOR = 1` and used `===`.
Both are wrong, and the combination is worse than either: it would have granted
tagging to **scouts** (job 1) and denied it to the fleet **creator**.

The three-state answer matters: `null` when the roster is unreadable (wait,
never guess "no"), `false` when genuinely not a commander, `true` otherwise.

**Skip, do not block.** `MacroOutcome` already distinguishes `"skipped"` ("it
cannot do its job on this ship and that is not worth stopping for") from
`"blocked"`. A rank-and-file pilot should keep fighting, looting and following —
it just never fires the tag write. Precedent: the no-salvager-fitted skip at
`scriptMacros.ts:1699`.

#### What phase 4 tagging honestly is

There is no live `targetTags` dict until phase 1 lands. So phase 4's only
mechanism against re-tagging is **memory of this block's own writes** — enough to
stop it hammering the server, not enough to know whether the FC or another
companion pilot already lettered that ship.

Ship it as a **single-letter, single-pilot** capability, safe only when exactly
one companion pilot runs a tag block. Say that in the code comment and the PR
body. Do not call it smart tagging anywhere a player will read it.

#### `jump-through-fleet` — land half, defer half

The `who` half resolves like any other fleet-mate block. The `beaconID` and
`solarSystemID` half has no source: nothing in the browser can discover them
today, and the structure-service bridge reads in `structures.ts` are a different
mechanic (Ansiblex/POS, not a ship-fit cyno).

The spec's option 2 — a new `rawID` arg kind so the player types the ids by hand
— is four files of net-new plumbing for a block nearly unusable until phase 1,
**and phase 1 makes it obsolete**: once `OnBridgeModeChange` is decoded the block
discovers the pair itself and both args disappear.

**Decision: land the `api.ts` wrapper and the `issue:` case in phase 4** (they
cost nothing and have no dependency) **and defer the block to land alongside
phase 1.** Do not build `rawID`.

⚠ **Never render a raw id in a step sentence.** `scriptText.test.ts` enforces
this with a `LOOKS_LIKE_ID` regex — a 5+ digit run in a sentence fails the test.
"Jump through <pilot>'s fleet bridge", and nothing about the ids.

#### Ordering

1. the `fleetCenter.ts` role read + its tests — blocks step 4, nothing else
2. `follow-fleet-mate` — independent
3. `orbit-fleet-mate` — independent, smallest
4. `fleet-tag-target` — needs step 1
5. `jump-through-fleet`, api + `issue:` only — independent

2, 3 and 5 are mutually independent and can go in any order.

### Phases 2, 5 and 6 — the spec

**Phase 2 is one guard, and it is also a bug fix.** `inWarp` appears **zero
times** in `web/src/nav/scriptDecide.ts`. It is checked piecemeal in fifteen
places inside `scriptMacros.ts`, but **interrupts are never checked at all** — so
a `shield-below` or `drone-health-below` watch can fire and issue a world call
while the ship is mid-warp, today, with or without a fleet.

The fix is a single early return at the top of `decideScriptAction`, before both
the `done` check and the `mem.latched` check:

```ts
if (obs.inWarp === true) {
  return { action: { kind: "wait" }, memory: mem, status: "running", ... };
}
```

⚠ `memory` must pass through **untouched**. That is what lets a latched trip, a
drone-redeploy record, or a flee hold-off survive a warp and resume on the exact
tick it clears. Use `=== true`, not `!== false` — an unreadable `inWarp` fails
open, matching every other tri-state field here.

This satisfies the decided precedence rule for every interrupt and every macro
at once. It does **not** distinguish a fleet warp from a self-issued warp,
because nothing in the codebase can — `flow.ts:7042` derives `inWarp` from
`shipMode` alone. That is an accepted limit, not a new one.

The fifteen per-macro checks become unreachable but harmless. Leave them.

#### Phase 5 — drone recall and redeploy

⚠ **The condition extinguishes itself, and this decides the whole design.** The
instant the response recalls the drones, they leave space, `lowestDroneHealth`
goes `null`, and `drone-health-below` reads `cannot-tell`. `resolveInterrupt`
only selects rows reading `met` — so a bare case inside `fireInterrupt` would
fire for exactly **one tick** and orphan the wait-and-relaunch state.

The codebase has already solved this shape once. `standDownAfterFight`
(`scriptDecide.ts:771`, called unconditionally from `:559`) is a **second pass**
driven by a persisted record rather than by the condition, and its own header
says why: "THIS CANNOT LIVE IN `fireInterrupt`. A watch is only consulted while
its condition is MET" (`:756`). Copy that shape exactly: a `fireInterrupt` case
that creates the record, plus an always-run `continueDroneRedeploy` pass that
drives it.

State machine: `recalling` → `holding-off` → `relaunching`.

- **Observe "gone" per recorded drone id against `obs.snapshot.entities`**, not
  via the coarse `obs.dronesOut` flag — a bot may have unrelated drones out from
  another task, and the flag would be wrong.
- **Relaunch from the current bay listing, not the original ids.** A recall can
  merge into an existing stack and the original ids may never resurface.
- **Emit `action: null` while holding off**, so the ordinary program keeps
  mining or shooting underneath. The behaviour should be invisible.
- A destroyed drone and a scooped drone are indistinguishable at this layer.
  They do not need distinguishing: either way nothing is in space, and the
  relaunch finds an empty bay and issues nothing.

**Use ticks, not a wall clock.** `SCRIPT_CADENCE_MS` is 2000 and the loop sleeps
*at least* that long, so "N ticks" is always a lower bound on elapsed time —
and undershooting is the only failure mode that matters for a hold-off. The pure
decide chain also has no injected clock today; threading one through would be a
cross-cutting change for precision this does not need. Express the argument to
the player in **seconds** and convert once, documenting that it is a minimum.

> This is the one place `src/squadBoard.js`'s injected-`now` convention does
> **not** apply. That module compares absolute time across independent readers;
> this one only needs "roughly N ticks since my own last action".

#### Phase 6 — flee and return

Everything in the plan doc's flee section applies. Additions from the spec:

- **The outbound leg is free.** Latch onto `continueHeadingHome` exactly as
  `dock-and-pause` and `dock-and-repair` already do, and it inherits
  fight-your-way-out-if-tackled and drone recall with no new movement code.
  What is new is that on arrival it must **not** call `paused(...)`.
- **Bound the attempts** on the `MAX_RECOVER_TRIPS` / `MAX_ESCAPE_ATTEMPTS`
  precedent, both of which are 3. An attempt is spent when the same condition
  re-fires shortly after a return; a return that holds resets the budget.
- **Flee outranks drone redeploy**, extending the decided precedence table one
  rung. Enforce it at runtime, not by authoring order: when any latching
  response fires, drop live redeploy records from `mem.macroMem`. No drones are
  lost — `recallBeforeLeaving` inside the outbound leg recalls everything the
  ship controls regardless of which watch launched it.

#### The build-breakers, in both phases

Adding a value to `InterruptResponse` will not compile until every exhaustive
consumer is updated in the same commit. `web/src/bots/runPolicy.ts:157` is the
one most easily missed — `Readonly<Record<InterruptResponse, MacroRunPolicy>>`.
`scriptText.ts` and `editorOptions.ts` hold the same shape.

#### Corrections to the spec as written

**Bookmark creation is not a blocker.** The spec concluded a bookmark return
point "is not buildable today without new BFF/bridge work" because `api.ts` only
reads bookmarks. The browser is only half the path: `beyonce.BookmarkLocation`
is allowlisted (`bridgeCallPolicy.js:21`) and routed (`server.js:16069`), and
`BookmarkStaticLocation` is routed at `:5698`. Missing wrapper, not missing
plumbing — same category as the phase-4 routes. Option A (remember the grid)
remains the recommended default on simplicity grounds, but it should be chosen
for that reason, not because the alternative is impossible.

**Confirmation gating is a body flag, not a dialog.** Several of these routes
sit behind `requireWriteConfirmation`, which is satisfied by `confirm: true` in
the request body (`server.js:5300`) — it exists to make the caller state intent,
not to raise UI. A bot passes it directly. Expect a `400
CONFIRMATION_REQUIRED`, not a hang, if it is forgotten.

### The one genuinely open question in phase 1

The exact envelope of `OnFleetStateChange`'s `args[0]` — whether `targetTags` is
the payload or one field of a larger state KeyVal. The spec's answer is right
and cheap: try `keyValField(args[0], "targetTags")` first, fall back to treating
`args[0]` as the dict, and test both shapes. That handles either outcome without
needing to know which, so it does not block the commit.
