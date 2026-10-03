# Defender capability and qualification boundary

Defender uses the shared mobile `fight-with-drones` engine, utility framework,
exact mutation reconciliation and invocation-owned settlement. MCC supplies its
owned target and run identity; it does not supply another combat engine.

## Automatic capabilities and deliberate restrictions

The accepted automatic set remains combat drones, supported loaded/reloadable
weapons, AB/MWD positioning, ordinary hardeners, fit-aware local repair and
Phase-1 web/painter/sensor/tracking/omni/capacitor utilities. Acute escape,
mandatory OFF maintenance, drone custody, Stop and relocation retain priority.

`combatUtilityPolicy.ts` identifies restricted modules by category, group and
activation effect. Tracking/guidance disruption share group 291; scram/disruptor
share group 52, so group or name alone never grants permission. Fitted restricted
modules are reported in `CombatUtilities.restrictions`, excluded from automatic
enrolment, and refused again at fresh dispatch. Unknown families also stay OFF.
Classification is not a claim that an effect is absent from EveJS.

| Family | Group / effect | Default | Missing useful-target proof |
| --- | --- | --- | --- |
| Neut | 71 / 6187 | FAIL-CLOSED | Live target capacitor and cap-dependent attack lane. NPC entity missiles bypass generic activation cap payment. |
| NOS | 68 / 6197 | FAIL-CLOSED | Live source/target capacitor amounts and actual transfer eligibility. Ordinary runtime NOS requires source amount below target amount and available source capacity. |
| ECM | 201 / 6470 | FAIL-CLOSED | Live sensor strength, useful protection of another target, and authoritative outgoing jam success. Jamming the aggressor permits it to lock the jammer itself. |
| Damp | 208 / 6422 | FAIL-CLOSED | Effective target lock range/resolution, current lock relevance and understood script. Static hull attributes do not establish current lock reach. |
| Tracking disruptor | 291 / 6424 | FAIL-CLOSED | Live projected turret attack profile and understood script. Runtime synthetic/fitted NPC turrets can be affected, but type ID alone does not identify the current attack lane. |
| Guidance disruptor | 291 / 6423 | FAIL-CLOSED | Live projected missile attack lane and understood script. The separate entity-missile lane reconstructs static missile attributes without projected modifiers. |
| Scram / disruptor | 52 / 5934, 39 | FAIL-CLOSED | A useful NPC warp-control outcome. There is no generic PvP/tackle policy. |

Runtime evidence is EveJS 0.12.9 `hostileModuleRuntime.js` (capacitor transfer and
projected modifiers), `jammerModuleRuntime.js` (sensor strength, jam application,
allowed jammer-source locks), `npcBehaviorLoop.js` / `npcEquipment.js` (generic
weapon vs entity-missile lanes), and targeting/weapon snapshot code. Both clean
reference and mutable runtime exhibit these distinctions. WC `RatThreat`, own
bound dogma and incoming jam source IDs do not expose the missing live target
facts. An active source-module tuple confirms activation/binding, not an ECM
success or useful disruption of an NPC attack.

Enabling a later family requires a narrow authoritative target observation and
usefulness contract, revalidated before dispatch. It must then use the existing
module/target outcome and owned settlement path. No new runner, universal cap
percentage, guessed target profile or direct server authority is appropriate.

Smartbomb, Burst ECM, ADC, Emergency Hull Energizer, MJD/MJFG, cloak, HIC,
nullifier, command bursts, siege/triage/bastion/core, remote logistics/ancillary
remote repair, AoE and strategic commitment modules remain excluded future
policy work. They are not activated by this framework.

## MCC scanner identity

The script scanner projection retains archetype, outer scan dictionary site key,
current dungeon instance and finite position. The inner `fields.siteID` may be
the dungeon instance rather than the outer scan key; it must not replace it.
Dropping these fields made real ore/ice rows look ineligible to the shared
operation selector. `scriptScannerSites` now preserves them for every existing
script consumer, without changing selection or travel policy.

Only the current MCC claim permits Defender travel. Missing scans, geometry,
identity, changed instance, changed run or retired claim cannot become guessed
destinations. Old owned combat state settles before new travel authority.
Anomaly and ice use the existing operation site travel helper; Defender never
reserves its own site or runs an independent patrol.

## Recovery and restart

The actual Standard Defender includes the existing armor `repair` watch. That
response is deliberately not restart-safe because recovery can spend station
repair funds. Consequently productive MAIN does not automatically reconnect or
resume after a WC process restart. The normal public reconnect returns
`BOT_RECOVERY_UNAVAILABLE` without acquiring again or dropping its current owner.
Normal Stop still settles and releases that owner.

Persisted productive Defender restart produces a visible manual-review report;
it does not select a pilot. Existing pending-preparation recovery is a separate
bounded contract and is not weakened here. Reconstructed MCC associations retain
their diagnostic owner/run information but clear trusted site authority and
report recovery-required/DEGRADED. Confirmed unclassified progress and uncertain
cleanup also stay held rather than being reset or replayed.

This is intentional fail-closed recovery coverage, not automatic combat recovery.
Operators Stop/reconcile and explicitly relaunch after review. A future change
to this policy needs its own proof of preserved combat custody and consequential
repair progress.

## Qualification

Focused verification passed 45 distinct cases: 36 new cases and nine adjacent
boundaries, including positive Phase-1 identity, restricted-family planning and
dispatch, exact outcomes, safety, scanner incarnation, both MCC target families,
actual-profile reconnect and persisted productive restart. `build:web`, changed
JS syntax checks and `git diff --check` passed. No full suite or soak was run.

Live gameplay used only freshly resolved Test04 (140000044), Test05 (140000045)
and Test03c (140000048), through isolated data and the normal public MCC/hosted
lifecycle. No Phase-2 live activation was attempted because no family met the
essential authoritative target/usefulness contract.

- ORE_ANOMALY: Test04 Venture and Test05 Vexor reached the same owned Saisio
  anomaly. One weak GM NPC died while Miner continued mining. Defender returned
  to WAIT at the operation site, drones in bay, temporary modules OFF and
  movement STOP. Normal MCC Stop confirmed both pilots offline/free.
  Start-to-Stop: 4m43s.
- ICE: Test03c Hulk and Test05 Vexor reached the same owned Osmon ice anomaly.
  Defender stayed idle with no active modules or drones. Miner conservatively
  paused on an unconfirmed long-cycle ice-harvester OFF result; this does not
  establish uninterrupted ICE mining. Normal MCC Stop nevertheless completed
  without failures and confirmed both pilots offline/free. Arrival/idle routing
  is qualified; no ICE combat episode was repeated. Start-to-Stop: 6m15s.
- Recovery: public reconnect on the actual productive Standard Defender returned
  409 `BOT_RECOVERY_UNAVAILABLE` without replacement acquisition. Its existing
  owner remained held until normal operation Stop. Productive process-restart
  refusal/manual review is covered deterministically; automatic resume remains
  intentionally unsupported.

The two final target-family runs totalled 10m58s. Earlier discovery attempts
stopped safely before the scanner identity correction. No ship/drone losses
were observed. Ammo and Test fitting/setup changes were disposable QA state.
Task WC/helper processes shut down after authoritative release; their ports
were free and the existing Launcher/EveJS runtime remained running.

The feature-complete boundary includes explicit Phase-2/tackle exclusions and
manual recovery. It does not promise arbitrary NPC EWAR applicability,
uninterrupted ICE mining, automatic combat restart, strategic/AoE modules or PvP.
