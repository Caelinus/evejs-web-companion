# Runtime patch test reference

The runtime-patch tests need the exact clean EveJS 0.12.9 source files named in
`runtime-patches/mining-support-0.12.9-manifest.json`. A current game checkout may
already contain changes, so it cannot substitute for that reference.

From this repository in PowerShell, recover the fixtures from the existing
sibling EveJS repository's Git history, then run the suite:

```powershell
$runtimeReference = node scripts/prepare-runtime-test-reference.js | ConvertFrom-Json
$env:EVEJS_CLEAN_REFERENCE = $runtimeReference.reference
$env:EVEJS_ROOT = (Resolve-Path '../eve.js').Path
npm test -- --test-concurrency=4
```

If EveJS is elsewhere, set `EVEJS_REPO` to its repository directory before the
first command. Its history must include the pinned source revisions; a shallow
checkout may need its history fetched. Alternatively, set
`EVEJS_CLEAN_REFERENCE` directly to an existing clean 0.12.9 source directory.
Set `EVEJS_ROOT` to the existing game directory to include the optional tests
against its static recipe and dogma tables. These tests read reference data;
they do not import mutable game services.

`FACTORY_RUNTIME_ROOT` is a separate optional contract check and requires a
gateway with the Factory patches installed, as described in
[pilot-training-runtime-setup.md](pilot-training-runtime-setup.md). The ordinary
EveJS gateway cannot satisfy that patched-runtime contract.

The preparation script verifies all eight manifest hashes, preserves the
reference's line endings, and writes fourteen source fixtures plus their pinned
revision record into a fresh temporary directory. It does not create a Git
worktree, change either checkout, import the game runtime, or open game data.
Supplemental dependencies come from the pinned gateway revision and execute in
the tests' isolated VMs with injected authorities.

The concurrency limit above avoids the Windows Node process-shutdown assertion
seen with `--test-force-exit` during the October 2 review. Tests should finish
naturally; do not use forced exit as evidence that teardown works.
