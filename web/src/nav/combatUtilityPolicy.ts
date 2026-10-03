import type { UtilityType, CombatUtility, UtilityFamily } from "./combatUtilities.ts";

// One positive identity contract for fit enrolment, planning and fresh dispatch.
export const AUTOMATIC_UTILITY_FAMILIES: Readonly<Record<number, readonly [UtilityFamily, number]>> = {
  65: ["web", 6426], 379: ["painter", 6425], 212: ["sensor", 2670],
  213: ["tracking", 4559], 646: ["omni", 6557], 76: ["capacitor", 48],
};

export type RestrictedUtilityFamily = "neut" | "nos" | "ecm" | "damp" | "tracking-disruptor" |
  "guidance-disruptor" | "scram" | "disruptor";
export interface UtilityRestriction {
  readonly family: RestrictedUtilityFamily;
  readonly status: "FAIL_CLOSED";
  readonly reason: string;
}

// Group alone is insufficient: weapon disruptors share group 291, and tackle
// shares group 52. These are data identities, never permission to activate.
const RESTRICTED: readonly { group: number; effect: number; family: RestrictedUtilityFamily; reason: string }[] = [
  { group: 71, effect: 6187, family: "neut", reason: "Live NPC capacitor and a capacitor-dependent attack lane are not observed." },
  { group: 68, effect: 6197, family: "nos", reason: "Live NPC capacitor amount and the actual transfer eligibility are not observed." },
  { group: 201, effect: 6470, family: "ecm", reason: "Outgoing jam success and protection of another target are not observed; ECM permits locking its source." },
  { group: 208, effect: 6422, family: "damp", reason: "Effective NPC lock range/resolution and relevant lock behavior are not observed." },
  { group: 291, effect: 6424, family: "tracking-disruptor", reason: "A live projected turret attack profile is not observed." },
  { group: 291, effect: 6423, family: "guidance-disruptor", reason: "A live projected missile attack lane is not observed; entity missiles bypass projection." },
  { group: 52, effect: 5934, family: "scram", reason: "Ordinary NPC warp control has no proven Defender benefit; no PvP policy is authorized." },
  { group: 52, effect: 39, family: "disruptor", reason: "Ordinary NPC warp control has no proven Defender benefit; no PvP policy is authorized." },
];

export function combatUtilityRestriction(type: UtilityType): UtilityRestriction | null {
  if (type.categoryID !== 7) return null;
  const matches = RESTRICTED.filter(row => row.group === type.groupID && type.effects.includes(row.effect));
  const spec = matches[0];
  return spec ? { family: spec.family, status: "FAIL_CLOSED", reason: spec.reason } : null;
}

/** Both planning and fresh dispatch must keep unknown/restricted capabilities OFF. */
export function automaticCombatUtility(module: CombatUtility): boolean {
  const spec = AUTOMATIC_UTILITY_FAMILIES[module.type.groupID];
  return module.type.categoryID === 7 && module.typeID === module.type.typeID && !!spec &&
    module.family === spec[0] && module.effectID === spec[1] && module.type.effects.includes(spec[1]) &&
    combatUtilityRestriction(module.type) === null;
}
