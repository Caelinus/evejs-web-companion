# The Pilot Hangar — the landing screen

Built 2026-09-03 from the `design_handoff_pilot_hangar` handoff. Self-contained: you should not need
the handoff or the conversation that produced this to change the screen.

## What it is

The first screen of the web companion. Every pilot this browser knows, grouped by the account it
signs in through, with cross-account **squads** laid over the top, and login behind a modal.

It replaced a flat list of every character the tab had ever seen plus a login panel. That works at
three pilots. At fifty it is a wall of identical rows with no structure: you scroll past four accounts
to find one hauler, and nothing on screen says which pilots belong to the same operation.

**"Bring online" is not a game-client launcher.** It means the web client opens that pilot's
interface. Several pilots are live in the one tab at once — that is R107 multibox — and the switcher
between them is the character bar, not this screen.

## The files

| File | What it owns |
| --- | --- |
| `web/src/ui/PilotHangar.svelte` | the screen: header, chips, summary, grid, selection bar |
| `web/src/ui/HangarPilotRow.svelte` | one pilot, including the manage-mode squad checklist |
| `web/src/ui/HangarSquadPicker.svelte` | "All squads ▼" — search, pin, edit, launch |
| `web/src/ui/HangarLoginDialog.svelte` | "+ Add account" — signs in, records the pilots, signs out |
| `web/src/ui/HangarAddCharacter.svelte` | an empty slot — hosts `CharacterCreate` on a throwaway session |
| `web/src/ui/HangarSquadEditor.svelte` | name / colour / delete |
| `web/src/ui/HangarSquadAssign.svelte` | "Save as squad" — put the selection in an existing squad or a new one |
| `web/src/ui/HangarLaunchProgress.svelte` | one row per pilot, resolving as each lands |
| `web/src/app/hangar.ts` | **pure.** filtering, grouping, sorting, and every string the screen prints |
| `web/src/app/hangarPrefs.ts` | **pure + localStorage.** squads, membership, pins, collapsed accounts |
| `web/src/app/hangarLaunch.ts` | the launch queue's vocabulary, shared with `App.svelte` |
| `web/src/app/rosterRefresh.ts` | re-reads each account without bringing anybody online |
| `web/src/styles.css` § 5 | the whole look, under `.hangar` |

`App.svelte` renders it and owns `bringOnline` — only App can create a session, so the hangar says
*which* pilots and App does the signing in.

## Where the data comes from

Per pilot the screen shows: name, ship, location, wallet, skill points, what it is training, and
whether it is already in the client. All of it except the last comes from
`charUnboundMgr.GetCharacterSelectionData` — the same call the character-select screen has always
used, which already carries `stationID` / `solarSystemID` / `skillTypeID` / `toLevel` /
`trainingEndTime`. "In client" is live from App's session list, never from storage.

