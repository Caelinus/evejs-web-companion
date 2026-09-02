# Bot Manager — a platform-wide script library and run console

Successor to [bot-builder-brainstorm.md](bot-builder-brainstorm.md). That doc designed the *language*;
this one designs where scripts **live** and how runs are **watched**. The language is not reopened here.

Status: design only. Nothing below is built.

## 1. What exists today

**One real script store.** `src/botScriptStore.js` — a JSON file (`data/bot-scripts.json`) keyed by
`accountID`, optimistic-concurrency by `rev`, capped at 50 scripts per account and 48 KB per doc
(`botScriptStore.js:19-21`). Reached through `/api/botscripts*`, all behind `requireAuth`
(`src/server.js:18437-18487`). `BotBuilder.svelte` is its only writer.

**One dead script store.** `web/src/bots/botLibrary.ts` — a complete, tested, localStorage-backed
library that nothing in the app imports. Its own header calls it the "works today" stopgap pending a
durable per-account store over the BFF; that store shipped. **Delete it** (§7).

**Scripts are already account-wide, not per-character.** `botScriptStore.js:12`: keying is per account
so a player's alts share one library. No CRUD method takes a `characterID`; no route reads one. The
siloing players feel is a UI absence, not a storage fact.

**Two structurally different ways to run.**

| | "Run here" | "Run on server" |
|---|---|---|
| Driver | `flow.startCustomBot` against the tab's `customBot` store slice (`Bots.svelte:106`) | `src/botHost.js`, its own minted session + headless flow |
| Identity | none — no `botID`, no endpoint | `botID`, listed by `GET /api/bots` |
| Exclusivity | the session's own ship claim | `claims: characterID -> botID` + per-run `claimSecret` (`botHost.js:151,411`) |
| Survives tab close | no | yes |
| Telemetry | local store slice | roster mirrored to `data/server-bots.json`; 15s vitals sampler |
| Grant | `window.confirm` risk dialog (`Bots.svelte:128`) | `BotLaunchGrant` re-derived and validated server-side |

**No unified view.** `ServerBots.svelte` lists server bots account-wide. In-tab runs are visible only
inside their own session's panel. A player holding two pilots has no single place showing both.

**No run history.** `botHost.js:417-422` drops a character's previous finished record the moment a new
bot starts on it — one retained record per character, so starting anew drops the old story.

**Shell.** Desktop-with-floating-windows. A panel is one entry in `web/src/ui/tabs.ts`, one branch in
`PanelHost.svelte`, and one line in the hardcoded `PANELS` list in `panelFirstMount.test.ts`. The client
is multibox (`App.svelte:2-12`, R107): several fully isolated per-character sessions live at once, each
with its own store and flow; exactly one Workspace is mounted.

## 2. The problem

The library is invisible. Scripts surface only as a flat list of names inside a launcher
(`Bots.svelte:360-403`) with no detail, no grouping, no search, no provenance, and no indication of what
a script does or where it is running. The editor has no run controls; the launcher has no editing. The
two run paths look unrelated because they *are* unrelated in code. And the account boundary — which the
operator does not experience as a boundary — partitions the library anyway.

## 3. Target model

**Decision 1 — the library is platform-wide.** One script namespace for the whole deployment. Every
account, every character, sees and can launch every script. This reverses the original per-account
keying deliberately: in a single-operator local deployment, the account is a login detail, not a
tenancy boundary.

**Decision 2 — visibility globalizes; authority does not.** This is the constraint everything else bends
around. Going global means the script *lookup* stops being scoped by account. It must not take the
character-ownership check with it. Today `botHost.start()` loads a script with
`store.get(accountID, scriptID)` and `server.js:18543` separately proves the character belongs to the
caller via `getCharacterForAccount`. **The second check stays exactly as it is.** Anyone may run any
script; nobody may fly a character they do not own. Any change that collapses those two lookups into
one is wrong.

**Decision 3 — both run modes are equals, and are badged as such.** Neither is the default. The manager
shows them in one list with an explicit mode badge and honest lifetime copy: a local run says it stops
when the tab closes, a server run says it keeps flying and names its deadline.

**Decision 4 — one script, many characters, no assignment.** A script is not "assigned" to a pilot.
Launching is an action taken *on* a pilot, from either the library row or the pilot row. Nothing is
stored binding a script to a character. Rejected the alternative — persistent per-character assignments
— because it invents state the runtime does not have and would drift from the `claims` map, which is
the real answer to "who is flying what".

**Decision 5 — provenance without tenancy.** Each record keeps the account that wrote it, for display
only ("saved by …"), never for filtering. A global library with no authorship is unreadable once it
holds 30 scripts.

## 4. The screen

One new panel, `botManager`, `where: "both"`. Three regions, top to bottom, in the established
`section.panel` / `.panel-head` idiom with shared `styles.css` classes only — no per-panel `<style>`
block (design-system.md:8-9).

