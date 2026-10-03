# Deferred module shutdown

Module OFF is not confirmed by Deactivate ACK. EveJS ice harvesting cannot
short-cycle: normal manual OFF completes at the current mining cycle boundary.
The prior fixed 15-second observation budget could therefore pause a healthy
miner while its accepted shutdown was still completing.

The BFF now reads the exact held module's effective dogma attribute 73 through
`QueryAttributeValue`. A positive finite effective cycle up to 300 seconds grants
one cycle plus a five-second margin. Unknown, invalid or longer durations retain
the conservative 15-second fallback; static type duration never grants extra
authority. Short cycles use their smaller derived bound and confirmed OFF
returns immediately.

The mutation request observes for at most its original short budget. If the
exact module remains active with known cycle authority, it returns the remaining
budget and ship scope. The API continues through read-only exact-module state
requests, avoiding the 65-second HTTP transport deadline. It sends Deactivate
once. One deadline is fixed at the first response and never renewed by reads.

Pilot/hosted request authority is captured before dispatch and retained during
observation. Requested module and ship identity must match every read. Retired
authority, unknown state or expired observation remain unconfirmed; existing
runner pause and owned-cleanup custody semantics are unchanged.

## Timing evidence

Test03c (140000048), Hulk 9988400022861, Ice Harvester I 9988400023477:

- Effective cycle: 85,680 ms, confirmed by bound dogma and activation effect.
- Productive mining: new ice appeared in the mining hold before normal `until`
  completion requested OFF.
- Original OFF HTTP request: 2026-10-03T20:25:31.006Z; Deactivate dispatch:
  20:25:31.051Z.
- Original response at 20:25:46.710Z: `stopped:false`, exact module still active;
  runner paused with `MODULE_ACTION_UNCERTAIN`.
- First read showing exact module OFF: 20:26:57.639Z (observation started at
  20:26:56.601Z), 86.588 seconds after dispatch. This is sampled timing rather
  than a claim to know the server's transition instant.

This establishes a normal deferred cycle beyond the old budget. No EveJS source
change, extra Deactivate, NPC combat or baseline A/B substitution was required.

## Fixed-candidate repeat

The same Test03c ship, fitting, ICE target family and normal `until` shutdown
were used. Only disposable inventory setup changed: 29 already-owned ice units
were retained below the unload threshold so new productive mining could reach
the normal boundary without waiting through several full-hold cycles.

- New ice increased from 29 to 32 and then 34 units.
- OFF HTTP request: 20:38:18.873Z; Deactivate dispatch: 20:38:18.915Z.
- Initial response at 20:38:34.268Z retained exact item/ship scope, 85,680 ms
  effective duration and 75,345 ms remaining observation budget.
- Exact module first read OFF at 20:39:45.874Z (read started 20:39:44.819Z),
  86.959 seconds after dispatch, inside the 90.680-second derived budget.
- The production API continued via exact-module GETs without another
  Deactivate. Runner remained running, confirmed the second harvester OFF,
  unloaded the ice and continued the program. No timeout-only safety pause.
- Normal MCC Stop completed without failures; Test03c was authoritatively
  offline/free with no hosted or bridge owner. Task WC/helpers stopped.

38 focused/owning cases passed, including long-cycle confirmation, bounded
timeout, unknown duration, wrong module/ship, retired authority, production API
single dispatch and BFF read-only reconciliation. `build:web`, changed-JS syntax
and diff checks passed. No full suite, combat QA, soak or EveJS restart was run.
