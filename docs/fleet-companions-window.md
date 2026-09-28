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

- **tab runs** — a pilot signed into this browser, flown by this tab's own loop;
- **server runs** — started from the Pilot Hangar, flown headless by the BFF,
  and still flying when every tab is shut.

Selecting a row opens that pilot's real `FleetCompanion.svelte` panel, bound to
**that session's** store and flow under a `{#key}` — the same component, the same
Start / Pause / Stop, the same setup form. Nothing is forked. A server row gets
its readout and a Stop, and no setup form, because its limits were taken when it
was started and fields here would change numbers that reach nothing.

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

- `nav/companionRoster.test.ts` — the window's words and sums (a finished server
  run is not a flying one; a roster with nobody flying never says "0 running").
- `ui/fleetCompanionsPanel.test.ts` — it embeds the real panel, keys it per
  pilot, reads each session's own store, polls the headless half, and can still
  stop one.
- `ui/globalWindow.test.ts` — two global windows coexist; the v1 migration.
- `ui/globalWindowMount.test.ts` — the layer draws every window, the door is in
  the character bar above the pilot-switch key, and a phone opens a global tab
  as a panel.
- `ui/botsPanel.test.ts`, `ui/botManagerPilotRow.test.ts`, `bots/pilotRoster.test.ts`
  — the companion is gone from both bot surfaces, and a hull it holds is still
  named on both.
