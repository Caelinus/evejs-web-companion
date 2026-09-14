# Fight with drones — the drone-boat combat block

Status: **spec, not built**. Written 2026-09-14, after a review of what a Tristan
actually does inside a 0.5 anomaly under the shipped `Ratting night` bot.

## 1. Why a new block and not a fix to Fight-the-rats

`fight-the-rats` (nav/scriptMacros.ts) is a GUN ladder that also happens to send
drones: lock the nearest hostile, put the drones on it, then run every idle gun.
Three of its assumptions are wrong for a drone boat, and none of them can be
changed in place without breaking the gunship it was written for.

* **It never moves the ship.** There is no approach, orbit or keep-at-range
  anywhere in it. A drone boat's whole tactic is range, so the block that cannot
  express range cannot fly one.
* **"Done when the grid is clear" means "clear inside LOCK range."**
  `hostilesInReach` filters by `maxTargetRangeM`, so a wave that lands at 50 km
  reads as an empty grid: the block finishes, and the bot starts looting with
  rats inbound. The filter is load-bearing (it stops a lock-retry spin on a rat
  parked 300 km out), so the answer is a rung that CLOSES, not a removed filter.
* **Its target ladder is inert against rats.** `tackle` / `ewar` / `logi` match
  PLAYER hull group names (Interceptor, Force Recon Ship, Logistics). Every NPC
  in the SDE is `Asteroid Serpentis Frigate` and friends, so all of them fall
  through to `other` and the real order is nearest-first.

So: a second block, the same way `warp-to-ore-anomaly` is a second block beside
`warp-to-anomaly` rather than a switch on one. Macro id `fight-with-drones`,
player-facing name **Fight with drones**.

`fight-the-rats` stays exactly as it is.

## 2. The stand-off band — the three numbers

The player's instinct is "kite at drone control range with a buffer". That is one
number, and it is not enough: the right distance is a BAND with a floor and a
ceiling, and the interesting case is when the band is empty.

```
  floor   = (largest threat range among hostiles ON GRID) + THREAT_BUFFER
  ceiling = min(droneControlRangeM, maxTargetRangeM) - LEASH_BUFFER
  hold    = floor, clamped into [.., ceiling]
```

* **Floor — what can grab you.** Not a constant: the largest `warpScrambleRange`
  among hostiles actually on this grid that actually scram. A rat that cannot
  scram contributes nothing to the floor. Re-computed every tick, so a new wave
  moves the band.
* **Ceiling — the leash.** `min(drone control range, targeting range)`. Sitting
  past drone control range means the drones stop answering; past lock range means
  there is nothing to put them on. Whichever is smaller wins.
* **Hold at the FLOOR, not the ceiling.** Further out is not safer in any way
  that matters: the drones have to fly the distance, and every metre of stand-off
  is added to their travel time on every target switch. Sit just outside what can
  grab you.

### The empty band is the ordinary case, not an exotic one

Tristan (verified in the SDE): 40 km lock, 315 m/s base, signature 600, 5 lock
slots, 25 Mbit bandwidth. Drone control range is NOT on the hull's own row — it
is skill-derived — so it varies per pilot.

| pilot | control | ceiling | threat on grid | floor | band |
|---|---|---|---|---|---|
| low skill | 27.5 km | 24.5 km | Dire Pithi Arrogator, scram range 20 km | 25 km | **EMPTY** |
| high skill | 45 km | 37 km | same | 25 km | 25-37 km |

The classic tackle frigates (`Dire Pithi Arrogator`, `Arch Angel Rogue`) scram at
**20 km** with a 25% activation chance and web at -50% — read from the SDE, not
guessed. A low-skill drone frigate therefore cannot outrange the thing that holds
it while keeping its drones on it. That is a real fit, and the block must have an
answer for it rather than producing a nonsense distance.

