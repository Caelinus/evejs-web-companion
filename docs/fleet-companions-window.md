# The Fleet companions window — taking the companion out of the bots

**Date:** 2026-09-13

The fleet companion stopped being a bot. This note says what moved, what
deliberately did not, and why each.

## What was wrong

The companion was built as the third instance of the `MiningBot` /
`MissionBot` pattern, so it inherited that furniture wholesale:

- it was a member of `BotID` and a row in the `BOTS` catalogue;
- its only door was the **Bots** launcher panel, which is itself not in the rail
  — you reached it through the Bot Manager, picked "Fleet companion" from a
  picker of saved scripts, landed on a per-pilot panel and expanded a card;
- and the Bot Manager's pilot rows carried a fleet readout — in fleet, whose
  orders, can it tag, its fit warnings — inside what is otherwise a library of
  scripts.

None of that describes what a companion is. A bot is a script you set up against
your own ship and leave running: it picks its own work (a belt, an agent), it can
be saved, shared and handed to the server. A companion picks nothing. It does
what a fleet tells it, and the questions you ask about one — who is following
whom, who has stopped, who is not in the fleet yet — are questions about the
**squad**, which a per-pilot panel can only answer one pilot at a time, by
switching to each pilot in turn and destroying the view you were reading with.

## What it is now

A **global window**, `ui/FleetCompanions.svelte`, on App's global layer beside
the Bot Manager, opened from a **button in the character bar** next to the
`EVEJS` mark. That bar is the only chrome that survives a pilot switch, which is
the honest place to hang a door onto a window about every pilot at once. The
button carries a count of how many pilots are currently flying as companions,
and lights up while its window is open.

The window is a roster of two kinds of row:

- **tab runs** — a pilot you added, flown by this tab's own loop;
- **server runs** — started from the Pilot Hangar, flown headless by the BFF,
  and still flying when every tab is shut.

Selecting a row opens that pilot's real `FleetCompanion.svelte` panel, bound to
**that session's** store and flow under a `{#key}` — the same component, the same
Start / Pause / Stop, the same checklist. Nothing is forked. A server row gets
its readout and a Stop, and no setup form, because its limits were taken when it
was started and fields here would change numbers that reach nothing.

## The op: a roster you build, and a fleet it joins

**Added 2026-09-13.** The window used to list every pilot signed into the tab,
automatically. That is not what an operation is: a pilot brought online to check
a contract sat in the fleet roster beside the three you meant, and nothing on
screen said which was which.

So the window now holds three things, in `app/companionRosterPrefs.ts`
(localStorage, `evejs-web-companion-roster:v1`):

| Stored | Why it is one answer, not one per pilot |
| --- | --- |
| the **fleet name**, as it appears in the fleet finder | the op is one fleet; asking per pilot is asking the same question four times |
| the **pilots**, by characterID | a session id is minted per tab and would be empty after a reload while its pilot was still flying |
| one **`CompanionSetup`** | adding a pilot STARTS it, so there is no moment at which a per-pilot form would be filled in |

⚠ **It is not a hangar squad, and the two must not be merged.** A squad
(`app/hangarPrefs.ts`) is a durable label on pilots across accounts, used to
bring them online and launch headless runs from the landing screen; its
companion configs are per pilot because pilots in a squad do different jobs.
This is one live operation in one tab, emptied when the op ends. Storing it in
the squad map would make "who is in tonight's fleet" a permanent property of a
pilot.

**Adding a pilot** offers only pilots already signed in here — bringing one
online needs an account password and is the Pilot Hangar's job. The add arms a
**join watch**, and the watch is what puts the pilot in the fleet and sets it
flying.

**Removing a pilot** stops it and takes it out of the fleet: the add put it in
somebody's fleet, and leaving it there after the row is gone leaves a ship in a
fleet warp chain that nothing on this screen is watching. **Stop all** does
*not* disband — a stop is how you take a ship back by hand mid-op, and pulling
it out of the fleet as well is the one thing you would not want at that moment.

## The join watch

`nav/fleetJoinWatch.ts` is the decider — pure, one pilot, one tick — and the
window is only its driver: it performs what the decider asks for, and hands back
what the server said. Every unsettled pilot re-reads its own fleet and the fleet
finder every 10s, through **its own flow**.

The round trip is the one `docs/join-advertised-fleet-handoff.md` paid an
afternoon to learn, and it is not re-derived here:

```
apply  ->  the server mints an INVITE and notifies the applicant
       ->  THE CLIENT ACCEPTS IT
       ->  only then is the pilot in the fleet
```

An apply does **not** join you. The apply's own boolean says which half you are
in (`true` = the advert wants the boss's approval and no invite exists;
`false` = an invite was minted), and `"unknown"` tries the accept, because a
wasted accept costs one swallowed call where a refused one strands a pilot with
an invite waiting.

Four decisions in that module are worth keeping:

1. **An advert that is not there yet is a WAIT, not an answer.** This is the one
   place the watch differs from the `join-advertised-fleet` block, and it is why
   the module exists: a block is one step of a script with somewhere else to be,
   so an empty fleet finder finishes it. The window promised to wait, and the
   wait has no bound — the player ends it by removing the pilot.
