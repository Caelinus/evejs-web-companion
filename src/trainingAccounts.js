"use strict";

function refusal(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode }); }
function accountName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) throw refusal("ACCOUNT_INVALID", "Use 1–64 letters, digits, _ . @ or - for the account name.", 400);
  return name;
}

// Thin guard around the existing owner-backed /account/create API. Passwords,
// roles and account IDs are never accepted as creation authority. The current
// EveJS API is dev auto-create; normal WC login handles authentication afterward.
function createTrainingAccounts({ store, journal = null }) {
  const attempts = new Map();
  async function read(name) {
    try {
      const account = await store.getAccount(name);
      if (!account) return null;
      if (!Number.isSafeInteger(account.accountID) || account.accountID <= 0 ||
          account.username !== name || account.banned)
        throw refusal("ACCOUNT_STATE_UNKNOWN", "Account identity cannot be confirmed.");
      return { username: account.username, accountID: account.accountID };
    } catch (error) { if (error.code === "ACCOUNT_NOT_FOUND") return null; throw error; }
  }
  async function recover(request) {
    const name = accountName(request.username);
    try {
      const account = await read(name);
      if (account) {
        journal?.clear(`account:${name}`);
        attempts.delete(name);
        return { status: "ACCOUNT_CONFIRMED", account };
      }
    } catch { /* Unknown authority must not cause a resend. */ }
    return { status: "RECOVERY_REQUIRED", account: null,
      message: "Account creation is not confirmed. Check status again; do not resend creation or choose an alternate name." };
  }
  async function create(request) {
    if (request.confirm !== true) throw refusal("CONFIRMATION_REQUIRED", "Confirm account creation.", 400);
    const name = accountName(request.username), key = name; // EveJS names are case-sensitive.
    if (attempts.has(key) || journal?.get(`account:${key}`)) return recover({ username: name });
    if (attempts.size >= 1000) throw refusal("ACCOUNT_CREATION_BUSY", "Too many pending account creations. Contact the server operator.", 503);
    attempts.set(key, true); // before the first await: only one create dispatch per name
    try {
      if (await read(name)) throw refusal("ACCOUNT_EXISTS", "This account already exists. Choose Use existing account.");
    } catch (error) {
      attempts.delete(key);
      if (error.code === "ACCOUNT_EXISTS") throw error;
      throw refusal("ACCOUNT_READ_UNAVAILABLE", "Account availability could not be verified. Nothing was created.", 503);
    }
    // Persist before dispatch. A crash after this point leaves an explicit
    // recovery fence even if EveJS has not yet made the account visible.
    try {
      if (journal && !journal.mark(`account:${key}`, { name })) {
        attempts.delete(key);
        return recover({ username: name });
      }
    } catch {
      attempts.delete(key);
      throw refusal("ACCOUNT_CREATION_STATE_UNAVAILABLE", "Creation safety state could not be saved; nothing was sent.", 503);
    }
    let dispatchedError = null, created = false;
    try { created = (await store.createAccount(name))?.created === true; }
    catch (error) { dispatchedError = error; }
    const outcome = await recover({ username: name });
    if (outcome.account) return { ...outcome, status: !dispatchedError && created ? "ACCOUNT_CREATED" : "ACCOUNT_RECOVERED" };
    if (["ACCOUNT_CREATE_DISABLED", "ACCOUNT_INVALID"].includes(dispatchedError?.code)) {
      journal?.clear(`account:${key}`);
      attempts.delete(key); // authoritative refusal before a write
      throw refusal(dispatchedError.code, dispatchedError.code === "ACCOUNT_CREATE_DISABLED"
        ? "Account creation is disabled by this EveJS server." : "EveJS refused the account name.", 400);
    }
    return outcome;
  }
  return { create, recover };
}

module.exports = { createTrainingAccounts, accountName };
