# Skill plans — personal and corporation

Successor to [goal-prompts/r28-skills.md](goal-prompts/r28-skills.md). R28 built the character
sheet and the training queue. It did not build **skill plans**, which in retail are the third
part of the same window: a named, ordered, shareable list of skills you intend to train, plus
the corporation's own library of them.

Status: design only. Nothing below is built.

## 1. What exists today

**In the companion: nothing.** `grep -ri "skill.plan"` over `src/`, `web/`, `contracts/` and
`docs/` returns exactly two hits, both a coincidental sentence in a refusal test
(`web/src/bridge/skills.test.ts:455`). No route, no decoder, no panel, no type.

**In eve.js: the whole feature, finished.** Both scopes have real state modules with real
persistence, and both are exposed to the retail client:

| | Personal | Corporation |
| --- | --- | --- |
| State module | `server/src/services/skills/plans/skillPlanState.js` | `.../corpSkillPlanState.js` |
| gameStore table | `skillPlans`, keyed by characterID | `corpSkillPlans`, keyed by corporationID |
| Gateway service | `_secondary/express/gatewayServices/skillPlanGatewayService.js` | `.../corpSkillPlanGatewayService.js` |
| Message family | `eve_public.character.skill.plan.*` | `eve_public.corporation.skill.plan.*` |

Both tables are runtime-owned and lazily bootstrapped (`database.ensureTable`), so a server that
has never had a plan simply has no file yet — an empty library is legitimately empty, never an
error (the `worldHasNoContracts` rule).

### The limits are the server's, and they are already enforced

`skillPlanState.js:13-17` — 10 personal plans per character; 150 requirement rows per plan; 5
milestones per plan; name at most 50 chars; description at most 1000 chars.
`corpSkillPlanState.js:21-22` — 100 plans per corporation; the milestone and text limits are
imported from the personal module, so there is one source for them.

