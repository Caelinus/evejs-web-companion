# The fleet companion — a plan

Design doc. **Nothing here is implemented yet.** It exists because the feature
sounds like a rewrite and is not one: the bot stack already has the hands, the
BFF already has the routes, and the one part that looked hardest — hearing what
the FC says — is already arriving in the browser and being thrown away.

The goal: you fly the real client, the companion flies one or more pilots
alongside you in the same fleet, and it obeys you the way a competent
fleet-mate does — through fleet warp, fleet broadcasts, target tags and fleet
chat — while keeping itself alive without being told to.

## The one-line version

Three of the four command channels need **no gateway work at all**, because
eve.js already pushes them to a browser-backed session and
`applyPushedNotification` simply does not look at them. The fourth (fleet chat)
needs one small patch in `evejs-server`. Everything downstream of that is
blocks, and the block runtime is finished.

## The shape of the thing — DECIDED

**The fleet companion is not a bot script.** It is a sibling decide-loop that
*uses the methods the bots use*. This was settled after the first draft of this
doc, and it changes what the phases below build, so read it before the specs.

The reasoning: the block DSL exists so a player can compose behaviour as text in
the Bot Builder. A fleet companion is bigger than that and worse suited to it —
fifteen broadcast names, target tags, jam events, chat commands and a flee
policy do not read as a step list, and exposing them as one asks the player to
hand-assemble something that should simply have settings.

**The codebase already has this pattern three times over.** `autopilotLoop.ts`,
`miningBotLoop.ts` and `missionBotLoop.ts` are browser-side decide-loops that
are *not* the script bot: each reads authoritative state per tick, issues at
most one atomic call, never simulates, bounds every branch, and pauses with a
reason. `miningBotLoop.ts`'s own header opens by calling itself "THE FOURTH
INSTANCE OF ONE PATTERN, not a new one". The fleet companion is the next
instance. They run 1,300-1,900 lines each, which is also an honest measure of
the size of this.

Configuration follows the same precedent: `startMiningBot(request)` takes a
**typed request object**, not a script document. So does this.

### What that keeps, and what it deletes

Reused unchanged — this is most of the value in the phases below:

- the per-tick observation build in `flow.ts`, and every field it already carries
- the `issue:` action switch — warp, align, orbit, lock, activate, drones, jump
- the pure helpers: `targetPriority.ts`, `fleetMatesOnGrid`, `hostilesInReach`,
  `recallBeforeLeaving`, `fightTheWayOut`, `scriptTravelHome` — but see the
  implementation doc: all but `scriptTravelHome` are PRIVATE to their modules
  today and must be exported first. Pure, but not yet importable.
- every decoder and store slice this feature adds (`bridge/`, `store/`)
- the squad board

**Deleted from the earlier specs**, which assumed new blocks:

- new `MacroID`s, `Condition` kinds and `InterruptResponse` values
- the whole editor fan-out — `scriptCodec.ts`, `scriptText.ts`,
  `editorOptions.ts`, `validateScript.ts`, `runPolicy.ts`, `BotInspector.svelte`
- the "one atomic commit across five files" constraint that came with adding a
  `ConditionKind`, which disappears entirely

That is a substantial simplification. The mechanism research in those specs
still stands; only the packaging changes.

⚠ **THE ONE REAL COST: headless execution.** `src/botHost.js` drives exactly one
entry point — `flow.startCustomBot(doc)`, the *script* bot. The three sibling
loops are browser-only by design, and `miningBotLoop.ts` says so plainly:
"It runs in the BROWSER. Closing the tab is closing the client... The BFF never
drives a mining loop with no client attached." A script bot survives a closed
tab; a sibling loop does not.

For a companion meant to fly beside you while you play the real client, that
matters. Two ways out, and the second is recommended:

1. Accept browser-only — the web companion is open anyway, and R107 multibox
   already runs several pilots in one tab.
2. **Extend `botHost` to drive the companion loop too.** This looks genuinely
   small: the host already imports the whole stack, mints its own session,
   holds the one-hull-one-driver claim, mirrors a durable roster and resumes
   after a restart — all of it behaviour-agnostic. What is bot-script-specific
   is a single line calling `startCustomBot`. A `flow.startFleetCompanion(
   request)` beside it is the whole change.

Treat option 2 as part of the work, not a follow-up, or the feature ships in a
shape that cannot be left running.

## What is already built

Worth stating plainly, because it narrows the work to about a third of what the
feature description implies.

| Capability | Where | State |
| --- | --- | --- |
| Action vocabulary: undock, warp, approach, align, orbit, dock, gate jump, lock/unlock, activate/deactivate module, drones | `web/src/app/flow.ts:7089` | done |
| Fit classification into hardeners / shield / armor / hull repairers / remote reps / tackle / webs / weapons | `web/src/app/flow.ts:5834` | done |
| Self-targeted module activation (`targetID 0`) | `web/src/app/flow.ts:7121` | done |
| Interrupts: `shield-below`, `armor-below`, `hull-below`, `capacitor-below`, `hostile-on-grid`, `drone-health-below`, `targeted-by-player` | `web/src/bots/botScript.ts:434` | done |
| Drone recall, and the align-out-and-recall move | `web/src/app/flow.ts:4467`, `:7703` | done |
| Fleet-mates on grid, resolved from the roster | `web/src/nav/scriptMacros.ts:2912` | done |
| Squad board: shared primary-target calling, `call` / `follow` roles, 30 s TTL | `src/squadBoard.js` | done |
| Join fleet, join advertised fleet, accept invite, invite | `web/src/bots/botScript.ts`, `docs/join-advertised-fleet-handoff.md` | done |
| Route solving, autopilot, `set-destination`, `travel-to-system` | `web/src/nav/routeSolver.ts`, `autopilotLoop.ts` | done |
| `salvage-wrecks`, `loot-wrecks`, `undock`, `dock-and-repair` | `web/src/bots/botScript.ts:669` | done |
| Headless bot host — a bot is just another session, tab may be closed | `src/botHost.js` | done |
| Multibox: several isolated per-character sessions live at once | R107, `docs/pilot-hangar.md` | done |

**BFF routes that exist but have no browser caller yet.** These are already
allowlisted in `src/bridgeCallPolicy.js` and routed in `src/server.js`; only the
`api.ts` wrapper, the flow action and the block are missing.

| Route | Retail method | Buys us |
| --- | --- | --- |
| `/api/bridge/flight/keep-at-range` (`src/server.js:15738`) | `beyonce.CmdFollowBall(targetID, range)` | "follow me at X km" — wrapper and manual UI already exist; only the bot block is missing |
| `/api/bridge/flight/orbit` | `beyonce.CmdOrbit` | "orbit me at X km" |
| `/api/bridge/flight/fleet-tag-target` (`src/server.js:16018`) | `beyonce.CmdFleetTagTarget(itemID, tag)` | tagging targets with letters |
| `/api/bridge/flight/jump-through-fleet` (`src/server.js:16030`) | `beyonce.CmdJumpThroughFleet(otherCharID, otherShipID, beaconID, solarSystemID)` | "jump to me" through a cyno bridge |

## The finding that makes this cheap

**Fleet broadcasts and target tags already reach the browser today.**

`fleetRuntime.sendBroadcast` ends at:

```
notifySession(targetSession, "OnFleetBroadcast", [
  name, scope, senderCharID, senderSolarSystemID, itemID, typeID
], "fleetid");
```

