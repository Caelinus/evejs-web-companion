# The fleet companion, simplified — a plan

**Status: DECIDED by the operator, 2026-09-11, after the first live test run.**
Written against `feat/fleet-companion` at 6b612a6 (phase 9 merged).

## The one-line version

A companion is configured by the SHIP IT IS IN and the FLEET IT IS IN. Nearly
every setting the panel offers is something the client can already read, and the
ones that are not are numbers and money. The settings screen loses five of its
eight sections.

## The operator's own words, and what each one turned out to mean

> **Role: why we even need this? they are companions, they follow fleet
> commander and act based on their fleet.**

Correct, and the code agrees more than the docs do. `COMPANION_PRESET_KEYS`
(`web/src/bots/companionRolePresets.ts:83`) fences a role to exactly ONE field,
`fleeHealthFloor`, and no decision rung reads `request.role` at all.

> **Defensive equipment: WTF? why this is manual config. All this can be
> automatically identified from fit. Self repair: why manual? can be identified
> from fit. Remote repair: automatic. weapons: automatic**

The automatic path was already built and already wired — `deriveModulesFromFit`
(`fleetCompanionLoop.ts:207`) makes `startFleetCompanion` read the live fit and
fill all eight lists (`flow.ts:6630`). The pickers are a SECOND, OLDER mechanism
kept alongside it.

> **you do not need to identify every single individual module. i think that
> group is enough to know when and for what to use it and is it active or
> passive.**

This is the whole argument, and it dissolves the one the pickers rested on. See
"Group plus duration is the whole answer" below.

> **use drones to defend: automtatic! ffs if pilot has combat drones, use it. if
> pilot has repair drones use them on fleet members, if pilot has salvage drones
> and there is command salva, use them on wreck. Do not mix drones, at one time
> one type of the drones**

The mixing complaint is exactly right and it is the one place in this app that
gets drones wrong. See "Drones" below.

> **Let this pilot try to tag targets for the fleet: usless. All pilots should
> tag targets when they are tackled. And only when they are tackled.**

`decideTackleTag` (`fleetCompanionLoop.ts:2602`) ALREADY tags only ships that are
tackling this pilot. The toggle is a gate in front of behaviour that is already
what was asked for.

> **What it listens to: i have never asked for this option. they listen for
> everything without any toggle off/on and then act on what they can do. wtf is
> squad board?**

`squad-board` is a checkbox with NO CONSUMER — `obeys` is read at four places
(`fleetCompanionLoop.ts:2466`, `:2479`, `:3337`, `:3346`) and not one of them is
squad-board. Ticking it has never done anything.

> **If there is no station in sight, warp to: Sun.. always sun.**

The repo's recorded finding that there is no sun is WRONG. See "The sun exists"
below.

> **salvage: salvage wrecks in vicinity. loot: loot wrecks and containers in
> vicinity.** (bare chat verbs, no link)

## Group plus duration is the whole answer

⚠ THE PICKERS' JUSTIFICATION DOES NOT SURVIVE THE OPERATOR'S POINT, and every
one of the eight field comments rests on it. They all say some version of "never
guessed here, a wrong guess cycles the wrong module". But there was never a
guess to make:

- **What a module is FOR** comes from the game's own SDE group name, and the
  classifier (`flow.ts:6733`) reads nothing else. `/shield booster/` is a self
  shield rep; `/remote armor/` is a remote armour rep; `/^warp scrambler$/` is
  tackle. It never looks at an individual module, so there is nothing for a
  player to disambiguate.
- **Whether it can be CYCLED** comes from dogma attribute 73, the cycle duration
  the server sends per fitted module (`itemHasActivationCycle`,
  `bridge/boundDogma.ts:273`). No duration means passive, so it is never
  activated. This is what separates Damage Control II from Assault Damage
  Control II — same group, opposite answers, and no regex over a name could ever
  have told them apart.

⚠ **THE DURATION CHECK MOVES TO EVERY BRANCH.** Today it gates only the
`/hardener|damage control|resistance/` arm (`flow.ts:6808`), because that is
where the Damage Control bug was found. Group-plus-duration is the general rule,
so a passive module can never land in a list something tries to cycle.

The per-itemID lists survive as HANDLES for the activate call — you activate one
particular fitted module — but they are derived, never asked for.

