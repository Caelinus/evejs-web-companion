# Stock hosted maintenance

An explicit Provisioning Center Apply or Training Provision Equipment action can manage a free, offline pilot without opening its cockpit. The server briefly selects that pilot through normal stock `/session/select`, performs selected NPC-station provisioning, verifies the result, releases the exact acquired handle and asks stock character status to prove offline.

## Authority and accepted intent

Page opening, roster refresh, qualification and preflight Review use account-owned character/status and corporation-fitting reads. Physical ship/location, equipment, source stock, Query/Take permissions, shortages and final plan remain UNKNOWN/PENDING until acquisition. The user chooses an explicit fitting and physical source. Definition provider corporation remains separate from physical source corporation.

Preflight accepts a five-minute intent, not a physical inventory snapshot. It pins account, pilot, pilot corporation, provider, saved date, fitting content/full definition fingerprint, source, consumer and (for Training) complete configuration identity and target stage. Selected Review rejects changed definitions and records the first selected physical baseline. That baseline remains strict through all reads before the first engine dispatch; the existing custody journal proves later movement. The result's equipment status comes from final selected readback.

The shared engine's current support remains unchanged: ordinary published T1 frigates, supported module slots and drone/cargo equipment at NPC stations. Unsupported plans refuse after selection and release normally. Exact equipment is a verified no-op, including LOW/MISSING optional supplies, and requires Query but no Take. New hull mutation requires Take. The policy is NEW_HULL_ONLY; an exact existing ship is not automatically topped up. No undock, travel, combat, mining, drone launch, unrelated cargo removal or Home changes occur.

## Ownership and progress

`provisioningCenterApply` owns a bounded invocation in the existing control journal. It installs one exact `temporary-provisioning` reservation in `characterOperations` and the synthetic/caller `sessionOperations`. It uses the existing `bridgeSessions` map for the opaque selected handle under `provisioning-center:<operationID>`; the browser never receives or adopts that handle. No bot controller or permanent ownership registry is added.

Known browser/hosted/operation/session reservations, unresolved custody and prior unproved releases refuse before selection. Every awaited ownership/acquisition/read boundary rechecks the private reservation and held-object identity. The shared engine may temporarily delegate that exact parent to its own exact child custody lease. A copied or stale object grants no exception. A stale acquired outcome is never attached; cleanup releases only its returned handle and never deletes a foreign reservation or held row.

Progress uses ACQUIRING_CONTROL, READING, REVALIDATING, PROVISIONING, VERIFYING, RELEASING and terminal COMPLETE/ALREADY_SATISFIED/REFUSED/BLOCKED/UNCERTAIN. Operation reads observe this progress and do not keep an idle pilot selected.

## Custody, release and restart

The outer invocation persists before acquisition. Its exact child custody ID persists before engine Apply. Existing shared provisioning dispatch persists each pending action before sending, rereads its result and never blindly replays ambiguous mutation. Failures reconcile only through the original selected owner where possible, then release that exact session. The administrative release callback bypasses the inventory mutation fence solely to end that acquired handle; custody continues fencing inventory and reacquisition.

Only exact character identity, `online=false` and `controlState=offline` prove final offline. An acknowledged session release without global offline proof remains UNCERTAIN. Failed release retains its exact held row and reservation; recovery can retry release of that same handle. Cleanup and recovery are singleflight. Durable terminal evidence precedes reservation deletion, and journal failure cannot prevent exact session cleanup.

After process restart no handle is recreated from the journal. Interrupted invocations reconstruct only their exact recovery reservation. Recovery observes stock offline status and retains unresolved custody; it never selects, continues or resends. A new explicit intent is allowed only after all relevant fences settle.

## Training evidence

Training is the `PILOT_TRAINING` consumer of the same Center Apply and selected engine. It rechecks the accepted provider/hull/date/fingerprint and trained hard skills after selection and immediately before engine Apply. Center acceptance cannot substitute for Training acceptance. Browser configuration/source checks remain required before sending Apply.

A successful, released Training operation may supply a 60-second selected observation receipt. The receipt preserves the final selected observation timestamp, including through slow cleanup or repeated invocation reads; refresh cannot renew it. Changed configuration/source/definition, non-free control or expiry removes its readiness authority. Duty Ready still requires Skills READY and Equipment VERIFIED. Optional supply state remains independent.

## Stock external-login race

WC reservations cover known WC state only. A retail login arriving after the offline observation follows stock `network.loginTakeoverEnabled`: false refuses duplicate selection; true can take over the other retail session. Neither stock gateway selection nor original game protocol offers a per-request atomic free-only selected acquisition. This accepted race is identical to stock hosted Start. No Factory endpoint, private gateway method, EveJS patch or mod is used.

Skill purchase/funding and Upwell service actions remain unavailable in this change. Native protocol handlers exist, but their companion transport, financial outcome recovery and service lifecycle require separate design/qualification.