and target tags push `OnFleetStateChange` carrying a `targetTags` KeyVal dict of
`itemID -> tag` (`fleetPayloads.js:207`, `fleetRuntime.js:899`). Both go through
`session.sendNotification`, which the gateway's browser-session stub captures
and publishes onto the SSE stream
(`evejsWebGatewayRuntime.js`, `materializePersistentBrowserSession`).

`applyPushedNotification` (`web/src/app/flow.ts:1300`) acts only on
`fleetSnapshotNotifications` and `scannerSnapshotNotifications`. Everything else
lands in the bounded `live` slice and is discarded. **The bytes are already
there.**

> ⚠ This made the note in `src/squadBoard.js:18` out of date — it said the
> in-game tag equivalent was blocked because "nothing in the client can READ a
> tag back yet". **Fixed 2026-09-11 when the decoder landed.** That header now
> describes the board as the FALLBACK beneath a real tag or broadcast, and says
> why it must not be deleted: a fleet mechanism is visible to every pilot
> including the humans, and the board is visible only to bots on one BFF.

### The fifteen broadcast names

`fleetConstants.js:58` — the server refuses anything else with `Illegal
broadcast`, so this list is the complete command surface, and it maps onto the
requirement almost exactly:

```
EnemySpotted  NeedBackup  HoldPosition  InPosition  TravelTo
JumpBeacon    Location    Target        HealTarget  HealArmor
HealShield    HealCapacitor            WarpTo      AlignTo     JumpTo
```

`itemID` on a broadcast is the entity or location it is about — the same kind of
id `lock`, `activate`, `orbit` and `warp` already take.

### What each one actually carries — from the client, not guessed

The server passes `itemID` through untouched, so its meaning is decided entirely
by the sending client. Read out of the decompiled client at
`ClientCodeGrabber/3396210/…/parklife/fleetSvc.py:1010-1130`. **This settles four
questions that were previously marked "needs a live capture".**

| Broadcast | `itemID` is | Range | Act on it? |
| --- | --- | --- | --- |
| `HealShield` / `HealArmor` / `HealCapacitor` | **the sender's own ship** (`session.shipid`) | bubble | **yes** — remote-rep that entity |
| `HealTarget` (`BROADCAST_REP_TARGET`) | a **third party's ship**, chosen from the watch list | bubble | **yes** — rep that entity |
| `Target` | the tactical target | system | **yes** — primary |
| `AlignTo` | an object, gated by `CanAlignOrWarpToTypeID` | system | **yes** — align |
| `WarpTo` | an object, same gate | system | no — the server warps the fleet itself |
| `JumpTo` | **a stargate** — gated to `groupStargate` | system | **partly** — see below |
| `TravelTo` | **a solar system id** (`session.solarsystemid2`) | global | **yes** — route to it |
| `JumpBeacon` | an **active beacon** the sender holds | global | prefer `OnBridgeModeChange` |
| `EnemySpotted` / `NeedBackup` / `HoldPosition` / `InPosition` | the sender's **nearest object** (`GetNearestBall`) | global | log only |
| `Location` | the sender's system, plus their nearest object | global | log only |

⚠ **`JumpTo` COULD NOT BE BUILT AS THIS TABLE SAYS, and the row above is
corrected to "partly".** Discovered while building it, 2026-09-11: `api.jump`
needs the gate on BOTH sides of the jump, and the broadcast carries one. The far
gate exists only in the static route graph, which is loaded asynchronously —
and the companion's ladder is pure and synchronous and carries no route graph.
Giving one rung its own copy of the autopilot's route solver is a bigger change
than the rung earns, and inventing the second id risks flinging an unattended
ship into the wrong system.

So the companion warps to the called gate, closes on it, and HOLDS at jump
range, and its readout says why rather than looking like a stuck bot. A later
phase that threads the route graph into the observation can finish it. The rest
of this table is unaffected.

Three things fall out of this that no amount of reasoning would have produced:

- **The Heal broadcasts name the patient in `itemID` directly.** A companion does
  not need to resolve `senderCharID` to a ship entity — the ship id is right
  there. Simpler and exact.
- **`TravelTo` is a system id, and `JumpTo` is a stargate.** Both were going to be
  deferred as ambiguous. Both are directly actionable, and `JumpTo` meaning a
  gate is what makes an actual jump safe rather than a guess.
- **The four "nearest ball" broadcasts are announcements, not orders.** Their
  `itemID` is whatever happened to be closest to the sender, which is why acting
  on them would be meaningless. Log them; do not act.

The three range modes are the sender's choice too: `SendGlobalBroadcast`,
`SendBubbleBroadcast` and `SendSystemBroadcast` are separate call paths, which is
where `rangeMode` comes from. The Heal family is bubble-scoped — deliberately,
since a rep request only makes sense to someone in range to answer it.

Rate limiting is server-side (`MIN_BROADCAST_TIME_SEC`, one third of that for
some names), so a spamming FC cannot wedge a follower. That is a real
protection, and it means the follower does **not** need its own rate limiter.

### Fleet warp costs nothing

`collectFleetWarpFollowers` warps the members server-side, honouring each
member's `acceptsFleetWarp` opt-out. When you press Warp Fleet in the real
client, the companion's ship warps whether or not the companion notices.

The work is therefore the opposite of what it looks like: **make the bot not
fight it.** A bot that issues an approach or an orbit while the server is
warping it produces refusals and a confused loop. The runner already carries
`inWarp` in the observation; the follower mode must yield to it.

## The gaps, by requirement

### 1. Fleet commands (align, warp to, target priorities, need shield/armor)

| Command | Mechanism | Work |
| --- | --- | --- |
| Warp to / align to | server-side fleet warp | yield to `inWarp`; nothing else |
| `AlignTo` broadcast | `OnFleetBroadcast` | decode + `align` action |
| `Target` broadcast | `OnFleetBroadcast` | decode + feed the existing `follow` squad role |
| Target priorities 1-9 | `OnFleetStateChange.targetTags` | decode + rank in `targetPriority.ts` |
| `HealShield` / `HealArmor` / `HealCapacitor` | `OnFleetBroadcast`, `senderCharID` | decode + the existing remote-rep blocks already know how to rep a fleet-mate on grid |
| `NeedBackup` / `EnemySpotted` | `OnFleetBroadcast` | optional; useful later |

New work: a decoder in `web/src/bridge/fleetBroadcasts.ts`, a store slice, and a
condition/action pair per behaviour.

**Broadcasts go stale exactly like a squad-board call.** Reuse the 30 s TTL and
the reasoning already written down in `src/squadBoard.js` — a follower whose
call has lapsed falls back to its own ladder, which is a working bot, not a
stopped one. Do not invent a second staleness policy.

**Prefer a real broadcast or tag over the squad board.** The board was always
the stand-in for the in-game mechanism. Once tags decode, `squad: follow` should
read: in-game tag first, then broadcast, then board, then own ladder.

⚠ **WHY A TAG OUTRANKS A BROADCAST, which this doc asserted twice without ever
saying.** It looks backwards: a broadcast is the fresher, more deliberate act,
and a reader who trusts that intuition will "fix" the order. The reason is
AUTHORITY, and it is in the server (checked 2026-09-11):

- `setFleetTargetTag` (`fleetRuntime.js:1318-1326`) refuses any writer that is
  not a commander -- `(member.job & FLEET_JOB_CREATOR) !== 0` or a role in
  `FLEET_CMDR_ROLES`. **A tag that exists is provably a commander's.**
