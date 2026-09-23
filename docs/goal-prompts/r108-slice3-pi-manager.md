# R108 slice 3: the PI Manager

**Status:** Design, awaiting approval. Amends slice 3 of the R108 design after the
operator's own proposal and three rounds of research. **Client + bridge only.**

**§6 is answered** — reading a colony needs only ownership, and was proved live;
acting needs a selected character. Read §6 before §4 and §5, because it removes
the takeover hazard from the read path entirely and changes what the cache is
for.

Slice 3 was originally specified as a read-only fleet board that never signed a
pilot in. The operator proposed something better: a manager that owns a roster of
assigned pilots and signs them in **only at the moment an action is due**, because
almost everything in planetary industry has a knowable deadline. This document is
that design, with the parts research has since disproved removed.

---

## 1. The shape

A **PI Manager**: one window, a roster of pilots the player has assigned to
planetary industry, what each one's colonies are doing, and the work that is due.

Three rules decide nearly every detail below.

**Rule 1 — a prediction may decide when to look; only a read may decide what to
say.** Every panel in this app inherits *nothing here simulates a colony*. A
schedule is a prediction and is allowed to be wrong; a sentence on screen is not.
So computed deadlines drive the scheduler and never the wording. When a
prediction is wrong the next read corrects it and the player never saw a guess
presented as a fact.

**Rule 2 — the manager is the brain, the bot host is the hands.** The server bot
host already flies pilots unattended, already holds a claims map, and already has
both planetary macros. The manager decides *what* needs doing and *when*; it does
not become a second thing that claims hulls by its own rules. See §4, which is
where this stops being a preference and becomes a safety requirement.

**Rule 3 — logging in is cheap, selecting a character is not.** A login claims no
hull. Selecting dispatches the real character select: it applies the character,
undocks it and joins its chat rooms. Everything expensive in this feature is a
*select*, not a *login*, and the schedule exists to minimise selects.

---

## 2. What research established

Read directly from the code, not assumed.

### The window

Global, account-scoped windows already exist. Membership of one set,
`GLOBAL_TABS` in `web/src/ui/globalWindow.ts`, is the whole mechanism; global
windows live in a second list above the per-pilot remount boundary, so they
survive a pilot switch. Adding one is four edits: a `TabID`, a neocom glyph
(exhaustive by construction — a missing one is a compile error), the id in
`GLOBAL_TABS`, and a `PanelHost` case.

**A second browser window is not on the table.** There is no `window.open`, no
`BroadcastChannel`, no `SharedWorker`, no storage-event listener anywhere. R42
deliberately moved the session token into `sessionStorage` *so that tabs would
stop sharing identity* — two tabs today are two independent sessions, possibly on
different accounts. "Separate window" here means a floating in-app window.

*(Landmine if anyone revisits that: global window positions persist to a
`localStorage` key that is not scoped per tab, so two tabs would race on one
stored rectangle.)*

### The precedent to copy

`FleetCompanions.svelte` is the same shape as this feature and should be read
before a line is written. It takes the whole `sessions` roster as a prop,
subscribes to **each session's own store slices**, and issues every action
through **that pilot's own flow** — its own comment: *this window is never
allowed to drive one pilot with another's*.

Its roster is also a deliberately player-built list rather than "everyone signed
in", for a reason that is exactly the operator's: *a pilot brought online to check
a contract sat in the fleet roster beside the three you meant*.

### Sessions and accounts

- There is **no account-level limit of any kind** — no session cap, no
  `ACCOUNT_IN_USE`. Every login mints an independent token with its own random
  session id, and server sessions are keyed by that token, never by account.
  Two pilots on one account signed in at once already works today.
- Every concurrency gate in the system is **per character**.
- An "account" is not an entity in this client; it is a name string used to
  bucket pilots locally.

### Assignment

There is **no job or role primitive** to reuse. Squads exist — `localStorage`,
per browser, cross-account, keyed by characterID, many-to-many — but a pilot's
*role* within one was deliberately removed, leaving a single boolean for fleet
companions. The codebase also carries an explicit warning that the companion
roster *is not a hangar squad, and the two must not be merged*.

