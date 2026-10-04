# Stock structure support

Structure search, names, access-scoped docking and configuration-only Home use stock methods. Stateless account-owned search with system zero enumerates accessible IDs; held [0] search follows the current system. Neither query grants service rights or moves a pilot.

Service-gated structure inventory, fitting and corporation-office actions return STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE on stock web gateway. Missing services remain UNKNOWN rather than an empty authoritative list. NPC station paths remain available. Native structureSettings.CharacterGetServices and officeManager.RentOffice exist, but a safe adapter for an already held web pilot needs upstream agreement. Docking permission is insufficient to infer service permission.

LEGACY — DO NOT DEPLOY: former Upwell allowlist/core patches are retired; use no WC runtime patch. See [stock integration policy](stock-evejs-integration-policy.md).