- `sendBroadcast` (`:2519-2522`) checks `ensureFleetMembership` and nothing
  else. Name, rate limit, range and per-recipient scope are all gated; **the
  SENDER's rank is not.** Any fleet member may broadcast `Target`, and scope
  only decides who hears it -- so receiving one says nothing about who sent it.

So the ordering is not "state beats calls", it is "a verified commander beats
an unverified one". Keep it, and keep this note with it.

**The upgrade this points at, not built yet.** `OnFleetBroadcast` carries
`senderCharID`, and `boundFleet.ts` already decodes each member's `role` and
`job` -- fields nothing currently consumes. So a follower COULD check whether a
broadcast came from a commander and rank a verified one above a tag. That is
the same roster read phase 7's tagging gate needs, which is where it belongs;
noted here so the two are built together rather than twice.

### 2. Chat commands

This is the only piece needing work outside this repo.

**Why it is not already there.** Chat deliberately bypasses notification capture
(`evejsWebGatewayRuntime.js`, the `onChatChannelMessage` subscription). The
gateway subscribes to `chatRuntime`'s `channel-message` event and maps
`roomName` to `"local"` or `"corp"` and nothing else. Fleet chat exists as
`fleet_<fleetID>` (`fleetRuntime.js:1827`, `:2212`) and
`getFleetRoomNameForSession` is already written
(`xmppStubServer.js:278`) — it is simply not consulted.

**The patch is bigger than the push path.** An earlier draft of this doc said it
was "genuinely small — add the fleet room to that map and widen the allowlist".
Investigated 2026-09-10: that is true of the **push** half only. The **read and
send** half needs new code, because the gateway's chat service is written as a
two-channel binary throughout.

`gatewayServices/webChatGatewayService.js` is the real gate — the BFF's
`CHAT_CHANNELS` merely mirrors it:

| What exists | What fleet needs |
| --- | --- |
| `CHAT_CHANNELS = ["local", "corp"]` (`:49`) — the single true allowlist for both read and send | a third entry |
| `readChannel` (`:252`) — a ternary between `readLocal` and `readCorp` | a `readFleet`, mirroring `readCorp` (`:236`) |
| `sendChannel` (`:287`) — a ternary between `broadcastLocalMessage` and `broadcastCorpMessage` | a `broadcastFleetMessage`, mirroring `:266` |
| `getCorpSessions` / `getCorpRoster` (`:126`, `:152`) | fleet equivalents |
| `syncPresence` (`:165`) tracks corp membership transitions | fleet membership transitions too |

Plus the push half, which really is small: `roomNamesForEntry`
(`evejsWebGatewayRuntime.js:5927`) gains the fleet room from the already-written
`getFleetRoomNameForSession` (`xmppStubServer.js:256`), and
`onChatChannelMessage` (`:5942`) gains a third branch in its ternary.

**The chat engine underneath is already fleet-ready** and needs nothing:
`chatRuntime` has `ensureFleetChannel` (`:1053`), a `fleet_mismatch` access
check (`:837`), and already includes the fleet room in
`getChannelsForStaticAccess` (`:1779`). The gap is entirely the web-bridge
layer. That is good news for correctness and bad news for the size estimate: it
is mechanical, mirrorable work, but it is not two lines.

**On this side of the wire** the change is mechanical but wide — 22 call sites
where `local | corp` is written as a closed pair, spanning `src/server.js`, the
store types and initial state, the chat decoder, the live-push narrowing in
`flow.ts:1209` (which today mislabels a fleet message as local), `Chat.svelte`'s
tab list and its two-channel ternaries, and the bot DSL's own `ChatChannelArg`.
Most widen for free once the type widens; the ones that do not are the hardcoded
ternaries and the `<select>` in `BotInspector.svelte`.

⚠ `web/src/bridge/social.ts:26` defines an unrelated `ChatChannel` interface — an
`LSC.GetChannels` row. Same name, different concept. Do not conflate them when
searching.

Then the command layer, which is a parser dispatching onto blocks that mostly
exist:

| Command | Dispatches to | State |
| --- | --- | --- |
| `undock` | `undock` block | exists |
| `destination: <link>` | `set-destination` + `travel-to-system` | exists; **link decode unknown** |
| `jump` | `jump` action + `routeSolver` nearest gate | exists |
| `salvage` | `salvage-wrecks` | exists |
| `follow me at <N> km` | `/api/bridge/flight/keep-at-range` | route exists, no client |
| `orbit me at <N> km` | `/api/bridge/flight/orbit` | route exists, no block for a fleet-mate target |
| `jump to me` | `/api/bridge/flight/jump-through-fleet` | route exists, no client |

`follow me` and `orbit me` both resolve "me" through the existing
`fleetMatesOnGrid` helper — the sender's character id from the chat entry, then
their ship entity on this pilot's grid. If they are not on grid, the honest
answer is to say so in chat, not to guess.

> ⚠ **Conduit jumps are a different thing from "jump to me".** A conduit jump is
> server-driven and passive: `conduitJumpRuntime.js:382` checks the member's own
> `acceptsConduitJumps` and moves them. `CmdJumpThroughFleet` is the
> member-initiated bridge jump. The chat command should mean the second.

**"Jump to me" does not need the chat command to carry the beacon.** When a
bridge goes up, `setBridgeMode` (`fleetRuntime.js:1376`) pushes
`OnBridgeModeChange [shipID, solarsystemID, itemID, active]` to the whole fleet
— which is exactly the `(otherShipID, solarSystemID, beaconID)` triple
`CmdJumpThroughFleet` wants, minus the character id, which the roster supplies.
So the follower can track the active bridge passively on the same push channel
as everything else, and `jump to me` becomes "use the bridge you already know
about". If no bridge is up, say so rather than guessing.

### 3. Situational awareness

**Harden up and self-repair — nearly free.** Every ingredient exists: the fit is
already classified into hardeners and shield/armor/hull repairers, `activate`
with `targetID 0` is the self-targeted path, and `shield-below` / `armor-below`
/ `capacitor-below` are already interrupt conditions. This is one new block that
bundles them, with a cap-aware rule so a permanently-running booster does not
flatten the capacitor.

**Flee at a configurable threshold, then come back.** New, and the most delicate
of the four.

- The **leave** half is largely written — but **not** by `panicRecallAndDock`
  (`web/src/app/flow.ts:7661`), which an earlier draft of this doc cited. That
  is the manual "Recall drones & dock" button: imperative, async, driven by
  direct `api.*` calls, and living in a different runner from the pure
  per-tick decide chain a script runs on. It cannot be called from
  `decideScriptAction`.

  The machinery that *is* reusable, and is already wired into every script run,
  is `scriptTravelHome` (`scriptMacros.ts:4572`) driven tick by tick by
  `continueHeadingHome` (`scriptDecide.ts:1085`). It already does dock-check,
  resolve home, ride the autopilot, `fightTheWayOut` when blocked, and
  `recallBeforeLeaving` (`scriptMacros.ts:280`) — the generalised align-out-and-
  recall. Wiring `shield-below` to `dock-and-pause` today already produces
  "recall, fight out if tackled, fly home, dock" with no new code.
