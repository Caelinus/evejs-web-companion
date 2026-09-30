# Mining Command Center

Open **Mining Operations** from the global window list. An operation coordinates
server-hosted pilots around one current resource target. Each pilot still uses
Farmer's ordinary script runner and EveJS authority; the Command Center owns
the target reservation, membership, logistics and Stop policy.

## Define an operation

Choose an anchor system, one target family, participating pilots, each pilot's
role and a finite run limit. Standard miner and hauler profiles use the shared
operation target. Custom routines must satisfy the operation target contract.
One member's failure degrades that member without silently ending healthy runs.

| Family | Supported behavior |
| --- | --- |
| Belt | Shared belt target, ordinary ore mining and belt surface travel. |
| Ore Anomaly | Current-system scanner identity and Farmer's ore-site behavior. |
| Ice | Ice-site identity and online Ice Harvesters; ore-only fits are refused. Ordinary Mining Drones are not used for Ice harvesting. |

GAS, adjacent-system scouting and a dedicated Defender role are deferred.
Resource preferences order eligible choices; they do not create a remote scan
or permit two active operations to reserve the same target.

## Deliver mining freight

**Hauler Service** lets miners jettison mining freight for service haulers. The
operation records the exact containers created by its miners; haulers do not
collect unrelated cans. The existing container claim service excludes a second
hauler from an actively serviced operation container. If the can's identity
cannot be confirmed after jettison, collection blocks for reconciliation.
When the resource target depletes, miners settle modules
and controlled drones and dump remaining partial holds. Haulers retain the old
logistics target until its grid and freight are confirmed clear, including
partial deliveries, then catch up to the current operation target.

**Self-Unload** settles equipment and controlled drones, delivers the mining
hold's eligible freight, confirms its empty hold and returns to the same
operation target. Unrelated cargo and equipment remain aboard. Standard
delivery can use the pilot's personal hangar or a specific corporation and
division. Corporation delivery is strict: a personal-hangar fallback, wrong
division, partial result or unreadable post-transfer state does not count as
success.

An NPC station or accessible player structure can be a delivery destination.
Structure delivery requires current docking access. Corporation delivery there
also requires an online office service and an accessible corporation office.
A dockable structure alone does not prove corporation inventory access.

## Stop and Parking

Parking is separate from delivery. Choose Stay, return and dock, or return,
unload mining freight and dock. Its destination may be a station or accessible
player structure. Unload Parking can target a personal hangar or an exact
corporation division. The latter uses the same strict corporation postcondition
as delivery. A blocked member remains visible as blocked/degraded; the
operation does not report parked merely because Stop was requested.

The operation uses the shared drone recall and hosted Stop lifecycle. A
confirmed empty controlled flight precedes ordinary relocation and terminal
cleanup. Repeated Stop is idempotent. After a process restart, current target
and live ownership are reread rather than reconstructed from saved observations.

## Travel Assist and limits

Optional Travel Assist controls only an AB or MWD it activated for the current
approach. It keeps that module cycling during the approach, switches it off
near the target or when authority changes, and leaves externally activated
modules alone. A confirmed module command is distinct from observed physical
acceleration. The current hosted-run ceiling follows Farmer's 72-hour grant
policy; no unlimited or automatically extended run is created.

Operation definitions remain in `data/mining-operations.json` version 1.
Current gameplay acceptance and environment-specific limitations should be
reported separately from this product guide.