## The sun exists, and warping to it is a first-class mechanic

⚠ **THE RECORDED FINDING WAS WRONG.** `fleetCompanionLoop.ts:314`, decision 5 in
`docs/fleet-companion-plan.md`, and `docs/fleet-companion-handoff.md` all assert
that eve.js's scene carries no celestial and that no read exposes one, "checked
2026-09-10". Re-checked 2026-09-11, against the server rather than against the
client's decoder:

- `_local/gameStore/data/celestials/data.json` carries **8,089 sun rows**, one
  per solar system, each `groupID: 6`, `groupName: "Sun"`, `kind: "sun"`,
  `position: (0,0,0)`, with a real `radius` and `itemName` ("... - Star").
- `worldData.getCelestialsForSystem` (`space/worldData.js:182`) returns every
  celestial for a system, unfiltered.
- `space/runtime.js:26534` adds each of them to the scene UNCONDITIONALLY —
  notably unlike the stargate loop three lines below, which is gated behind
  `INCLUDE_STARGATES_IN_SCENE`. `buildStaticCelestialEntity` (`runtime.js:10657`)
  stamps `kind: celestial.kind || "celestial"`, so a sun's scene entity kind is
  literally `"sun"`.
- `canSessionSeeStaticEntityForSession` (`runtime.js:31180`) rejects only
  bubble-scoped, public-grid-scoped and site-scoped statics. A sun entity carries
  none of those markers and falls through to `return true` — visible to every
  session in the system.
- Warping to one is DELIBERATELY IMPLEMENTED, not incidental:
  `space/destiny/simulation/warpState.js:882` has a dedicated `case "sun":`
  landing distance of `radius + 5,000,000 m`, sitting beside `planet`, `moon`,
  `station` and `stargate`.

So a safe spot needs no new plumbing whatsoever: it is `api.warpTo(sunItemID)`,
the identical call the companion already makes to warp to a station, on an
itemID read out of the snapshot it already polls every tick.

⚠ **WHY THE ORIGINAL CHECK MISSED IT.** It enumerated the entity kinds the
CLIENT's own code mentions and concluded the server emits no others. The client
has a `kind === "celestial"` branch (`space/tactical.ts:356`) and the sun's kind
is `"sun"`, so the sun arrives and is simply unrecognised. An absence in the
reader was read as an absence in the world.

## Drones

⚠ **THE COMPANION IS THE ONE PLACE IN THIS APP THAT MIXES DRONE TYPES.**
`decideDrones` never imports `droneRoles.ts` at all; both launch branches send
`obs.droneBayItemIDs`, the entire unfiltered bay (`fleetCompanionLoop.ts:3194`
and `:3248`). Every scripted bot is careful about this and uses
`launchRoleDrones` (`scriptMacros.ts:307`), which recalls other-role drones
first and then launches only the role it wants. The companion reuses that.

What each role does, and what the SERVER actually implements (checked
2026-09-11 against `services/drone/droneDogma.js` and `droneRuntime.js`):

| Role | SDE group | Server effect | What the companion does |
|---|---|---|---|
| Combat | 100 | `targetattack`, works | Launch when a hostile is on grid. **No engage command needed** — `noteIncomingAggression` (`droneRuntime.js:6439`) auto-assigns idle combat drones onto whatever shoots their controller, and `DEFAULT_DRONE_IS_AGGRESSIVE` is `true` (`:187`) with no client surface to change it. |
| Logistic | 640 | remote shield/armour/hull, works | Launch and point at a fleet-mate calling for reps, on the rung that already drives the remote modules. |
| Salvage | 1159 | `salvagedroneeffect`, works | Only on the `salvage` chat command. Auto-pick with `targetID: 0`. |
| Mining | 101 | works | Never launched. Not a companion's job. |
| Electronic Warfare | 639 | `entityecmfalloff`, works | Never launched. Not asked for; revisit deliberately. |
| Stasis Webifying | 641 | **none** | Never launched. |
| Energy Neutralizer | 544 | **none** | Never launched. |

⚠ **WEBIFIER AND NEUTRALIZER DRONES HAVE NO SERVER-SIDE EFFECT.** They exist in
the SDE and they sit in drone bays, but `droneDogma.js` defines no effect for
either, so `commandEngage` refuses them with "That drone has no supported engage
profile" (`droneRuntime.js:5009`). Treating them as combat would launch drones
that cannot do anything. They stay in `other` and are never launched.

