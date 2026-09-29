"use strict";

// MCC-owned scripts use the ordinary script runner. IDs identify behavior,
// while rev and botHost's document hash pin the exact granted implementation.
const BELT_MINER_ID = "mcc.belt.hauler-service.miner";
const BELT_HAULER_ID = "mcc.belt.hauler-service.hauler";
const PROFILES = Object.freeze({
  MINER: { scriptID: BELT_MINER_ID, name: "Belt Miner / Hauler Service", rev: 2 },
  HAULER: { scriptID: BELT_HAULER_ID, name: "Belt Hauler", rev: 1 },
});
// Families own distinct implementations. Future families cannot route through
// a belt routine merely because they share a member role.
const PROFILE_FAMILIES = Object.freeze({
  BELT: { family: "BELT", executable: true, profiles: PROFILES, selfUnload: selfUnloadProfile("belt", "Belt"), build: buildBeltProfile },
  ORE_ANOMALY: { family: "ORE_ANOMALY", executable: true, profiles: siteProfiles("ore-anomaly", "Ore Anomaly"), selfUnload: selfUnloadProfile("ore-anomaly", "Ore Anomaly"), build: buildOreAnomalyProfile },
  ICE: { family: "ICE", executable: true, profiles: siteProfiles("ice", "Ice"), selfUnload: selfUnloadProfile("ice", "Ice"), build: buildIceProfile },
  GAS: { family: "GAS", executable: false, profiles: {}, reason: "Gas profiles are not implemented." },
});
const familyCapabilities = () => Object.values(PROFILE_FAMILIES).map(({ build, ...metadata }) => metadata);

function selfUnloadProfile(id, name) {
  return Object.freeze({ scriptID: `mcc.${id}.self-unload.miner`, name: `${name} Miner / Self Unload`, rev: 1 });
}

function siteProfiles(id, name) {
  return Object.freeze({
    MINER: { scriptID: `mcc.${id}.hauler-service.miner`, name: `${name} Miner / Hauler Service`, rev: 1 },
    HAULER: { scriptID: `mcc.${id}.hauler-service.hauler`, name: `${name} Hauler`, rev: 1 },
  });
}

function buildOreAnomalyProfile(definition, member) { return buildSiteProfile(definition, member, "site"); }
function buildIceProfile(definition, member) { return buildSiteProfile(definition, member, "ice-site"); }

// Shared freight/control structure, distinct versioned semantic profiles. The
// site modes have operation-only travel authority and never select a belt.
function buildSiteProfile(definition, member, mode) {
  const result = buildMiningServiceDocument(definition, member);
  if (!result) return null;
  result.doc.notes = `MCC standard ${definition.area.targetClasses[0]} profile. Operation target authority only.`;
  const body = result.doc.program[0].body;
  const step = member.role === "MINER" ? body[1] : body[0].else[1];
  step.args.belt.belt.mode = mode;
  return result;
}

function standardProfileFor(definition, member) {
  if ((member?.routineMode || (member?.automationID ? "CUSTOM" : "STANDARD")) !== "STANDARD" ||
      definition?.area?.targetClasses?.length !== 1) return null;
  const family = PROFILE_FAMILIES[definition.area.targetClasses[0]];
  if (!family?.executable) return null;
  if (definition.unloadPolicy === "SELF_UNLOAD") return member.role === "MINER" ? family.selfUnload : null;
  return definition.unloadPolicy === "HAULER_SERVICE" ? family.profiles[member.role] || null : null;
}

function buildStandardProfile(definition, member) {
  const family = PROFILE_FAMILIES[definition?.area?.targetClasses?.[0]];
  return family?.executable ? family.build(definition, member) : null;
}

function buildBeltProfile(definition, member) {
  return buildMiningServiceDocument(definition, member);
}

function buildMiningServiceDocument(definition, member) {
  const profile = standardProfileFor(definition, member);
  if (!profile) return null;
  const destination = definition.unloadDestination;
  if (!destination) return null;
  if (destination?.corporationDivision != null &&
      (!Number.isSafeInteger(destination.corporationDivision) || destination.corporationDivision < 1 || destination.corporationDivision > 7)) return null;
  const station = destination.kind === "structure"
    ? Number.isSafeInteger(destination.id) && destination.id >= 1_000_000_000_000 && destination.name && destination.solarSystemName
      ? { entity: "structure", id: destination.id, name: destination.name, systemName: destination.solarSystemName }
      : null
    : Number.isSafeInteger(destination.stationID) && destination.stationID > 0 && destination.stationName && destination.systemName
      ? { entity: "station", id: destination.stationID, name: destination.stationName, systemName: destination.systemName }
      : null;
  if (!station) return null;
  const belt = { kind: "belt", belt: { mode: "nearest" } };
  const delivery = { id: "deliver", kind: "macro", macro: "deliver-ore", args: {
    station: { kind: "station", ref: station },
    ...(destination.corporationDivision == null ? {} : { into: { kind: "corpDivision", division: destination.corporationDivision, name: null } }),
  } };
  const doc = {
    format: "evejs-bot-script", version: 1, name: profile.name,
    notes: "MCC standard BELT profile. Resource target comes only from operation.currentTarget.",
    home: station, interrupts: [],
    program: member.role === "MINER" ? [{
      id: "loop", kind: "loop", repeat: { kind: "forever" }, body: [
        { id: "undock", kind: "macro", macro: "undock", args: {} },
        // Current Farmer/Batch 6 controller selects drones from ship capability;
        // the old per-step toggle is not part of the current script format.
        { id: "mine", kind: "macro", macro: "mine-at-belt", args: { belt }, until: { kind: "ore-hold-at-least", fraction: 0.9 } },
        definition.unloadPolicy === "SELF_UNLOAD" ? delivery : { id: "jettison", kind: "macro", macro: "jettison-ore", args: {} },
      ],
    }] : [{
      id: "loop", kind: "loop", repeat: { kind: "forever" }, body: [
        { id: "hold-check", kind: "branch", when: { kind: "ore-hold-at-least", fraction: 0.9 },
          then: [delivery],
          else: [
            { id: "undock", kind: "macro", macro: "undock", args: {} },
            { id: "travel", kind: "macro", macro: "travel-to-belt", args: { belt } },
            { id: "loot", kind: "macro", macro: "loot-containers", args: {} },
          ],
        },
        { id: "idle", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 3 } } },
      ],
    }],
  };
  return { ...profile, doc };
}

module.exports = { BELT_MINER_ID, BELT_HAULER_ID, PROFILES, PROFILE_FAMILIES, familyCapabilities, standardProfileFor, buildStandardProfile };
