# Svelte components are not type-checked

Recorded 2026-09-02. A verification gap worth knowing before you trust a green build.

## The gap

`npm run build:web` is `tsc -p tsconfig.json && vite build`. Neither half checks a Svelte
component's props or template:

- `tsc` cannot parse `.svelte` at all. It checks the `.ts` files and nothing else.
- `vite build` compiles templates but does not type-check them.
- There is no `svelte-check` in the toolchain.

**Proved, not assumed.** Adding a *required* prop to `BotManager.svelte` that no caller passes still
built clean:

```
docker build --target web-build     # ✓ built, no error
```

So a green build says the TypeScript modules are sound. It says nothing about whether a component is
handed the props it declares.

## What actually catches component errors today

The SSR tests. `web/src/ui/panelFirstMount.test.ts` renders every panel against a fresh store, and the
per-panel tests (`standingsPanel.test.ts`, `botManagerPanel.test.ts`, …) render real markup. These catch
a component that *crashes*; they do not catch a type mismatch on a path no test renders.

Practical consequence: when wiring a new prop through the shell, read the receiving component's
declaration rather than assuming, and add an SSR render that exercises the new path.

## Why svelte-check is not installed

It runs, and the backlog is small — but adopting it needs a TypeScript migration, not a dependency.

`svelte-check@4.7.6` (latest as of writing) peers `typescript@^5.0.0 || ^6.0.0`. This project is on
`typescript@^7.0.2`, the native compiler. Forced, the tool refuses with its own message:

> TypeScript 7 support currently requires both TypeScript 7 and TypeScript 6 installed in your project,
> and requires using the `--tsgo` or `--tsgo-experimental-api` flag.

That layout makes the plain `typescript` package resolve to v6, so `tsc` in `build:web` and `typecheck`
would silently become TypeScript 6 unless those scripts are rewritten to the native binary too. That is
a change to what every future build compiles with, and it wants its own branch and its own proof that
the emitted bundle is unchanged.

## The baseline, for whoever adopts it

It does run today with the dual-TypeScript setup, against the `web-build` image:

```bash
docker run --rm evejs-web-check sh -c "npm i --no-save --legacy-peer-deps svelte-check typescript@~6 '@typescript/native@npm:typescript@7' >/dev/null 2>&1 && npx svelte-check --tsconfig ./tsconfig.json --tsgo --output human"
```

At the time of writing that reports **31 errors and 7 warnings in 15 files**, all pre-existing:

| File | Errors |
|---|---|
| `web/src/ui/overviewActions.test.ts` | 8 |
| `web/src/ui/Overview.svelte` | 7 |
| `web/src/ui/InventoryShip.svelte` | 5 |
| `web/src/ui/BotBuilder.svelte` | 4 |
| `Travel.svelte`, `ShowInfo.svelte`, `CharacterCreate.svelte` | 2 each |
| `Tactical.svelte`, `RadialMenu.svelte`, `MissionBot.svelte`, `App.svelte`, and four `*.test.ts` | 1 each |

Twelve of the 31 are test files using a `fakeFlow()` proxy that returns `unknown`, so they are looseness
in the tests rather than defects in shipped code.

The bot-manager work (`BotManager.svelte`, `BotManagerPilotRow.svelte`, `libraryView.ts`,
`pilotRoster.ts`) contributes **none** of them.

## When to revisit

When `svelte-check` supports TypeScript 7 as the sole `typescript` dependency. Then it can go in as a
non-gating `check:svelte` script, the 31 above can be burned down, and it can become gating.