That call needs a signed-in session and this is the screen you see *before* you sign in. So
`rosterRefresh.ts` does what Onboarding's stop-a-bot button already did: signs in on a **throwaway
per-session token** (any password; `{token: …}` leaves the tab's global storage untouched), reads,
resolves the IDs to names through `/api/names`, and signs the token out. **No character is ever
selected**, so nothing undocks and nothing is claimed.

Accounts are refreshed **one at a time**, and the reason is the same one behind App's restore loop: a
browser allows about six connections per origin, so a dozen simultaneous sign-ins fill that pool with
sign-ins and the next click of any kind queues behind them.

The results land in `knownCharacters.ts`, which grew four optional columns (`locationName`,
`trainingSkillName`, `trainingToLevel`, `trainingEndsAtMs`) plus the two IDs those names came from.

> **The carry-over rule, and why it exists.** Only a caller holding a token can resolve a place or a
> skill name, and an ordinary sign-in through the character-select screen has one but does not do the
> lookup. It still calls `rememberCharacters`, which replaces the account's rows wholesale — so
> without a rule it would blank both columns on every login. The rule: a row keeps the name it had
> **for as long as the ID behind that name is unchanged**. A pilot that moved or started a different
> skill drops the old name rather than carrying a lie. `knownCharacters.test.ts` pins all three cases.

`trainingEndsAtMs` is stored as an **instant, not a duration**, so the countdown re-reads correctly on
every render, and a queue that finished while the tab was shut shows as idle instead of frozen at its
old figure. `hangar.ts` returns `null` for a training entry whose end time has passed.

Squads, pinned squads, pinned pilots and collapsed accounts are **local only** — `hangarPrefs.ts`,
localStorage. The server has no idea those pilots belong together. Manage mode's ✕ is local too: it
forgets a pilot or an account in *this browser*, and signing in again brings it back.

## Decisions worth not re-opening

**An empty character slot opens create-character, not the login modal.** The handoff has the slot open
the login modal, because in the prototype adding a character and adding an account were the same act.
Here they are not: the account is already signed into and already on screen, so a login there is a
no-op, while the thing the slot offers — put a pilot in this free slot — is `CharacterCreate`, which
needs a signed-in flow. `HangarAddCharacter` builds one on a throwaway session, hosts the existing
screen on it, and signs out. Creating a pilot does not bring it online.

**`MAX_SLOTS` is 3.** The emulator reports `characterSlots: 3` in the selection tuple; the tuple field
is not decoded yet, so this is a constant. Decode it if it ever varies.

**Manage mode makes the row inert.** No checkboxes, no `▶ ALL`, and clicking a row does nothing. It is
the mode where you remove pilots, and a stray click that put six of them in the client would be the
worst possible surprise there.

**Below 760px a tap SELECTS instead of launching**, and the selection bar's "Bring online ▶" is the
deliberate action. Mis-tap protection — see the target-size note below. The exception is a pilot that
is already in the client: there is nothing to launch, so the tap goes to its cockpit at every width.

**Clicking a pilot that is already ON goes to its cockpit.** It used to fall through `launch`'s
"already online" filter and do nothing, which — with the hangar open over a live cockpit — left no way
back into the client except the header. The header's way back is `◀ To client`, named for where it
goes rather than what it undoes.

**The hangar is reachable from the cockpit.** `Pilots` on the character bar reopens it. Without that
button the hangar was a one-way door: the first pilot coming online put the only screen that can
launch the other twenty, edit squads or forget a pilot out of reach for the life of the tab.

**No squad edit is written until it is confirmed.** Both squad dialogs open on a DRAFT — a `Squad`
value with an id that is not in prefs — and it becomes real on Save, or not at all. Previously the
squad was created first and cancelling was supposed to undo it, which left a "New squad 3" behind
every time the undo did not apply.

**"Save as squad" asks WHICH squad.** From a selection the first question is not what to call a new
squad, it is whether this is a new one at all; before `HangarSquadAssign` there was no way to add a
selection to a squad that already existed, so every op made another squad. `addSquadMembers` is a
union — adding two pilots never drops the four already in it.

**Every squad is a chip; pinning decides ORDER, not existence.** Only pinned squads used to reach the
chip row, and nothing pins itself, so on a fresh install squads were reachable solely through the
"All squads ▼" dropdown. The chips now run `All pilots · Not training · In client │ <every squad>`,
pinned ones first. The picker stays for search, pinning and editing once the row is long.

**Deleting a squad does not go through manage mode.** Delete lives in `HangarSquadEditor`, and the
only door to that editor was the chips' `edit` — which only appears in manage mode, where it replaces
`▶ ALL`. So a squad could be made from three places (the picker's `+ New squad`, "Save as squad", the
per-pilot checklist) and unmade from none, unless the player thought to press Manage and noticed a
button had changed under them. Every picker row now carries the same `edit`, which is why the picker
is its own component: the popover is closed in the screen's default render, and an SSR test cannot
open it.

**The per-pilot squad control is a checklist popover, not a chip grid.** The handoff tried the flat
grid: at eleven squads it made every row about 230px tall.

## How it sits with the design system

`docs/design-system.md` is still binding for panels. The hangar is not a panel — it is a full-bleed
screen whose job is ~100 pilots and four facts about each on one page — and it was designed and signed
off at its own densities. The divergences are deliberate and bounded:

- Every rule is under `.hangar`, so nothing leaks into a panel.
- The palette is declared once as `--hangar-*` custom properties, in one place, on
  `.hangar, .hangar-chrome`.
- `.hangar-chrome` exists because the dialogs are fixed overlays rendered **outside** the screen:
  without it they inherit the page font and none of the custom properties. `HangarAddCharacter`
  deliberately does not take it — it hosts the app's own panel, which must keep the app's look.
- The `:where()` in the button reset is load-bearing. `.hangar button` is a class plus a type, which
  out-specifies every single-class paint rule below it; written that way, every filled control on the
  screen came out transparent.

**Where it does not diverge.** Nothing is conveyed by colour alone: ON and IDLE carry their words,
every squad dot carries a `title`, every launch button says ALL, every queue row prints its state. No
numeric ID is rendered (R7d) — an unresolved place or skill is an em dash. No horizontal page scroll
at 360px: the grid collapses to one column and the chip row is the one thing that scrolls, inside
itself.

**The one known tension is R8's ≥40px targets.** A pilot row is a 56px tap target and an account header
is 40px, but the chips, the pin star and the row checkboxes are smaller — deliberately, because a grid
of 100 pilots at 40px per control is the screen this replaced. The mitigation is behavioural: below
760px the row itself is what you aim at, and it selects rather than launching.

## Fonts

Barlow **Semi** Condensed for UI and JetBrains Mono for every number and status label — one width step
wider than the app's display face, which is the right call for whole pilot, ship and system names set
at 12–15px in a 272px column. Both are self-hosted through `@fontsource`, for the same reason as the
display face and more so: the hangar is the *first* screen, so a webfont from `fonts.gstatic.com`
would be the app's first request, and on the LAN this client normally runs on there is no outbound
path for it to take.

## Verification

- `web/src/app/hangar.test.ts` — 18 tests: the stale-training rule, scope × search composition, the
  pinned-then-SP sort, slot padding, and every formatted string.
- `web/src/app/hangarPrefs.test.ts` — 12 tests: round-trip, junk and half-written storage, the two
  cascade deletes (a squad takes its membership and pin; a forgotten pilot leaves every squad), and
  `addSquadMembers` as a union that ignores an unknown squad.
- `web/src/app/knownCharacters.test.ts` — the carry-over rule and the FILETIME conversion.
- `web/src/ui/pilotHangar.test.ts` — SSR renders: first run, a populated hangar, a roster row written
  before the hangar existed, empty slots, squads (pinned and not), a collapsed account, manage mode,
  the squad picker (open, closed and empty — every row offering the editor), and "Save as squad" with
  and without squads to choose from.
- `web/src/ui/squareCorners.test.ts` — now pins the circles **by selector** rather than counting to
  one, so a new `border-radius: 50%` has to be named and reviewed.

Read `docs/svelte-typecheck-gap.md` before trusting a green build: `tsc` does not parse `.svelte`, so
a component's props are checked by the SSR tests and nothing else.

**Driven live** against a running EveJS server at 1440/1280/375/360px: the refresh, the search, the
scope chips, the squad picker, manage mode with its checklist popover, the selection bar, "Save as
squad", the login dialog and the squad editor. The launch progress dialog was **not** driven live —
doing so brings real characters online — so it is covered by its types and by App's `bringOnline`
being the same loop as the tested restore-on-refresh path.

## Out of scope, still

The in-client pilot switcher; drop targets for the draggable rows (rows set `text/plain` to the pilot
name, nothing accepts it yet); account renaming; hide-without-delete; keyboard shortcuts; a
last-updated stamp.
