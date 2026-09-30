import { trainingAccount, loginFactoryAccount, loadTrainingCharacters, type ApiOptions, type TrainingAccountOutcome } from "../app/api.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { rememberFactoryAccount, type FactoryStorage } from "./factory.ts";

export interface PendingTrainee { username: string; characterName: string }
export interface TraineeInput extends PendingTrainee { password: string; confirmation: string }
export interface PendingStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const pendingTraineeKey = "pilot-training:pending-account:v1";
export function rememberCreatedAccount(storage: FactoryStorage, account: string): string {
  try { rememberFactoryAccount(storage, account); return ""; }
  catch { return "Account is authenticated, but this browser could not remember it. You can continue now; after refresh, use the existing account."; }
}
export function readPendingTrainee(storage: PendingStorage): PendingTrainee | null {
  const raw = storage.getItem(pendingTraineeKey);
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingTrainee;
  if (!value || !/^[A-Za-z0-9_.@-]{1,64}$/.test(value.username) || typeof value.characterName !== "string")
    throw new Error("Pending account recovery is unreadable. Contact the server operator before creating another account.");
  return { username: value.username, characterName: value.characterName };
}
export function validateTrainee(input: TraineeInput): PendingTrainee {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) throw new Error("Use 1–64 letters, digits, _ . @ or - for the account name.");
  if (!input.password || input.password !== input.confirmation) throw new Error("Enter a password and matching confirmation.");
  if (!input.characterName.trim()) throw new Error("Enter an initial character name. The character creator will validate availability.");
  return { username, characterName: input.characterName.trim() };
}
const defaults = {
  create: (name: string) => trainingAccount("create", name),
  recover: (name: string) => trainingAccount("recover", name),
  login: (name: string, password: string) => loginFactoryAccount(name, {}, password),
  roster: (options: ApiOptions) => loadTrainingCharacters(options),
};
export async function continueNewTrainee(input: TraineeInput, storage: PendingStorage, deps = defaults) {
  const requested = validateTrainee(input), existing = readPendingTrainee(storage);
  if (existing && (existing.username !== requested.username || existing.characterName !== requested.characterName))
    throw new Error("Recover the pending account before starting a different trainee.");
  const pending = existing || requested;
  storage.setItem(pendingTraineeKey, JSON.stringify(pending)); // names only; never passwords/tokens
  let outcome: TrainingAccountOutcome;
  try { outcome = existing ? await deps.recover(pending.username) : await deps.create(pending.username); }
  catch (cause) {
    if (cause instanceof BridgeCallError && ["ACCOUNT_EXISTS", "ACCOUNT_INVALID", "ACCOUNT_CREATE_DISABLED", "ACCOUNT_READ_UNAVAILABLE", "CONFIRMATION_REQUIRED"].includes(cause.code)) {
      storage.removeItem(pendingTraineeKey); throw cause;
    }
    // A lost POST response permits only a read. Never resend the create.
    try { outcome = await deps.recover(pending.username); }
    catch { throw new Error("Account creation is unconfirmed. Check creation status again; no automatic retry."); }
  }
  if (!outcome.account || outcome.status === "RECOVERY_REQUIRED" || outcome.account.username !== pending.username)
    throw new Error("Account creation is unconfirmed. Check creation status again; no automatic retry.");
  const auth = await deps.login(outcome.account.username, input.password);
  if (auth.account !== outcome.account.username) throw new Error("Account authentication changed identity.");
  const requestOptions: ApiOptions = { token: auth.token };
  const roster = await deps.roster(requestOptions);
  if (roster.account !== auth.account) throw new Error("Account identity changed during roster read.");
  storage.removeItem(pendingTraineeKey);
  return { ...roster, requestOptions, characterName: pending.characterName };
}