So the PI roster is its own store, shaped like the companion configs
(characterID-keyed), **seedable from a squad but not the same thing**.

### What the manager knows before it signs anyone in

The remembered-pilot store carries name, ship, skill points, balance, location,
training and a last-seen instant. It carries **no planetary data at all**, and
nothing anywhere caches colony state pre-login. The manager's cache is new, and
so is the read-at freshness that goes with it.

### There is no scheduler

Every client-side timer in this codebase is a fixed-interval poll guarded by
`skipWhileBusy`. The **only** computed-wake timer in the whole system is the bot
host's run-deadline: it takes a target instant, subtracts now once, sets a single
`setTimeout`, `unref()`s it, and rebuilds it from persisted state after a
restart. There is no cron, no job queue, no task table.

The manager's scheduler is therefore the first of its kind here, and that timer
is the model to copy rather than any client-side poll.

### What is computable

| Question | Computable? | From |
|---|---|---|
| Has this extractor's program ended, and when does it? | **Yes, exactly** | the program's own `expiresAtMs` |
| When will this factory run dry? | **Yes, as of slice 1** | recipe input quantities and `cycleTimeSeconds` against the pin's contents |
| When will a hold fill up? | **No** | a point-in-time fill only; no rate field. See §6 |
| Is a factory starved right now? | Yes, rear-facing only | `receivedInputsLastCycle === false` |

`colonyAttention.ts` already emits a `dueAtMs` per finding and sorts colonies by
their worst one. **That is most of a priority queue already** — the scheduler
consumes it rather than replacing it.

⚠ `clockOffsetMs` and `serverNow()` are the only sanctioned clock. A scheduler
that slept against `Date.now()` would drift by exactly the amount the player's
machine is wrong, and this rule is already stated three times in three modules.

---

## 3. The roster

The player assigns **pilots**, not accounts.

Each assigned pilot carries: whether they are assigned, an optional extractor
program length (the player's own choice, which is what makes an extractor's next
deadline predictable), and the last time their colonies were read.

Seedable from a squad in one action — "add everyone in this squad" — because
that is the grouping the player already made. It does not stay linked to the
squad; a squad is a fleet grouping and this is a job list, and the two drifting
apart silently is worse than copying once.

A pilot with no colonies is not an error and not a mistake: *some of them might
already have PI set up, some might be in progress* is the operator's own framing,
and the roster shows that difference rather than hiding a pilot who has not built
yet.

---

## 4. Occupancy, and the one thing that cannot be built as asked

The operator's requirement: do not log a pilot in if a bot is flying it, in the
client or on the server.

**Half of that is checkable and half is structurally impossible.**

- A **server bot** is visible to anyone, unauthenticated, through the active-bots
  endpoint. Fully checkable, before any login.
- A **tab-run bot** exists only inside that tab's JavaScript. No endpoint —
  authenticated or not — reports which characters are currently *selected* by some
  session. A bot running in another tab, or on the player's phone, is invisible.

And the failure is silent rather than loud: tab-versus-tab takeover is untouched
by design, so selecting that character is **not refused** — it steals the hull and
kicks the other tab. The guard would pass and the damage would happen anyway.

**This is why rule 2 is a safety requirement.** The bot host holds a real claims
map and refuses honestly: `CHARACTER_IN_USE` when a web session holds the
character, `BOT_ALREADY_RUNNING` when another bot does. Routing every action
through it converts an undetectable takeover into a refusal that can be put on
screen in the server's own words.

So:

- **Acting** goes through the bot host. Always.
- **Reading**, if it needs a select at all (§6), is refused for any pilot with a
  server bot, and for any pilot this browser already has online — the two cases
  that are knowable.
- For the unknowable case, the manager does not claim a guarantee it cannot keep.
  It says what it checked.

---

## 5. The schedule

The manager holds one timer, not one per pilot.

1. From the cached colonies of every assigned pilot, compute each colony's next
   due instant: the earliest of its extractor expiries and its predicted factory
   dry-outs, against the server's clock.
2. Take the earliest across the whole roster. That is the wake time.
3. Sleep until it — one computed `setTimeout`, in the bot host's style, not a
   poll.
