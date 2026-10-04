# Stock runtime test reference

Use an immutable clean upstream reference for source-backed tests. Set STOCK_EVEJS_ROOT to its directory. Tests isolate the unchanged selection preflight/duplicate-owner code without booting or importing gameStore. They explicitly prove both takeover-enabled and takeover-disabled behavior.

No runtime patch fixture or installer is supported. LEGACY — DO NOT DEPLOY: historical Factory/Upwell/Mining/Provisioning patch fixtures are retired. A mutable extended runtime is not upstream compatibility evidence. See [stock integration policy](stock-evejs-integration-policy.md).
