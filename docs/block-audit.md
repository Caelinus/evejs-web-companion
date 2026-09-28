# Bot-block audit — every player action we can reasonably automate (2026-07-24)

The working list of blocks, reconciled against **what the client can actually do
today**. Unlike [block-catalog-brainstorm.md](block-catalog-brainstorm.md) (the
wish-list), every proposed block here is tagged with the concrete bridge call or
existing `ScriptAction` that backs it, so the feasibility tag is grounded, not
guessed.

Legend
- ✅ **shipped** — a block exists today.
- 🟢 **rides verified actions** — composes `ScriptAction`s the runner already
  issues live (`lock` / `activate` / `orbit` / `warp` / `moveItems` …). Low risk;
  the mechanic is proven, only the block wrapper + observe-hint is new.
- 🔌 **write plumbed, unverified** — the BFF write route + bridge ack decoder
  exist, but the memory notes these Phase-3/4 writes are *fast-mode educated
  guesses, never fired live*. Needs one live QA pass before trusting.
- 🛠️ **format / orchestrator work** — no gateway call; new program shape, a new
  condition kind, or a client-only behaviour.
- ❓ **needs research** — the retail path or a missing write is unconfirmed.

Category = the play-loop filter key in `macroCatalogView.ts`
(`movement · combat · mining · hauling · market · missions · industry · ship ·
planets · fleet · flow`).

---

## 1. Shipped today (44 blocks)

| Category | Blocks |
|---|---|
| movement | undock · travel-to-station · travel-to-belt · warp-to-bookmark · **set-destination** · **dock-at-nearest** · **travel-to-system** |
| mining | mine-at-belt (+ nearest / biggest / **most valuable** rock order) · **compress-ore** |
| combat | defend-with-drones · hardeners-on · fight-the-rats · warp-to-anomaly |
| hauling | deliver-ore · unload-cargo · salvage-wrecks · loot-wrecks · move-items · **jettison-cargo** · **tidy-hangar** |
| industry | refine-ore |
| market | buy-item · sell-item |
| missions | find-distribution-agent · request-mission · accept-mission · load-mission-cargo · travel-to-dropoff · turn-in-mission · return-to-agent · find-combat-agent · fly-to-mission-site |
| ship | refit-ship · repair-ship |
| planets | restart-extractors |
| fleet | remote-rep · orbit-and-boost · **remote-cap** · create-fleet · invite-to-fleet · join-fleet · **join-advertised-fleet** |
| social | **send-chat** |
| flow | wait (+ branch / sub-bot / board-slot program nodes) |

**Watches (interrupts):** shield / armor / hull / health / capacitor-below ·
hostile-on-grid · wallet-below/above · **cargo-full** · **players-in-system-above**
· **targeted-by-player** · **drone-health-below**.
**Responses:** pause · dock-and-pause · **dock-and-repair** · launch-drones · fight-back · repair · **alert**.

Plus the **watches** (interrupts): shield/armor/hull/health/capacitor-below,
hostile-on-grid, with responses pause / dock-and-pause / dock-and-repair /
launch-drones / fight-back / repair.

---

## 2. Proposed new blocks

### flow — program logic (greenlit: "control flow")
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **branch-lite** — if a check holds, run block A, else B | new `ProgramNode` | 🛠️ | The HRM model is branchless today; needs a `BranchBlock` node + forward-scan handling. One level, no cycles (keeps the livelock proof). |
| **run saved bot as a block** (sub-bots) | new `ProgramNode` + orchestrator | 🛠️ | Inline another saved script as one step. Format + a depth/size cap (no recursion). |
| **named board slots** — "the station block 2 found" | new `Arg` reading the run board | 🛠️ | The board already carries facts across steps; this lets a later block's arg *read* one. |