- The **come back** half is new. It needs a remembered return point, a hold-off
  before returning, and a bounded number of attempts so a bot cannot yo-yo into
  a camp forever.

  **A bookmark is a viable return point.** `beyonce.BookmarkLocation` — bookmark
  where the ship is standing — is allowlisted and routed
  (`src/server.js:16069`), as is `BookmarkStaticLocation` (`:5698`). Only the
  browser wrapper is missing, which puts it in the same category as the four
  phase-4 routes rather than in "needs new bridge work". The cheaper option, and
  the recommended default, is to remember the grid directly: the site or belt
  entity the step was working, falling back to the ship's raw coordinates.

  ⚠ **A docked ship cannot read its own armour or hull.** Docking restores
  shields and capacitor but not armour, and a docked session carries no ship to
  read at all. So a flee triggered by `armor-below` **cannot be confirmed healed
  while docked** — the bot must undock and re-read to find out, and a still-met
  condition on that fresh read is what spends an attempt. Design the return
  around that, not around a health check that cannot happen.

  There is also **no way to know the original grid is safe without flying to
  it.** That is precisely what the attempt cap is for. Do not invent a
  "grid clear" read; none exists.
- Thresholds must be **per-pilot configurable** — a logi's flee point is not a
  battleship's — so they belong on the script, alongside the existing
  0.05..0.95 threshold range. The threshold itself already is: `shield-below`
  and friends carry a per-row `fraction`, so nothing new is needed for it.

> **DECIDED: fleet warp wins.** If the FC fleet-warps while the bot is running
> its own escape, the FC's movement stands and the bot's flee does not fire — a
> fleet that is already leaving does not need the bot's opinion. This is the
> movement rule everywhere, not just here; see Precedence below.

**If tackled, tag targets with letters.** Three parts. One is solved, one has a
constraint that decides *which* pilot can do it at all, and one is unsolved.

- *The write* is plumbed: `CmdFleetTagTarget` is allowlisted and routed.

- ⚠ *Only a fleet commander may tag.* `setFleetTargetTag`
  (`fleetRuntime.js:1310`) returns `false` — silently, no error — unless the
  caller holds `FLEET_JOB_CREATOR` or a role in `FLEET_CMDR_ROLES` (`[1, 2, 3]`
  = leader, wing commander, squad commander). A rank-and-file companion pilot
  **cannot tag**, and gets no refusal telling it so. This is not a detail to
  discover at runtime: it decides which pilot in the squad is the tagger, and it
  means the player must give that pilot a commander role, or the squad must
  create the fleet with it.

- ⚠ *A tag is unique across the fleet.* `setFleetTargetTag:1343` walks the
  existing tags and **deletes any other item holding the same letter** before
  setting it. Two targets cannot both be `A`; assigning `A` to a second rat
  silently steals it from the first. So a bot tagging three rats must use three
  letters, and it needs the current `targetTags` dict in hand to know which are
  free. That dict is the same one arriving on `OnFleetStateChange`, so the
  decoder from Phase 1 is a prerequisite for tagging, not just for following.

- *Already-tagged targets are left alone.* If an entity is in `targetTags`, do
  not re-tag it. This is the rule that keeps the fleet's letters stable — a rat
  that is `B` stays `B` for as long as it lives — and it also happens to be what
  makes the uniqueness rule harmless in practice, because the bot then only ever
  assigns letters that nothing holds.

- *Knowing you are tackled* is **SOLVED — a positive read exists.** Investigated
  2026-09-10; this reverses the earlier assumption in this doc that only the
  reactive warp refusal was available.

  The server pushes **`OnJamStart`** to the **victim's own session** the moment a
  hostile module cycle lands, and `OnJamEnd` when it drops
  (`space/runtime.js:13215`, sent from `:36080`). Payload:

  ```
  [sourceBallID, moduleID, targetBallID, jammingType, fileTime, durationMs]
  ```

  `jammingType` is `"warpScramblerMWD"` for a scram and `"warpScrambler"` for a
  disruptor (`hostileModuleRuntime.js:1197`). It carries the aggressor's entity
  id in `sourceBallID` — so the thing holding you names itself, which is exactly
  what wants tagging.

  **It already reaches the browser.** The browser-session notification stub
  suppresses exactly one method, `DoDestinyUpdate`, and captures every other
  `sendNotification` onto the push stream. `OnJamStart` is not suppressed, so it
  arrives on the same SSE channel as the fleet notifications and needs **no BFF
  route and no gateway change** — only a decoder in `applyPushedNotification`,
  the same shape as everything else in phase 1.

  The `isReadyForDestiny(session)` gate on the send site is satisfied for a
  companion pilot in space: the suppression comment records destiny frames
  arriving for these sessions at 10 Hz, which only happens once
  `_space.initialStateSent` is true.

  The reactive path stays as the backstop, and is worth keeping: the refusal is
  `{error: "CALL_REFUSED", message: "You cannot warp because you are warp
  scrambled."}`, from `errorMsg "WARP_SCRAMBLED"` at `runtime.js:47349`.
  `fightTheWayOut` already responds to it.

  The tagging behaviour is unchanged either way: rank the hostiles with the
  existing `targetPriority.ts` ladder, tag with A, B, C, and leave an
  already-tagged entity alone.

**Drone damage: recall, then redeploy to break the lock.** `drone-health-below`
already exists as an interrupt condition and `recallDrones` as an action, so the
missing piece is only the **timed redeploy**.

The mechanic being exploited is that an NPC drops target lock on a drone that
leaves space, and re-acquires from scratch on the new launch. That means the
hold-off duration is the whole design, and it is not something to guess: it
depends on eve.js's own NPC re-target cadence. Make it a script argument with a
sane default, and measure the default live rather than reasoning about it.

> ⚠ A recalled drone stays visibly in space while it flies home
> (`web/src/app/flow.ts:4474`). The redeploy timer must start when the drone is
> **gone**, not when the recall is accepted, or the relaunch will fire while the
> drone is still in the NPC's lock.

### 4. Multiple pilots

The foundation is done and this is mostly an orchestration layer, not new
mechanism.

- The bot host already runs one bot per character with a hard one-hull-one-driver
  claim (`src/botHost.js:418`), and the roster survives a BFF restart.
- The squad board is already keyed by fleet id as an exact decimal string, and
  is shared in-process across every bot — so N companion pilots in one fleet
  already have a coordination channel that costs nothing.
- R107 multibox already runs several isolated per-character sessions in one tab.

What is missing is the **squad as a unit**:

- Start / stop N pilots as one group, with one script or one script per role.
- **Roles.** A three-pilot squad is not three copies of one bot: logi, tackle
  and DPS want different flee thresholds, different broadcast subscriptions
  (`HealArmor` matters to logi and to nobody else) and different tag behaviour.
  Only one pilot in a squad should be tagging, or they will fight over letters.
- A squad readout: who is alive, who is in warp, who fled, who is out of drones.
- **Ordering on the fleet-join lap.** The existing multibox alt-fleeting loop
  (char 1 creates and invites, alts join —`docs/block-audit.md:88`) is the
  pattern; a squad start should drive it rather than making the player do it.

> **The tagger needs no election.** An earlier draft of this doc proposed one on
> the squad board. It is unnecessary: the server already answers the question,
> because only a fleet creator or commander can tag at all
> (`setFleetTargetTag:1319`). The tagger is whichever companion pilot holds a
> commander role, and if none does, nobody tags. Read the role off the roster —
> `GetInitState` already carries `role` and `job` per member and
> `boundFleet.ts` already decodes them — and let a pilot without one skip the
> behaviour silently rather than firing writes the server drops on the floor.

## How the player says which pilots these are

The instinct is a checkbox or a "fleet companion" button. **Do not add either.**
The selection mechanism already exists, is already tested, and is already the
thing players use to group pilots for an operation: the **squad**, in the Pilot
Hangar (`docs/pilot-hangar.md`).