2. **In a fleet is not in YOUR fleet.** `inFleet` is a boolean; on its own it
   cannot tell the op's fleet from somebody else's. `GetMyFleetFinderAdvert`
   names the fleet a pilot is in (verified in the runtime: it resolves the fleet
   from the session character, not from being its boss, so any member reads it),
   and a pilot in a fleet that cannot be named that way is **blocked**, not
   assumed. The cost of guessing right is one saved click; the cost of guessing
   wrong is an unattended ship taking orders from a fleet nobody picked.
3. **A companion standing down is left alone.** Decision 5 of the ladder docks a
   pilot nobody is supervising and *leaves the fleet*. The watch latches that
   (`stoodDown`) and holds — including after the abandonment ends by releasing
   the ship — because a watch that rejoined would loop join → abandon → join for
   as long as the advert stood. A human puts it back.
4. **A start the player stopped is not started again.** Adding a pilot starts
   it, so the driver latches `started` and clears that latch only when the pilot
   is out of the fleet and looking for it again. Without it, Stop (and Stop all)
   would undo themselves on the next beat.

⚠ **A refused apply is reported.** The refusal ledger's lesson: a watch that
retries quietly shows the same patient sentence whether the fleet is merely not
advertised yet or every call is being refused outright. The row carries the
refusal beside its own words.

## What left the Bot Manager

The picker entry, the setup route, the whole companion badge, and the Stop on a
companion row. A companion is not in `BOTS`, so the Manager cannot offer one.

## What did NOT leave, and must not

**Ship ownership.** `ShipControllerID` is `BotID | "companion" | "custom"`, and
`createShipClaim` still walks it: starting a mining bot on a hull a companion is
flying stops the companion first, and vice versa. Take the companion out of that
union and two loops issue movement and module calls against one ship with
neither aware of the other — the exact bug the claim was written to make
structurally impossible.

**Saying who holds the hull.** The Bots panel and the Bot Manager both still name
a companion that is flying a ship (`PilotRunState.isCompanion`, and the Bots
panel's `runningName`). Without that, a hull a companion is actively flying reads
as free, and the player's next act on either screen is to start a script on top
of a pilot in the middle of a fleet fight. The Manager names the run, says where
it is managed, and offers no controls for it.

## Two structural changes this needed

1. **The global layer holds a list.** It held exactly one window
   (`WinState | null`) while the Bot Manager was alone on it; a second member
   would have made the two evict each other. `globalWindow.ts` now takes and
   returns `WinState[]`, App drives moves/close/focus/put-away through
   `desktop.ts`'s own generic reducers, and storage moved from
   `evejs-web-global-window:v1` (one object) to `evejs-web-global-windows:v2`
   (a list), reading the old key once so a player's Bot Manager stays where they
   left it.

2. **The companion's requirements moved out of the bot registry** into
   `nav/fleetCompanionRequirements.ts`. The requirement *machinery* — the
   three-answer verdict, blocking vs advisory, `evaluateRequirements` — is
   general and stays shared; only the catalogue membership was wrong.

## Where the tests live

- `nav/fleetJoinWatch.test.ts` — the whole round trip, the waiting, and the
  states only a player can clear. ⚠ It drives apply → answer → accept → in,
  because the block's original 29 tests all stopped at "emits an apply" and
  passed while it hung on a healthy fleet.
- `app/companionRosterPrefs.test.ts` — what survives a reload, and what stored
  bytes are allowed to do (nothing).
- `nav/companionRoster.test.ts` — the window's words and sums (a finished server
  run is not a flying one; a roster with nobody flying never says "0 running").
- `ui/fleetCompanionsPanel.test.ts` — it embeds the real panel, keys it per
  pilot, reads each session's own store, polls the headless half, can still stop
  one, and the roster/join rules above are pinned off the source.
- `ui/fleetCompanionPanel.test.ts` — the per-pilot panel, including the
  regression guard that the limits form does not grow back on it.
- `ui/globalWindow.test.ts` — two global windows coexist; the v1 migration.
- `ui/globalWindowMount.test.ts` — the layer draws every window, the door is in
  the character bar above the pilot-switch key, and a phone opens a global tab
  as a panel.
- `ui/botsPanel.test.ts`, `ui/botManagerPilotRow.test.ts`, `bots/pilotRoster.test.ts`
  — the companion is gone from both bot surfaces, and a hull it holds is still
  named on both.

## The live run, 2026-09-13

Driven against a real advertised fleet with two pilots: add -> apply -> accept
-> in the fleet -> flying, both of them; remove -> stopped and out of the fleet
(the fleet's own member count dropped with it); a name nobody is advertising ->
both rows waiting, indefinitely; and the roster, the fleet name and the limits
all came back after a BFF rebuild and a reload.

**It found one defect that the tests did not.** The rung that recognised "this
watch put the pilot there" ran BEFORE the name check and printed the *typed*
name against it, so retyping the op's fleet while a pilot was already flying in
the old one left its row reading `In "Nightshift"` about a pilot sitting in
"Test". Fixed by asking the advert's name first and never naming a fleet the
server did not name back: a pilot in a fleet that is no longer advertised now
reads "In the fleet it joined, which is no longer advertised."

That also settled a cost question in the driver the wrong way round. The finder
read had been skipped for a settled row, to save two calls; but it is the only
read that NAMES the fleet a pilot is in, so skipping it is exactly what let a
stale name stand. It is unconditional now. What is skipped instead is
`flow.loadFleet` — five calls — whenever a flying companion has already
reported its own fleet, which is both cheaper and fresher.
