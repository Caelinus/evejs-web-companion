# Hosted session transport and notification custody

Hosted runners use the normal authenticated event stream, including fleet
invitations that cannot be reconstructed from a later roster read. Trusted HTTP
notification drains enter the same dispatcher. The flow captures pilot, token
and runner/session generation before the request; responses from retired
generations cannot apply notifications to a replacement session.

Fleet binding and constituent script/drone reads preserve every successful
notification drain, including successful subreads beside a failed inventory or
ship-info read. This matters because draining is destructive; a later stream
read cannot replay a notification discarded by an HTTP reader.

Bridge writes retain the exact held-session object and private hosted claim
generation across asynchronous binds. Actual dispatch rechecks both, and a late
failure cannot forget a newer held session. An optional expected fleet identity
likewise fences invitation dispatch against inviter fleet changes.

Loaded charges preserve a validated ship/slot/type tuple when the inventory
authority supplies a sublocation identity. They are never coerced into a numeric
item ID or mistaken for the fitted module occupying the same slot.

Runner observation failures retain bounded recorder diagnostics without changing
retry limits. Branch entry is observed before macro argument/type-name resolution;
it is not an active executable macro position. These foundations grant no new
gameplay action or restart eligibility.