A squad is cross-account, named, coloured, pinnable, edited through a per-pilot
checklist popover (`HangarPilotRow.svelte`), reachable as a chip on the header
row, and launchable as a unit (`HangarSquadPicker.svelte`). Every one of those
affordances is what a fleet op needs. A second grouping control — "tick the
pilots that are fleet companions" — would be a competing answer to a question
the hangar already answers, and the hangar doc records what happened last time
grouping was flat: at fifty pilots it is a wall of identical rows.

**So: the squad says WHICH pilots. What is missing is WHAT EACH ONE DOES.**

That is a **role**, and a role is a **setting on the companion request** — not a
script. An earlier draft of this doc said "a role is a script" and proposed
storing a script id per squad member. That is wrong under the decided
architecture: there is no script. What a squad member carries is the typed
config the companion loop starts with, the way `startMiningBot` takes a
`MiningBotRequest`.

| Concern | Answer | Where |
| --- | --- | --- |
| Which pilots are in this op | the squad | exists |
| What this pilot does in it | its companion role + settings | new, typed |
| Pairing the two | per-member role on the squad | `hangarPrefs.ts`, `hangarLaunch.ts` |
| Who tags | the fleet role, not the UI | server-decided, see above |
| Whether it is working | a companion badge per pilot | Bot Manager |

Concretely: `Squad` today is `{id, name, color}` plus a membership map of
character ids (`web/src/app/hangarPrefs.ts:18`). The membership map's value
becomes the per-pilot companion config, and `HangarPilotRow`'s existing
checklist popover gains a role picker next to each ticked squad. No new screen,
no new mode, no new selection concept.

**The account boundary stops being a problem, and that is a real gain.** The
earlier draft had a genuine fork here: squads span accounts but `botScriptStore`
keys scripts by `accountID`, so a mixed squad could not name one shared script
id. Since squads here **routinely** mix accounts, that fork mattered. Typed
config removes it — a role is a value on the squad, not a reference into an
account-scoped library, so a mixed squad carries one shared definition and every
pilot in it means the same thing by "logi".

> ⚠ **Squads live in `localStorage`** (`docs/pilot-hangar.md:101`) and a
> headless run outlives the tab. A squad whose roles exist only in one browser
> cannot be resumed by the BFF after a restart, which the bot host otherwise
> does (`botHost.js`, the durable roster). If roles are to survive, the config a
> run was started with belongs **next to the run**, mirrored the way `botHost`
> already mirrors its roster — not only next to the pilot list. This is the same
> durability question as the headless-execution cost above, and it wants the
> same answer.

**Where the running state shows.** Not the hangar — the hangar is the landing
screen, and "in client" there is already live from App's session list. The
follower state belongs in the Bot Manager, which is the existing single view of
runs across pilots, as a per-run badge: in fleet, following whom, last order
heard, and whether this pilot can tag. That last one matters because a pilot
silently unable to tag looks identical to one that has nothing to tag.

## Two things the server does not do, found by reading it

Both were on the "needs a live capture" list. Neither needed one, and both
overturn something this doc previously asserted.

### Warp costs no capacitor here, so a "cap floor to protect the escape" is fiction

Retail charges capacitor to warp (`warpCapacitorNeed`, dogma attribute 153) and
that is why a flattened capacitor is fatal there. **eve.js does not implement
it.** There is no reference to capacitor anywhere under `space/destiny/` — not
in `warp.js`, `warpState.js`, `warpContract.js`, `warpBuilders.js` or
`warpCommands.js`. A ship on this server warps fine at zero capacitor.

