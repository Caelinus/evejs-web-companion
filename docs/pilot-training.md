# Pilot Training

Open `/pilot-training` on the WC origin. `/goblin-factory` redirects here (308).
This standalone control plane does not restore a cockpit, claim botHost, or poll space.
The older `factory*` modules and login alias remain compatibility implementation details.

## Typical workflow

1. Choose **+ New trainee** or **Use existing account**. Creation uses EveJS authority;
   an ambiguous result offers recovery instead of blindly creating again.
2. Assign a role and add up to three ship/fitting contracts from the corporation's
   saved fittings. Fresh roles have no predefined ships. Choose the target contract.
3. Review FAST requirements derived from the actual hull and fitting. A changed
   fitting must be accepted again; qualification does not prove equipment ownership.
4. Optionally configure onboarding with its dedicated non-CEO authority and reviewed ordinary rights. Temporary login follows stock retail server policy.
5. Inject missing skillbooks in the game client, then review/apply the stock append-only queue. Direct purchase and automatic funding are unavailable.
6. Set an NPC station or accessible player-structure training/provisioning home if useful. This records the intended home;
   it does not move the pilot, buy equipment or provision a ship.

Use stock EveJS and the [stock integration policy](stock-evejs-integration-policy.md). New accounts retain EveJS development password semantics.

## Qualification contracts

An explicitly assigned role starts with zero configurations. Add ship lists hulls from
the pilot's current corporation fitting library, then filters fittings by hull. Up to
three ordered configurations per role are supported. Creation order is progression
order; the same hull with different fittings is allowed, duplicate owner/fitting pairs
are refused. Edit retains the configuration ID; Remove clears a removed explicit target.

Each contract stores `configurationID`, `roleID`, `order`, `corporationOwnerID`,
`fittingID`, `hullTypeID`, accepted saved date/content fingerprint, and an optional
versioned support-policy key. A target is a configuration ID, never a name/index.
The user may directly target a later contract without waiting for earlier ones.

FAST derives the recursive maximum-level dogma closure from the accepted hull and
validated fitting contents. No fitted drones means no invented drone requirements.
Existing MINER Basic/Intermediate/Advanced support packages preserve the prototype's
BALANCED/MASTERY behavior. Other roles, including custom role IDs, have generic FAST;
unsupported support modes are disabled. Role/account names are not inferred.

Only actually trained hard requirements establish READY. Queued/training/unknown
remain distinct. Missing or changed/unaccepted fitting authority fails closed.
Equipment stays UNKNOWN. Qualification does not prove inventory, fitting or duty readiness.
ETA still uses authoritative runtime queue timestamps; uncovered plans remain UNKNOWN.

## Browser configuration and migration

`pilot-training:config:v2:<account>:<characterID>` is the single active document for
role, plan mode, target configuration ID and all role configurations. Valid old
`pilot-training:miner:*` selections and `goblin-factory:pilot:v1:*` preferences migrate
once. Only selected contracts migrate; accepted date/hash are preserved. Deterministic
legacy IDs make the migration idempotent. Old keys remain inactive backups, so removing
a migrated contract does not recreate it on F5. Invalid data is retained and reported.

`pilot-training:settings:v1` stores browser-local onboarding, explicit training wallet
and resolved home settings. Fresh defaults are disabled/NONE/unconfigured. It stores
an account/character selector key for authority, never passwords, tokens or sessions.
Change Dedicated non-CEO authority to use a later purpose-created service character;
that character must already be authenticated, free and an authorized Director.

WC also keeps a credential-free server journal at
`data/pilot-training-creation-attempts.json`. It records an account name or an
account/character-name creation attempt before dispatch. If WC restarts while
EveJS completion is uncertain, the next request must recover from authoritative
account/roster reads; an absent result does not authorize a second create.

## Optional corporation onboarding

The WC BFF owns temporary account/web-session-bound reviews at
`POST /api/pilot-training/onboarding/review|apply`. Both identities and corporation
state are reread. The authority must be a persisted non-CEO Director of the configured
corporation. Neither source nor target CEO can be acquired, and the runtime repeats
the CEO check synchronously before selection. Busy pilots fail without takeover.

Existing `corpRegistry` authority performs InsertApplication, officer
UpdateApplicationOffer (offer=6), trainee UpdateApplicationOffer (accept=2), then
membership reread. Existing members skip the join. FULL_ACCESS_EXCEPT_CEO calls
UpdateMember and verifies all eight ordinary/grantable role fields plus unchanged CEO.
NONE leaves roles alone. Existing Directors and blocked-role members are protected.

Masks are pinned to EveJS 0.12.9 `corporationRuntimeState.js`:
FULL_GRANTABLE_ROLE_MASK = FULL_ADMIN_ROLE_MASK minus CORP_ROLE_DIRECTOR;
FULL_LOCATIONAL_ROLE_MASK covers deliveries/hangar/container rights. Decimal strings
preserve all 64 bits. This grants broad ordinary and delegation rights, including
wallet/hangar access; it does not promote to Director or transfer CEO ownership.

Join/role operations are sequential, not an atomic transaction. Each step is verified.
An ambiguous failure stops without replay or synthetic rollback; completed changes
remain. Temporary sessions release in reverse order, and uncertain release retains
recovery protection. Automatic onboarding runs only after confirmed creation when
explicitly enabled; existing pilots require review and confirmation.

## Funding, home and wallets

Saved wallet configuration is retained. Direct skill purchase and automatic funding are unavailable on stock web gateway. No financial transfer occurs through this unsupported action.
Queue review/apply retains account ownership, offline state/version, fitting/plan
fingerprint, append-only behavior and authoritative post-write verification.

Home stores generic locationID/name/system/kind/capability. The resolver accepts
catalog NPC stations and player structures with current docking access. NPC Home
retains `MANUAL_GM_ONLY`; structure Home records `CONFIG_ONLY` for future provisioning.
Saving either Home does not move a pilot. Player-structure relocation is not implemented.
Financial decisions read live wallet authority, never roster display values.

## Stock integration and validation

No WC core runtime patch is supported. Qualification, queue, creation and onboarding ownership tests cover stock interfaces; unsupported purchase/equipment actions refuse before acquisition. See [stock integration policy](stock-evejs-integration-policy.md).
