"use strict";

// Deployed into the runtime gateway. All mutations use existing live services;
// injected dependencies keep this authority boundary testable without a world.
const { randomUUID } = require("node:crypto");
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)))
    fail("WALLET_STATE_UNKNOWN");
  return BigInt(Math.round(value * 100));
}
const isk = (value) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createFactorySkillAcquisition(d) {
  const reviews = new Map();
  const locks = new Set();
  const now = d.now || Date.now;
  function actor(ref) {
    if (!ref || !Number.isSafeInteger(ref.userid) || ref.userid <= 0 || !Number.isSafeInteger(ref.characterID)) fail("FACTORY_IDENTITY_INVALID");
    const entry = d.getEntry(ref.bridgeSessionID, ref.userid);
    const id = Number(entry.session.characterID || entry.session.charid);
    const record = d.getCharacter(id);
    if (!entry.factoryOwned || id !== ref.characterID || !record || record.accountID !== ref.userid) fail("FACTORY_IDENTITY_MISMATCH");
    entry.lastUsedAtMs = now();
    const corporationID = Number(record.value.corporationID);
    if (!Number.isSafeInteger(corporationID) || corporationID <= 0 || corporationID !== Number(entry.session.corporationID || entry.session.corpid)) fail("CORPORATION_CHANGED");
    const ceoID = Number(d.getCorporationCEOID(corporationID));
    if (!Number.isSafeInteger(ceoID) || ceoID <= 0) fail("CORPORATION_STATE_UNKNOWN");
    if (ceoID === id) fail("CEO_AUTHORITY_NOT_ALLOWED");
    return { entry, id, corporationID, userid: ref.userid };
  }
  function read(request) {
    const trainee = actor(request.trainee);
    if (!Array.isArray(request.skillTypeIDs) || request.skillTypeIDs.length < 1 || request.skillTypeIDs.length > 150 ||
        request.skillTypeIDs.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(request.skillTypeIDs).size !== request.skillTypeIDs.length) fail("INVALID_SKILL_TARGETS");
    if (!["CHARACTER_WALLET_ONLY", "CHARACTER_PLUS_CORPORATION_SHORTFALL"].includes(request.policy)) fail("INVALID_FUNDING_POLICY");
    if (!d.purchaseEnabled()) fail("SkillPurchaseDisabled");
    const fundingMode = request.fundingMode || "AUTHORITY";
    if (!["SELF", "AUTHORITY"].includes(fundingMode)) fail("INVALID_FUNDING_AUTHORITY");
    if (request.policy === "CHARACTER_PLUS_CORPORATION_SHORTFALL" && (!request.trainingWallet ||
        request.trainingWallet.corporationID !== trainee.corporationID || request.trainingWallet.accountKey !== request.division)) fail("TRAINING_WALLET_UNCONFIGURED");
    const skills = [];
    for (const typeID of [...request.skillTypeIDs].sort((a, b) => a - b)) {
      if (d.injected(trainee.id, typeID)) continue;
      if (d.call("skillHandler", "IsSkillAvailableForPurchase", [typeID], trainee.entry.session) !== true) fail("SkillUnavailableForPurchase", `Skill ${typeID} cannot be purchased directly.`);
      const price = cents(d.call("skillHandler", "GetDirectPurchasePrice", [typeID], trainee.entry.session));
      skills.push({ typeID, price: isk(price) });
    }
    const total = skills.reduce((sum, skill) => sum + cents(Number(skill.price)), 0n);
    const personal = cents(d.wallet(trainee.id)?.balance);
    const shortfall = total > personal ? total - personal : 0n;
    let officer = null;
    let source = null;
    const blockers = [];
    if (shortfall > 0n && request.policy === "CHARACTER_WALLET_ONLY") blockers.push("INSUFFICIENT_PERSONAL_ISK");
    if (shortfall > 0n && request.policy === "CHARACTER_PLUS_CORPORATION_SHORTFALL") {
      officer = fundingMode === "SELF" ? trainee : actor(request.officer);
      if (fundingMode !== "SELF" && officer.id === trainee.id) fail("SEPARATE_FUNDING_AUTHORITY_REQUIRED");
      if (officer.corporationID !== trainee.corporationID) fail("CORPORATION_MISMATCH");
      const key = request.division;
      if (!Number.isInteger(key) || key < 1000 || key > 1006) fail("INVALID_WALLET_DIVISION");
      if (!d.canTake(officer.entry.session, key)) fail("CORPORATION_FUNDING_UNAUTHORIZED");
      const division = d.division(officer.corporationID, key);
      if (!division) fail("WALLET_DIVISION_UNAVAILABLE");
      const balance = cents(division.balance);
      if (balance < shortfall) blockers.push("INSUFFICIENT_CORPORATION_ISK");
      source = { characterID: officer.id, accountID: officer.userid, corporationID: officer.corporationID, division: key, balance: isk(balance) };
    }
    return { trainee, officer, quote: { characterID: trainee.id, accountID: trainee.userid, corporationID: trainee.corporationID,
      skills, total: isk(total), personalBalance: isk(personal), shortfall: isk(shortfall),
      funding: source, policy: request.policy, fundingMode, trainingWallet: request.trainingWallet || null, blockers, canAcquire: skills.length > 0 && blockers.length === 0 } };
  }
  function quote(request) {
    const { quote: result } = read(request);
    for (const [key, review] of reviews) if (review.expiresAt <= now()) reviews.delete(key);
    while (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
    const reviewID = randomUUID();
    const expiresAt = now() + 180_000;
    reviews.set(reviewID, { quote: result, ids: [...request.skillTypeIDs], expiresAt });
    return { ...result, reviewID, expiresAt };
  }
  async function acquire(request) {
    if (request.confirm !== true) fail("CONFIRMATION_REQUIRED");
    const review = reviews.get(request.reviewID);
    if (!review || review.expiresAt <= now()) fail("REVIEW_REQUIRED");
    // Validate the session's account before consuming somebody else's review.
    const target = actor(request.trainee);
    if (target.userid !== review.quote.accountID || target.id !== review.quote.characterID) fail("FACTORY_IDENTITY_MISMATCH");
    reviews.delete(request.reviewID);
    const input = { ...request, skillTypeIDs: review.ids, policy: review.quote.policy, division: review.quote.trainingWallet?.accountKey, fundingMode: review.quote.fundingMode, trainingWallet: review.quote.trainingWallet };
    const current = read(input);
    if (!same(current.quote, review.quote)) fail("REVIEW_REQUIRED", "Prices, skills, balances or funding authority changed; review again.");
    if (!current.quote.canAcquire) fail("ACQUISITION_BLOCKED");
    const { trainee, officer } = current;
    const keys = [`pilot:${trainee.id}`, ...(officer ? [`pilot:${officer.id}`, `wallet:${officer.corporationID}:${input.division}`] : [])];
    if (keys.some((key) => locks.has(key))) fail("FACTORY_BUSY");
    keys.forEach((key) => locks.add(key));
    const entries = [...new Set([trainee.entry, ...(officer ? [officer.entry] : [])])];
    entries.forEach((entry) => { entry.session._factoryMutationPending = true; });
    let funded = "0.00", fundingVerified = !officer, purchaseAttempted = false, purchaseReturned = false, errorCode = null;
    let fundingAttempted = false;
    const ids = current.quote.skills.map((row) => row.typeID);
    try {
      if (officer) {
        const reason = `Pilot Training skill funding ${randomUUID()}`;
        const amount = Number(current.quote.shortfall);
        fundingAttempted = true;
        let transferError = null;
        try { await d.call("account", "GiveCashFromCorpAccount", [trainee.id, amount, input.division, reason], officer.entry.session); }
        catch (error) { transferError = error; }
        const matches = (entry, debit) => entry.description === reason && Number(entry.ownerID1) === officer.corporationID &&
          Number(entry.ownerID2) === trainee.id && Number(entry.entryTypeID) === d.donationType &&
          Number(entry.amount) === (debit ? -amount : amount) && (!debit || Number(entry.accountKey) === input.division);
        const debit = d.corpJournal(officer.corporationID, input.division).some((entry) => matches(entry, true));
        const credit = d.journal(trainee.id).some((entry) => matches(entry, false));
        funded = credit ? current.quote.shortfall : "0.00";
        fundingVerified = debit && credit;
        if (!fundingVerified || transferError) fail("FUNDING_UNVERIFIED", "Transfer outcome is incomplete or uncertain; no purchase attempted.");
        // Revalidate live identities and prices after the awaited transfer. A
        // concurrent credit/debit or membership change never changes our spend.
        const after = read({ ...input, policy: "CHARACTER_WALLET_ONLY" });
        const expectedBalance = isk(cents(Number(current.quote.personalBalance)) + cents(amount));
        actor(input.fundingMode === "SELF" ? input.trainee : input.officer);
        if (!d.canTake(officer.entry.session, input.division) || !same(after.quote.skills, current.quote.skills) ||
            after.quote.corporationID !== current.quote.corporationID || after.quote.personalBalance !== expectedBalance ||
            cents(d.division(officer.corporationID, input.division)?.balance) !== cents(Number(current.quote.funding.balance)) - cents(amount)) fail("REVIEW_REQUIRED");
      }
      actor(input.trainee);
      purchaseAttempted = true;
      await d.call("skillHandler", "PurchaseSkills", [ids], trainee.entry.session);
      purchaseReturned = true;
    } catch (error) { errorCode = error.code || "SKILL_PURCHASE_FAILED"; }
    finally {
      entries.forEach((entry) => { entry.session._factoryMutationPending = false; });
      keys.forEach((key) => locks.delete(key));
    }
    let purchased = [], missing = [...ids], wallet = null, verificationReadable = false;
    try {
      purchased = ids.filter((id) => d.injected(trainee.id, id));
      missing = ids.filter((id) => !purchased.includes(id));
      wallet = isk(cents(d.wallet(trainee.id)?.balance));
      verificationReadable = true;
    } catch { errorCode ||= "ACQUISITION_UNVERIFIED"; }
    const verified = purchaseReturned && verificationReadable && missing.length === 0 && fundingVerified;
    const status = verified ? "SKILLS_ACQUIRED" : purchased.length ? "PARTIAL_SKILL_ACQUISITION" :
      funded !== "0.00" ? "FUNDING_TRANSFERRED_PURCHASE_FAILED" : fundingAttempted && !fundingVerified ? "FUNDING_UNVERIFIED" :
      purchaseAttempted ? "ACQUISITION_UNVERIFIED" : "ACQUISITION_REFUSED";
    return { status, verified, purchased, missing, wallet, funded, fundingVerified, fundingAttempted, purchaseAttempted,
      errorCode, total: current.quote.total, message: verified ? "Skills verified. Review the queue separately." :
        "Acquisition incomplete. Inspect fresh skills and wallet before reviewing again. No retry or rollback was attempted." };
  }
  return { quote, acquire };
}
module.exports = { createFactorySkillAcquisition, cents, isk };