So the framing this doc used — "the floor protects the escape, not the tank" —
is wrong here, and the inverted rule it justified ("stop boosting while still
hurt") loses its reason.

**The floor that does earn its place already exists in this codebase.**
`REPAIR_CAP_FLOOR = 0.2` (`scriptDecide.ts:1062`), shipped, not a placeholder,
with the reasoning "an empty capacitor repairs nothing" — and already used to
switch a running repairer off below it. The companion reuses that constant
rather than inventing a second answer to the same question.

If a per-fit number is ever wanted, both inputs are already on the wire:
per-module activation cost is dogma attribute 6 (`moduleAttributes.ts`) and
capacitor capacity is 482 (`shipStats.ts`), both flowing through
`GET /api/bridge/bound-dogma`. That is a formula over readable quantities, not a
measurement.

### Recall-and-redeploy does not break an NPC's lock

⚠ **This one means a requested behaviour cannot be built as described.**

The ask was: when a drone starts taking damage, recall it and relaunch a bit
later so the NPC loses lock. On this server there is **no target-loss memory and
no drone cooldown of any kind**:

- A recalled drone leaves the scene immediately (`droneRuntime.js:4305`).
- On the NPC's next think tick — `thinkIntervalMs`, 100-500 ms, median ~185 ms
  (`npcBehaviorLoop.js:4305`) — the target is simply gone and it re-scores every
  candidate by distance (`findNearestCombatTarget:1814`).
- The only stickiness is generic: profiles that set `allowTargetSwitching` hold
  a target for `NPC_TARGET_SWITCH_INTERVAL_MS` (60 s; 10 s on a couple of dozen
  burner profiles). **Roughly 40% of profiles set it at all**, so the rest can
  relock the relaunched drone on the very next tick.
- Nothing anywhere scores drones specially. There is no grudge, no memory, no
  re-acquire delay to wait out.

**What to build instead.** The recall itself is still worth having — it takes a
damaged drone out of danger, and that half works perfectly. What changes is the
relaunch trigger: it is not a timer, because no duration is safe. It is an
**observable condition** — relaunch when something else is holding the rat's
aggro (which the majority-profile 60 s stickiness does give you, once your ship
has absorbed it), or when the drone is simply no longer being shot.

So `droneRedeployHoldOffSeconds` survives as a floor on the wait, never as the
thing that makes it safe. Do not describe this feature to a player as breaking
lock; it does not.

### The chat link format, read out of the client

The third "unanswerable from source" item. It was answerable — from the client,
which is the thing that produces the markup. What the eve.js server does not
know, `ClientCodeGrabber` does.

At Enter-press the chat window serialises with `GetValue(html=0)`
(`chat/client/window.py:381`), which emits the **unquoted** form:

```
<url=showinfo:TYPEID//ITEMID>Display text</url>
```

`showinfo:{type_id}//{item_id}` comes from `format_show_info_url`
(`evelink/format/show_info.py:8`). A solar system is `typeSolarSystem = 5`, so a
system link is `<url=showinfo:5//30000142>Jita</url>`. The client's own decoder
is `split(":")` then `split("//")` (`show_info/parse.py:22`) — mirror that.

Accept the `<a href="showinfo:…">` form too: other client surfaces (mail,
notifications) emit it, and being liberal costs nothing.

⚠ **LINKS CONTAIN SPACES, AND THIS DECIDES THE GRAMMAR.** The URL half never
does — it is a scheme word and decimal digits joined by `//`. But the display
half is the object's name, and station and bookmark names routinely contain
spaces ("Jita IV - Moon 4 - Caldari Navy Assembly Plant"). So a parser must
**never whitespace-split a message before extracting the link**: split once on
the literal `destination:` prefix, then run a tag regex over the remainder.

Two smaller facts worth keeping:

- `<`, `>` and `&` inside the display text are always entity-escaped
  (`editPlainText.py:320`), so a station name can never spoof a closing `</url>`.
- A message is hard-truncated at 2048 characters with a trailing `" ..."`
  (`chat/client/util.py:51`), which can cut a link mid-tag. Tolerate a mangled
  trailing link rather than rejecting the whole message.

**The numeric id is authoritative — take `item_id`, ignore the display text.**
That sidesteps name lookup and localisation entirely.

## Decisions to make before writing code

**1. Who may command.** Broadcasts and tags are naturally bounded — fleet
membership is required, the server rate-limits, and the server has already
filtered on scope and range before a session sees a broadcast at all. Chat is
not bounded. A chat-command channel with no sender gate means anyone in the
fleet can undock and fly your ships. Gate on fleet boss / wing commander role
from the roster read, or on an explicit list of character ids on the script.
Default to the narrowest thing that works.

**The gate is safe to build on.** A chat entry's `characterID` is derived
server-side from the authenticated session (`chatRuntime.js:87` —
`session.characterID || session.charid || session.userid`), never from anything
in the message text, so it cannot be spoofed by crafting a message. The
companion's decoder already reads it (`web/src/bridge/chat.ts:49`). Gate on that
field and nothing else — never on `characterName`, which is display text.

One thing the decoder does **not** read: the server also attaches a richer
`sender` summary object to every entry that the client currently throws away. If
the gate ever needs corp or alliance context rather than a character id, that is
where it comes from, and it means decoding one more field rather than a new
call.

**2. A follower is a mode, not a step list — DECIDED, and it is not a bot
script at all.** See "The shape of the thing" above. This was previously left
open as "consider a `follow-the-fleet` block"; it is now settled the other way.

**3. Precedence — DECIDED, and AMENDED 2026-09-11 when phase 6 was built.**
The order in which the authorities win, once, for every ambiguous case:

```
server fleet warp  >  own flee rule  >  FC broadcast  >  chat command  >  own ladder
```

The consequence worth stating out loud, because it is the one that will look
like a bug: **a bot being fleet-warped does not flee, does not re-target, and
does not answer a chat command until the warp lands.** That is correct. A pilot
who breaks formation to save themselves mid-warp is not a fleet-mate.

⚠ **The flee used to sit BELOW the FC broadcast, and that was wrong.** The
original order read `... > chat command > own flee rule > own ladder`, which
makes a standing target call outrank a pilot's own survival. It was written
before there was any code, and `decideFleetOrders` was already contradicting it
in a comment — "phase 6 must not put its flee beneath this rung; a pilot that
never stops obeying a target call would never flee" — so the two could not both
stand.

**What phase 5 had already fixed, and what it had not.** The parking fix made a
STANDING call (target locked, guns running, nothing new to issue) hand back a
readout that the ladder holds aside, so rungs below it still get their tick. That
removed the worst reading of the old order. What it did not remove: a fleet order
with something REAL left to issue still wins outright, and `lockThenEngage`
issues one lock and then one activate per weapon before it goes quiet. On a fresh
primary with six guns that is seven ticks — about fourteen seconds at the two
second cadence — and an FC that keeps re-calling extends it without limit.

**The operator was asked, and chose the flee.** Fleet warp was never in dispute
and keeps its place at the top: rung 1 yields to it unconditionally.

⚠ **This is the acceptance test, and only one half of it discriminates.** With
the flee rung moved back beneath the fleet rung, "a pilot obeying a *standing*
target call still flees" STILL PASSES, because the parking fix handles it. The
case that fails is **a pilot mid-lock on a fresh primary**. That was established
by moving the rung, not by argument, and both tests are in
`fleetCompanionLoop.test.ts` with a comment saying which is which.

⚠ **A side effect worth knowing.** Nothing now sits beneath the fleet rung, so
`CompanionDecision.standing` — built in phase 5 specifically so a flee could
live below it — has no behavioural consumer. It is kept because the readout it
protects is still correct (a pilot whose guns are running must not report
"Standing by"), and because phase 8's chat rung is the next candidate for that
slot. Do not remove it on the grounds that nothing needs it.

**4. The headless launch grant — DECIDED: keep the machinery, drop the dialog.**

A bot script's grant (`web/src/bots/runPolicy.ts:57`) is three fields: the exact
stored revision, exactly the risk classes derived from that revision, and a hard
minute cap. The BFF re-derives all of it and refuses anything broader or stale,
because browser-supplied policy is never trusted as fact.

The **consent** half does not earn its place here. It exists because a
player-composed script can call arbitrary risky macros and the player should see
which ones before it flies. A companion's surface is fixed at build time, the
operator wrote the request, and a companion only ever flies in a fleet with a
human in it (decision 5). So there is **no review step: the start control
launches.**

The **deadline** half is not about supervision at all, and it is the half that
bites. `maxRuntimeMinutes` is the only thing that ends an unattended run:
`botHost.js:405` derives `expiresAt` from it and nothing else, the timer at
`botHost.js:512` is the sole unattended stop, and `resume()` (`botHost.js:734`)
refuses any persisted row whose `expiresAt` has already passed — which is also
what stops a restarted BFF from reviving yesterday's companion into a fleet that
no longer exists.

So the shape is:

- `analyzeCompanionRunPolicy(request)`, mirroring `analyzeBotRunPolicy(script)`:
  `combat` from `useDrones` / `defenseModuleIDs` / **any of the three
  remote-repair module lists** (widened in phase 1, see below), `fleet` from `attemptsTagging`
  and the warp yield, `social` from the chat send.
- `validateBotLaunchGrant` **unchanged** — the request's revision and canonical
  hash fill the `scriptRev` slot a script's revision fills today.
- The cap defaults to `DEFAULT_SERVER_BOT_RUNTIME_MINUTES` and **is editable on
  the start control**, so live QA can set a short one and watch it expire.

⚠ **Do not pass an empty `riskClasses` to save the derivation.**
`pilotRoster.ts:229` renders an empty list as the sentence "No consequential
permissions", and the comment above it says that is deliberate — "an empty list
is a sentence, not a blank". A pilot that writes fleet tags and sends chat must
not describe itself that way in the Bot Manager.

⚠ **TWO SUB-DECISIONS PHASE 1 MADE IN CODE, RECORDED HERE AFTER THE FACT.**
Both were argued out in a comment and would otherwise be re-derived, or
re-litigated, by whoever reads the code next.

**(a) `combat` is earned by a remote repairer too.** The derivation above named
`useDrones` and `defenseModuleIDs` only, because those were the fields that
existed. Phase 1 added `remoteShieldModuleIDs`, `remoteArmorModuleIDs` and
`remoteCapacitorModuleIDs` so the companion can answer a rep call, and all three
now earn `combat` as well. The reasoning is the same one the class already
rested on — "nothing on the ship can be cycled into a fight" is what withholds
it, and a fitted remote repairer is exactly such a thing. A logistics pilot with
a working repairer is a participant in a fight as much as a gunner is.

**(b) A Heal broadcast is answered ABOVE a target tag**, which is a different
question from the tag-versus-`Target` precedence above and has a different
answer for a different reason. That one is authority. This one is urgency and
NON-EXCLUSIVITY: a tag is standing state and is still true next tick, a rep call
is time-critical, and a logi can hold a lock AND run a repairer — the two
compete only for one tick's single atomic call. So the heal rung falls THROUGH
the moment there is nothing new to start, rather than parking the tick. A logi
whose repairer is already cycling still locks the primary; a pilot with nothing
fitted is never blocked by a call it cannot answer.

**5. A human in the fleet is a CONTINUOUS condition — DECIDED, with a protocol.**

The rule the operator stated: a companion does no unsupervised work. That is not
a preflight. `FLEET_COMPANION_REQUIREMENTS` today (`botRegistry.ts:442`) only
asks whether the fleet **read** succeeded (`availability === "ready"`), so a
companion alone in a fleet of one passes it, and passing it once says nothing
about the next six hours.

**The check.** At least one fleet member that **this host is not driving** —
subtracting the tab's own claims and the BFF's bot roster (`claims`, already in
`botHost.js`). Re-evaluated every tick, above every order source in the
precedence list, because it is a liveness gate and not an order.

⚠ Counting members does **not** work. Four companions plus the operator is four
members after the operator logs off.

⚠ Honest limit: another account's companion in the fleet reads as human, because
we can only subtract the bots we know about. Accepted.

**Why the naive version fails, read out of the server** (2026-09-10,
`/d/evet/server/src/services/fleets/fleetRuntime.js`):

- A disconnect **removes** the character from the fleet
  (`handleSessionDisconnected`, :1861). So a logged-off human cannot satisfy the
  check, and `inFleet` is not hollow. Good.
- But the fleet **survives with one member**. That size test is `<= 1` *before*
  the removal, so a human leaving a two-member fleet leaves the companion in a
  fleet of one — and `assignBossToAnyRemainingMember` (:1838) **promotes it to
  boss**. The failure mode is therefore not merely "keeps flying unsupervised";
  it is "is promoted to commander, and its tag writes start succeeding", in a
  fleet nobody is in. Only a drop to zero members destroys the fleet.

**The protocol, when the check fails.** Get safe, then disband, then wait.

1. **Get safe.** Dock, reusing the travel-and-dock machinery `travel-to-station`
   already has (`continueHeadingHome` — one of the private helpers the handoff
   lists). The scene reports stations directly: `station` is one of its own
   entity kinds, and `api.dock(stationID)` is `api.ts:2409`.
2. **Drop fleet.** `api.leaveFleet()` (`api.ts:1278`), per pilot. Each companion
   decides for itself, so "all pilots drop fleet" is the emergent effect of one
   rung — never a broadcast, and never one pilot acting for another.
3. **Wait, bounded: 30 minutes.** Then stop and release the hull.
4. **Rejoin only the human who left.** `OnFleetInvite` carries the inviter's
   character id (`fleetCenter.ts:111`) and `api.acceptFleetInvite(fleetID)`
   (`api.ts:1231`) accepts it. Accept **only** from a character id that was a
   non-bot fleet-mate at the moment of abandonment, remembered on the record.
   ⚠ Without that gate, an idle docked companion can be fleet-invited by a
   stranger and handed a ship.

⚠ **Order is load-bearing.** Safe first, *then* leave. Leaving first gives up the
fleet-warp channel while the ship is still in space.

⚠ **The 30-minute clock must be persisted.** The roster row survives a BFF
restart (`persistRoster`), so an abandonment timestamp held only in memory hands
the companion a fresh 30 minutes on every restart — an unbounded wait assembled
out of bounded ones.

**One step cannot be built as asked: "a safe spot (the sun) if no station
exists".** There is no sun to warp to. The scene's entity kinds are `ship`,
`structure`, `drone`, `asteroid`, `stargate`, `station`, `sentryGun`,
`container`, `cynoField` and `signatureSite` — no sun, no planet, no celestial —
and there is no celestial read anywhere in `api.ts` or on the BFF, whose map
routes are static-data station and system lookups. Checked 2026-09-10.

What exists instead, and is better: **a bookmark.** `api.loadBookmarks` and
`api.warpToBookmark` (`api.ts:3823`, `:3830`) are both already there, so the safe
spot is one optional field on the request — `safeSpotBookmarkID` — and the
operator picks somewhere they have actually checked, rather than the celestial
every other pilot in the system also warps to. A system with no station **and**
no bookmark is the one case with nothing to do: the companion stops where it is
and says why, because a fabricated safe spot is worse than an honest stop.

## Work breakdown

Ordered by value per unit of work. Phases 1-3 need no gateway change.

| # | Phase | Depends on | Size |
| --- | --- | --- | --- |
| 0b | **DONE 2026-09-11.** Supervision gate + abandonment protocol (decision 5): the non-bot-member check as a top rung, dock, drop fleet, bounded wait, invite-gated rejoin | botHost persistence for the clock | medium; the rejoin gate is the careful part |
| 1 | `OnFleetBroadcast` + `OnFleetStateChange` decoders, store slice with TTL, `follow-the-fleet` block covering Target / AlignTo / HealShield / HealArmor | — | largest single chunk, entirely in-repo |
| 2 | Yield to `inWarp`; precedence rules | 1 | small |
| 3 | Tank-up block (hardeners + repairers, cap-aware) | — | small, independent |
| 4 | `api.ts` + flow actions + blocks for keep-at-range, fleet tag, jump-through-fleet | — | small, independent, routes exist |
| 5 | Drone recall-and-redeploy, with a measured hold-off | — | small |
| 6 | Flee-and-return with configurable thresholds | 2 | medium; the return half is the new part |
| 7 | Tackle detection, then tagging | 1 (for the live `targetTags` dict), 4, and the Unknowns below | medium, gated on a live check |
| 8 | Gateway fleet-chat patch, then the command parser and the sender gate | patch in `/d/evet` | medium, cross-repo |
| 9 | Squad roles: per-member script on the squad, launch pairs them, follower badge in the Bot Manager | 1-8 | medium |

Phases 3, 4 and 5 are genuinely independent and make good filler work; 1 is the
one to start with, because everything interesting depends on it and it touches
nothing outside this repo.

## Unknowns that need a live capture

Each of these is a fact about the running world, not a design choice. Settle
them with a real session before building on a guess — the
`join-advertised-fleet` handoff is on record as the cost of guessing one.

1. **The wire shape of a pasted destination link** in a chat backlog entry.
   **Still open, and now known to be unanswerable from source.** Investigated
   2026-09-10: eve.js never parses, strips, generates or special-cases EVE link
   markup anywhere in the chat path. Fleet chat arrives over XMPP;
   `extractBody` (`xmppStubServer.js:115`) is a `<body>` regex, `decodeXml`
   (`:81`) undoes exactly the five standard XML entities and nothing else, and
   `normalizeString` in `chatRuntime` is a bare passthrough. The message reaches
   the backlog as whatever literal bytes the retail client put in the stanza.

   That encoding is a property of the closed-source client, not of this server,
   so **only a capture settles it**: join a fleet with a real client, paste a
   station or system link into fleet chat, and read `entry.message` back — either
   by tapping `extractBody`'s input, or through
   `chatRuntime.getChannelBacklog(roomName)` directly, which needs no fleet
   support to exist yet. What to look for: whether it is an anchor, a bracketed
   `<url=…>` token, or something else, and **whether it contains literal spaces**
   — which is what would break a naive space-splitting command parser.

   **ANSWERED 2026-09-10 from the client** — see "The chat link format" above.
   The format is `<url=showinfo:5//ITEMID>Name</url>`, the numeric id is
   authoritative, and links contain spaces. `destination: <name>` remains a fine
   fallback, but the link form is now buildable.

   ⚠ The `/`-prefixed and `.`-prefixed chat commands in `chatCommands.js` are a
   **server-admin GM console**, not related to this feature. Do not build the
   fleet command parser on that mechanism or name commands so they collide with
   it.

2. ~~Whether a positive "scrambled" read exists.~~ **ANSWERED 2026-09-10: yes.**
   `OnJamStart` / `OnJamEnd`, pushed to the victim, already on the SSE stream.
   See the tackle section above. The space *snapshot* carries nothing — the
   answer was a notification, not a field, which is why looking only at
   `space.ts` said no.

3. ~~The NPC re-target cadence.~~ **ANSWERED 2026-09-10, and it kills the
   mechanic.** There is no target-loss memory and no drone cooldown; the AI
   re-scores by distance every 100-500 ms. See "Two things the server does not
   do" above. No measurement was needed — the AI is in the server source.

4. ~~Whether the two fleet notifications arrive wrapped in `__MultiEvent`.~~
   **ANSWERED 2026-09-10: no, never.** `notifyFleetMultiEvent`
   (`fleetRuntime.js:786`) has exactly one call site in the whole server
   (`:859`), it fires only when two or more member changes land at once, and the
   only name it ever wraps is `OnFleetMemberChanged`. Both of our notifications
   go through direct `notifySession` / `notifyFleet` calls. The decoder may
   assume unwrapped delivery.

   > ⚠ **This turned up a live bug, unrelated to this feature but in the code
   > phase 1 rewrites.** `applyPushedNotification` matches on the raw `method`
   > string, and `"__MultiEvent"` appears **zero** times in
   > `web/src/app/flow.ts`. So when the server batches two or more member
   > changes, the wire `method` is `"__MultiEvent"`, `fleetSnapshotNotifications
   > .has(method)` misses, and **the whole batch is silently dropped** — no
   > `scheduleFleetRefresh`. Fix it in phase 1: it is the same unwrap-then-
   > dispatch step the new decoders need, and the payload is a bare array of
   > `[name, args]` pairs.

5. ~~What `scope` and `rangeMode` look like in practice.~~ **ANSWERED
   2026-09-10: the client can trust every broadcast it receives.** `sendBroadcast`
   filters twice before any session is notified — range in
   `collectBroadcastRecipientSessions` (bubble / system / universe) and scope in
   `shouldReceiveBroadcast` (the recipient's role against the sender's). A
   session only ever receives a broadcast it already passed both filters for.
   `scope` still arrives as arg[1], but for labelling, not for filtering.

### The exact positional shape of both notifications

Read out of `fleetRuntime.js:2538` and confirmed against the decompiled
client's own handler signature (`fleetSvc.py:1542`,
`def OnFleetBroadcast(self, name, scope, charID, solarSystemID, itemID, typeID)`).
Recorded here because the tables above describe what the fields MEAN without
ever stating the order, and a decoder needs the order.

