import type { FactoryStorage } from "./factory.ts";
import type { DockableLocation } from "../nav/dockableLocation.ts";
export interface TrainingCorporation { corporationID: number; name: string; divisions: { accountKey: number; name: string }[] }
export interface TrainingAuthority { key: string; name: string; account: string; corporationID: number; eligible: boolean }
export interface TrainingSettingsContext {
  corporations: TrainingCorporation[];
  authorities: { characterID: number; name: string; corporationID: number; eligible: boolean }[];
}
export type TrainingHomeMatch = DockableLocation;
export interface TrainingSettings {
  onboarding: { enabled: boolean; corporationID: number | null; rights: "NONE" | "FULL_ACCESS_EXCEPT_CEO"; authorityKey: string };
  trainingWallet: { corporationID: number; accountKey: number } | null;
  home: { locationID: number; name: string; systemID: number | null; kind: string; relocation: string; capability: string } | null;
}
const key = "pilot-training:settings:v1";
export const defaultTrainingSettings = (): TrainingSettings => ({ onboarding: { enabled: false, corporationID: null, rights: "NONE", authorityKey: "" }, trainingWallet: null, home: null });
function validate(value: TrainingSettings): void {
  const o = value?.onboarding;
  if (!o || typeof o.enabled !== "boolean" || !["NONE", "FULL_ACCESS_EXCEPT_CEO"].includes(o.rights) || typeof o.authorityKey !== "string" ||
    (o.corporationID !== null && (!Number.isSafeInteger(o.corporationID) || o.corporationID <= 0)) ||
    (o.enabled && (!o.corporationID || !o.authorityKey))) throw new Error("Onboarding requires a corporation and a dedicated non-CEO authority.");
  if (value.trainingWallet && (!Number.isSafeInteger(value.trainingWallet.corporationID) || value.trainingWallet.corporationID <= 0 ||
    !Number.isInteger(value.trainingWallet.accountKey) || value.trainingWallet.accountKey < 1000 || value.trainingWallet.accountKey > 1006)) throw new Error("Configure a corporation and training wallet division explicitly.");
  if (value.home && (!Number.isSafeInteger(value.home.locationID) || value.home.locationID <= 0 || typeof value.home.name !== "string" ||
      !((value.home.kind === "NPC_STATION" && value.home.relocation === "MANUAL_GM_ONLY") ||
        (value.home.kind === "PLAYER_STRUCTURE" && value.home.relocation === "CONFIG_ONLY" &&
          value.home.capability === "DOCKABLE_STRUCTURE" && value.home.locationID >= 1_000_000_000_000 &&
          typeof value.home.systemID === "number" && Number.isSafeInteger(value.home.systemID) &&
          value.home.systemID > 0 && value.home.name.trim().length > 0))))
    throw new Error("Unsupported home location. Resolve the location first.");
}
export function readTrainingSettings(storage: FactoryStorage): TrainingSettings {
  const raw = storage.getItem(key);
  if (raw === null) return defaultTrainingSettings();
  const value = JSON.parse(raw) as TrainingSettings; validate(value); return value;
}
export function saveTrainingSettings(storage: FactoryStorage, value: TrainingSettings): void { validate(value); storage.setItem(key, JSON.stringify(value)); }
