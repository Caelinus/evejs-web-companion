# Pilot Training runtime authority for EveJS 0.12.9

Pilot Training uses Farmer's account, corporation, fitting and queue reads. Direct skill acquisition additionally needs the narrow Factory authority packaged in [`runtime-patches`](../runtime-patches/pilot-training-0.12.9-manifest.json). The stock clean EveJS 0.12.9 runtime does not provide it. The patches belong in a **mutable** runtime only; do not alter the clean reference. Back up affected files and preserve the configured loader/mods.

The manifest records the SHA-256 values of the clean reference, each artifact, and a verified disposable composition. Check actual files before applying anything; do not reapply to an already matching runtime. The Factory composition was mechanically verified against a temporary copy of clean EveJS 0.12.9 after the two [Upwell patches](upwell-structure-support.md), without starting or modifying EveJS.

Apply in this order when the same runtime needs both structure Home and direct purchase:

1. `dockable-structure-search.patch`, then `accessible-structure-services.patch`, as described in the Upwell setup note.
2. [`live-factory-gateway.patch`](../runtime-patches/live-factory-gateway.patch) with `git apply --unidiff-zero`. This accepted zero-context patch changes the live gateway, protocol and character service; verify the clean-base hashes and rehearse its application in a disposable copy before touching a mutable runtime.
3. [`pilot-training-generic.patch`](../runtime-patches/pilot-training-generic.patch) with `git apply --include=server/src/_secondary/express/evejsWebGatewayRuntime.js`. The patch also contains a historical helper hunk; **do not apply that helper hunk**.
4. [`factory-gateway-placement.patch`](../runtime-patches/factory-gateway-placement.patch) corrects several zero-context hunk placements in the gateway runtime. Without this step, the first two historical patches can apply successfully while attaching Factory methods and guards to the wrong functions.
5. Install the complete [`factorySkillAcquisition.js`](../runtime-patches/factorySkillAcquisition.js) at `server/src/_secondary/express/factorySkillAcquisition.js` and verify its manifest hash.

The generic patch is checked against the output of step 2, not directly against the clean runtime. The placement patch is checked against the output of step 3. Review each step's result and the final composition hashes. The manifest also records hashes of the previously accepted installed runtime; its newline encoding differs from the disposable composition, but all seven normalized source files were compared byte-for-byte after newline normalization. If a runtime has additional accepted modifications, reconcile the affected files instead of replacing them wholesale. Do not assume matching version labels prove matching source.

The authority requires an authenticated free pilot and a temporary Factory-owned session. It checks the exact account and trainee, prices and injected skills, blocks ordinary release during a financial mutation, verifies purchase/funding results, and requires authoritative offline proof for cleanup. WC separately denies generic bridge dispatch of `skillHandler.PurchaseSkills`; purchase is available only through the reviewed Pilot Training route. Corporation onboarding and direct purchase remain opt-in. No patch provides equipment provisioning or a production password system.

This Farmer forward-port has **mechanical verification only**. Before live use, deploy the reviewed composition through the normal mod-loader/launcher maintenance path and perform isolated Pilot Training acquisition, funding, queue and Home QA. This document does not authorize changing the clean reference or a running gameplay environment.