⚠ **REPAIR DRONES DO NOT KNOW WHAT A FLEET IS.** `isFriendlyRepairTarget`
(`droneRuntime.js:3895`) tests character, owner, corporation and alliance — and
NEVER fleet membership. So logistic drones will rep your own pilots and your
corp-mates and will silently do nothing for an out-of-corp fleet-mate. For a
squad of one operator's own characters this is invisible; for a mixed fleet it
is the whole feature failing quietly. Recorded, not worked around: there is no
client-side fix, and we do not modify the server.

`droneRoles.ts` needs a fourth role, `logistic`, for group 640. Today it falls
into `other` and nothing can select it.

## Tagging

The toggle goes; the rung does not change. What is worth writing down is why
removing the gate is safe, because the field comment argues loudly that it is
not ("ONLY ONE PILOT PER SQUAD SHOULD SET THIS"):

1. **The server is the real gate.** Only a fleet creator, leader, wing commander
   or squad commander may tag (`bridge/fleetCommand.ts:47`, mirroring
   `fleetRuntime.js:1317`), and `obs.canTag !== true` already stops the write.
   In an ordinary fleet the companions are plain members and tag nothing.
2. **A lettered ship is skipped.** The rung filters out any entity already in
   `fleetTargetTags`, so a second tagger seeing the same tackler does not
   re-letter it.
3. **The trigger is narrow.** Only ships that are TACKLING THIS PILOT are
   candidates, so two companions collide only when the same ship has tackled
   both of them, in the same tick, before either letter is visible.

The squad-start warning that counts taggers (`squadStart.ts:50`) goes with the
field.

## What it listens to

All three real channels are always on. `obeys` and `chatCommandSenders` are
deleted, and so is the `squad-board` member of `FleetCompanionOrderSource` —
nothing has ever read it. The BFF's squad board itself stays; it belongs to the
scripted bots.

⚠ **THE CHAT SENDER GATE IS A BUG, NOT A SETTING.** The panel says "Whoever the
fleet roster already names a commander is obeyed regardless". That is false.
`isChatCommandSenderAllowed` (`nav/chatCommands.ts:235`) is
`chatCommandSenders.includes(message.characterID)` and nothing else, and
`flow.ts` does not even FETCH chat unless that hand-typed list is non-empty. So
today an FC's chat orders are silently ignored by every companion nobody typed
character ids into. The gate becomes what the screen already promised: **fleet
commanders, off the roster** — which is also decision 1's "narrowest thing that
works", now that there is no hand-typed list to be narrower than.

⚠ **CHAT IS LOCAL CHAT AND STAYS LOCAL.** The gateway hardcodes its channels to
local and corp; a fleet room is never delivered. Always-on chat commands
therefore means "a commander of YOUR fleet, typing in local". Bounded by fleet
membership, which is the bound that matters.

### Two new verbs, both bare

`salvage` and `loot` take NO showinfo link. That makes them the first verbs that
are commands without one — `parseChatCommand` currently returns `null` when a
verb matches and no link follows (`chatCommands.ts:202`), and that rule stays
intact for the four link verbs; the two new ones simply never enter the link
path. `ChatCommand` grows two members with no `itemID` field at all.

- **`salvage`** — every wreck in vicinity. Salvage drones, auto-pick
  (`salvageDrones(ids, 0)`), the pattern `salvageWrecks` already uses
  (`scriptMacros.ts:1727`).
- **`loot`** — containers on grid, plus wrecks that are legally ours.

⚠ **`loot` IS OWNERSHIP-GATED AND `salvage` IS NOT**, and that asymmetry is the
server's, not a policy of ours. `isOwnWreck` (`scriptMacros.ts:1715`) opens a
wreck only if its owner is this character or this corporation, and a wreck whose
owner cannot be read is never opened — the no-can-flipping rule, structural
rather than polite. Containers have no ownership check at all. Salvaging any
wreck is legal. So `loot` in a mixed fleet walks past an out-of-corp fleet-mate's
kills, and that is correct behaviour rather than a gap.

⚠ **`loot` MOVES THE SHIP.** It approaches to within 2,400 m of each target
(`LOOT_RANGE_M`), which is the only thing in this list that can pull a companion
off formation. It sits below the flee rule and yields to fleet warp like
everything else.