### market — the transaction loop — ✅ SHIPPED 2026-07-24
Correction to the earlier read: general `placeMarketBuyOrder` / `placeMarketSellOrder`
routes DO exist (the R16 market panel's own writes, escrow-verified) — so a general
buy AND a general sell are both buildable, not just PLEX.
| Block | Backing | Status | Notes |
|---|---|---|---|
| **buy-item** (N units, up to price P each) | `placeMarketBuyOrder` | ✅ | One-shot order; server confirm-gated; spends ISK. Flag for one live QA. |
| **sell-item** (all of item X, at ≥ price P) | `placeMarketSellOrder` per stack | ✅ | Lists each hangar stack; the stack leaving the hangar is the confirm. |
| **wallet-below / wallet-above** watch | `loadWallet` (per-tick when watched) | ✅ | New condition kinds carrying absolute ISK; a wallet-watching bot pays for the read, others don't. |
| **restock to N** before undock | buy + `moveItems` | 🟢 | Composable by the player today (buy + move); a dedicated block is a nicety. |
| sell/update PLEX | `PlacePlexSellOrder` / `ModifyPlexCharOrder` | 🔌 | PLEX-specific; skipped (general sell covers the need). |

### fleet — logistics & support — ✅ SHIPPED 2026-07-24
The fleet-roster read is decoder-only (not wired to api/flow), but it isn't needed:
the space snapshot already carries every ship's owner + health each tick, and players
are FRIENDLY in this world — so "the most-hurt friendly ship on grid" targets fleet-mates
without a roster read.
| Block | Backing | Status | Notes |
|---|---|---|---|
| **remote-rep** (rep the most-hurt friendly) | snapshot filter + `lock` + `activate` | ✅ | Reactive; done when everyone on grid is full. Reps resolved by group name (`/remote shield|armor/i`). |
| **orbit-and-boost** (stay on a mate, keep repping) | `orbit` + remote-rep core | ✅ | Sustained logistics loop; a watch or the player stops it. |
| **remote cap transfer** | `lock` + `activate` | ✅ | Same pattern with a cap transmitter. Fired live 2026-07-25 — see §3. |
| **create-fleet** (form up, become boss) | `fleet/create` + `bound-fleet` read | ✅ | Argless; done once `inFleet` reads true. |
| **invite-to-fleet** (invite a known pilot) | `fleet/invite` (inviteeCharID) | ✅ | Picks from the local known-pilots roster; requires being in a fleet. |
| **join-fleet** (accept a pending invite) | `fleet/invite/accept` + `bound-fleet` read | ✅ | Reactive — keeps accepting until `inFleet` true (bounded). The multibox alt-fleeting loop: char 1 create+invite, alts join. |
| **join-advertised-fleet** (join a named fleet from the finder) | `fleet-ads` read + `fleet/apply` + `bound-fleet` read | 🔌 | The pull twin of join-fleet: no invite needed, the alt finds the boss's advert by NAME. **Opportunistic** — already fleeted, or nobody advertising that name, both finish `done` so a mining loop carries on alone; only an apply that never lands blocks. Name match is trimmed + case-insensitive but never a substring; ties go to the bigger fleet. ⚠ `ApplyToJoinFleet` is a fast-mode decoder never fired live — owed the same QA pass the create/invite/join set got on 2026-07-25. |
| **warp to a fleet member** | fleet-warp / warp-to-member | ❓ | Deferred — the write is unconfirmed. |
| fleet **broadcast / kick / make-leader** | `boundFleetWrites` | 🔌 | *Educated-guess, never fired live*; low bot value — deprioritised. |

⚠ create/invite/join WRITES are fast-mode decoders never fired live — the `bound-fleet` READ that gates/confirms them IS verified live (FleetNotFound → a real "not in a fleet"). Owed one live QA pass, which the multibox alts make testable.

### social — talking — send-chat ✅ SHIPPED 2026-07-24
| Block | Backing | Status | Notes |
|---|---|---|---|
| **send-chat** (say one line in local/corp) | verified R7 `/chat/:channel/send` | ✅ | Fired live 2026-07-25: read back out of the local backlog with the right sender. Inside a branch = "announce when a check holds". |
| chat as a WATCH RESPONSE ("if shields drop, call for help in corp") | same send | 🛠️ | Needs an `InterruptResponse` variant carrying text — the branch composition covers most of it today. |
| private/named channels, EVE-mail | LSC joined-channel writes ❓ | ❓ | Only local/corp are plumbed on the BFF chat route. |
| **alert the player** response (browser notification / sound) | client-only | 🛠️ | Still the best "get a human" primitive — pairs with server-bot vitals. |

### combat — module & targeting primitives
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **launch / recall drones** (standalone) | `launchDrones` / `recallDrones` | 🟢 | Exists as an interrupt response; a plain block is trivial. |
| **mining drones on a rock** | drones/mine route | 🔌 | Route exists; widen the drone-engage path to ore. |
| **orbit / keep-at-range a target** | `orbit` | 🟢 | Generic positioning block. |
| **speed module on/off** (AB/MWD) | `activate` / `deactivate` | 🟢 | On while closing, off in orbit / cap-starved. |
| **overheat a rack** | — | ❓ | Only if the heat path is in eve.js. |
| **reload / load a charge** | — | ❓ | Charge-swap write unconfirmed. |

### hauling — cargo & logistics
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **jettison / jetcan** | `decodeJettisonAck` (CmdJettison) | 🔌 | Ack decoder exists; pairs with jetcan-mining. |
| **stack & tidy hangar** | stack-all | 🔌 | Small quality-of-life block. |
| **pickup run** (collect item X across stations → deliver) | travel + `moveItems` | 🛠️ | Multi-stop; composes existing travel + move with a station list. |

### mining — extras
| Block | Backing | Tag | Notes |
|---|---|---|---|
| ~~**mine biggest rocks first**~~ ✅ | the snapshot's own `remainingQuantity` | ✅ | Shipped. The survey read turned out NOT to be the backing: `miningScanMgr.perform_scan` answers a strict SUBSET of what the snapshot already carries (both read `getMineableState`), so the picker reads the row it already had. |
| **mine across belts / the constellation** | belt rotation + travel | 🛠️ | Rotate belts across systems (deferred in the shipped mine block). |
| **ice / gas variant** | module-group picker widening | 🔌 | Mostly the equipment picker recognising ice/gas harvesters. |

### industry
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **install a manufacturing job** | `decodeJob` / `decodeJobs` writes | 🔌 | Blueprint + materials at station. |
| **deliver finished jobs** | `decodeCompleteManyJobsAck` | 🔌 | Collect completed job output. |
| **build-from-minerals loop** | refine + install + deliver | 🛠️ | Composes the above with refine-ore. |

### ship & fitting
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **board ship by name** | `boardShip` action (exists) | 🟢 | The reship primitive without a full fitting. |
| **insure the ship** | insurance bridge | 🔌 | One-shot docked action. |

### movement
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **dock at the nearest station** | dock (panic already computes nearest) | 🟢 | Promote the safety-floor's own "nearest station" to a block. |

### planets
| Block | Backing | Tag | Notes |
|---|---|---|---|
| **collect PI → haul home** | launchpad / customs-office chain | ❓ | Extractor restart shipped; the *collect + haul* chain needs the pickup write path researched. |

### awareness — new conditions & one response
| Item | Backing | Tag |
|---|---|---|
| conditions: local-count-above-N · targeted-by-a-player · drone-health-low · cargo-full (generic) · missions-completed≥N | reads mostly exist | 🛠️ |
| **alert the player** response (browser notification / sound) | client-only | 🛠️ |

---

## 3. The 2026-07-25 pass — what landed

Everything from items 1–7 of the previous ranking, plus a block the operator asked
for directly. All live-verified in the app; full suite 2884/2884.

| Item | What shipped |
|---|---|
| **alert-the-player watch response** ✅ | A new `InterruptResponse` **"alert"**: browser notification + two short WebAudio beeps + a held `lastAlert` on the readout, and (the case that matters) folded onto the SERVER-bot record so `/api/bots` and the Server Bots panel carry it when no tab exists. Two properties make it behave, both in the orchestrator: it fires **once per episode** (re-arms only when its condition reads not-met — a cannot-tell keeps it spent, so a blind read never cries wolf), and a spent row is **transparent**, so an alert row above a dock-and-pause row no longer silences it. The editor's `+ Alert me too` inserts the twin ABOVE its partner, which is the order that makes "tell me AND dock" work. LIVE: fired once, kept the program running, and delivered through the readout with notification permission DENIED. |
| **tackle before guns** ✅ | The PvP engage core now runs point → web → drones → guns. Tackle is SDE-grounded: group **52 "Warp Scrambler"** holds every Warp Disruptor *and* Scrambler (63 types), group **65 "Stasis Web"** the webifiers; both regexes anchored so "Warp Core Stabilizer" and "Structure Warp Scrambler" cannot match. ⚠ Bounded at `MAX_TACKLE_ATTEMPTS` per target — a point out of range is refused silently, and "activate the idle point, else shoot" would then pick the point every tick and never fire the guns. |
| **new conditions** ✅ | `cargo-full` (the ordinary hold, gated inventory read), `players-in-system-above` (local-chat roster; **0 means "anyone at all"**), `targeted-by-player` (a player ship whose own lock points at this hull — no new read), `drone-health-below` (own drones on grid — no new read). The three surroundings reads are **interrupt-only** by `conditionSites`, same guard as `hostile-on-grid`. Read gating generalised from one `walletWatched` boolean to `scriptWatchedConditionKinds(doc)`. |
| **dock-at-nearest** ✅ | The panic override's nearest-dockable pick as a block, riding `decideCloseIn`; recalls drones before warping off. |
| **remote cap transfer** ✅ | `remote-cap`, SDE group **67 "Remote Capacitor Transmitter"** (anchored so the five self-only "Capacitor …" groups cannot match); feeds the emptiest mate from the snapshot's own `capacitorRatio`. |
| **jettison + tidy hangar** ✅ | `jettison-cargo` (whole hold or one item type; confirm-gated `ship/Jettison`, confirmed by the hold emptying) and `tidy-hangar` (`inventory/stack` StackAll, one shot). |
| **biggest rocks first** ✅ | An OPTIONAL `pick` arg on mine-at-belt using the snapshot's existing `remainingQuantity` — no survey read needed, and the default stays `nearest` so proven behaviour is untouched. Unknown amounts sort last (a null is not a zero). |
| **value ordering with no list** ✅ (operator ask) | An EMPTY ore priority list is no longer "mine anything": the block restricts to the rocks worth the most per m³ on the grid and falls through to the next ore as they run out — the list a player would have written by hand if they were ranking by what a hold is worth. A hand-written list is left exactly as written, because typing one answers a different question ("I need THIS ore") from "what is this belt worth". ⚠ It RESTRICTS, it does not ROTATE: the set only ever shrinks within rocks already on this grid, so a bot cannot start touring belts chasing an ore it saw elsewhere, and the rock currently being worked stays a candidate so a richer rock drifting into view cannot make it drop a half-mined one. Unpriced ore is not cheap ore — with nothing priced the block picks exactly as it always did. |
| **most valuable ore first** ✅ (operator ask) | The third `pick` order, and the one the retail client's Mining Surveyor tooltip actually shows: its "Ore Value" gradient is not a server read at all but a CLIENT computation (`mining_util.get_volume_est_price` — reprocessed material value × 0.66 ÷ portion size ÷ unit volume). The same arithmetic now runs once in the BFF (`staticData.getOreValuePerM3`) and is stamped onto rock rows as `oreValuePerM3`, beside `oreGrade`. Per m³ because a hold is a volume: it is what one TRIP is worth, which is what makes a bot mine the Kernite instead of the nearer Veldspar. The prices are this server's own average prices — its config service builds that table from each type's static `basePrice`, so the number agrees with what the in-game client would show. Unpriceable ore sorts last (a null is not a zero), and **ties break by distance**, without which a belt of one ore would pick whichever rock the snapshot listed first. |
| **set destination + autopilot** ✅ (operator ask) | `set-destination` points the shared autopilot at a station **or a whole system** and finishes once the trip is under way, rather than waiting for arrival. New `destination` Arg kind (entity station|system, closed set) and a `allowSystems` mode on StationPicker. |
| **fly to a system and WAIT** ✅ (operator ask) | `travel-to-system` — the arrival-waiting twin of `set-destination`, on the same shared autopilot (`startSystemRoute`). Exists because set-destination finishing early is a trap in front of any grid-reading block: caught live 2026-09-08, a mining bot pinned to a belt one system over mined a single lap (it was started in-system) and then stopped every lap after with *"the belt this step is pinned to is not on this grid"*, because `mine-at-belt` became the active step while the ship was still leaving home. Arrival is judged on the SYSTEM ID alone — docked counts, because the autopilot's own system plan treats a dock in the destination system as arrived and will not undock for it. New `system` Arg kind (systems ONLY, so a station cannot sit in a slot the block could never fly to) and a `scope` prop on StationPicker replacing the old `allowSystems` boolean (`"station"` / `"any"` / `"system"`). |
| **compress ore on grid** ✅ (operator ask) | `compress-ore` — the FLEET mechanic. A mining support ship on grid running an Industrial Core plus a compression module is a facility (`resolveCompressionFacilityTypelistsForEntity`), and `inSpaceCompressionMgr.CompressItemInSpace(itemID, facilityBallID)` swaps an ore stack in your own hull for its compressed type at the same quantity — ~100× less volume in this build (Veldspar 0.1 m³ → Compressed Veldspar 0.001 m³, checked in the SDE). The block finds the facility from a READING, closes to its range on the shared ladder, then works the hold one stack per tick. ⚠ **needs the server-side half** — see below. |

### compress-ore: PROVEN LIVE (2026-07-25)

With the gateway change deployed, compression works end to end. On a Porpoise
running a Medium Industrial Core I plus a Medium Asteroid Ore Compressor I:

- the ship's own snapshot row reported `compressionFacility {rangeMeters:
  375000, typeListIDs: [334]}` — the projection working on real data;
- the compress route turned **2000 Scordite into 2000 Compressed Scordite**
  (typeID 1228 → 62520): 300 m³ down to 3 m³, `compressed: true` with the tuple.

Two findings worth keeping:

- **Module effects do not survive a session handover.** The core and compressor
  switch off when the character is re-selected or handed to a server bot, so a
  server-bot run cannot hold up its own facility. That is the intended shape
  anyway — the facility is a fleet-mate's job — but it does mean the own-ship
  case is a manual-play convenience, not a bot-drivable one.
- **Ice products are not ore.** Heavy Water and friends have no compressed twin;
  only raw ore/ice types do. The block asks once per stack and moves on, which is
  the right behaviour for a hold holding both.

⚠ The FLEET-MATE path — the intended workflow, where a miner compresses against
somebody else's support ship — is still unproven, because forming a two-character
fleet is broken; see below.

### ⚠ compress-ore depends on an EveOffline change (2026-07-25)

Before that gateway change the live server refused it outright:

```
403 CALL_NOT_ALLOWED
inSpaceCompressionMgr.CompressItemInSpace is not on the web-call allowlist.
```

Two additions are needed in the emulator (branch `feat/web-gateway-ore-compression`
off `origin/main` in the EveOffline repo, with 6 tests):

1. the `inSpaceCompressionMgr.CompressItemInSpace` allowlist pair — the callMethod
   bridge is deny-by-default, so the call is refused before dispatch. Every guard
   worth having is already server-side (in space, same scene, live typelists,
   own-ship-or-same-fleet, in range, and the item must be the caller's and in the
   caller's own hull), so nothing is re-derived on the web side.
2. a `compressionFacility {rangeMeters, typeListIDs}` projection on ship rows in
   the web snapshot. This is PARITY, not invention: the retail client is already
   told, via `compression_facility_typelists` on the ship's slim item. Without it
   a web client could only find a facility by trying the call against every ship
   on grid — and the handler answers "not a facility", "out of range" and "this
   ore has no compressed form" with the same null, so it could never say which.

Without it, `compress-ore` blocks with a plain reason rather than firing
hopefully: the snapshot carries no facility reading, and an ABSENT reading is
treated as "not a facility" everywhere (client type, decoder and block agree).

### The fleet blocks never worked — four bugs, all fixed (2026-07-25)

Driving two live sessions against `create-fleet` / `invite-to-fleet` /
`join-fleet` for the first time turned up four separate faults. They had been
shipped as "fast-mode decoders, never fired live"; this is what that was hiding.

1. **`CreateFleet` answers ok and leaves you in no fleet.** `createFleetRecord`
   mints the record but adds no member row and no `characterToFleet` mapping —
   `Init` on the returned bound object is what makes the creator the boss. FIXED:
   the route binds THROUGH CreateFleet and calls Init. Verified: the fleet then
   exists with the creator aboard, and `Invite` — which had refused with
   FleetNotFound — succeeds. Needs the new `fleetObjectHandler.Init` allowlist
   pair (EveOffline `feat/web-gateway-ore-compression`).
2. **`AcceptInvite` needs the fleet's own id, which the invitee cannot derive
   from membership because they have not joined yet.**
   The handler resolves it from the caller's bound object, falling back to
   `session.fleetid` — nothing, before joining. FIXED: the route takes an
   explicitly required positive `fleetID` from the live pending
   `OnFleetInvite` and binds against that fleet. `RejectInvite` follows the same
   rule. `Reconnect` is different: it requires the positive saved fleet ID from
   the session's reconnect state. In all three cases the runtime state remains
   the authority, and the BFF uses a targeted uncached handle so an old
   session-owned bind cannot select the wrong fleet. These IDs identify the
   already-authorized pending/saved relationship; they grant no new privilege.
3. **The bound-fleet read reported a CACHED fleetID** — the BFF's held-session
   snapshot, taken at select and never refreshed — so a fleet formed since read
   as none. That is why `create-fleet`'s `inFleet` gate could never see its own
   success. FIXED: `decodeBoundFleet` prefers `GetInitState.fleetID`.

4. **`FleetNoPositionFound` on accept — a wing/squad of 0 was taken literally.**
   The BFF sent `Number(body.wingID) || 0` for "no preference", and
   `inviteCharacter` overwrote the placement it had just resolved because
   `0 != null`. Wing ids are allocated from 1, so the invite was stored pointing
   at a wing nobody can be in — and it failed nowhere near the caller, on ACCEPT,
   with an error that reads like the fleet is full. FIXED on both sides: the BFF
   only sends a POSITIVE id, and the runtime only lets a positive id override
   (EveOffline `fix/fleet-join-no-position`, PR #33, with
   `server/tests/fleetJoinPlacement.test.js`).

✅ **Verified live, end to end:** create → invite → accept put both pilots in one
fleet; the miner's snapshot then carried the fleet-mate's
`compressionFacility {rangeMeters: 375000, typeListIDs: [334]}`, and 1000
Scordite compressed to 1000 Compressed Scordite in the miner's own hold. That is
the intended workflow — miner mines, support ship sits in fleet running its core
and compressor, miner compresses — so `join-fleet` and the fleet-mate half of
`compress-ore` are both proven.

### The last three unfired calls, fired (2026-07-25)

Everything below was shipped as "plumbed, unit-tested, never fired live". All
three are now proven against the running server, and — as with the fleet blocks
— each was judged by a STATE DELTA, never by a 200.

**send-chat.** A line into local came back out of the `local_30005239` backlog
with the right sender. Worth recording what the same pass showed: the gateway's
`/chat/send` calls `broadcastLocalMessage` DIRECTLY, so it never reaches
`executeChatCommand`. A slash command typed by a bot is published as chat text
and never dispatched. That is the right call — a bot must not be able to run GM
commands — but it means the send-chat block cannot be used to drive them.

**tidy-hangar (StackAll).** Split 250 Scordite off a stack to make a second row,
then stacked: 73,416 + 250 → one row of 73,666.

**tackle + remote cap.** Test Pilot in an Astero — Warp Disruptor I (group 52),
Stasis Webifier I (group 65), Small Remote Capacitor Transmitter I (group 67),
all three ONLINE and picked up by `resolveDefenseModuleIDs` /
`resolveRemoteRepModuleIDs` — against Gaston in a Hulk, in Aring (0.267, so
lowsec: the emulator's CONCORD response is gated at 0.5 and never fires).

| what | evidence |
| --- | --- |
| **point** | cycles in `activeModuleIDs`, and the target's own warp attempt came back `You cannot warp because you are warp scrambled` |
| **web** | cycles, and the target's speed fell 200 → 101 m/s under it (Stasis Webifier I is −50%), recovering to 151 once it was switched off |
| **remote cap** | cycles, and the SENDER's capacitor paid for it: 0.876 → 0.610 over ~21 s of transfer |

⚠ **The range gap is real, and this is what it looks like.** At 17.9 km the point
came on but the web and the transmitter both refused
`TargetNotWithinRangeGeneric` — correct, they are 10 km and ~6 km modules. Only
after closing to ~2 km did the whole ladder run. A bot that locks whatever is on
grid and fires will land its point and get a refusal from everything else. See
gap 5 below: this is no longer a hunch.

## 4. Remaining gaps, ranked (refreshed 2026-07-25)

1. **industry jobs** (install / deliver, 🔌) — the last untouched play loop, and
   the biggest remaining piece of work: needs the job writes exercised once live.
2. **insure the ship** (🔌 + ❓) — deliberately NOT built. The route exists
   (`insurance/insure-ship`, confirm-gated) but it SPENDS ISK, has never been
   fired live, and `InsureShip(itemID, quotedPremium, …)` needs a quote read that
   is not plumbed. Not worth shipping a financial write that cannot be verified.
3. **chat as a watch RESPONSE** ("call for help in corp when shields drop", 🛠️) —
   needs `InterruptRow` to carry text, which no response does today. The
   send-chat block inside a branch covers most of it.
4. **richer PvP target filters** (corp / alliance / an ignore list, 🛠️) — the
   snapshot already carries `corporationID`/`allianceID` per ship; this is Arg
   shapes and pickers, not new reads. The one-pilot `only` filter exists.
5. ~~close the distance in the PvP blocks~~ ✅ **DONE** — see §5.
6. **missions-completed ≥ N condition** (🛠️) — needs the journal read gated in.
7. **mine across belts / the constellation** (🛠️) — belt rotation across systems.
8. **ice / gas harvester variants** (🔌) — mostly the equipment picker widening.
9. **jetcan mining loop** (🛠️) — compose jettison + a hauler alt now that both
   halves exist.

Still **not buildable without new BFF work**: PI collect-and-haul, overheat,
charge reload/swap, fleet-warp, named/private chat channels, EVE-mail.

## 4. Recommended build order (historic, pre-2026-07-24 — kept for context)

1. **market: buy-item + restock + wallet watches** — the greenlit transaction
   loop; the one general market write (`BuyMultipleItems`) plus two new condition
   kinds. Ship behind a confirm; flag for one live QA.
2. **fleet: remote-rep + orbit-and-boost** — greenlit and 🟢 (rides verified
   `lock`/`activate`/`orbit`); the real value is the logistics loop. Defer
   fleet-warp (❓) and fleet management (low value).
3. **flow: branch-lite + named board slots** — greenlit control flow; the
   deepest change (touches the forward scan), so it lands after the additive
   blocks prove the pipeline extensions. Sub-bots follow branch-lite.
4. **combat primitives + dock-at-nearest + jettison** — small 🟢 blocks that fill
   obvious gaps and unlock jetcan mining / better ratting safety.
5. **mining survey-picker + industry jobs** — 🔌 blocks gated on one live QA each.

**Do not build without new BFF work:** general sell-orders / update-orders for
arbitrary items (only PLEX is plumbed), overheat, charge reload, PI collect-haul,
fleet-warp.

## 5. Closing the distance (2026-07-26)

The engage ladder now BURNS toward its target before it works the modules, and
that took two passes — the second one only because the bot was watched doing it.

**The gap.** A lock lands from much further out than the guns and the web reach,
so "locked" never meant "in reach". It only looked that way because the point,
the longest-ranged of the three, usually worked. Measured live at 17.9 km: the
point came on, the web and the remote cap both refused
`TargetNotWithinRangeGeneric`.

**The first fix** put an `approach` in the ladder after the lock, once per
target (a standing follow order on the server, not a nudge to repeat), and made
the web wait for its own 10 km reach.

**⚠ It made things worse, and only a live run showed it.** The bot undocked,
closed on its target, reported "Guns on them" — and the target was neither
pointed nor webbed, and warped off unhindered. The point had been fired three
times during the burn; `MAX_TACKLE_ATTEMPTS` went entirely on refusals nobody
could have expected to land; and by the time the ship arrived, tackle was off
for that target for good. **The longer the approach, the more certain the budget
was gone before arrival** — so adding the approach turned a brief bug into a
reliable one.

**The second fix** is the rule that was missing: the budget exists to catch a
module refusing for a reason we *cannot see*, and an out-of-range refusal is not
that — the range is right there in the snapshot. Both halves now wait for their
own reach (point 24 km, the generous end of group 52 so a disruptor is not held
back on the chance it is a scram; web 10 km), and **a shot skipped for range is
not an attempt**.

**Verified live, by the bot itself**, running `Leave the station` →
`Attack Gaston Vernier if they appear here`:

| the bot's own words | what the target saw |
| --- | --- |
| Locking the player's ship. | — |
| Closing in — too far out for the web and the guns. | 33.9 → 30.4 → 26.8 → 23.2 → 19.7 → 16.1 → 12.5 km |
| Holding them in place so they cannot warp off. | `You cannot warp because you are warp scrambled` |
| Guns on them. | max velocity **200 → 100** the moment it crossed 8.96 km |

The web came on at 8.96 km — inside its 10 km reach, on a budget that had
survived a 25 km burn. That is the whole fix in one number.

### Two more, found the same way (2026-07-26, later)

Watching a second and third run turned up two more faults that the range checks
had *hidden* rather than fixed.

**One shared budget meant "if the point struggles, the web never fires".**
`POINT_RANGE_M` was set to 24 km to cover both halves of SDE group 52 (Warp
Disruptors ~20 km, Warp Scramblers ~9 km). That put the limit ABOVE what a
disruptor can actually do, so the engage kept firing into the 20–24 km band, the
refusals were charged to the budget — and because the point and the web *shared*
one counter, the point spending it left the web permanently disarmed. Observed
live: point cycling, web idle, at a range of **230 metres**.

Fixed twice over: the limit is now a disruptor's own 20 km optimal, and each half
carries its own attempt count. One module's bad luck can no longer disarm the
other.

**Clean run afterwards**, from 25 km: point on at **19.85 km** (first attempt,
inside its own optimal), web on by **5.4 km** with the target's max velocity
halved, guns after. Every stage is in the screenshots.

## 6. Bug sweep across the other blocks (2026-07-26)

Having found three faults in the PvP ladder by watching it run, I swept the rest
of the deciders for the same shapes rather than reading them line by line. Two of
the four classes turned up real bugs.

### ⚠ The remote blocks could fire into nothing, forever

`remote-rep`, `orbit-and-boost` and `remote-cap` each issued their activate and
returned `mem` **unchanged**. A module that would not come on was found idle
again next tick and re-fired — no counter, no progress, no reason surfaced. And
neither block can finish while it is failing: remote-rep reports `done` only when
everyone on grid is full, remote-cap when everyone has cap to spare. **A
fleet-mate parked out of reach was an infinite loop.**

Neither had a range check either, though a lock reaches far further than remote
assistance does (measured: a Small Remote Capacitor Transmitter I refused at
17.9 km, ran at 2.2 km). Both now close on a mate out of reach, once per target,
and do not spend an attempt on a module they can see cannot reach.

The bound counts **consecutive** failures only — a module observed cycling refills
the budget. Without that the fix would itself be a bug: a bot that stops repping
mid-fight after three cycles.

`salvage-wrecks` was already doing this correctly (`dist > SALVAGE_RANGE_M` →
wait), which is what the fix was modelled on.

### ⚠ A roaming hunt went progressively blind

`visitedHits` — the itemIDs of scanner hits already chased — rode along on every
jump. A hunt that returned to a system it had swept before still counted those
hits as visited and would not chase them, though the ship in question is a live
target now. The longer the roam ran, the less of its hunting ground it would look
at. The list also grew with no cap, unlike `triedItemIDs`.

Leaving a system now drops everything scoped to it. The vantage-point branch
already reset the list for a weaker reason, so the precedent was there.

### Swept and clean

- **Side-effecting ticks returning memory unchanged** — mechanical sweep of every
  `return tick(...)` carrying an `activate`/`lock`/`warp`/… action found exactly
  two sites beyond the ones fixed: the salvager (range-guarded, above) and
  `fight-the-rats`' guns.
- **Watch responses** — `repair` re-fires each tick by design, and local
  repairers have no target and no range, so there is nothing to bound.

### Deliberately NOT changed: the guns

`fight-the-rats` and the engage ladder re-fire idle guns with memory unchanged,
the same shape as the bug above. Here the re-fire is **correct**: a gun drops out
of `activeModuleIDs` between cycles and has to be switched on again, so bounding
it would stop the bot shooting. The right guard is a range check — and gun ranges
run from 2 km blasters to 250 km artillery, so picking one number would repeat the
`POINT_RANGE_M` mistake exactly. It needs the fitted weapon's own optimal, which
the client does not currently carry. Left alone on purpose.

### Second sweep — classes checked, nothing found (2026-07-26)

Recorded so a later pass does not spend the time again. Each of these was checked
because it has produced a bug in this codebase before, or because getting it wrong
would be severe:

| class | verdict |
| --- | --- |
| memory rebuilt field-by-field in `runProgram` | all four returns spread `...mem` first — the `spentAlerts` bug is fixed and stayed fixed |
| threshold units (a `%` box vs a 0-1 ratio) | correct both ways: `pct(f) = f * 100` out, `clampFraction(p / 100)` back |
| the four newer conditions | all route a missing reading to `cannot-tell`, never to a verdict |
| the alert latch (`releaseSpentAlerts`) | releases only on `not-met`, so a blind tick cannot re-alert |
| `done` reachability + premature completion | every `done` is behind a real reading; `hardeners-on` is the model — bounded, then **blocked with a reason** |
| `pickRock` "biggest first" | a null `remainingQuantity` is skipped, not read as zero, and falls back to nearest |
| `pickRock` "most valuable first" | same rule for a null `oreValuePerM3`; ties (a belt of one ore prices every rock alike) break by distance rather than by list order |
| `richestRocks` (the ore priority nobody typed) | restricts within THIS grid only, so "the belt is dry" still means no rocks at all; the rock being worked stays a candidate; nothing priced = no restriction |
| interrupt ↔ block memory | every interrupt path passes `mem` through, so a firing watch cannot reset a bounded ladder (watches run every tick, so this one mattered) |
| ISK precision | the decoder keeps bigint-safe strings for display; the watch compares a `number`, imprecise only above 2^53 ISK — no practical effect on a threshold |
| R7d (no raw ids in player text) | every arg render falls back to a phrase ("a pilot you pick") when the name is missing |
| BFF write routes answering `ok` unverified | four found; all four are covered either by a server-side throw or by the block re-observing next tick, which is the architecture's own answer |

## 7. The mission chain, fired live (2026-07-26)

The last untouched play loop. Run as the shipped **Delivery runs** preset against
a real agent, one delivery, judged by state deltas.

**The setup matters for anyone repeating this.** Test Pilot's own station has two
level-4 *Security* agents (division 24) — combat, useless for a courier test. The
nearest *Distribution* agent (division 22) is one jump out in Chej. A BFS over
`mapStargates.jsonl` finds it in a second and is worth doing before driving
anything; `find-distribution-agent` independently picked the same agent, which is
the first result of the run.

| block | verdict |
| --- | --- |
| `find-distribution-agent` | ✅ picked Mebhiyen Ranaka, the nearest level-1 courier agent, matching an independent BFS |
| the travel leg | ✅ set destination, undocked, warped, **jumped a gate**, warped in, docked — the autopilot end to end |
| `request-mission` | ✅ a real courier offer on the table |
| `accept-mission` gates | ✅ correct: turned down 4 × 60 m³ against a 120 m³ hold, and 10 jumps against a 6-jump ceiling — then **stopped with a player-readable reason** after `MAX_BLOCK_ATTEMPTS`, exactly as designed |
| `load-mission-cargo` | ✅ package aboard — 3 units, 1,800 m³ of a 4,875 m³ hold, read back from the hold |
| `travel-to-dropoff` | ✅ flew the **10 jumps** and docked at 60008332, the exact drop-off from the briefing |
| `turn-in-mission` | ✅ hold emptied, then the journal went **empty** and the wallet moved **1,004,389,000 → 1,004,564,313 ISK (+175,313)** — completion proven by game state, not by a button press |
| `return-to-agent` | ✅ set the destination straight back to the agent's station and rode the autopilot home |

### ⚠ The bug: a missing reading DECLINED a job

The first accept tick after docking gated on a cargo hold that had not been read
yet, and the bot turned down a perfectly good mission:

> Your ship did not report how much room its cargo hold has, so the bot left the
> offer alone.

**Declining is irreversible** — it burns the offer and starts a decline timer
against the agent — so it must never be the answer to "I could not see". This is
the cannot-tell rule, and this is the one place in the codebase where breaking it
cost a real action rather than a wrong readout.

`gateOffer` returns one string for both "fails the gate" and "cannot be judged",
which is right for a readout and wrong for a decision. The three blind cases (no
stated volume, no cargo reading, no route when a ceiling is set) are now answered
with a WAIT, bounded so a reading that never arrives ends blocked with its own
reason. A second, smaller one went with it: with **no** ceiling set, `gateOffer`
still declined when it had no jump count — over a number nobody had asked about.

### Not a bug, but worth knowing

Saving a script under the name of an existing one creates a SECOND script rather
than overwriting, and the Bots list shows both by name with no way to tell them
apart. That is how a run was started against a stale copy with the old jump limit
— an operator trap, not a code fault.