`OnFleetBroadcast` is SIX positional arguments:

```
[0] name                 one of the 15; the server refuses anything else
[1] scope                1 = DOWN, 2 = UP, 3 = ALL (fleetConstants.js:11-13)
[2] senderCharID         normalized server-side, plain safe number
[3] senderSolarSystemID  normalized server-side, plain safe number
[4] itemID               NOT normalized - see the subtlety below
[5] typeID               NOT normalized - see the subtlety below
```

⚠ **`senderSolarSystemID` sits BETWEEN the sender and the itemID.** A decoder
that assumes the obvious four-field shape reads the system id as the target.

`OnFleetStateChange` is ONE argument, and **the question the implementation doc
called "the one genuinely open question in phase 1" is now closed.**
`args[0]` is a `util.KeyVal` whose `targetTags` field carries the dict
(`buildFleetStateChangePayload`, `fleetPayloads.js:207-211`) - so `targetTags`
is ONE FIELD of a state object, not the payload itself. Both server call sites
(`fleetRuntime.js:899` fleet-wide, `:1675` on join) use the identical builder,
so there is no second shape to handle. The spec's belt-and-braces fallback
(treat `args[0]` as the dict if the field is absent) costs nothing and should
stay, but it is now insurance rather than a coin flip.

### One decoder subtlety, found while answering 4 and 5