## The request, after

Deleted: `role`, `defenseModuleIDs`, `shieldBoosterModuleIDs`,
`armorRepairerModuleIDs`, `hullRepairerModuleIDs`, `remoteShieldModuleIDs`,
`remoteArmorModuleIDs`, `remoteCapacitorModuleIDs`, `weaponModuleIDs`,
`deriveModulesFromFit`, `useDrones`, `attemptsTagging`, `obeys`,
`chatCommandSenders`, `safeSpotBookmarkID`.

Kept, because none of them can be read off a ship: `fleeHealthFloor`,
`capacitorFloor`, `maxFleeAttempts`, `droneHealthFloor`,
`droneRedeployHoldOffSeconds`, `repairsAtStation`.

⚠ **EVERY COMPANION IS NOW ARMED, AND THAT IS A DELIBERATE LOSS.** An empty
`weaponModuleIDs` meant "lock what the fleet calls, never fire it", and it was
the default, so a pilot could only ever shoot if its operator ticked a gun. That
safety default cannot survive "weapons: automatic" — a derived list arms
whatever the hull carries. The operator was told and chose it. The consequence
for the launch grant is that `combat` is now unconditional (the fit has not been
read at grant time and may hold anything), which is what
`deriveModulesFromFit` already earned on its own (`companionRunPolicy.ts:145`).

⚠ **THE CODEC REFUSES UNKNOWN KEYS, SO DELETION IS NOT FREE.**
`decodeFleetCompanionRequestValue` rejects any key outside `REQUEST_KEYS`
(`companionRunPolicy.ts:189`), deliberately — "a stored key this codec does not
recognise is a field a later version wrote and this version cannot honour". Every
saved squad config in `hangarPrefs` and every persisted bot-roster row carries
the fifteen keys above. A straight deletion makes all of them decode-fail, and
`companionConfigMap` (`hangarPrefs.ts:141`) drops a failed config SILENTLY — so
the visible symptom would be every squad quietly losing its setup.

The fix is an explicit RETIRED-KEYS set: accepted, ignored, never written back.
It is not the same thing as loosening the unknown-key rule, and it must not be
written as one — an unrecognised key is still refused, and only these fifteen
named ones are forgiven.

## Work breakdown

Ordered by dependency. The request shape is settled FIRST because everything
else reads it.

1. **The request type and defaults** — `nav/fleetCompanionLoop.ts`. Coordinator.
2. **`logistic` drone role** — `nav/droneRoles.ts`. Independent of 1.
3. **`salvage` / `loot` verbs** — `nav/chatCommands.ts`. Independent of 1.
4. **Codec, retired keys and risk derivation** — `bots/companionRunPolicy.ts`.
5. **The panel** — `ui/FleetCompanion.svelte`.
6. **Role removal from the hangar** — `app/hangarPrefs.ts`, `ui/PilotHangar.svelte`,
   `ui/BotManagerPilotRow.svelte`, `bots/companionReadout.ts`,
   `bots/companionRolePresets.ts` (deleted), `src/botHost.js`.
7. **The rungs** — `nav/fleetCompanionLoop.ts`: drones by role, `obeys` gates
   removed, the sun safe spot, the salvage and loot orders. Coordinator.
8. **Wiring** — `app/flow.ts`: unconditional derivation, the generalised duration
   check, drone role classification on the observation, new action kinds.
   Coordinator.
9. **Correct the record** — the three places that say there is no sun.

⚠ **`flow.ts` AND `fleetCompanionLoop.ts` ARE COORDINATOR-OWNED.** Two agents
editing one file lose each other's edits silently. Everything else is
single-owner.

## Do not re-litigate

- The eight module pickers are gone. Group plus dogma duration is the answer.
- The sun is real. Do not reinstate the bookmark on the strength of the old
  comment; the old comment is wrong and has been corrected in place.
- Webifier and neutralizer drones are never launched, because the server has no
  effect for them — not because of a policy we could relax.
- Repair drones cannot rep an out-of-corp fleet-mate. This is server-side and we
  do not modify the server.

## As built — decisions taken while writing it

Recorded after the fact so they are argued once rather than re-derived. Landed
2026-09-11; 528 tests green, `tsc` clean, `docker build --target web-build` green.

