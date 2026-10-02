# EveJS web client code review and implementation report

**Report date:** October 2, 2026

**Repository:** [rrfarmer/evejs-web-companion](https://github.com/rrfarmer/evejs-web-companion)

**Implementation branch:** `codex/code-review-fixes-2026-10-02`

**Integration branch:** `master`

**Validated implementation revision:** `c0102b09a40d76efde91083017a86fc0706184df`

All **15 original findings are fixed in focused commits**, with regression coverage for the reported failures. Follow-up review also corrected cancelled-login publication, pending script writes across pause/recovery, late alignment results, and refused drone/follow commands. The detailed original findings are retained below with links to the source revision reviewed.

The main changes protect pilot identity, serialize controller work, and keep requested, refused, uncertain, and confirmed actions distinct. Purchases and quantity-limited transfers no longer complete on refusal. An outcome lost after dispatch pauses work for verification instead of issuing a duplicate. Courier delivery moves only the remaining mission requirement and preserves surplus cargo. Automated drone orders validate per-drone results: the companion retries only refused drones, while scripts pause on a partially accepted flight.

## Implementation record

| Finding | Implemented behavior | Commit(s) |
|---|---|---|
| CR01 | Explicit per-pilot credentials suppress cookie fallback, including empty tokens. Closing a flow retires queued requests/controllers. Unverified release retains ownership. Cancelled legacy logins cannot publish their token over a current identity. | `aab0d42`, `bc8907d`, `7fc72ae` |
| CR02 | Commit action progress after confirmed success. Preserve retryable memory on definite refusal and custody on uncertainty. Serialize ticks, block resume during pending writes, and preserve completed quantities/manifests across transport recovery. | `2fd4a77`, `2a25e3c`, `0e5ce2e` |
| CR03 | Lock assistance recipients before activation; require a readable completed lock and bound lock waits/refusals. Uncertain activations are not replayed. | `2d7d231` |
| CR04 | Pause retires the old companion driver. A resumed driver waits for the previous tick to settle. | `1b69df5` |
| CR05 | Definite escape-warp refusal permits bounded retry. Uncertain warp retains custody and requires observed movement before fleet departure. | `59c1776` |
| CR06 | Autopilot checks route generation after reads and issued commands, on success and failure, so retired work cannot mutate a new route. | `75f38bd` |
| CR07 | Unreadable freight remains unknown. Mining, unloading, jettison, compression, and hold-empty conditions require readable contents. | `1418813` |
| CR08 | Authorized standing chat commands advance a timestamp/identity cursor and take effect once. | `2923497` |
| CR09 | Drone engagement belongs to the observed deployed flight and resets after recall/relaunch or membership change. Definite command refusals can retry safely; per-drone failures are surfaced. | `75f92ab`, `47f8100`, `1d071e4` |
| CR10 | Warp, docking, and competing movement retire the old formation latch. Formation restores once when the competing task ends; refused follow commands no longer read as successful. | `6bb0413`, `1d071e4` |
| CR11 | A retired companion observation failure cannot stop or overwrite the replacement run. | `e6c9f71` |
| CR12 | Remote repair/capacitor assistance stops the old or unconfirmed recipient, observes the module inactive, then activates on the new recipient. | `bcafb36` |
| CR13 | Courier transfers carry one stack and a bounded quantity. Both cargo and hangar must confirm each split before another transfer or completion. | `d9488af`, `17ce01e` |
| CR14 | One dogma event handler updates the dedicated slice and fitting mirror, preserving the last good snapshot on read failure. | `9a0d6ed` |
| CR15 | Alignment records an order identity and dispatch outcome. Successful orders are not repeated; refusals are bounded and uncertain outcomes pause. Exact pending results survive pause without changing a replacement run. | `fc44efa`, `7eb2411` |

The review commits are integrated into the default branch, `master`. Existing PI contributions were incorporated through upstream integration.

## Final validation

- Complete repository suite: **7,766 tests; 7,763 passed, zero failed or cancelled, 3 skipped**. It finished naturally with four concurrent test workers and a verified clean-runtime reference.
- `npm run typecheck`, `npm run build:web`, and `git diff --check` passed.
- A targeted batch including real EveJS static tables and propulsion source: **108 passed, zero skipped**.
- The real [EveJS source project](https://github.com/rrfarmer/EveOffline) isolated runner passed all three relevant test files: `assistanceModuleRuntime.test.js`, `webGatewayTargetingActivation.test.js`, and `webGatewayCourierComplete.test.js`; no failures or timeouts.
- The courier app integration test exercises the real flow, decoders, runner, performer, and API against a mocked BFF. It verifies a ten-unit transfer from 1,010 units, mission completion, and 1,000 units retained aboard.

The runtime test reference is recovered from committed EveJS history and checked against all eight manifest hashes. The preparation utility writes source fixtures into a fresh temporary directory and leaves both checkouts and live game data intact. See [runtime-test-reference.md](runtime-test-reference.md) for reproducible commands.

Run the same web-project checks from this repository in PowerShell, using the existing EveJS directory:

```powershell
$env:EVEJS_ROOT = 'C:\path\to\eve.js'
$env:EVEJS_REPO = $env:EVEJS_ROOT
$runtimeReference = node scripts/prepare-runtime-test-reference.js | ConvertFrom-Json
$env:EVEJS_CLEAN_REFERENCE = $runtimeReference.reference
$env:EVEJS_PROPULSION_AUDIT_ROOT = $env:EVEJS_ROOT
npm test -- --test-concurrency=4 --test-timeout=30000
npm run typecheck
npm run build:web
```

The test baseline was repaired in separate commits: the new PI bot-log action, independent gateway allowlist/write-denylist pinning, confirmed character creation, recovery-aware bridge fixtures, uncertain inventory custody, and exact runtime reference preparation. The safeguards those fixtures exercise remain in place.

## Remaining validation and maintenance work

The three optional Factory gateway checks require the patched Factory runtime described in [pilot-training-runtime-setup.md](pilot-training-runtime-setup.md). The existing EveJS gateway does not have those methods installed, so those checks are not evidence of working Factory deployment.

Live multi-pilot and ship-operation QA remains necessary before deployment. Prioritize cookie/session cancellation, rapid pause/resume with commands in flight, loss of a mutation response, drone recall/relaunch, assistance recipient changes, formation after warp/looting, and courier surplus preservation. The real-runtime checks used isolated test data; they did not drive live player ships or assets.

Transport recovery automatically preserves the proven buy/refit/scanner/quantity-transfer and route-haul contracts. Other active-step state, including confirmed sell orders and mixed movement/target/drone state, stays paused with its progress intact and an explicit verification message. Expanding automatic recovery should use typed macro recovery contracts rather than clearing arbitrary memory.

Svelte templates still lack a complete type-checking gate; TypeScript and the production build do not provide one. Focused SSR tests cover changed rendering, including dogma statistics. The existing [Svelte typecheck gap](svelte-typecheck-gap.md) records the toolchain migration separately. Large session/route/controller files also remain candidates for incremental extraction. The production build reports a large main JavaScript chunk: 1.45 MB minified, approximately 423 KB gzip; code splitting is a separate performance follow-up. These are maintenance follow-ups, not unresolved instances of the 15 defects.

The chat protocol provides timestamps and sender/text identity, not a unique message ID. Two byte-identical messages from one sender in the same millisecond cannot be distinguished reliably.

## Original review — historical findings before implementation

The rest of this document records the initial read-only review. Its defects, recommendations, and baseline test results describe revision `fecf96ddb7323539acb44c519a0ebc4ba4a833fb`, before the fixes listed above.

**Review date:** October 2, 2026

**Repository:** [rrfarmer/evejs-web-companion](https://github.com/rrfarmer/evejs-web-companion)

**Reviewed revision:** `fecf96ddb7323539acb44c519a0ebc4ba4a833fb`

**Scope:** Repository-wide review of the BFF, session handling, frontend state, navigation, bot execution, and relevant tests. The review was read-only; no implementation changes were made.

The review found **15 actionable issues: five P1 and ten P2**. The highest-risk findings concern session isolation, multiple controllers driving one ship, and bot memory treating a requested action as a successful action. Address the P1 findings first, with regression tests that exercise failures and multiple ticks.

P1 means an urgent defect to fix next. P2 means an ordinary defect that should be fixed. These are engineering priorities based on demonstrated code paths, not a record of observed live-game losses.

Source links below point to the reviewed revision so the cited locations remain stable after fixes.

### Original P1 findings

#### CR01 Disable cookie fallback for an explicitly empty session token

**Location:** [web/src/app/api.ts:162](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/app/api.ts#L162)

A fresh per-session flow has `token: null` and sends no Authorization header, but its requests still use `credentials: "same-origin"`. If the browser has a valid cookie for an existing ready pilot, choosing **Add character**, then immediately **Cancel**, calls the new flow's logout through that cookie and releases the unrelated pilot. This unintended release was reproduced against the real BFF with injected session fixtures. Controllers that survive logout also have a possible path to read or command another pilot through the same fallback; that impact was traced in code rather than exercised in a live game.

**Recommended fix:** Suppress cookie authentication whenever a caller explicitly supplies a per-session token, including an empty token. Cover the generic bridge call path as well as the common JSON API path. Retire active controllers on successful logout or release while retaining ownership if release is refused or unverified.

**Regression test:** Keep pilot A online with a browser cookie, create a fresh tokenless session B, and cancel B. A must remain held, and B must issue no authenticated requests as A.

#### CR02 Commit action completion only after success

**Location:** [web/src/nav/scriptRunner.ts:545](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/scriptRunner.ts#L545)

The runner stores macro memory before awaiting `issue()`. One-shot macros set flags such as `placed`, `applied`, or `issued` at that point, so a refused purchase, refit, or scanner analysis can advance as completed on the next tick. Quantity-limited transfers can similarly count refused work as moved. A one-step purchase rejected for insufficient funds made one attempt and then reported **Finished**. The session-change refusal handler promises a retry, but the committed macro state can prevent it.

**Recommended fix:** Separate pending intent from confirmed completion. Restore or preserve retryable state after an explicit refusal. For a timeout or disconnect after dispatch, retain the pending action and reconcile authoritative state before deciding whether to retry.

**Regression test:** Reject purchases, fitting changes, scans, and quantity-limited transfers. Assert that none advances as completed. Include `SESSION_CHANGE_IN_PROGRESS` and an ambiguous transport outcome.

#### CR03 Lock recipients before activating remote repairs

**Location:** [web/src/nav/fleetCompanionLoop.ts:3380](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L3380)

Shield, armor, and capacitor assistance broadcasts immediately produce a module activation against the named recipient without first locking it. The game server rejects an unlocked target with `TARGET_NOT_LOCKED`. Because the module remains inactive, the companion repeatedly chooses the same activation and does not reach lower-priority behavior. A controller reproduction produced four rejected activations and no lock commands.

**Recommended fix:** Lock the recipient, observe the completed lock, and then activate an appropriate module. Apply bounded handling for unavailable targets and range refusals.

**Regression test:** Broadcast an assistance request for an unlocked fleet member. Expect lock first, no activation while the lock is pending, and activation after authoritative confirmation.

#### CR04 Retire the previous companion loop when pausing

**Location:** [web/src/nav/fleetCompanionLoop.ts:7280](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L7280)

Pause changes status without changing the run token. The resume caller starts another `run()`. If resumed before the original sleep or observation settles, both loops see a running controller with the same token and can continue driving the ship. A deferred-sleep reproduction left two loops active; repeated quick pause/resume operations can accumulate additional loops.

**Recommended fix:** Invalidate the old run on pause and ensure that only one driver can run for the current generation. Pending ticks must recheck generation after every asynchronous boundary before issuing commands.

**Regression test:** Pause and resume while sleep and observation promises are unresolved. Resolve the old promises and verify that only the replacement driver continues observing or issuing commands.

#### CR05 Clear the escape warp latch after an explicit refusal

**Location:** [web/src/nav/fleetCompanionLoop.ts:2627](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L2627)

The escape-to-sun decision sets `safeSpotWarpIssued` before issuing the warp. If the server refuses it while the ship is tackled, the flag remains set. Even after tackle clears, subsequent ticks only wait for the original warp to start. A reproduction refused the first warp, cleared the scramble, and observed only waits afterward. The same escape helper serves abandonment behavior.

**Recommended fix:** Clear the issued latch after a definite refusal and permit a bounded retry. Preserve pending state and reconcile movement after an ambiguous transport failure.

**Regression test:** Refuse the first escape warp, then remove the tackle. Verify another warp attempt. Separately test a timeout where the original warp may have landed.

### Original P2 findings

#### CR06 Reject autopilot ticks from replaced routes

**Location:** [web/src/nav/autopilotLoop.ts:1228](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/autopilotLoop.ts#L1228)

Checks after asynchronous reads inspect shared controller status without verifying the tick's starting run token. Abort followed by a new route makes status running again, allowing the old tick to drive the replacement route and bypass its settle window. Reproduced: the new route issued a warp, then resolution of the old snapshot immediately produced a dock command.

**Recommended fix:** Capture generation at tick entry and guard all success, failure, and command paths after awaits.

**Regression test:** Hold an old snapshot read open, replace the route, advance the new route, then resolve the old read. The stale tick must neither issue a command nor mutate the new route's state.

#### CR07 Preserve unreadable freight contents

**Location:** [web/src/nav/miningBotLoop.ts:449](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/miningBotLoop.ts#L449)

`freightHoldItemIDs()` converts an individual hold's `items: null` into an empty list. The BFF intentionally returns null when inventory listing fails while capacity succeeds, and the decoder preserves it. With a present ore hold using 4,900 of 5,000 capacity but unreadable contents, classic mining chose to undock and ordinary delivery claimed unloading was complete. Jettison and custom hold-empty observations contain the same unknown-to-empty conversion.

**Recommended fix:** Carry unknown contents through the relevant helpers and decisions. Require readable authoritative contents before declaring a hold empty or delivery complete.

**Regression test:** Provide a present, nearly full hold with unreadable contents and readable empty cargo. Mining must wait, delivery must remain incomplete, and the hold-empty condition must remain unknown.

#### CR08 Process standing chat commands once

**Location:** [web/src/nav/fleetCompanionLoop.ts:3733](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L3733)

Each tick replays the fresh chat backlog onto memory that already reflects those messages. Two stop messages repeatedly reset `stopShipIssued`. An older stop followed by a destination repeatedly clears `destinationRoutedFor`, restarting travel every tick. Both sequences were reproduced across repeated decisions.

**Recommended fix:** Track processed command identities or a reliable cursor, and apply only new commands while preserving the resulting standing order.

**Regression test:** Evaluate the same backlog repeatedly with two stops and with stop followed by destination. Each command must take effect once; an unchanged destination must not restart travel.

#### CR09 Reset drone target latches after recall and relaunch

**Location:** [web/src/nav/fleetCompanionLoop.ts:6483](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L6483)

The last engagement target survives the complete recall, hold, and relaunch cycle. If the fleet primary remains unchanged, the new flight matches that old latch and receives no engagement command. A reproduction traversed the entire cycle and returned wait after relaunch. The repair-drone target latch has the same defect.

**Recommended fix:** Associate engagement state with the current deployed flight, and clear or revalidate it when drones leave space, are replaced, or relaunch.

**Regression test:** Engage a target, recall hurt drones, relaunch, and keep the same primary. Expect an engagement order for the current flight. Repeat for repair drones.

#### CR10 Restore formation after other navigation replaces it

**Location:** [web/src/nav/fleetCompanionLoop.ts:6011](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L6011)

The follow anchor and range latches survive warp and loot or salvage approaches, although those actions replace the ship's actual keep-at-range movement. After landing or completing the area job, the companion reports holding station while stopped or still moving toward the old wreck. A keep-at-range, warp, and landed-stop sequence reproduced the incorrect wait.

**Recommended fix:** Retire formation latches when another navigation action supersedes them, or confirm that authoritative movement still represents the intended follow before suppressing a command.

**Regression test:** Follow the commander, warp or approach a wreck, then return to formation behavior. Verify that keep-at-range is reissued when needed.

#### CR11 Ignore observation failures from retired companion runs

**Location:** [web/src/nav/fleetCompanionLoop.ts:7064](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L7064)

The observation success path checks generation, but its rejection path changes the current memory first. If an old observation rejects after Stop followed by Start, it sets the replacement run to error. A deferred-observation reproduction demonstrated that state change.

**Recommended fix:** Apply the same generation check in read-error handling before changing state or publishing progress.

**Regression test:** Start a pending observation, stop and restart, then reject the old observation. The new run must remain running with its own state and failure reason.

#### CR12 Retarget active remote assistance modules

**Location:** [web/src/nav/scriptMacros.ts:5397](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/scriptMacros.ts#L5397)

Remote repair chooses the most injured fleet member each tick but only activates modules that are currently inactive. When the selected recipient changes, modules cycling on the previous recipient are never deactivated or redirected. The new recipient can remain unaided while the readout claims repair. Remote capacitor assistance uses the same logic.

**Recommended fix:** Track or observe each assistance module's current recipient and safely move active assistance to the selected target.

**Regression test:** Activate assistance on A, then make B the selected recipient while the module remains active on A. Verify the appropriate deactivation and activation sequence rather than indefinite wait.

#### CR13 Unload only the required courier quantity

**Location:** [web/src/nav/scriptMacros.ts:2509](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/scriptMacros.ts#L2509)

Mission turn-in gathers every cargo stack matching the mission type and ignores the required quantity. The action performer transfers all those stacks into the destination hangar. A ten-unit mission with matching stacks of ten and one thousand selected all 1,010 units. This relocates surplus cargo; it does not destroy it. The classic mission loop already limits delivery to the required amount.

**Recommended fix:** Construct transfers totaling the remaining required quantity, splitting a stack when necessary, and leave surplus goods aboard.

**Regression test:** Deliver ten required units from multiple matching stacks totaling 1,010. Exactly ten units must move, with the surplus retained aboard.

#### CR14 Update the dedicated dogma store slice

**Location:** [web/src/store/clientStore.ts:1338](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/store/clientStore.ts#L1338)

Two switch cases handle `dogma/loaded`. The first updates the fitting slice and breaks, so the second case that updates `store.dogma` is unreachable. Fitting subscribes to the dedicated slice for effective module statistics. A successful event left it unloaded with no information, keeping the UI on Reading and hiding read errors.

**Recommended fix:** Consolidate event handling so the intended slices both update, with deliberate behavior for failed reads and retained snapshots.

**Regression test:** Dispatch successful and failed dogma events and verify the dedicated slice plus the rendered module-statistics view.

#### CR15 Latch completed alignment orders

**Location:** [web/src/nav/fleetCompanionLoop.ts:6762](https://github.com/rrfarmer/evejs-web-companion/blob/fecf96ddb7323539acb44c519a0ebc4ba4a833fb/web/src/nav/fleetCompanionLoop.ts#L6762)

An unchanged alignment order produces a command on every observation throughout its freshness window. Issued actions select the faster loop cadence, allowing up to roughly three bridge requests per second per companion before network latency. Repeated decisions reproduced the duplicate calls.

**Recommended fix:** Remember a successfully issued order identity and suppress duplicate alignment while it remains current. Permit a new command when the order changes or movement has been superseded, with safe handling of refusals and uncertain outcomes.

**Regression test:** Repeat observations containing one unchanged alignment order and verify one successful dispatch. Then replace the order and verify a new dispatch.

### Initial validation and test setup problems

`npm run typecheck` passed. A core and frontend subset covering **431 test files** completed with **6,423 tests: 6,412 passed, one failed, and ten skipped**. Its failure was the bot-log union fixture missing the newly introduced `collectLaunch` action.

The default `npm test` run did not complete cleanly. It exposed bridge-contract drift, integration fixtures that no longer satisfy the drone-recovery gate, and an event-stream test that stalled. Runtime-patch tests also attempted to read an unavailable external clean-reference checkout. These baseline and setup problems are separate from the 15 product findings.

The pinned bridge manifest omits `officeManager.RentOffice` and `skillHandler.PurchaseSkills` from the BFF write policy. Update the manifest through the existing contract workflow and keep it synchronized with the runtime classification. Update the affected integration fixtures to exercise the current recovery contract, preserving the production safeguards.

Findings were checked through source inspection, relevant call sites and tests, and isolated in-memory decision, controller, store, or BFF reproductions. Live-game integration was not exercised. Passing existing tests does not cover the reported multi-tick and lifecycle failures.

The TypeScript check also does not type-check Svelte component templates. The repository records this gap in [svelte-typecheck-gap.md](svelte-typecheck-gap.md).

### Original recommended implementation sequence

1. Fix session isolation and controller generations first: CR01, CR04, CR06, and CR11. Add cookie-aware and deferred-promise regressions.
2. Establish explicit pending, refused, uncertain, and confirmed action states: CR02 and CR05. Avoid blind retries of consequential writes after timeouts.
3. Fix assistance and formation behavior: CR03, CR09, CR10, and CR12.
4. Correct hold readability, chat deduplication, courier quantities, dogma state, and repeated alignment: CR07, CR08, CR13, CR14, and CR15.
5. Repair the test baseline, then run the complete suite and focused live-game scenarios for the changed flows.

### Original maintainability observations

The recurring design problem is using memory of a requested command as evidence that the world applied it. Shared action-state conventions would reduce inconsistent retries and stale latches across the script runner and companion controller.

Session ownership, feature routes, and recovery behavior are concentrated in large files such as `src/server.js` and `web/src/app/flow.ts`. Smaller modules with explicit ownership and lifecycle boundaries would make consistency checks easier. Refactor incrementally alongside behavior-preserving regression tests; a large structural rewrite is not required before addressing the defects above.