**A. Pilots.** One row per held session plus every character with a live server bot. Columns: pilot,
where it is, what it is running (script name + mode badge), status, and the run's live line. Actions:
Start (opens a script picker), Pause, Stop. Uses `table.guests` with `.reflow` + `data-label` so it
becomes labelled cards at ≤640px. Vitals — shield/armor/hull and hold fill — render here as `.hud-gauge`
meters; `botHost.js` already samples them every 15s and `ServerBots.svelte` renders none of it today.

**B. Library.** The global script list: name, saved-by, revision, risk words, step count, and where it
is currently running. Search by name. Row actions: Edit (opens Bot Builder), Run on…, Duplicate, Export,
Delete. Empty state via `.empty`.

**C. Recent runs.** A short history strip — what ran, on whom, how it ended, last alert. Requires §5's
retention change; without it this region shows only current runs, and is worth building anyway.

**The multibox wrinkle.** Panels receive `{store, flow}`, both scoped to the *active* session. Region A
needs every held pilot. Two options:

- **(a) Thread the roster in.** `App.svelte` owns `sessions[]`; pass a read-only projection to this one
  panel. Small convention break, honest: in-tab runs genuinely are tab-local, and a run in a different
  browser tab is invisible no matter what we do here.
- **(b) Announce local runs to the BFF** so `/api/bots` returns one unified list.

**Recommend (a) now, (b) never unless a second device turns up.** (b) makes a tab-lifetime run pretend
to be durable, and the honest copy in Decision 3 is better than the illusion.

## 5. Data and API changes

1. **Re-key the store.** `botScriptStore.js`: `accountID` stops being the partition key. Records gain
   `authorAccountID` (display only, Decision 5). `list()` takes no account; `get`/`update`/`remove` take
   `scriptID` alone. `rev` semantics unchanged.
2. **Quota moves with the key.** 50-per-account becomes **200 platform-wide**, plus the unchanged 48 KB
   per doc. A per-author cap is not worth having when there is no tenancy. 200 is four times the old
   per-account cap and still bounds the file at ~10 MB worst case.
3. **Routes.** `/api/botscripts*` keep `requireAuth` (you must be logged in) but stop filtering by
   account. `POST` records `authorAccountID` from `req.account`.
4. **`botHost.start()`** loads by `scriptID` only. `server.js:18543`'s `getCharacterForAccount` check is
   untouched (Decision 2). The grant, hash-pinning, `restartSafe` resume rules, `claims` map and claim
   secret are all unchanged — none of them keys on the script's owner.
5. **Run retention.** Replace "one retained record per character" with a bounded ring of the **last 20
   ended runs platform-wide**, in the existing `data/server-bots.json` mirror. Enables region C. Twenty
   covers a session's history without turning the mirror into a log file; it holds no tokens or script
   bodies, only the `publicBot()` shape already written today.
6. **Surface what already exists.** `vitals`, `stepPath`, `pauseReason`, `note` are on the `ServerBot`
   API type (`api.ts:2704-2732`) and on the host record, with no UI consumer. No backend work needed.

## 6. What must not change

- The character-ownership check (Decision 2).
- `claims` / `claimSecret` / `CHARACTER_IN_USE` / `CHARACTER_IN_USE_BY_BOT` — one hull, one driver, both
  directions.
- Grant validation, script hash+rev pinning, and the conservative `restartSafe` resume policy.
- Decode-on-read: every doc still goes through `decodeScriptValue` before it reaches a runner.

## 7. Migration

- Existing `data/bot-scripts.json` records carry an `accountID`; rename that field to
  `authorAccountID` in place and drop the partition. One-shot, on first read, idempotent.
- Name collisions across accounts become visible in one list. Do not auto-rename; the saved-by column
  disambiguates.
- **Delete `web/src/bots/botLibrary.ts` and `botLibrary.test.ts`.** Dead since D2/D3 shipped.

## 8. Slices

- **M1** — store re-key + migration + route changes, server-side only, existing UI untouched. Verifiable
  by `node --test`.
- **M2** — `Bots.svelte` and `ServerBots.svelte` read the global list. No new screen yet. This alone
  delivers the ask's second half.
- **M3** — the `botManager` panel, regions A and B, roster threaded per §4(a). Register in `tabs.ts`,
  `PanelHost.svelte`, and `panelFirstMount.test.ts`.
- **M4** — run retention ring + region C.
- **M5** — retire the duplicate launcher surfaces in `Bots.svelte` now that the manager owns them; keep
  the built-in mining/mission cards where they are.

Verify each with `npm test` and `npm run typecheck`; the web build is checked in Docker
(`docker build --target web-build`).

## 9. Open, not decided here

- ~~Whether the Bot Builder's gaps fold into this work.~~ **Decided: separate track, sequenced after.**
  M1+M2 land first — they are server-side plus two small UI edits, verifiable by `node --test`, and they
  deliver the original ask (both launchers selecting from one global library). The builder is then
  rebuilt against a settled store rather than a moving one, with the audit gaps fixed by construction.
  M1 also carries the starter-bot import: the six `blockSnippets` sequences become library records
  (see [bot-builder-interface.md](bot-builder-interface.md) §6).
- Whether region A should offer "run this on all idle pilots" — powerful, and the fastest way to
  discover that a script was never safe to run unattended on three hulls at once.