**When the band is empty the block does not kite.** It holds at the ceiling and
says so in the readout, in one sentence the player can act on ("Your drones only
reach 27.5 km and that frigate scrams at 20 km, so there is no room to kite —
fighting at 24.5 km instead"). Kiting at a range the drones cannot work in is
worse than brawling, and fleeing is the watches' job, not this block's.

### Which rat is the anchor

You can only hold range from ONE object, and a grid holds many. The block anchors
on the **nearest hostile that carries a threat** (scram first, then web), falling
back to the nearest hostile at all. Holding 25 km off the nearest scrambler says
nothing about the one behind you — this is an approximation, and it is the same
approximation a player makes. Say so in the code comment; do not imply the block
maintains a distance from the whole grid.

### Hysteresis

`keepAtRange` is a standing server order (see the settle audit — it is safe to
re-issue but it costs the tick's one action). Re-issue ONLY when the anchor
changes or the desired hold moves by more than `RANGE_HYSTERESIS_M` (2 km).
Otherwise the rung falls through and the tick goes to shooting.

## 3. The ladder

One action per tick, first rung with something to do wins. Every rung is written
so it has something to do only while the world disagrees with what is wanted —
the `decidePropulsion` idiom ("issues one call and then falls through").

0. **Guards.** Docked -> blocked ("undock first"). In warp -> wait. Not in space
   -> wait.
1. **Drones out.** `launchRoleDrones(obs, mem, ..., "combat", ...)`, unchanged —
   role-aware, so salvage drones stay in the bay.
2. **Hold the range.** Compute the band; issue `keepAtRange(anchor, hold)` when it
   disagrees past the hysteresis.
3. **Propulsion.** See §5. One call on a change, then falls through.
4. **Primary.** Pick by §6, lock it. Same bounded lock wait as today.
5. **Drones onto the primary**, once per target (`dronesOn` memory).
6. **Rotate a hurt drone.** See §4.
7. **Pre-lock.** Fill spare lock slots with the next targets in priority order, so
   the next primary is already locked when this one dies. Tristan holds 5; the
   current block uses 1 and pays a fresh lock every kill.
8. **Guns.** Every idle gun that is actually loaded (§7) onto the primary.

### Finishing

Done when the grid is clear AND the drones are home — but "clear" is fixed:

* hostiles in lock range -> fight (rungs above).
* hostiles on grid but NONE in lock range -> **approach the nearest** (rung 2
  becomes an approach rather than a stand-off) for up to `MAX_CLOSE_TICKS`.
* no hostiles on grid at all, or the close-in budget is spent -> recall drones,
  then done.

That is the wave fix. The budget is what stops a rat fleeing at 400 m/s from
towing the bot across the system forever.

## 4. Drone rotation — "started losing shield", not a percentage

The player's rule, and it is the right one: a drone that has begun taking damage
is about to die, and the cheapest save is to pull it and send it back out, which
also drops the rat's aggro on it.

State machine, per drone, in the step's memory:

```
  idle -> recalling (shieldRatio < 1.0)        issue recallDrones([thisDrone])
  recalling -> relaunching (it is in the bay)  issue launchDrones([thisDrone])
  relaunching -> idle (it is in space)         (rung 5 re-engages it)
```

* **The trigger is `shieldRatio < 1.0`, not a threshold.** Per-drone shield is
  already in the snapshot; only `lowestDroneHealth` (the minimum across all
  drones) is currently folded out of it, which is why the existing
  `drone-health-below` watch cannot express this.
* **One drone at a time.** Rotating two at once halves the damage on grid for as
  long as both are in transit.
* **Bounded: `MAX_DRONE_ROTATIONS` (3) per drone per site.** A drone that keeps
  getting picked is being focused; after three rotations leave it out and let it
  die, because the rotation costs more damage than the drone is worth.
* **Never while the drone is the only one out and the primary is alive** — this
  rung sits below the engage rung for that reason.

Cost, after the settle change: recall is 0 settle, launch is 1, engage is 0, so a
rotation is roughly 2 s + the drone's flight home + 4 s + 2 s. Before that change
it was four world calls at 6 s each, which is why this rung was not worth building
until the cadence was fixed.

## 5. Propulsion — burn to reposition, never to hold

The signature bloom is the whole reason this is not "prop mod on":
a microwarpdrive multiplies signature radius, and on a Tristan (sig 600) that
turns it into a much easier target for exactly the rat guns it is trying to
escape. So:

* **Light it only to CLOSE A GAP**: `|currentRange - hold| > PROP_GAP_M` (5 km).
* **Kill it the moment the ship is inside the band** (within hysteresis). Holding
  station with a burner lit is pure signature for no distance.
* **Scram kills a microwarpdrive and does nothing to an afterburner.** When the
  live jam feed says this ship is scrammed, do not re-light an MWD (the server
  has already switched it off; re-activating is a call spent to be refused) and
  prefer an afterburner if one is fitted.
* **Capacitor floor gates the LIGHTING, never the stopping.** An MWD eats roughly
  a frigate's capacitor per cycle; a module already running must always be
  stoppable.
* **Unknown kind is treated as a microwarpdrive** — the cheap half of being wrong.

None of this is new work. `nav/fleetCompanionLoop.ts` already implements all five
rules (`CompanionPropulsionModule`, `decidePropulsion`), including the wire quirk
that a Deactivate must NAME the propulsion effect or the module keeps cycling.
**Lift it into a shared module** (`nav/propulsion.ts`) that both loops call, per
the separate "one policy, two callers" item. Do not reimplement it here.

## 6. Target priority — by dogma, not by hull name

Keep the existing closed vocabulary (`tackle` / `ewar` / `logi` / `other`) and the
existing ordered `targets` arg, the existing picker UI, and the existing rule that
a class left off ranks LAST rather than becoming unshootable. Change only the
CLASSIFIER, which today can only read player hull groups.

For an NPC row, classify from the type's own dogma:

| class | evidence | count in the pinned SDE |
|---|---|---|
| `tackle`, sub-rank 1 | `entityWarpScrambleChance` (504) > 0, with `warpScrambleRange` (103) as its reach | 402 entity types |
| `tackle`, sub-rank 2 | `speedFactor` (20) < 0 — the attribute the server's own web definition uses as its strength | 990 entity types |
| `ewar` | `entitySensorDampenDurationChance` (932), `energyNeutralizerEntityChance` (931), `entityTargetPaintDurationChance` (935) | 98 / 212 / 66 |
| `other` | everything else | the rest |

Sub-ranking inside `tackle` is new and it matters: **a scram stops you leaving,
a web only slows you down**, so scram dies first. Within a sub-rank, nearest
first, as today.

This is not a name match and not a group match. `Pithi Arrogator` has scramble
chance 0 and `Dire Pithi Arrogator` has 0.25 — same faction, same size, and only
the attribute tells them apart. A group-name classifier cannot see the difference;
that is the whole reason this table exists.

### The live half

`bridge/jamNotifications.ts` already decodes the server's `OnJamStart` push, which
NAMES THE SOURCE (`sourceBallID`) and the `jammingType` — `webify`,
`warpScramblerMWD`, `warpScrambler`, `ewRemoteSensorDamp`, `ewEnergyNeut`,
`ewTargetPaint`, `ewTrackingDisrupt`, `ewGuidanceDisrupt`. A rat that is actually
holding this ship right now is ground truth and beats any static guess, including
for a type whose dogma we read wrong. Feed it in as a promotion: a source id in
the live jam list ranks at the top of its class regardless of what its dogma said.

## 7. Guns that have nothing loaded

The current block activates every idle gun. A gun with no charge will not fire,
and — worse — the attempt is booked in the refusal ledger, where
`MAX_CONSECUTIVE_REFUSALS` on one key ENDS THE RUN.

`flow.ts` already computes the three-state `takesCharge` and `hasCharge` per
module for the fleet companion's fit check. Plumb the unloaded set into the
observation and skip those guns. A drone boat with no guns at all is already
handled (drones alone are a legal way to fight); a drone boat whose guns are all
empty should fight with drones and say so ONCE in the readout, not stop.

## 8. What the observation must carry (the plumbing, not the block)

| field | source | note |
|---|---|---|
| `droneControlRangeM` | `fit.stats.bays.droneControlRange` (attr 458) | plumb like `maxTargetRangeM`; **may read unknown** — see §11 |
| `threatByTypeID` | NEW read-only BFF route over `staticData.getTypeDogma` | shaped like `/api/ore/families`: zero bridge calls, one round trip per NEW type seen, cached — the same pattern `targetGroupNames` already uses |
| `activeJams` | `bridge/jamNotifications.ts`, already decoded and already in the store | currently reaches the fleet companion only |
| `myDrones` | the space snapshot, per drone | `{ itemID, shieldRatio, armorRatio, hullRatio }`; `lowestDroneHealth` stays for the existing watch |
| `unloadedWeaponIDs` | the fit facts (`takesCharge && !hasCharge`) | |
| `propulsionModules` | the shared propulsion module | `{ itemID, typeID, kind }` |

No upstream (server) change anywhere in this list.

## 9. Registration checklist

A new `MacroID` cannot compile until it is classified in every exhaustive table.
All five are `Readonly<Record<MacroID, ...>>`:

* `bots/botScript.ts` — `MacroID` + `MACRO_IDS`
* `bots/macroSpecs.ts` — args + `untilRequired: false`
* `bots/runPolicy.ts` — risk class `combat`
* `bots/macroCatalogView.ts` — palette entry
* `bots/editorOptions.ts` — `MACRO_ARG_DESCRIPTORS` (+ bounds for the new numeric arg)
* `bots/scriptText.ts` — player-facing sentences
* `nav/scriptMacros.ts` — the decider and its registry entry

### Args (all optional — a bare block must be valid)

| key | kind | meaning |
|---|---|---|
| `targets` | `targetList` | existing ordered class list; default = shipped ladder |
| `squad` | `squadRole` | existing; call / follow / off |
| `holdRangeKm` | **new** `distanceKm` (1..300) | override the computed hold; unset = computed band |
| `propulsion` | **new** `propMode` ("auto" \| "off") | default "auto" |

Two new `Arg` kinds mean codec validation + bounds; that is the only format
change, and it is additive.

## 10. Deliberately not in scope

* **ECM / jammer priority.** There is nothing to prioritise: **zero** types in the
  pinned SDE carry `entityTargetJam` (928) or `ewTargetJam` (831), and the
  server's own NPC target-jam definition ships `jammingType: ""`, which the client
  decoder rejects as a non-empty-string requirement. So NPC ECM is neither present
  in the data nor observable on the wire. Recorded here so it is not re-opened.
* **Mobile Tractor Unit** for the loot phase — dropped by the operator for now,
  though the server has a full MTU runtime and the loot phase is the bigger time
  sink once the fight is fixed.
* **Drone damage-type selection** by rat faction. A bay-loading decision, not a
  runtime one.
* **Replacing `fight-the-rats`.**

## 11. Risks and the live checks that settle them

1. **`droneControlRange` may read unknown.** It is not on the Tristan's hull row
   (verified) — it is character/skill derived, so it arrives only if the live fit
   read reports the effective value. `maxTargetRangeM` is already documented as
   "unreadable, the usual case". If control range reads unknown, the band has no
   ceiling and the block MUST fall back to the player's `holdRangeKm`, and to a
   conservative 20 km if that is unset too. **One live check answers this**, and
   it decides whether the arg is an override or the primary input.
2. **A frigate cannot outrun a frigate.** Tristan base 315 m/s; rat frigates are
   faster. Without a prop mod the "kite" degrades to "hold the best range you can
   while they close", and with one lit you are paying signature. The block should
   be honest in the readout about which of the two is happening rather than
   implying a kite it cannot fly.
3. **Read rate.** Settle ticks skip the observe entirely, so the per-action settle
   cut raises the read rate during a fight. This block issues more actions than
   `fight-the-rats` (range, prop, rotation, pre-lock), so it is the one that will
   show it first. Watch the gateway on the first live run.

## 12. Tests (pure, against fake observations — the `scriptMacros.test.ts` shape)

* band: floor from the worst scrammer ON GRID, ceiling from the smaller of the two
  leashes, hold at the floor;
* **empty band -> brawl at the ceiling** and say why (the low-skill Tristan case);
* threat range comes from the grid, so a new wave with a longer-ranged scrammer
  moves the band;
* no threat on grid -> hold at the ceiling;
* hysteresis: no second `keepAtRange` for a sub-2 km change;
* rotation: shield 0.99 -> recall that ONE drone -> relaunch when it is in the bay
  -> re-engage; capped at three per drone;
* priority: scram before web before ewar before nearest; a live jam source
  promotes its rat over a statically-equal one;
* ammo: an unloaded gun is never activated; all-guns-unloaded still fights;
* finishing: hostiles on grid but out of lock range -> approach, not done; budget
  spent -> recall and done.
