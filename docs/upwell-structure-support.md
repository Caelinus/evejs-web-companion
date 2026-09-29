# Shared Upwell destinations on the Farmer forward-port line

Web Companion can store an NPC station or an accessible player structure as a dockable destination. The identity includes the kind and stable numeric ID; a structure is never represented as a fabricated NPC station. Existing station-only script references remain valid. Generic travel and cargo destinations may use a structure; mission agents and mission locations remain NPC-station-only.

The selected pilot's access-filtered `GetMyDockableStructures(0)` supplies all-system search. Names and systems are resolved only for IDs in that list. WC checks current docking access again before a route or dock command, and completes a structure trip only when authoritative flight status reports the intended `structureID`. An inaccessible or unresolved structure fails closed.

When docked in a structure, WC binds personal inventory to its actual location ID. Manual fitting uses that location after checking fitting service. Corporation inventory requires the office service, a real corporation office, division access, and the existing strict Batch 3 before/after transfer contract. A personal-hangar fallback cannot satisfy a strict corporation delivery. Scripted `applyFitting` remains station-only because its existing action contract still uses `stationID`.

Service availability is a separate access-scoped read, not an inference from docking. IDs currently exposed by EveJS are docking 1, fitting 2, office 3, reprocessing 4, market 5, repair 8, and industry 20. An unreadable service state grants nothing. An online service does not by itself prove that every WC action using it works; each action still needs its own location and authority checks. Pilot Training reuses this access-scoped picker for its configuration-only Home; MCC remains a later batch.

## EveJS 0.12.9 dependency

Stock clean EveJS 0.12.9 does not provide the two narrow authority methods required by WC. Review [the Upwell-only manifest](../runtime-patches/upwell-0.12.9-manifest.json), verify its clean-file and patch SHA-256 values, and apply these patches to a **mutable** EveJS 0.12.9 runtime in order:

1. [dockable-structure-search.patch](../runtime-patches/dockable-structure-search.patch) — explicit zero requests access-filtered all-system structure IDs; omitted/current-system calls keep their old meaning.
2. [accessible-structure-services.patch](../runtime-patches/accessible-structure-services.patch) — exposes access-scoped service IDs and the narrow office-rental gateway authority.

From the EveJS runtime root, check both patches together before applying:

```sh
git apply --check /path/to/wc/runtime-patches/dockable-structure-search.patch /path/to/wc/runtime-patches/accessible-structure-services.patch
git apply /path/to/wc/runtime-patches/dockable-structure-search.patch
git apply /path/to/wc/runtime-patches/accessible-structure-services.patch
```

`officeManager.RentOffice` is denied by WC's generic bridge-call write policy. Its dedicated route requires explicit confirmation, the held pilot's current structure, current office-service authority, and an authoritative office reread. Neither patch grants arbitrary structure administration or exposes owner-only operational data in destination search.

This Batch 5 result is mechanically verified only. Apply the runtime patches and perform live Upwell travel, inventory, corporation division, and fitting QA in a separate acceptance task before claiming gameplay acceptance.