4. On waking, act on what is due, refresh what was acted on, recompute, sleep
   again.

Consequences worth stating:

- A roster whose soonest deadline is nine hours away costs **nothing** for nine
  hours. That is the whole point of the operator's proposal.
- A wake is per *moment*, not per pilot: several colonies due together are one
  wake.
- The manager groups the due work **by account**, and processes one pilot per
  account at a time. Today nothing requires this. It is written as a named
  constant — how many pilots of one account may be worked at once, set to 1 — so
  that if eve.js later drops multi-pilot logins this is a constant change rather
  than a redesign, and if it keeps them the constant is raised. Depending on
  today's behaviour is how a silent breakage is bought.
- Accounts are worked concurrently, bounded, because nothing gates them.

---

## 6. ANSWERED: reading needs ownership, acting needs a session

This was the question that blocked the design. It has been settled against the
gateway source **and proved against the running server**, not reasoned about.

### Reading a colony does NOT require selecting a character

`GET /_evejs-web/v1/snapshot?accountID=&characterID=` takes both ids from the
query string and is gated by `validateOwnedCharacter`
(`D:\evet\server\src\_secondary\express\evejsWebGatewayRuntime.js`), which loads
the character, compares `character.accountID` to the supplied account, and
returns. It consults **no session map, no online flag, no bridge session**.
`buildPlanetRuntimeForCharacter` then filters colonies by `ownerID` out of a
persisted table — again with no session anywhere.

Proved live against the running stack:

| Probe | Result |
|---|---|
| Colonies through the **BFF** with nothing selected | `409 NO_LIVE_SESSION` — *"No character is online; select a character first."* |
| `/snapshot` through the **gateway**, no session, nothing selected | **`200`** for every character on the account |
| `/snapshot` for a character that exists but belongs to **another account** | `403 CHARACTER_ACCOUNT_MISMATCH` |
| `/snapshot` for a character id that does not exist | `404 CHARACTER_NOT_FOUND` |

The two refusals matter as much as the success: they prove the ownership gate
actually discriminates, rather than the endpoint being open to anyone.

**So the held-session requirement is the BFF route's own shape, not the
gateway's.** The BFF takes the character from whichever one the tab selected
because that is how it was written, and its own code already depends on the
gateway answering for an offline character — `POST /api/bridge/select` and
`POST /api/bots/start` both call `getSnapshot` as an ownership pre-check
*before* the character is brought online.

### The route to copy already exists

`GET /api/roster/training` takes **plural** `characterIDs` from the query string,
passes each one to the gateway with the caller's own accountID, lets
`validateOwnedCharacter` refuse anything the account does not own, and silently
drops a refused id rather than failing the whole request. Its own comment says
so. It is `requireAuth` only — no held session.

That is exactly the shape the PI Manager's read wants, and it means the read
route is a small, precedented addition rather than new ground.

### Acting DOES require a selected character

The planetary writes ride the bound-object seam, and both `bindBoundObject` and
`callBoundMethod` hard-require a `bridgeSessionID` that resolves to a live
session minted by an earlier character select — there is no fallback the way the
plain call route has one. The emulator then takes `ownerID` from that session
rather than from the arguments, so a write can never touch another character's
colony, but it also cannot happen without that character being online.

### What this changes

- **The read path claims no hull and carries no takeover risk.** §4's hazard
  applies only to acting.
- Refreshing the whole board costs one cheap login per account plus one cheap
  call per character. Nothing is selected, so nothing is stolen.
- **Selecting a character now happens for exactly one reason: to act.** And
  acting goes through the bot host (§2, rule 2), which is the only thing in the
  system that arbitrates hull ownership honestly.
- The cache and the schedule (§5) stop being load-bearing for *correctness* and
  become what they should be: a way to avoid pointless work.

### The one thing still unproved, stated plainly

**A colony's data has not been seen coming back through a sessionless read,
because this server currently has no colonies at all** — the `planetRuntimeState`
table has zero rows, which is also why every probe above reported no planet
runtime. That absence is explained, not ignored: it is consistent with an empty
table and tells us nothing against the design.