`OnFleetBroadcast`'s `senderCharID` and `senderSolarSystemID` are normalised
server-side and arrive as plain safe numbers. **`itemID` and `typeID` are not.**
They are passed through from the original client call untouched
(`fleetRuntime.js:2538` — `itemID ?? null`, no `toInteger`), so if the caller
marshalled a 64-bit id, it reaches the gateway as a native `bigint` — and
`encodeJsonSafeCallValue` stringifies a bigint to a **bare decimal string**, not
a `{type:"long"}` wrapper.

So the decoder must tolerate `itemID` arriving as a number, as `null`, **or as a
bare numeric string**. Use the `positiveSafeID` idiom from `fleetCenter.ts:94`
(`unwrapLong` first, then a `/^\d+$/` fallback) rather than a bare `unwrapLong`,
which would return null for the string case and silently drop the broadcast's
target.

Fleet target tags do **not** have this problem: `buildTargetTagsPayload` runs
every key through `toInteger` server-side, so tag keys are plain JSON numbers.

⚠ **A READING OF THE MARSHAL PATH SAYS THE OPPOSITE, AND IT IS THE WRONG PATH.**
Re-checked 2026-09-11 after a survey concluded no bare-string case could exist.
That survey traced `sendNotification` -> `marshalEncode`, where a bigint becomes
a lossless `PyLongLong` and no string is ever produced. That is correct **for
the retail client**, which speaks binary Python-marshal. Our web client does
not: it reads the web gateway's JSON, and `encodeJsonSafeCallValue`
(`_secondary/express/evejsWebGatewayRuntime.js:4203`) is

```js
JSON.parse(JSON.stringify(value, (key, fieldValue) => (
  typeof fieldValue === "bigint" ? fieldValue.toString() : fieldValue
)))
```

applied to `notifications` on every response (`:6403`, `:6525`, `:6680`) and to
`notification` on the stream (`:6500`). A bigint id therefore reaches US as a
bare decimal string. **Keep the `/^\d+$/` fallback and keep the test that pins
it**, and do not let a marshal-path argument talk anyone out of either.

### The tag alphabet the real client actually offers

Settled 2026-09-11 from the decompiled client (`menusvc.py:1943-1948`). The
server enforces no vocabulary at all (below), but the stock client's tag menu
offers exactly:

- the digits `0`-`9`
- the letters `A B C D E F G H I J X Y Z` - note the classic gap, **no K
  through W**

So those are what a human FC in the real client will actually send, and they
are what our ranking should order deliberately. It does not narrow the reader's
obligation one bit: `normalizeFleetTag` still accepts any non-empty string, so
an unrecognised tag must be RANKED rather than dropped.

### The tag alphabet is ours to choose

Raised while specifying phase 1, and settled the same day: there is **no tag
vocabulary anywhere on the server**. `normalizeFleetTag` (`fleetRuntime.js:267`)
trims and accepts any non-empty string, and no constant, allowlist or ordering
exists in `fleetConstants.js` or elsewhere.

So "target priorities 1-9" and "tag with letters" are not two different server
mechanisms — they are the same free-text field with two different human
conventions written into it. Two consequences for the code:

- **Our writer picks its own letters.** A, B, C in kill order is a decision, not
  a discovery, and needs no live capture to make.
- **Our reader must tolerate anything.** A human FC in the real client can type
  whatever they like into that field. Rank an unrecognised tag last rather than
  dropping the row — a tagged ship the bot cannot rank is still a ship the fleet
  has singled out.

When capturing any of these, record the protocol and not the payload: field
order, byte counts, which fields are omitted. Character ids and names from the
capture session do not belong in the fixtures.
