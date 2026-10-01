"use strict";
const model = require("./jettisonCustody");

// All observations and the single mutation are injected normal bridge calls.
function createJettisonCustodyHandler(deps) {
  return async function handle(req, res, owner, reconcileOnly = false) {
    const notifications = [];
    let custody = owner.read();
    let ownsCustody = reconcileOnly && custody !== null;
    const settle = () => {
      owner.settle(custody);
      custody = owner.read();
    };
    // A processed custody read carries drains even when productive work is
    // blocked. The API adapter checks accepted/state, never HTTP ACK alone.
    const reply = (accepted, error = null) => res.status(200).json({ ok: true, accepted,
      notIssued: custody === null || custody?.state === "refused-before-dispatch",
      ...(error ? { error, message: "Jettison custody requires reconciliation; no second jettison was issued." } : {}),
      jettisonCustody: model.copy(custody), notifications });
    try {
      if (reconcileOnly && !custody) return reply(true);
      if (!reconcileOnly && custody?.scope.runID === req.body?.invocation?.runID &&
          custody.scope.invocationID === req.body.invocation.invocationID) {
        const requested = req.body.itemIDs;
        if (!Array.isArray(requested) || new Set(requested).size !== requested.length ||
            !requested.every(id => Number.isSafeInteger(id) && id > 0) || requested.length !== custody.items.length ||
            !requested.every(id => custody.items.some(row => row.itemID === id))) return reply(false, "JETTISON_INVOCATION_CHANGED");
        return reply(custody.state !== "not-issued" && !model.unresolved(custody), custody.reason || "JETTISON_PENDING");
      }
      if (!reconcileOnly && (custody?.state === "not-issued" || model.unresolved(custody))) return reply(false, custody.reason || "JETTISON_PENDING");
      const scope = await deps.readScope(req, owner, notifications);
      const before = await deps.readEvidence(req, owner, custody, notifications);
      if (!reconcileOnly) {
        custody = model.prepare({ scope, invocation: req.body?.invocation, scene: before.scene, rows: before.rows,
          itemIDs: req.body?.itemIDs, nowMs: deps.now() });
        owner.begin(custody); // Before the mutation, independently of macro memory.
        ownsCustody = true;
        await deps.assertDispatch(req, owner, custody);
        const issued = model.issued(custody, deps.now());
        owner.markIssued(issued);
        custody = issued;
        const outcome = await deps.dispatch(req, custody);
        if (Array.isArray(outcome.notifications)) notifications.push(...outcome.notifications);
        const receipt = model.resultIDs(outcome.result);
        if (receipt) custody = { ...custody, resultMovedIDs: receipt.moved, resultLaunchedIDs: receipt.launched };
        settle(); // Retain item-level result before postcondition reads.
      }
      const after = reconcileOnly ? before : await deps.readEvidence(req, owner, custody, notifications);
      const freshScope = await deps.readScope(req, owner, notifications);
      custody = model.reconcile(custody, { scope: freshScope, ...after, nowMs: deps.now() });
      settle();
      if (custody.state === "confirmed-created" && !deps.register(custody)) {
        custody = { ...custody, state: "ambiguous", reason: "JETTISON_TARGET_CHANGED" };
        settle();
      }
      return reply(!model.unresolved(custody), custody.reason);
    } catch (error) {
      // Preparation does not acquire custody. A concurrent duplicate may lose
      // begin() after the original has issued; it must never settle its local
      // unissued copy over that mutation.
      if (!ownsCustody) {
        custody = owner.read();
        return reply(false, custody?.reason || error?.code || "JETTISON_NOT_ISSUED");
      }
      if (custody?.state === "not-issued") custody = { ...custody, state: "refused-before-dispatch", reason: error?.code || "JETTISON_NOT_ISSUED" };
      else if (custody && model.unresolved(custody)) custody = { ...custody, state: "ambiguous", reason: error?.code || "JETTISON_OBSERVATION_UNKNOWN" };
      if (custody) settle();
      return reply(false, custody?.reason || error?.code || "JETTISON_NOT_ISSUED");
    }
  };
}
module.exports = { createJettisonCustodyHandler };
