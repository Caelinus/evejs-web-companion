# `join-advertised-fleet` hung after applying — what it was, and the fix

**Status: FIXED in the companion, not yet re-driven live.** The block shipped in
`d2264b7`, hung on a live fleet on 2026-09-09, and the accept half it was
missing is implemented on `fix/join-advertised-fleet-accepts`. Kept as a record
because the protocol fact underneath it is easy to get wrong twice, and because
one R94 decoder guess turned out to be wrong.

**The one-line version:** apply → the server mints an invite → **the client
accepts it**. We had written the first step and none of the third. eve.js was
correct throughout; every defect here was ours.

## What the player sees

A bot on the block sticks on phase `Joining a fleet`, reason
`Waiting to be let into "<name>".`, forever (until the block's 150-tick bound
trips and it stops with "never got into the fleet"). The advert is real, the
pilot is eligible, the fleet needs no approval, and the pilot still never joins.

Everything up to the apply works. The finder read succeeds, the name matches,
the right `fleetID` is picked, and `fleet/apply` is dispatched and succeeds. The
bug is what the companion fails to do *next*.

## Root cause

**This is a companion bug, not an eve.js one.** Apply -> the server mints an
invite -> the client calls `AcceptInvite` is the *designed* round trip, and
eve.js implements the server half of it correctly. The companion is not the
client and never implemented the accept half. Nothing below is a defect in the
runtime; it is the protocol, and we only wrote one end of it.

`fleetRuntime.js` in the eve.js server (read live out of the `evejs-server`
container at `/app/server/src/services/fleets/fleetRuntime.js`):

```
applyToJoinFleet(session, fleetID, autoAccept = false)      :2703
  ├─ advert missing / not registered      -> FleetNotFound
  ├─ !isAdvertOpenToSession               -> FleetNotAllowed
  ├─ advertJoinLimit reached              -> FleetTooManyMembers
  ├─ advert.joinNeedsApproval  -> stores a joinRequest, pings the boss, return true
  └─ else -> inviteCharacter(bossSession || session, ..., { autoAccept: true })
                                                            :2737
```

and `inviteCharacter` (`:1553`) ends at:

```
createInviteRecord(fleet, inviter, invitee, placement, options);   :1576
notifySession(inviteeSession, "OnFleetInvite", [...]);             :1581
return true;
```

It creates a **pending invite** and notifies the invitee. It never touches
`fleet.members`, `runtimeState.characterToFleet`, or the fleet chat channel.
Membership happens only in `acceptInvite` (`:1592`), which is a separate call.

So on an open, no-approval advert the round trip is:

1. apply -> the server mints a pending `OnFleetInvite` addressed to the
   applicant, flagged `autoAccept: true`
2. **the client calls `AcceptInvite`**
3. only then does `inFleet` flip

The block does step 1 and then waits for step 3. We never wrote step 2, so it
waits forever. `bound-fleet` is reporting correctly — the pilot genuinely is not
in the fleet.

### The return value tells you which path you took

`applyToJoinFleet` returns **`true` only on the approval path** (`:2730`) and
`false` when it minted an invite (`:2748`). That is the discriminator, and the
real client uses exactly it: it turns a `true` into `FleetApplicationReceived`
(`fleetSvc.py:1908`).

**The companion already receives this and throws it away.**
`dispatchBridgeWrite` passes `result: outcome.result ?? null` straight through
(`src/server.js:5338`), so the boolean reaches the browser in the ack envelope.
But `api.ts`'s `applyToJoinFleet` is typed `Promise<void>` and discards the
response, and `decodeFleetWriteAck` reads only `ok`/`applied` because R94
guessed ApplyToJoinFleet "returns null/ack" — a fast-mode guess this now
disproves. Prefer this over pre-reading `joinNeedsApproval` off the advert: it
is the server's own answer at the moment of the call, not a field that may have
changed since the listing was read.

### `autoAccept` is a client instruction, and a real client obeys it

`applyToJoinFleet`'s own `autoAccept` parameter is declared and never read
(`:2703`); the function hardcodes `{ autoAccept: true }` on the invite it
creates, and that flag is only ever *written* server-side — into the invite
record (`:1542`) and the notification payload (`:750`).

That does **not** make it inert. It is an instruction to the client — "accept
this invite without prompting the player" — and the real EVE client honours it.
It reads as a no-op today only because the companion never implemented the
accept half that would act on it. Once step 2 exists, this flag is exactly the
signal saying an unattended ship may accept without asking, which is what a bot
wants. Implement it, do not dismiss it.

## What the fix does

The block is now apply → accept → confirm.

- `decodeFleetApplyOutcome` (new, `bridge/fleetWrites.ts`) reads the apply's
  boolean into `"needs-approval" | "invited" | "unknown"`, and `api.ts` returns
  it instead of `void`.