These match retail (ten personal plans, five milestones, one tracked plan at a time — see
[Skill Plans and How They Work](https://support.eveonline.com/hc/en-us/articles/4406388028178-Skill-Plans-and-How-They-Work)
and [EVE University](https://wiki.eveuniversity.org/EVE_University_Corporation_Skill_Plans),
which also records the hundred-plan corporation cap and the pagination that follows from it).

### A saved plan is not the plan you typed

`canonicalizeSkillRequirements` (`skillPlanState.js:114-198`) rewrites the requirement list on
every save: duplicate skills collapse to their highest level, **prerequisite skills are pulled in
recursively** (through the fitting service's `getRequiredSkillRequirements`), and the result is
emitted **one row per level in dependency order** — Gunnery V becomes five rows, and anything
Gunnery needs lands ahead of it. The 150-row cap applies to the *expanded* list.

This is the single most important fact for us. It is also the reason this feature is cheap:
the server hands back a list that is already in the exact shape and order the training queue
wants, so "start training this plan" needs **no new write at all** — it is the existing
`skillMgr.SaveNewQueue` with the plan's own rows.

### Who may manage a corporation plan

`corpSkillPlanGatewayService.js:70-88` — CEO, or the Director bit, or the dedicated
**Skill Plan Manager** role (bit 62). Everyone else in the corporation may read and share, and
gets a bare `403` with an empty body on any mutation. Reads are scoped to your own corporation.

### Plans do not touch the queue, and nothing is "recommended"

There is no server-side "apply plan to queue" anywhere in either scope; the requirement list is
read from the fitting service at *write* time only. `SetActive`/`GetActive` are a per-character
bookmark — the tracked plan — and corporations have no active-plan concept at all
(`corpSkillPlanState.js:18-20`). There is no publish flag, no default, no recommended flag, and
no author recorded on a corporation plan.

### Sharing is a UUID and nothing else

`GetSharedRequest` on both scopes resolves a plan by UUID across **every** character
(`findSharedPersonalPlan`) or **every** corporation (`findCorpPlanByID`), with no ownership,
membership or permission check. Knowing the id is the entire access control. That is the
server's design and we should mirror it — but we should also say it out loud in the UI rather
than let a player assume a plan is private.

## 2. The one blocking fact: the companion's seam does not reach it

eve.js has the whole feature and the retail client uses it. The question is only *which wire*,
and the client answers it directly. `skills/skillplan/` in the V24.01 client is built on
protobuf over the gRPC message bus and nothing else:

```
skills/skillplan/grpc/personalSkillPlanRequest.py
  import eveProto.generated.eve_public.skill.plan.plan_pb2 as skill_plan_pb2
  from message_bus.skillPlanRequestsMessenger import SkillPlanRequestsMessenger
```

with `corpSkillPlanRequest.py`, `corpMilestoneRequest.py` and the matching
`*NoticeMessenger` modules beside it. `appConst.py:370` carries
`corpRoleSkillPlanManager = 4611686018427387904L` — bit for bit the mask eve.js checks. There is
no `skillPlanMgr` machoNet service in the client's calls or in eve.js's service registry.

(The third retail plan type, **Certified**, is client-side FSD — `skillPlanFSDLoader.py` — and no
skill-plan file ships in this SDE drop. Personal and corporation are the two that exist here.)

So skill plans are served on eve.js's **public gateway** — a gRPC-over-HTTP/2 endpoint
(`POST /eve_public.gateway.Requests/Send`, dispatch at `publicGatewayLocal.js:2577`) on its own
`http2.createSecureServer` with a local TLS cert, speaking protobuf `RequestEnvelope`s whose
`payload.type_url` names the operation. That is the surface the retail client talks to.

The companion talks to a different surface: the JSON web gateway at `/_evejs-web/v1`
(`evejsWebGateway.js:5`), which offers bespoke routes such as `GET /skills` (`:1235`) and
`POST /skill-queue` (`:1369`) alongside the generic machoNet seams `/call`, `/bound/bind` and
`/bound/call` (`:1436`, `:1547`, `:1581`).

**There is no bridge between the two.** The web gateway does not proxy the gateway-service
registry (it imports exactly one such module, `webChatGatewayService`, which the registry index
deliberately excludes — `evejsWebGatewayRuntime.js:59-64`). And there is no machoNet skill-plan
service to reach through `/call`: grepping `server/src/services` and `server/src/network` for
`skillPlan` turns up only character-deletion and id-allocation plumbing. The protobuf family
*is* the only surface.

Three ways to close that gap:

| | What it is | Cost | Verdict |
| --- | --- | --- | --- |
| **B. The BFF speaks the public gateway** | the same wire the retail client uses: HTTP/2 + TLS to the local responder, gRPC framing, protobuf built from eve.js's own JSON descriptors | a codec and a transport in the BFF | **recommended** — needs nothing from eve.js |
| A. New web-gateway routes | ~250 lines in eve.js `_secondary/express/*` calling the two state modules directly, exactly as `/skills` calls `skillQueueRuntime` | one eve.js patch plus its tests | the fallback, and the answer if the intercept responder turns out to be off |
| C. Companion-local plan store | plans in `data/`, like `botScriptStore.js` | small | **no** — it would reimplement `canonicalizeSkillRequirements`, i.e. a game mechanic, and the plans would be invisible in-game |

C is the tempting one and it is the wrong one. The prerequisite expansion is a mechanic, the
project's first rule is that mechanics are the server's, and a plan the game client cannot see is
not the feature players asked for.

### Why B is cheaper than it looks

**Nothing authenticates that path.** `buildGatewayResponseForRequest` decodes the envelope and
goes straight to `gatewayServiceRegistry.handleRequest(requestTypeName, requestEnvelope)` with no
session lookup and no gate; `observeGatewayTransportIdentity` only *records* what the envelope
claimed. The active character is whatever `authoritative_context.identity.character.sequential`
says (`gatewayServiceHelpers.js:19-41`). The BFF already holds a live bridge session for a
character it logged in and selected, so asserting that character is the same claim the game
client makes — not an escalation.

**The schema is handed to us.** `skillPlanProto.js` and `corpSkillPlanProto.js` are not compiled
descriptors; they are `protobuf.Root.fromJSON({…})` with the field numbers in plain sight:

```js
Attributes: { fields: {
  name: { type: "string", id: 1 },
  skill_requirements: { rule: "repeated", type: "eve_public.skill.plan.SkillRequirement", id: 2 },
  description: { type: "string", id: 3 } } }
```

Both families transcribe directly into the BFF.

**The wire, concretely.** `httpsPort = microservicesPort + 1`
(`_secondary/express/server.js:1092`, `microservicesPort` 26002 in `config/server.json`) — so
**127.0.0.1:26003**, HTTP/2 over TLS with the local self-signed cert,
`POST /eve_public.gateway.Requests/Send`, `content-type: application/grpc+proto`, a 5-byte
length prefix per frame and a `grpc-status` trailer. Served when `shouldHandleInterceptLocally()`
is true — `ENABLE_LOCAL_INTERCEPT` with proxy mode not `forward`, which is the ordinary offline
setup.

**Measured, not assumed.** A dependency-free probe — hand-encoded protobuf, Node's built-in
`http2`, no client session, no login, a character id the server had never seen — was answered:

```
POST /eve_public.gateway.Requests/Send   →  HTTP 200 application/grpc+proto
eve_public.character.skill.plan.GetAllRequest    → status 200, GetAllResponse, 0 plans
eve_public.corporation.skill.plan.GetAllRequest  → status 200, GetAllResponse, 0 plans
eve_public.character.skill.plan.GetActiveRequest → status 200, GetActiveResponse,
                                                   Identifier.uuid = 00000000…00 (ZERO_UUID)
```

That last one matters: a **non-empty payload decoded correctly**, and its value is the documented
"no active plan" sentinel.

The full write round trip was then run against the same synthetic id — create, list, read back,
delete, list again — every step `200`:

```
CREATE  → CreateResponse, planID 8444129d…
GETALL  → 1 plan
GET     → name "probe plan", description "temporary - delete me"
          requested 1 row (typeID 3301 level 3); server stored 4:
            typeID 3300 level 1     <- prerequisite, pulled in and placed first
            typeID 3301 level 1
            typeID 3301 level 2
            typeID 3301 level 3
DELETE  → DeleteResponse
GETALL  → 0 plans
```

So encode, frame, dispatch, decode, mutate and clean up all work from outside the game client
with nothing but the standard library — and §1's claim about `canonicalizeSkillRequirements` is
now **observed, not read**: one requested row became four, prerequisite first, one row per level,
in dependency order. That is the list `planQueueEntries` maps straight onto queue entries, which
is why "start training" needs no new write.

(The probe used `90000001`, ESI's own documented example id, and left `skillPlans` on disk at
`{}` exactly as it found it.)

⚠ **The port is published as 443, not 26003.** In this Docker setup the container's 26003 is
mapped `127.0.0.1:443->26003/tcp`, because the retail client reaches it by hosts-file intercept
of CCP domains. From the BFF container the peer is the server container's own `26003`; from the
host it is `443`. Whatever the setting is called, it cannot be derived from
`EVEJS_GATEWAY_URL` by adding one — it has to be its own setting with its own doctor check.

Three things B carries that A would not:

1. **A new surface for the companion.** 26003 needs its own setting, and in Docker it is `host.docker.internal:26003` over TLS where every existing hop is plain HTTP. `npm run doctor` should name it.
2. **Schema drift.** Pinned field numbers track eve.js and client versions; a JSON route would not. This is the one real argument for A.
3. **A 200 is even less proof than usual.** `buildGatewayFailure` degrades a thrown handler error into a `200` empty-success whenever the request type has a registered empty-success response (`publicGatewayLocal.js:2330-2355`). Every write must be confirmed by re-reading the library — which §3c already requires, and which matters more here than anywhere else in the app.

## 3. Design

### 3a. The transport (Phase 0)

A new `src/eveProtoGatewayClient.js` beside `eveGatewayClient.js`: one long-lived HTTP/2 session
to the local responder, a `sendGatewayRequest(typeName, payloadBuffer, characterID)` that wraps a
`RequestEnvelope`, frames it for gRPC and decodes the `ResponseEnvelope`, and a transcription of
the two proto families from eve.js's own JSON descriptors. Settings: the responder's origin
(defaulting to the gateway host with port +1) and whether to trust the local self-signed cert,
both surfaced by `npm run doctor` the way every other connection setting is.

Because it is a second transport rather than a second route, it earns its own section in
`docs/bridge-wire-contract.md` — one that records the framing, the envelope shape, the
empty-success degradation, and the field numbers we pinned.

The operations are the protobuf families in §1: `GetAll`/`Get`/`GetShared`/`Create`/`Delete`/
`SetName`/`SetDescription`/`SetSkillRequirements`/`GetActive`/`SetActive` and the four milestone
ops for personal; the same set plus `SetCategory` for corporation, where every mutation returns a
bare `403` with an empty body when the caller lacks CEO, Director or Skill Plan Manager.

⚠ **`GetAll` returns ids, not plans.** The personal family answers with a list of UUIDs and needs
a `Get` per plan; the corporation `GetAll` answers with summaries and still needs a `Get` for
requirements. Fan those out concurrently under the BFF's existing concurrency cap and answer the
browser with one assembled library — the round trips belong on the BFF's side of the wire, not
the browser's.

**Fallback (option A).** If the intercept responder turns out to be disabled in a supported
setup, the same feature is ~250 lines of JSON routes in eve.js
`_secondary/express/evejsWebGateway.js` + `evejsWebGatewayRuntime.js`, calling the two state
modules directly the way `/skills` calls `skillQueueRuntime`, with a `skillPlans` capability flag
beside `skillQueue` (`evejsWebGatewayRuntime.js:5788`) and
`gameStore.flushTablesSync(["skillPlans"])`. Everything downstream of §3b is unchanged either
way — which is the point of putting the transport behind its own module.

⚠ **Corporation notices.** The protobuf service publishes `CreatedNotice`, `DeletedNotice`,
`NameUpdatedNotice` and friends to `{corporation: id}` when a plan changes. Going through the
public gateway we get these for free — an in-game window sees a web-made change. Going through
option A we would not, unless the runtime is handed the same `publishGatewayNotice`. Another
point for B, and one to state plainly if A is ever taken.

### 3b. The BFF

`src/server.js` calls the §3a client and assembles a library; the browser never learns which
transport served it. Errors are normalized to `{ok:false, error:<CODE>, message:<text>}` at the
BFF boundary — the gRPC statuses map as `404` → `SKILL_PLAN_NOT_FOUND` /
`CORP_SKILL_PLAN_NOT_FOUND`, `403` → `SKILL_PLAN_FORBIDDEN`, and `400` carries the state module's
own message. That keeps the wording job in the browser where R28 put it
(`web/src/bridge/skills.ts`), and keeps option A a drop-in replacement.

Routes: `GET /api/bridge/skill-plans`, `GET /api/bridge/corp-skill-plans`,
`GET /api/bridge/skill-plans/shared`, and the POSTs, all `requireAuth` plus
`requireHeldBridgeSession`, answering with the re-read library the way `answerWithSkillSheet`
answers with the re-read sheet (`:17260-17271`).

Confirmation gates: **none** on personal writes — nothing is destroyed and no ISK moves, which is
why `/api/bridge/skills/queue` has none either. **`requireWriteConfirmation` on corporation
delete**, because that one removes something other people are using.

Contract: no `src/bridgeCallPolicy.js` entry and no `contracts/*.json` diff. Nothing here is a
retail `service.Method` pair — the plan traffic is a separate transport, and the one retail call
the feature makes, `skillMgr.SaveNewQueue` for "start training", is already allowlisted. Worth
writing down so nobody goes hunting for a contract change that should not exist. The new wire
gets documented in `docs/bridge-wire-contract.md` instead.

### 3c. The web client

**`web/src/bridge/skillPlans.ts`** — pure, in the discipline of `skills.ts`. It arranges; it
computes nothing:

- `decodeSkillPlanLibrary` and `decodeCorpSkillPlanLibrary`, with `null` meaning *unknown* and never an empty list.
- `planProgress(plan, skills)` — a requirement `{typeID, level}` is done when the sheet says `skill.level >= level`. Remaining SP comes off the sheet's own `levelSkillPoints` thresholds. Nothing is recomputed.
- `planQueueEntries(plan, skills, maxEntries)` — the untrained tail, **in the server's order**, truncated to `queue.maxEntries` (which `decodeSkillSheet` already gives us; do not hardcode the queue cap). This is what "Start training" posts.
- `milestoneProgress` — for the `skill` branch of the milestone oneof only. See §5.
- `skillPlanRefusal(code, message, planName)` — the thirteen codes in plain player language, tested one by one exactly as `skills.test.ts` tests the eleven queue codes.

**`web/src/store/types.ts`** — `SkillPlan`, `SkillPlanRequirement`, `SkillPlanMilestone`,
`SkillPlanLibrary`, `CorpSkillPlanLibrary`, `SkillPlansState`, next to the R28 block at
`:2349-2437` and following its null-is-unknown comments.

**`web/src/app/api.ts` and `flow.ts`** — `loadSkillPlans`, `loadCorpSkillPlans`, `saveSkillPlan`,
`deleteSkillPlan`, `setActiveSkillPlan`, `importSharedPlan`, `startTrainingPlan`. Every write
re-reads before the store is touched; a refusal becomes a `skill-plans/action-error` and the
library is reloaded anyway. **A 200 is not proof** — the same rule as the queue.

**`web/src/ui/Skills.svelte`** — a tab strip inside the existing panel: **Skills · Queue ·
Plans**. Inside rather than beside, because that is where retail puts it and because it costs no
new `TabID` (`web/src/ui/tabs.ts:31,96`) and no new `PanelHost` branch
(`web/src/ui/PanelHost.svelte:22,96-97`). The Plans tab holds three blocks:

- **Tracked** — the active plan, its progress meter, its milestones, and one **Start training** button.
- **My plans** — up to ten, each a row with a progress meter and `Track` · `Start training` · `Edit` · `Delete` · `Copy share code`.
- **Corporation plans** — the same rows, read-only, with `New` / `Edit` / `Delete` appearing only when `canManage` is true. Not greyed-out buttons: absent ones (R33).

The editor reuses the sheet's own grouped, searchable skill list and its level pips, so a plan is
built out of the same rows the player already reads. Time-to-complete is derived from the sheet's
`skillPointsPerMinute` under the R28 interpolation rule — a read always wins.

Two honesty requirements, both worth more than any styling:

1. **Show what the server did.** The saved plan will not be the plan that was typed. Render the re-read and say so — "Your server added 6 prerequisite skills and put them in training order."
2. **Say what a share code is.** "Anyone with this code can read this plan." That is true of the server's design, and hiding it would be the dishonest option.

Icons come free: R27 measured 100% cache coverage of skill types, so every requirement row gets a
real `TypeIcon`.

## 4. Tests

- BFF `test/eveProtoGatewayClient.test.js` — the codec against **captured bytes**, not against itself: encode a `CreateRequest`, decode a real `GetResponse`, and prove the empty-success degradation is detected rather than read as a successful write. Build the fixtures from a live call; keep no character id in them (use `90000001`).
- BFF `test/bridgeSkillPlans.test.js` — house style against a faked transport: route shapes, auth, the corporation-delete confirmation gate, the `404`/`403`/`400` mapping, and every code passed through untranslated.
- eve.js `server/tests/webGatewaySkillPlans.test.js` — **only if option A is taken**: round-trip create/list/update/delete/active; the 10- and 100-plan capacity refusals; the corporation role gate refusing a plain member and admitting CEO, Director and Skill Plan Manager; shared lookup by id; and that a save's prerequisite expansion survives read-back verbatim.
- web `web/src/bridge/skillPlans.test.ts` — progress against a synthetic sheet; `planQueueEntries` truncating at the sheet's own `maxEntries`; **each refusal code rendering as a sentence and never as a code**.
- web `web/src/app/skillPlansFlow.test.ts` — every write re-reads; a refusal leaves the library unmutated.
- web `web/src/ui/skillPlansPanel.test.ts` — SSR render; the tab strip; `canManage: false` omitting the corporation edit controls; meters and milestones.
- Add the Plans view to `panelFirstMount` (R18).

Verification is `docker build --target web-build .` for the typecheck and Svelte compile, and
`node --test` for the suites.

## 5. Risks and open questions

1. ~~Prove the responder is reachable.~~ **Done** — see §2. Reads, a create, a read-back and a delete all answered `200` with correctly decoded payloads, from outside the game client, with no dependencies. The one thing still unproven is the corporation **403** role gate, which needs a character in a corporation; prove it in Phase 3 rather than guessing the refusal shape.
2. **Schema drift is B's standing cost.** The field numbers we pin come from eve.js's descriptors for one client version. Keep the transcription in one module, cite where each family came from, and let the codec test fail loudly rather than decode garbage quietly.
3. **`GetShared*` is uncontrolled by design.** Build explicit import-by-code and nothing else. A browse-all-plans surface on top of an unauthenticated global lookup would be a privacy hole we invented.
4. **The `train_to_type` milestone branch** points at a generic item type — a ship — not a skill. Judging "can you fly it" needs the fitting service. Render those milestones by name with their description and **no progress bar**, rather than inventing one. The `skill` branch gets a real one.
5. **150 plan rows against a much smaller queue cap.** Read the cap from the sheet; never hardcode it. When the tail is longer, queue what fits and say how many were left over.
6. **No author on a corporation plan.** The server does not record one. Say nothing rather than guess.

## 6. Phasing

Each phase is independently shippable.

| Phase | What | Depends on |
| --- | --- | --- |
| 0 | The transport: proto codec, gRPC client, a live `GetAll` proving it | — |
| 1 | Personal plans: read, track, **start training** | 0 |
| 2 | Personal plan editor and milestones | 1 |
| 3 | Corporation plans: read for all, manage for role holders | 1 |
| 4 | Share and import by code | 1 |

Phase 1 is where most of the value is and it needs no editor: a player who already has plans from
the game client can see them, track one, and put it in the queue with one button.

And on the whole feature landing upstream as one pull request: option B is what makes that
possible. Nothing in phases 0-4 asks rrfarmer to change an eve.js checkout.
