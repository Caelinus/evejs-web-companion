# Public hosted Start ownership

`POST /api/bots/start` reserves the character and caller session while validating
and handing off pilot control. It passes that exact private Symbol to
`botHost.start`, which forwards it to the production ownership probe. Both maps
must contain that same Symbol, including after asynchronous ownership reads.
An operation name, character ID, different session or retired Symbol grants no
exception. The capability never comes from HTTP input or persisted bot state.

The host claims the character before `beforeStart`. That callback receives the
new private hosted claim capability. After any caller cockpit has been safely
released, the route verifies the claim and retires its character reservation.
The caller session remains fenced until the request finishes. This transfers
authority to the normal hosted lifecycle once, and allows acquired-session
failure cleanup and ordinary Stop to release the host's session.

For a free caller, a fresh runtime status must prove the pilot offline before
claiming. Generic hosted selection uses stock `/session/select`, the same
`charUnboundMgr.SelectCharacterID` handler as a real client. It requires no
Factory method or `/factory/*` endpoint. WC rechecks its reservation and hosted
generation after awaited release and refuses another known held owner or foreign custody.
Resume does not inherit a retired Start capability.

WC's offline observation is not atomic acquisition against external clients.
If an external owner appears before selection, EveJS applies its configured
retail policy: `loginTakeoverEnabled=true` permits takeover; false refuses the
duplicate. The original game-port protocol uses the same handler and policy.
These are inherited stock server semantics, not an atomic free-only guarantee.

On failure, exact comparisons clean only this attempt's reservations. Existing
hosted claims and held cockpit rows continue to fence unresolved release or
write custody. A definitely released caller may be restored only after hosted
ownership has ended, under a separate private restoration reservation, fresh
offline proof and stock selection. The exact reservation, hosted claims, held
sessions and custody are checked again after that observation. A later external
login still follows the same server takeover policy. Refused or uncertain
restoration stays visible. Retired callbacks cannot restore a new WC generation.

A request carrying a hosted claim header must retain that exact current claim;
it cannot fall back to browser selection after retirement. Selection and
restoration check their captured authority again before installing an acquired
session. A stale outcome releases only its returned handle. An unconfirmed
release retains a held-session fence and refuses productive requests until its
exact logout is confirmed; it never replaces a newer cockpit row.

Customs-export keeps its exact-self probe and its existing runtime offline
checks. MCC's existing explicit operation/run handoff exception is unchanged;
ordinary public Start cannot borrow it. Factory/temporary control, foreign
browser sessions, other hosted bots and unresolved custody remain blocking for
fresh Start. A resumed MCC preparation may reconcile only its exact current
checkpoint, account, operation/run and custody ID before MAIN. Its existing
held session may reconcile custody. Reacquisition while custody is unresolved
refuses explicitly: stock selection supplies no per-request free-only authority.
No Defender combat policy or MCC Defender execution is changed here.

The integration regression exercises the actual public route, actual host and
production ownership probe with a fake gateway/browser stack. It covers exact
identity, both-map context, foreign owners, stale generations, one-winner races,
failure cleanup, retained release uncertainty, restart and the MCC seam. Existing
customs-export, hosted recovery and Factory boundaries are run alongside it.