- `flow.ts` keeps that answer per run and hands it to the block as an
  observation (`fleetApplication`), because only the runner ever sees a write's
  result. It carries the fleet id, so a block can tell its own application from
  one an earlier lap made.
- The decider accepts the minted invite, naming the fleet it applied to; stops
  immediately with a plain sentence on the approval path; and treats `"unknown"`
  as "try the accept".
- `acceptFleetInvite` gained `fleetID: number | null` — `null` keeps `join-fleet`
  asking the store, a number means "this fleet", which avoids racing the
  notification.

Decisions worth keeping, and the reasoning:

- **The fleetID is passed rather than looked up.** `flow.ts`'s existing
  `acceptFleetInvite` case reads `store.fleet.get().pendingInvite?.fleetID` and
  throws when it is undefined. That couples the bot to a notification having
  arrived *and* been decoded into the Fleet Center slice — a race on the tick
  right after the apply. The block already knows the id it applied to;
  `acceptInvite` server-side only checks that the caller has an invite whose
  `fleetID` matches (`:1598-1601`), so passing the advert's id straight through
  is both sufficient and more robust.
- **The approval path is a genuinely different outcome.** It stores a join
  *request* for the boss and sends no invite at all, so there is nothing to
  accept and no amount of waiting helps. The block now says so and stops at
  once, rather than sitting out the bound and blaming a timeout.
- **Second failure mode, currently untriggered but latent.**
  `applyToJoinFleet` passes `findSessionByCharacterID(getBossCharacterID(fleet))
  || session` into `inviteCharacter`, which opens with
  `ensureFleetMembership(session, fleetID)`. If the boss's session cannot be
  resolved, that falls back to the *applicant's* session — who is not a member —
  and the call throws. So applying to a fleet whose boss is offline or otherwise
  unresolvable fails, and the runner swallows it exactly as it swallowed this.
  Not what bit us (the boss was online), but it will bite eventually.
- **The swallowing is the reason this cost an afternoon.** The apply's error —
  or, here, its silent non-effect — is invisible: the action executor's throw is
  eaten by the runner, and the block's only signal is the 150-tick timeout. The
  refusal ledger (`nav/refusalLedger.ts`) exists for exactly this and this path
  does not feed it. Worth wiring while you are in here.

## What is already proven, so do not re-derive it

- The finder read, the name match, the tie-break and the id are all correct —
  the block reached "applying" with a valid `fleetID`, which is only reachable
  past all of those.
- `buildAdvertPayload` (`fleetPayloads.js:292`) does put a real `fleetID` in the
  advert body, so decoding the id out of the body rather than the dict key is
  fine.
- `getAvailableFleetAds` (`:2581`) filters by the *same* `isAdvertOpenToSession`
  the apply re-checks, so an advert that appears in the listing cannot then be
  refused as `FleetNotAllowed` — eligibility is not the problem.
- A fleet formed the normal way has a default wing and squad
  (`createFleetRecord` → `createDefaultWingAndSquad`), so
  `findPlacementForRole`'s `FleetNoPositionFound` is not firing here. This was
  the obvious suspect given the 2026-07-25 wing/squad-of-0 bug; it is not that.

## Where the code is

| Thing | Where |
|---|---|
| The decider | `web/src/nav/scriptMacros.ts`, `joinAdvertisedFleet` |
| The action | `web/src/nav/scriptDecide.ts`, `applyToJoinFleet` |
| Action execution + the finder read | `web/src/app/flow.ts` |
| BFF wrappers | `web/src/app/api.ts`, `loadFleetAds` / `applyToJoinFleet` |
| BFF routes | `src/server.js`, `/api/bridge/fleet/apply`, `/api/bridge/fleet-ads` |
| Runtime truth | `evejs-server` container, `/app/server/src/services/fleets/fleetRuntime.js` |

Read the runtime out of the container (`docker exec evejs-server-1 …`) — there
is no eve.js checkout on this host.

## Tests, and why the first set proved nothing

The original 29 tests all passed while the block hung on a healthy fleet,
because **every one of them stopped at "emits an `applyToJoinFleet` action"**.
Nothing asserted what happened after the apply, which is exactly where the bug
was. A green suite was not evidence, and the "never fired live" warning on these
writes was the stronger signal.

The block's tests now drive the round trip: apply → the answer comes back →
accept, naming the fleet → `inFleet` → done; plus the approval path stopping at
once, `"unknown"` still accepting, and a previous lap's answer not being
mistaken for this one. `fleetWrites.test.ts` pins the boolean both ways and
pins `"unknown"` as *try*, not *assume approval*.

**Still owed: a live run.** Tests did not catch this the first time and cannot
prove the fix; only a real advert can.

Suite baseline on this host: **19 pre-existing failures** (locale/formatting and
some hangar ones), unrelated to this work. Do not chase them.