It is closed by building one colony in-game on any character and re-running the
same `/snapshot` probe with nothing selected. Until somebody does that, the claim
"colonies arrive sessionless" rests on the gateway source, which is strong
evidence but is not a live reading — and this repo has been wrong before about a
surface nobody had exercised.

---

## 7. What this does not do

- **It does not build a colony.** Structure placement is spatial and out of scope
  for R108 entirely.
- **It does not abandon a colony.** That route exists and destroys the colony; it
  stays out of the UI.
- **It does not run when the window is closed.** The scheduler lives in the
  window. Work that must survive a closed browser is the bot host's, which is
  what rule 2 already routes actions through — a long-running unattended PI
  operation is a bot, started from here, not a second daemon.
- **It does not claim to know about bots it cannot see** (§4).

## 8. Risks

- **The undetectable tab-run bot.** Mitigated by rule 2, not solved. Worth saying
  plainly in the UI rather than implying a completeness the app cannot deliver.
- **A wrong prediction wakes the manager early or late.** Harmless by rule 1: an
  early wake is a wasted read, a late wake is what today's alternative — no
  manager at all — does every time.
- **The first scheduler.** No prior art in this codebase to copy on the client
  side. Expect the timer's edge cases (a clock jump, a sleeping laptop, a roster
  edited while a wake is pending) to need their own tests.
- **A cache of several pilots read at different moments** is not one moment. Every
  row carries its own read-at, and the board never presents a merged view as if it
  were a snapshot.

---

## 9. What landed: the read path and the board (read-only)

### §6's open question is closed

Probed on 2026-09-23 against the running server, which by then had colonies on two
pilots of one account. With the owning pilot logged out, nothing selected and no
server bot on it, `/snapshot` returned its colonies — owner-filtered — while a
third pilot on the same account came back with a colony table that was present
and empty. The ownership gate still discriminated (403 across accounts). The
premise holds as a live reading, not only as source.

⚠ The host's `D:\evet\_local\gameStore\gamestore.sqlite` is **not** the running
server's store; the container's is `/var/lib/evejs/gameStore/gamestore.sqlite`.
The earlier "zero colonies" count was read from the host file and proved nothing.

### The pieces

| Piece | Where |
|---|---|
| `GET /api/roster/planets` — plural ids, caller's account, refused left out, per-pilot `readAtMs` beside one envelope `serverNowMs` | `src/server.js` |
| The decoder, and "asked but not answered" | `web/src/bridge/piRoster.ts` |
| The roster store — members plus each pilot's last reading kept verbatim and decoded on the way out | `web/src/app/piRosterPrefs.ts` |
| The read — one throwaway sign-in per account, one account at a time, 12 per ask, never a select | `web/src/app/piRosterRead.ts` |
| The board — four per-pilot outcomes, worst first across pilots, a read age on every row | `web/src/bridge/piBoard.ts` |
| The window — global, in the rail, reads when opened and on Refresh, never on a timer | `web/src/ui/PiManager.svelte` |

The one-line colony sentence moved out of `Planets.svelte` into
`colonyLineWords` (`colonyAttention.ts`) so the panel and the board cannot word one
colony two ways.

### Proved live, end to end

The worktree's own BFF code, booted against the real gateway: throwaway sign-in,
one ask for three owned pilots and one foreign one, sign-out. The three owned
pilots answered (five colonies, none, two), the foreign one was left out, and the
same session's `/api/bridge/planets` answered `409 NO_LIVE_SESSION`. The pilots'
read instants differed from the envelope's sample by up to ~0.4 s — the skew that
keeping the two apart exists to avoid. No select appeared in the server log.

### Not done here, deliberately

- **Opening the window needs a pilot online in the tab.** The rail lives in the
  per-pilot workspace, as the Bot Manager's does. A door on the Pilot Hangar
  landing screen would let the board open with nobody online; that screen is being
  changed elsewhere, so it is left for a later pass.
- **No scheduler, no dispatch** (§5 and slice 4).
- **Selecting a colony does not yet focus it in Planets**, which is per-pilot and
  would need that pilot to be the active one.
