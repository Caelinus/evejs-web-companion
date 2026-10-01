# Hosted ore jettison custody

The generated MCC HAULER_SERVICE miner remains `restartSafe:false`. Only its
same-process hosted reconnect path may recover ore-only whole-stack jettison.
Other destructive macros and persisted restart eligibility keep their existing
gates. A pinned script, current private hosted generation, unchanged original
grant, and fresh operation/ship/system authority are required before resuming.

`ship.Jettison` returns moved **source item IDs**, not the resulting can ID.
The runtime whole-stack transfer preserves those item IDs in the new can. HTTP
success is an action acknowledgement; it does not prove a resulting container.

Before dispatch, the host retains the exact bot/run/invocation, pilot, ship,
system, target claim, source hold flags, item/type identities and quantities,
complete relevant source holds, and existing owned container IDs. It records
issue before calling the mutation. This evidence lives outside runner macro
memory and survives hosted suspension and transport recovery.

Fresh reconciliation proves creation only when the selected source IDs have
left, unrelated source rows are unchanged, and exactly one new owned can has
the same item IDs, types and quantities. The can must be absent from the
pre-dispatch set and belong to the captured scene/pilot. A returned item-level
result must agree if available. Exact positive observations can reconcile a
lost reply; proximity, an existing can, multiple candidates, unknown rereads,
partial transfers and changed authority cannot.

An unchanged source plus an explicit empty mutation result and no new owned
can confirms no **ore** mutation. It does not claim that the runtime could not
have created an empty container. An unknown result with unchanged inventory
remains ambiguous. No blind retry occurs while custody is pending or ambiguous.

Confirmed can provenance registers the exact captured target in the existing
MCC/BFF container authority. Haulers use ordinary exclusive container claims.
Custody neither marks a can emptied nor adds an ownership registry; subsequent
hauling/disappearance follows existing settlement semantics. If registration
loses its captured target claim, recovery blocks with control retained.

Manual start/resume, transport resume, Stop and Parking cannot clear an
unresolved issued mutation. Reconciliation reads are allowed during recovery;
productive execution resumes only after a source-proven recoverable state.
Neither reconciliation nor reconnect renews the original hosted grant.

A support-bound HAULER may reconnect while its long-lived loot step is active.
Before resuming that step, the host confirms membership in the surviving
selected support fleet. Existing member/support deciders issue at most one
ordinary invite or exact fleet acceptance per fresh read tick. The private
acceptance permit rechecks Stop, original grant and both hosted pilot generations
at actual dispatch. ACK alone does not produce READY; a fresh roster read must
prove membership. Recovery cannot create or switch fleets, and keeps the existing
MANAGED/EXISTING_ONLY policy semantics.

PROCESS-RESTART JETTISON RECOVERY NOT IMPLEMENTED. Custody is volatile run-scoped
botHost state. Persisted hosted records retain `restartSafe:false`; a complete
WC process interruption does not provide a durable mutation journal.