**`CompanionSetup` is a `Pick` of the flown request, not a type declared beside
it.** `COMPANION_SETUP_KEYS` is the single list of stored field names, and both
the type and the codec's key set are built from it — so the stored shape and the
flown shape cannot disagree about a field, and widening the stored surface means
editing one constant with this document arguing against it.

**The chat gate lives in `bridge/fleetCenter.ts` as `fleetCommanderCharacterIDs`.**
It is `isFleetCommander` — the single mirrored copy of the server's own gate,
already used to answer "may I tag" for one row — applied to every row instead.
One definition of "commander", used twice. `null` (roster unreadable) means obey
nobody and must never collapse to empty.

⚠ **UNGATING THE TWO READS MADE THEM LOAD-BEARING, AND THEY HAD TO BE MADE
UNLOAD-BEARING AGAIN.** While chat and the drone bay were each behind a setting,
a companion whose operator had not enabled one never made that call, so a route
that answered badly could not reach the tick's `Promise.all`. Once every
companion reads both, an unavailable route rejected the whole tick and stopped a
pilot that was otherwise flying perfectly well. Both now swallow their own
failure into `null`, which every rung beneath already reads as "did not look".
This was found by a test suite that hung rather than failed; it would have been
found in production by a companion that silently stopped.

**`salvage` and `loot` tolerate trailing text.** `salvage the wrecks in vicinity`
parses as `salvage`. The verbs stay anchored and word-bounded, so `salvaged`,
`looting` and a mid-sentence mention still do not match. This matches what the
four link verbs already did — they accept arbitrary text before their link — and
it is the phrasing a human actually types.

**`loot` routes through `lootIntoShip`, the same implementation the Overview's
own "Take everything" uses**, so every specialised bay on the hull is offered the
loot before anything falls to ship cargo. Only the "which bays does this hull
have" cache is duplicated, because the script runner answers that off its
`capabilityCache` — DSL machinery this loop deliberately does not have.

**The Bot Manager's role badge is gone with nothing in its place.** A badge
reading "DPS" while the pilot was repairing a fleet-mate would be worse than no
badge, and the line beneath it already says what the pilot is doing and whose
order it is following.

**`fittingBody` grew an `extraModules` option rather than a hardener being added
to `PROCURER_MODULES`.** Every module list is derived from the hull now, so a
hardener in the shared fixture would arm the tank rung in every suite that uses
it — and the tank rung sits ABOVE tagging, which silently changes which rung
fires in tests about something else. A fixture that changes which rung fires is
not a neutral fixture.

⚠ **`salvage` ACTS ON THE FIT, NOT ONLY ON THE DRONE BAY — FOUND IN LIVE
TESTING.** The first cut of the verb launched salvage drones and nothing else,
because that is how the order was first phrased ("if pilot has salvage drones…").
It was wrong for exactly the reason every module picker was wrong: what a pilot
can do is a property of its FIT. A hull with a salvager bolted on and an empty
drone bay was told to salvage and stood there — observed live on a Pioneer with
`bay: []`. The request grew a ninth derived list, `salvagerModuleIDs` (group
"Salvager", high slots, via the `resolveSalvageModuleIDs` the DSL already had),
and `decideSalvaging` runs the nearest wreck through approach → lock → activate.

The two halves are **not exclusive**: a ship carrying both sweeps with the drones
on the server's auto-pick *and* works the nearest wreck with the module. They are
separate rungs because one costs a drone command and the other moves the ship —
which is also why the module half sits at the bottom of the ladder beside the
loot rung, beneath the flee.

⚠ **PICKING A TARGET IS NOT AN ACTION.** The salvager rung's first draft returned
an `approach` the moment it chose a wreck, so a wreck already in range cost a
wasted tick closing on something the ship was already next to. Choosing now falls
through to the range test in the same pass. The same shape of bug is worth
watching for in any rung that picks a target and acts on it.

⚠ **A FAILING TEST IN `companionFlow.test.ts` HANGS THE RUN RATHER THAN FAILING
IT.** These tests call `flow.stopFleetCompanion()` as their last statement, so an
assertion that throws skips it and leaves the loop's timer alive — the process
then never exits and the failure never prints. This is pre-existing and was not
introduced here, but it cost real time to diagnose: if a run hangs, re-run it
with `--test-force-exit` to see which test actually failed.
