"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Resolved in config.js, which defaults both to the native
// <eveRoot>/_local/... layout and lets EVEJS_GAMESTORE_DATA_DIR /
// EVEJS_SDE_DIR point them at the docker evejs-data volume layout instead.
const DATA_DIR = config.gamestoreDataDir;
const SDE_DIR = config.sdeDir;
const caches = new Map();
const VALID_ICON_SIZES = new Set([32, 64, 128, 256, 512, 1024]);

/**
 * One static table off the EveJS gameStore, or an EMPTY table when it is not
 * there to read.
 *
 * ⚠ A MISSING STATIC TABLE MUST NOT BE FATAL. This used to read unguarded, so a
 * `data/stations/data.json` that was absent — a fresh clone with no EVEJS_ROOT
 * set, a partially-populated gameStore, a root pointed at the wrong folder —
 * threw ENOENT out of `getStation`, up through `buildStationStatic`, and out of
 * `POST /api/bridge/select` as a 500. That is the one call every session has to
 * make: the failure did not cost a station's NAME, it cost the ability to bring
 * a character online at all.
 *
 * Every caller already copes with a missing row — `getStation` answers null,
 * `buildStationStatic` falls back to `Station <id>` — so an empty table lands in
 * paths that are already written for it. `readJsonlTable` directly below has
 * always guarded exactly this way; this is the same rule applied to its twin.
 */
function readStaticTable(tableName) {
  const filePath = path.join(DATA_DIR, tableName, "data.json");
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonlTable(fileName) {
  const filePath = path.join(SDE_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildIndex(tableName, bucketName, idField) {
  const cacheKey = `${tableName}:${bucketName}:${idField}`;
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }

  const table = readStaticTable(tableName);
  const bucket = table[bucketName] || table;
  const values = Array.isArray(bucket) ? bucket : Object.values(bucket);
  const index = new Map();
  for (const entry of values) {
    const id = Number(entry && entry[idField]);
    if (id > 0) {
      index.set(id, entry);
    }
  }
  caches.set(cacheKey, index);
  return index;
}

function buildJsonlIndex(fileName, idField = "_key") {
  const cacheKey = `jsonl:${fileName}:${idField}`;
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }

  const index = new Map();
  for (const entry of readJsonlTable(fileName)) {
    const id = Number(entry && entry[idField]);
    if (id > 0) {
      index.set(id, entry);
    }
  }
  caches.set(cacheKey, index);
  return index;
}

function getType(typeID) {
  const numericTypeID = Number(typeID) || 0;
  return (
    buildIndex("itemTypes", "types", "typeID").get(numericTypeID) ||
    getSkillType(numericTypeID) ||
    null
  );
}

function getTypeName(typeID) {
  const entry = getType(typeID);
  return entry ? String(entry.name || `Type ${typeID}`) : `Type ${typeID}`;
}

function getTypeGroupName(typeID) {
  const entry = getType(typeID);
  return entry ? String(entry.groupName || "Unknown") : "Unknown";
}

function getTypeCategoryID(typeID) {
  const entry = getType(typeID);
  return entry ? Number(entry.categoryID || 0) || null : null;
}

function getTypeCategoryName(typeID) {
  return getCategoryName(getTypeCategoryID(typeID));
}

function getCategory(categoryID) {
  return buildJsonlIndex("categories.jsonl").get(Number(categoryID) || 0) || null;
}

function getCategoryName(categoryID) {
  const entry = getCategory(categoryID);
  if (!entry) {
    return categoryID ? `Category ${categoryID}` : "Unknown";
  }
  return String(
    (entry.name && (entry.name.en || entry.name.en_us)) ||
    entry.name ||
    `Category ${categoryID}`,
  );
}

function getLocalizedValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return (
      value.en ||
      value.en_us ||
      Object.values(value).find((entry) => typeof entry === "string") ||
      null
    );
  }
  return null;
}

function getLocalizedName(entry, fallback) {
  return String(
    getLocalizedValue(entry && entry.name) ||
    (entry && (
      entry.corporationName ||
      entry.allianceName ||
      entry.factionName ||
      entry.regionName ||
      entry.shortName ||
      entry.tickerName
    )) ||
    fallback ||
    "Unknown",
  );
}

function getRegion(regionID) {
  return buildJsonlIndex("mapRegions.jsonl").get(Number(regionID) || 0) || null;
}

function getRegionName(regionID) {
  const numericRegionID = Number(regionID) || 0;
  if (!numericRegionID) {
    return null;
  }
  const entry = getRegion(numericRegionID);
  return entry ? getLocalizedName(entry, `Region ${numericRegionID}`) : `Region ${numericRegionID}`;
}

function getCorporation(corporationID) {
  const numericCorporationID = Number(corporationID) || 0;
  if (!numericCorporationID) {
    return null;
  }
  return (
    buildIndex("corporations", "records", "corporationID").get(numericCorporationID) ||
    buildJsonlIndex("npcCorporations.jsonl").get(numericCorporationID) ||
    null
  );
}

function getCorporationName(corporationID) {
  const numericCorporationID = Number(corporationID) || 0;
  if (!numericCorporationID) {
    return null;
  }
  const entry = getCorporation(numericCorporationID);
  return entry
    ? getLocalizedName(entry, `Corporation ${numericCorporationID}`)
    : `Corporation ${numericCorporationID}`;
}

function getAlliance(allianceID) {
  const numericAllianceID = Number(allianceID) || 0;
  if (!numericAllianceID) {
    return null;
  }
  return buildIndex("alliances", "records", "allianceID").get(numericAllianceID) || null;
}

// --- Faction / character / agent name resolvers (goal R7c) -----------------
// The names-everywhere UI pass resolves every raw ID to a name. Corp / alliance
// / type / station / system already had resolvers; factions, characters, and
// agents did not. These read the same read-only gameStore reference tables
// (factions.records, the characterID-keyed characters table, and the
// agentAuthority roster whose `ownerName` is the agent's name). NPC/unknown IDs
// return null so the batch route can report a definitive "unknown" (the client
// then keeps the raw ID) — see resolveNames.

function getFaction(factionID) {
  const numericFactionID = Number(factionID) || 0;
  if (!numericFactionID) {
    return null;
  }
  return buildIndex("factions", "records", "factionID").get(numericFactionID) || null;
}

function getFactionName(factionID) {
  const numericFactionID = Number(factionID) || 0;
  if (!numericFactionID) {
    return null;
  }
  const entry = getFaction(numericFactionID);
  return entry ? getLocalizedName(entry, `Faction ${numericFactionID}`) : `Faction ${numericFactionID}`;
}

/**
 * The character-creation ancestries, off the SDE.
 *
 * ⚠ THE ONLY SOURCE FOR THESE. Unlike races, bloodlines and schools — which
 * EveJS keeps in its own gameStore and serves through the retail read
 * charUnboundMgr.GetCharCreationInfo — the world has NO ancestry table at all.
 * CreateCharacterWithDoll takes an ancestryID, stores it verbatim on the
 * character record, and never validates it against anything; the reads that
 * echo it back (GetCharacterInfo, the paperdoll rows) just replay the stored
 * number. So the ancestry a player picks is pure flavor as far as the server
 * is concerned, and the SDE is where the names and descriptions live.
 *
 * That also means the attribute bonuses below are NOT applied: creation writes
 * all five attributes at a flat 20. They ship anyway so the picker can show
 * what an ancestry means in retail, but no caller should read them as this
 * character's actual stats.
 *
 * Rows are keyed by `_key` (the ancestryID) and carry a bloodlineID. The SDE
 * covers bloodlines this world does not have (Jove and Drifter); filtering to
 * the bloodlines EveJS actually names is the CALLER's job, because only the
 * retail read knows which those are.
 */
function listAncestries() {
  const cacheKey = "ancestries:list";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }

  const rows = readJsonlTable("ancestries.jsonl")
    .map((entry) => {
      const ancestryID = Number(entry && entry._key) || 0;
      const bloodlineID = Number(entry && entry.bloodlineID) || 0;
      if (ancestryID <= 0 || bloodlineID <= 0) {
        return null;
      }
      return {
        ancestryID,
        bloodlineID,
        name: getLocalizedValue(entry.name) || `Ancestry ${ancestryID}`,
        shortDescription:
          typeof entry.shortDescription === "string" ? entry.shortDescription : "",
        description: getLocalizedValue(entry.description) || "",
        iconID: Number(entry.iconID) || null,
        // Retail's attribute bonuses. Not applied by this world — see above.
        attributes: {
          charisma: Number(entry.charisma) || 0,
          intelligence: Number(entry.intelligence) || 0,
          memory: Number(entry.memory) || 0,
          perception: Number(entry.perception) || 0,
          willpower: Number(entry.willpower) || 0,
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.ancestryID - right.ancestryID);

  caches.set(cacheKey, rows);
  return rows;
}

// The characters table is keyed by characterID at the top level (no `records`
// bucket, and the entries carry `characterName` but not `characterID`), so the
// index takes the object key as the ID.
function getCharactersByID() {
  const cacheKey = "characters:byID";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const table = readStaticTable("characters");
  const bucket = table.characters || table.records || table;
  const index = new Map();
  for (const [key, entry] of Object.entries(bucket)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = Number(entry.characterID) || Number(key) || 0;
    if (id > 0) {
      index.set(id, entry);
    }
  }
  caches.set(cacheKey, index);
  return index;
}

function getCharacter(characterID) {
  const numericCharacterID = Number(characterID) || 0;
  if (!numericCharacterID) {
    return null;
  }
  return getCharactersByID().get(numericCharacterID) || null;
}

function getCharacterName(characterID) {
  const numericCharacterID = Number(characterID) || 0;
  if (!numericCharacterID) {
    return null;
  }
  const entry = getCharacter(numericCharacterID);
  // No fallback echo: an unknown character (an NPC or another player not in the
  // local table) returns null so callers keep whatever live name they have or
  // the raw ID.
  return entry ? String(entry.characterName || entry.name || `Character ${numericCharacterID}`) : null;
}

function getAgentName(agentID) {
  const numericAgentID = Number(agentID) || 0;
  if (!numericAgentID) {
    return null;
  }
  const agent = getAgentsByID().get(numericAgentID);
  return agent ? String(agent.ownerName || `Agent ${numericAgentID}`) : null;
}

function getAllianceName(allianceID) {
  const numericAllianceID = Number(allianceID) || 0;
  if (!numericAllianceID) {
    return null;
  }
  const entry = getAlliance(numericAllianceID);
  return entry
    ? getLocalizedName(entry, `Alliance ${numericAllianceID}`)
    : `Alliance ${numericAllianceID}`;
}

function getMarketGroup(marketGroupID) {
  return buildJsonlIndex("marketGroups.jsonl").get(Number(marketGroupID) || 0) || null;
}

function getMarketGroupName(marketGroupID) {
  const entry = getMarketGroup(marketGroupID);
  return entry ? getLocalizedName(entry, `Market Group ${marketGroupID}`) : null;
}

function getMarketGroupPath(marketGroupID) {
  const pathEntries = [];
  let currentID = Number(marketGroupID) || 0;
  const seen = new Set();
  while (currentID > 0 && !seen.has(currentID)) {
    seen.add(currentID);
    const entry = getMarketGroup(currentID);
    if (!entry) {
      break;
    }
    pathEntries.unshift({
      marketGroupID: currentID,
      name: getLocalizedName(entry, `Market Group ${currentID}`),
      parentGroupID: Number(entry.parentGroupID || 0) || null,
      hasTypes: entry.hasTypes === true,
    });
    currentID = Number(entry.parentGroupID || 0) || 0;
  }
  return pathEntries;
}

function normalizeIconRequest(typeID, size = 64, variation = "icon") {
  const numericTypeID = Number(typeID) || 0;
  const numericSize = VALID_ICON_SIZES.has(Number(size))
    ? Number(size)
    : 64;
  const safeVariation = String(variation || "icon").replace(/[^a-z0-9_-]/gi, "") || "icon";
  return {
    typeID: numericTypeID,
    size: numericSize,
    variation: safeVariation,
  };
}

function getTypeIconCachePath(typeID, size = 64, variation = "icon") {
  const normalized = normalizeIconRequest(typeID, size, variation);
  return normalized.typeID > 0
    ? path.join(
      config.iconCacheDir,
      "types",
      String(normalized.size),
      normalized.variation,
      `${normalized.typeID}.png`,
    )
    : null;
}

function getLocalTypeIconUrl(typeID, size = 64, variation = "icon") {
  const normalized = normalizeIconRequest(typeID, size, variation);
  const cachePath = getTypeIconCachePath(normalized.typeID, normalized.size, normalized.variation);
  if (!cachePath || !fs.existsSync(cachePath)) {
    return null;
  }
  return `${config.iconCacheUrlPath}/types/${normalized.size}/${normalized.variation}/${normalized.typeID}.png`;
}

function getRemoteTypeIconUrl(typeID, size = 64, variation = "icon") {
  const normalized = normalizeIconRequest(typeID, size, variation);
  return normalized.typeID > 0
    ? `https://images.evetech.net/types/${normalized.typeID}/${normalized.variation}?size=${normalized.size}`
    : null;
}

function getTypeIconUrl(typeID, size = 64, variation = "icon") {
  const localUrl = getLocalTypeIconUrl(typeID, size, variation);
  if (localUrl) {
    return localUrl;
  }
  const normalized = normalizeIconRequest(typeID, size, variation);
  return normalized.typeID > 0
    ? getRemoteTypeIconUrl(normalized.typeID, normalized.size, normalized.variation)
    : null;
}

function getSkillType(typeID) {
  return buildIndex("skillTypes", "skills", "typeID").get(Number(typeID) || 0) || null;
}

function buildTypeDogmaIndex() {
  const cacheKey = "typeDogma:typesByTypeID";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const table = readStaticTable("typeDogma");
  const rows = table.typesByTypeID || {};
  const index = new Map();
  for (const [typeID, entry] of Object.entries(rows)) {
    const numericTypeID = Number(typeID || (entry && entry.typeID) || 0);
    if (numericTypeID > 0) {
      index.set(numericTypeID, entry);
    }
  }
  caches.set(cacheKey, index);
  return index;
}

function getTypeDogma(typeID) {
  return buildTypeDogmaIndex().get(Number(typeID) || 0) || null;
}

// dogmaEffects: moduleBonusAfterburner / moduleBonusMicrowarpdrive. The two
// PROPULSION effect ids, named because deactivation needs the NAME: the eve.js
// Deactivate handler routes a prop mod to deactivatePropulsionModule only when
// the caller says "moduleBonusAfterburner"/"moduleBonusMicrowarpdrive" — an
// empty effect falls to the generic path, which reports success WITHOUT
// stopping the prop mod (dogmaService.js Handle_Deactivate; activation infers
// the default effect, deactivation does not — a marked server-side asymmetry).
const PROPULSION_EFFECT_NAMES = Object.freeze({
  6731: "moduleBonusAfterburner",
  6730: "moduleBonusMicrowarpdrive",
});

/**
 * The propulsion effect NAME a module type runs, or null for everything that
 * is not an afterburner/MWD. What the deactivate bridge route passes to
 * dogmaIM.Deactivate so a prop mod actually stops (see the constant above).
 */
function getPropulsionEffectName(typeID) {
  const dogma = getTypeDogma(typeID);
  const effects = dogma && Array.isArray(dogma.effects) ? dogma.effects : [];
  for (const effectID of effects) {
    const name = PROPULSION_EFFECT_NAMES[Number(effectID)];
    if (name) {
      return name;
    }
  }
  return null;
}

// dogma: 128 is the charge SIZE (1 small, 2 medium, 3 large, 4 x-large) and
// 604/605/606/609 are the charge GROUP ids a module will accept. Both sides of
// the match come from the same table, so this needs no bridge call and no
// allowlist pair — exactly like the per-type volume lookup above it.
const CHARGE_SIZE_ATTRIBUTE = 128;
const CHARGE_GROUP_ATTRIBUTES = Object.freeze([604, 605, 606, 609]);

/**
 * What charges a MODULE will take: its size, and the charge groups it accepts.
 *
 * ⚠ ADVISORY ONLY. This is here so a picker can put the charges that will
 * probably work first — it must never HIDE a charge, because the SERVER is the
 * authority on what loads and this table cannot know about every special case.
 * A module with no charge attributes returns empty, which reads as "we cannot
 * say", not as "nothing fits".
 */
function getModuleChargeFitment(typeID) {
  const attributes = (getTypeDogma(typeID) || {}).attributes || {};
  const groups = [];
  for (const attributeID of CHARGE_GROUP_ATTRIBUTES) {
    const groupID = Number(attributes[String(attributeID)]);
    if (Number.isFinite(groupID) && groupID > 0 && !groups.includes(groupID)) {
      groups.push(groupID);
    }
  }
  const size = Number(attributes[String(CHARGE_SIZE_ATTRIBUTE)]);
  return {
    size: Number.isFinite(size) && size > 0 ? size : null,
    groups,
  };
}

/** A CHARGE's own size (dogma 128), or null when the type has none. */
function getChargeSize(typeID) {
  const size = Number(
    ((getTypeDogma(typeID) || {}).attributes || {})[String(CHARGE_SIZE_ATTRIBUTE)],
  );
  return Number.isFinite(size) && size > 0 ? size : null;
}

function getTypeDogmaAttribute(typeID, attributeID, fallback = null) {
  const dogma = getTypeDogma(typeID);
  const attributes = dogma && dogma.attributes;
  if (!attributes || typeof attributes !== "object") {
    return fallback;
  }
  const numericAttributeID = Number(attributeID) || 0;
  if (Object.prototype.hasOwnProperty.call(attributes, String(numericAttributeID))) {
    return attributes[String(numericAttributeID)];
  }
  if (Object.prototype.hasOwnProperty.call(attributes, numericAttributeID)) {
    return attributes[numericAttributeID];
  }
  return fallback;
}

function getStation(stationID) {
  return buildIndex("stations", "stations", "stationID").get(Number(stationID) || 0) || null;
}

function getStationName(stationID) {
  const entry = getStation(stationID);
  return entry ? String(entry.stationName || `Station ${stationID}`) : `Station ${stationID}`;
}

function getStationShortName(stationID) {
  const numericStationID = Number(stationID) || 0;
  if (numericStationID === 60003760) {
    return "Jita 4-4";
  }
  return getStationName(numericStationID);
}

function getSolarSystem(solarSystemID) {
  return buildIndex("solarSystems", "solarSystems", "solarSystemID").get(Number(solarSystemID) || 0) || null;
}

function getSolarSystemName(solarSystemID) {
  const entry = getSolarSystem(solarSystemID);
  return entry ? String(entry.solarSystemName || `System ${solarSystemID}`) : `System ${solarSystemID}`;
}

// --- Planet celestials (goal R41) ------------------------------------------
// A colony record names its planet by ID only. The player-facing name of a
// planet is not stored anywhere as a string — in EVE it is DERIVED, and it is
// derived the same way everywhere: the solar system's name followed by the
// planet's position in that system as a Roman numeral ("Tanoo I"). The SDE's
// mapPlanets carries exactly the two facts that needs, `solarSystemID` and
// `celestialIndex`, so we build the name rather than inventing a table.
//
// This is a NAME, not a mechanic: nothing about extraction, cycles or yields is
// computed here. It exists so the Planets panel can obey R7d and show a place
// instead of a number.

function getPlanetCelestial(planetID) {
  return buildJsonlIndex("mapPlanets.jsonl", "_key").get(Number(planetID) || 0) || null;
}

const ROMAN_NUMERALS = Object.freeze([
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
]);

function toRomanNumeral(value) {
  let remaining = Number(value) || 0;
  if (remaining <= 0 || !Number.isFinite(remaining)) {
    return "";
  }
  let out = "";
  for (const [amount, numeral] of ROMAN_NUMERALS) {
    while (remaining >= amount) {
      out += numeral;
      remaining -= amount;
    }
  }
  return out;
}

/**
 * "Tanoo I", or null when this planet is not in the static map.
 *
 * Null — never a stringified ID — because a planet we cannot name is a fact the
 * caller has to decide about, and "Planet 40000002" on screen would break R7d
 * more quietly than an absent name does.
 */
function getPlanetName(planetID) {
  const celestial = getPlanetCelestial(planetID);
  if (!celestial) {
    return null;
  }
  const systemID = Number(celestial.solarSystemID) || 0;
  const system = systemID ? getSolarSystem(systemID) : null;
  if (!system) {
    return null;
  }
  const numeral = toRomanNumeral(celestial.celestialIndex);
  const systemName = getSolarSystemName(systemID);
  return numeral ? `${systemName} ${numeral}` : systemName;
}

// --- System-adjacency graph (goal R5b) -------------------------------------
// The browser autopilot's route solver is client-side (retail solves routes
// locally from its static map DB; there is no wire call to the game server for
// a route — roadmap §7 / G2). We serve the adjacency it needs as read-only
// static reference data, exactly as station names stay client-local.
//
// The gameStore `stargates` table is the source: each record is one DIRECTED
// edge with the gate IDs the R5a jump call wants — itemID is the source gate in
// `solarSystemID` (the autopilot warps to it and jumps through it), and
// destinationID is the gate on the far side in `destinationSolarSystemID` (the
// `toGate` of beyonce.CmdStargateJump). This mirrors what autopilot.py reads
// from `cfg.mapSolarSystemContentCache[sys].stargates` (`sg.destination`).

function getStargates() {
  const cacheKey = "stargates:list";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const table = readStaticTable("stargates");
  const list = Array.isArray(table.stargates) ? table.stargates : [];
  caches.set(cacheKey, list);
  return list;
}

/**
 * The compact system-adjacency graph the browser route solver consumes:
 * `edges` is a flat array of `[fromSystemID, toSystemID, fromGateID, toGateID]`
 * tuples (one per stargate), `systems` maps each gate-connected system ID to
 * its name (for the travel-panel readout only). Cached after the first build.
 */
function getSolarSystemGraph() {
  const cacheKey = "map:solarSystemGraph";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const edges = [];
  const systemIDs = new Set();
  for (const gate of getStargates()) {
    const fromSystemID = Number(gate && gate.solarSystemID) || 0;
    const toSystemID = Number(gate && gate.destinationSolarSystemID) || 0;
    const fromGateID = Number(gate && gate.itemID) || 0;
    const toGateID = Number(gate && gate.destinationID) || 0;
    if (fromSystemID <= 0 || toSystemID <= 0 || fromGateID <= 0) {
      continue;
    }
    edges.push([fromSystemID, toSystemID, fromGateID, toGateID]);
    systemIDs.add(fromSystemID);
    systemIDs.add(toSystemID);
  }
  const systems = {};
  for (const systemID of systemIDs) {
    systems[systemID] = getSolarSystemName(systemID);
  }
  const graph = { systems, edges };
  caches.set(cacheKey, graph);
  return graph;
}

// --- Agent reference data (goal R6a) ---------------------------------------
// The per-station agentMgr.GetAgents roster is unreliable for *finding* an
// agent to travel to (it returns 0 for a character re-selected directly into a
// docked station, and only lists the current station). So the Agent Finder
// lists agents from the static agentAuthority reference table, exactly the way
// the solar-system graph is served: read-only static reference data, NOT a
// gateway call and NOT gameplay SQLite. `ownerName` is the agent's name;
// station/system names resolve through getStationName / getSolarSystemName.

const AGENT_FIND_DEFAULT_LIMIT = 500;
const AGENT_FIND_MAX_LIMIT = 5000;

// A "real" mission agent of an exposed kind is the STANDARD agent of that kind's
// retail division — NOT a Paragon / career / storyline / epic / event placeholder
// that happens to share the same `missionKind` string. The static export's
// `missionKind` is right for ordinary agents but is ALSO stamped on special
// agents (e.g. "IRIS - Jita" agentID 3020034 is a Paragon agent — division 37,
// agentType 13 — yet carries missionKind "courier"), so filtering on the raw
// `missionKind` mislabels them. The finder instead classifies by
// (divisionID, agentTypeID), the retail agent-division scheme:
//   courier   → Distribution division 22, basic agent type 2  (real couriers)
//   encounter → Security division 24, basic agent type 2
//   mining    → Mining division 23, basic agent type 2
//   research  → R&D division 18, research agent type 4
// Verified against agentAuthority/data.json (10,941 agents): of 4,421
// missionKind:"courier" rows, exactly the 3,725 div-22/type-2 rows are ordinary
// distribution agents; the other 696 are career types 5/6/7/8, storyline 10,
// event 11, research-type 3 (all still division 22), plus off-division epic
// (division 25, type 12) and Paragon (division 37, type 13) — none of which are
// ordinary courier agents. Every export row is a placeholder with empty
// missionTemplateIDs (the runnable mission content lives in the mission
// runtime), so the finder can only filter to the right KIND, not the content.
const AGENT_KIND_CLASSIFICATION = Object.freeze({
  courier: Object.freeze({ divisionID: 22, agentTypeID: 2 }),
  encounter: Object.freeze({ divisionID: 24, agentTypeID: 2 }),
  mining: Object.freeze({ divisionID: 23, agentTypeID: 2 }),
  research: Object.freeze({ divisionID: 18, agentTypeID: 4 }),
});
const AGENT_STANDARD_CLASSIFICATIONS = Object.freeze(
  Object.values(AGENT_KIND_CLASSIFICATION),
);

/** True when the agent is the standard mission agent matching one classification. */
function matchesClassification(agent, spec) {
  return (
    (Number(agent && agent.divisionID) || 0) === spec.divisionID &&
    (Number(agent && agent.agentTypeID) || 0) === spec.agentTypeID
  );
}

/** True when the agent is a real mission agent of ANY exposed kind (for "all"). */
function isStandardMissionAgent(agent) {
  return AGENT_STANDARD_CLASSIFICATIONS.some((spec) => matchesClassification(agent, spec));
}

function getAgentsByID() {
  const cacheKey = "agentAuthority:agentsByID";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const table = readStaticTable("agentAuthority");
  const bucket = (table && table.agentsByID) || {};
  const index = new Map();
  for (const [key, agent] of Object.entries(bucket)) {
    const id = Number(agent && agent.agentID) || Number(key) || 0;
    if (id > 0) {
      index.set(id, agent);
    }
  }
  caches.set(cacheKey, index);
  return index;
}

/**
 * The compact agent summary the finder consumes: the agent's identity plus its
 * station/system with names resolved for display. IDs stay numeric (all fit in
 * 2^53). Distance-from-current-system is computed client-side (a single BFS
 * over the map graph — goal R6a), so no distance is baked in here.
 */
function toAgentSummary(agent) {
  const stationID = Number(agent && agent.stationID) || null;
  const solarSystemID = Number(agent && agent.solarSystemID) || null;
  const agentID = Number(agent && agent.agentID) || 0;
  return {
    agentID,
    name: String((agent && agent.ownerName) || `Agent ${agentID}`),
    level: Number(agent && agent.level) || null,
    // The retail classification the finder filters on (division + agent type),
    // carried through so the wire shape is transparent/testable.
    divisionID: Number(agent && agent.divisionID) || null,
    agentTypeID: Number(agent && agent.agentTypeID) || null,
    missionKind: agent && agent.missionKind ? String(agent.missionKind) : null,
    missionTypeLabel: agent && agent.missionTypeLabel ? String(agent.missionTypeLabel) : null,
    corporationID: Number(agent && agent.corporationID) || null,
    factionID: Number(agent && agent.factionID) || null,
    stationID,
    stationName: stationID ? getStationName(stationID) : null,
    solarSystemID,
    solarSystemName: solarSystemID ? getSolarSystemName(solarSystemID) : null,
  };
}

/**
 * Find agents from the static agentAuthority table, filtered server-side and
 * capped so the ~11k-agent dataset never crosses the wire whole (goal R6a/R6b).
 * `kind` defaults to "courier" (the milestone); "all"/"any"/"" disables the
 * kind filter and returns real mission agents of any exposed kind. Agents are
 * classified by (divisionID, agentTypeID) — NOT the raw `missionKind` — so
 * Paragon / career / storyline / epic / event placeholders are never listed
 * under an ordinary kind (goal R6b, see AGENT_KIND_CLASSIFICATION). A `kind`
 * the finder does not classify returns no matches rather than mislabel. `level`
 * (1..5) is optional. The pre-cap match set is sorted deterministically by
 * (level, agentID) so the cap is stable/reproducible; the client sorts the
 * returned rows by jumps from the current system. Returns
 * `{ agents, total, capped, kind, level, limit }` where `total` is the full
 * match count before the cap.
 */
function findAgents(filters = {}) {
  const rawKind = filters.kind === undefined || filters.kind === null ? "courier" : String(filters.kind).trim().toLowerCase();
  const kind = rawKind === "all" || rawKind === "any" || rawKind === "" ? null : rawKind;
  const level = Number(filters.level) || null;
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), AGENT_FIND_MAX_LIMIT)
    : AGENT_FIND_DEFAULT_LIMIT;

  // Resolve the kind to its (division, agentType) predicate. "all" (kind===null)
  // spans every real mission agent; a requested-but-unclassified kind matches
  // nothing (better an empty finder than a mislabeled special agent).
  const spec = kind === null ? null : (AGENT_KIND_CLASSIFICATION[kind] || undefined);
  const isKindMatch = kind === null
    ? isStandardMissionAgent
    : (spec === undefined ? null : (agent) => matchesClassification(agent, spec));
  if (isKindMatch === null) {
    return { agents: [], total: 0, capped: false, kind, level, limit };
  }

  const matches = [];
  for (const agent of getAgentsByID().values()) {
    if (!isKindMatch(agent)) {
      continue;
    }
    if (level !== null && (Number(agent.level) || null) !== level) {
      continue;
    }
    matches.push(agent);
  }
  matches.sort((a, b) => {
    const levelDelta = (Number(a.level) || 0) - (Number(b.level) || 0);
    if (levelDelta !== 0) {
      return levelDelta;
    }
    return (Number(a.agentID) || 0) - (Number(b.agentID) || 0);
  });

  const total = matches.length;
  const capped = total > limit;
  const agents = (capped ? matches.slice(0, limit) : matches).map(toAgentSummary);
  return { agents, total, capped, kind: kind, level, limit };
}

// --- Map location name search (goal R7a) -----------------------------------
// So a player can set a travel destination by NAME (not a raw EVE ID), the
// Travel tab searches the static solar-system + station tables by name. This is
// read-only static reference data exactly like getSolarSystemGraph / findAgents
// — NOT a gateway/bridge call. The client then reuses startRoute(id) (the R5b
// route solver + autopilot) on a chosen match. Matches carry the solar system
// so the client can annotate jumps-away from the current system.

const MAP_FIND_DEFAULT_LIMIT = 50;
const MAP_FIND_MAX_LIMIT = 200;
const MAP_FIND_MIN_QUERY = 2;

// Match quality: an exact name beats a prefix beats a substring (-1 = no match).
// So a search for "Jita" surfaces the Jita SYSTEM before "Jita IV - ..." stations.
function scoreNameMatch(lowerName, needle) {
  if (lowerName === needle) {
    return 0;
  }
  if (lowerName.startsWith(needle)) {
    return 1;
  }
  return lowerName.includes(needle) ? 2 : -1;
}

/**
 * Search the static solar-system and station tables by name (goal R7a). `q` is
 * the (trimmed, case-insensitive) query; `kind` optionally narrows to just
 * "system" or "station" (default: both). Results are ranked by match quality
 * (exact → prefix → substring), then shorter name, then alphabetically, and
 * capped (default 50 / max 200) so a broad query stays responsive. A query
 * shorter than MAP_FIND_MIN_QUERY returns nothing (no whole-table dump). Each
 * match is `{ id, name, kind, solarSystemID, solarSystemName }` — `id` is the
 * station or system ID the client hands to startRoute. Returns
 * `{ matches, total, capped, q, kind, limit }` (`total` = full match count
 * before the cap).
 */
function findMapLocations(filters = {}) {
  const q = filters.q === undefined || filters.q === null ? "" : String(filters.q).trim();
  const rawKind = filters.kind === undefined || filters.kind === null ? "" : String(filters.kind).trim().toLowerCase();
  const kind = rawKind === "system" || rawKind === "station" ? rawKind : null;
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MAP_FIND_MAX_LIMIT)
    : MAP_FIND_DEFAULT_LIMIT;
  if (q.length < MAP_FIND_MIN_QUERY) {
    return { matches: [], total: 0, capped: false, q, kind, limit };
  }

  const needle = q.toLowerCase();
  const scored = [];
  if (kind === null || kind === "system") {
    for (const system of buildIndex("solarSystems", "solarSystems", "solarSystemID").values()) {
      const name = String((system && system.solarSystemName) || "");
      const score = scoreNameMatch(name.toLowerCase(), needle);
      if (score < 0) {
        continue;
      }
      const id = Number(system && system.solarSystemID) || 0;
      scored.push({ score, name, entry: { id, name, kind: "system", solarSystemID: id, solarSystemName: name } });
    }
  }
  if (kind === null || kind === "station") {
    for (const station of buildIndex("stations", "stations", "stationID").values()) {
      const name = String((station && station.stationName) || "");
      const score = scoreNameMatch(name.toLowerCase(), needle);
      if (score < 0) {
        continue;
      }
      const id = Number(station && station.stationID) || 0;
      const solarSystemID = Number(station && station.solarSystemID) || null;
      const solarSystemName = solarSystemID
        ? getSolarSystemName(solarSystemID)
        : (station && station.solarSystemName ? String(station.solarSystemName) : null);
      scored.push({ score, name, entry: { id, name, kind: "station", solarSystemID, solarSystemName } });
    }
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name) ||
    a.entry.id - b.entry.id);

  const total = scored.length;
  const capped = total > limit;
  const matches = (capped ? scored.slice(0, limit) : scored).map((s) => s.entry);
  return { matches, total, capped, q, kind, limit };
}

// --- Tradable-item name search (goal R16) -----------------------------------
// The market panel needs the player to pick an ITEM by name — the browser never
// knows a typeID, and typing one would violate R7d anyway. This is the type-table
// twin of findMapLocations: read-only static reference data, ranked the same way
// (exact -> prefix -> substring), NOT a gateway/bridge call.
//
// ⚠ ONLY THINGS THAT CAN ACTUALLY BE TRADED. A type is offered only when it is
// `published` AND carries a `marketGroupID`. Unpublished and non-market types
// exist in the table in quantity (test objects, effect beacons, internal
// placeholders); offering them would let a player build an order for something
// no market will ever list, and the refusal would arrive from the server with
// no useful explanation.

const MARKET_FIND_DEFAULT_LIMIT = 25;
const MARKET_FIND_MAX_LIMIT = 100;
const MARKET_FIND_MIN_QUERY = 2;

function findMarketTypes(filters = {}) {
  const q = filters.q === undefined || filters.q === null ? "" : String(filters.q).trim();
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MARKET_FIND_MAX_LIMIT)
    : MARKET_FIND_DEFAULT_LIMIT;
  if (q.length < MARKET_FIND_MIN_QUERY) {
    return { matches: [], total: 0, capped: false, q, limit };
  }

  const needle = q.toLowerCase();
  const scored = [];
  for (const entry of buildIndex("itemTypes", "types", "typeID").values()) {
    if (!entry || entry.published !== true) {
      continue;
    }
    const marketGroupID = Number(entry.marketGroupID) || 0;
    if (marketGroupID <= 0) {
      continue;
    }
    const name = String(entry.name || "");
    const score = scoreNameMatch(name.toLowerCase(), needle);
    if (score < 0) {
      continue;
    }
    scored.push({
      score,
      name,
      entry: {
        typeID: Number(entry.typeID) || 0,
        name,
        groupName: String(entry.groupName || "Unknown"),
      },
    });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name) ||
    a.entry.typeID - b.entry.typeID);

  const total = scored.length;
  const capped = total > limit;
  const matches = (capped ? scored.slice(0, limit) : scored).map((s) => s.entry);
  return { matches, total, capped, q, limit };
}

// --- Ore families for the bot editor's ore picker ---------------------------
//
// Twin of findMarketTypes above: pure static reference data, no gateway call.
// A "family" is a type GROUP within the Asteroid category (25) — every grade
// of one ore (0-Grade, plain, II/III/IV-Grade) and its compressed variant sit
// in the SAME group (verified live: Veldspar's four grades all carry group 462,
// Scordite's carry 460), so the distinct group set already IS the family set;
// there is no separate family table to build.
//
// ⚠ PUBLISHED ONLY, like findMarketTypes: this feeds a picker, and an
// unpublished type (a test object, a removed ore) offered there would let a
// player build a bot around ore the server will never actually hand them.
const ASTEROID_CATEGORY_ID = 25;

function listOreFamilies() {
  const namesByGroupID = new Map();
  for (const entry of buildIndex("itemTypes", "types", "typeID").values()) {
    if (!entry || entry.published !== true) {
      continue;
    }
    if ((Number(entry.categoryID) || 0) !== ASTEROID_CATEGORY_ID) {
      continue;
    }
    const groupID = Number(entry.groupID) || 0;
    if (groupID <= 0 || namesByGroupID.has(groupID)) {
      continue;
    }
    namesByGroupID.set(groupID, getTypeGroupName(entry.typeID));
  }
  const families = Array.from(namesByGroupID, ([groupID, name]) => ({ groupID, name }));
  families.sort((a, b) => a.name.localeCompare(b.name) || a.groupID - b.groupID);
  return families;
}

// --- Browsing the market by group (goal R83) -------------------------------
//
// The market panel could only be reached by TYPING a name. That is fine when you
// know what you want and useless when you do not — "what ammunition fits this?"
// and "what is on sale here?" are the questions a market is for, and neither can
// be typed. The retail client answers both with a group TREE, and the data for
// one is already on disk: every marketGroups.jsonl row carries a parentGroupID
// and a hasTypes flag.
//
// Two reads: the children of a group (or the roots), and the types inside a
// group. Both are pure static reference data, like findMarketTypes above — no
// gateway call, so they work before the market daemon has answered anything.

const MARKET_GROUP_TYPES_MAX = 500;

/** parentGroupID -> child rows, built once. Roots are keyed under 0. */
function getMarketGroupChildIndex() {
  const cacheKey = "marketGroupChildren";
  if (caches.has(cacheKey)) {
    return caches.get(cacheKey);
  }
  const index = new Map();
  for (const entry of buildJsonlIndex("marketGroups.jsonl").values()) {
    const id = Number(entry && entry._key) || 0;
    if (id <= 0) {
      continue;
    }
    const parentID = Number(entry.parentGroupID || 0) || 0;
    if (!index.has(parentID)) {
      index.set(parentID, []);
    }
    index.get(parentID).push({
      marketGroupID: id,
      name: getLocalizedName(entry, `Market Group ${id}`),
      // Whether it holds items directly. A group can have BOTH children and
      // types, so this is not "is a leaf" — the panel needs to know it can show
      // items here as well as descend.
      hasTypes: entry.hasTypes === true,
    });
  }
  for (const children of index.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name) || a.marketGroupID - b.marketGroupID);
  }
  caches.set(cacheKey, index);
  return index;
}

/**
 * The children of a market group, or the ROOTS when `parentGroupID` is absent
 * or zero. Always an array — an unknown group has no children rather than
 * being an error, which is what lets the panel treat "empty" as a real answer.
 */
function getMarketGroupChildren(parentGroupID) {
  const parentID = Number(parentGroupID) || 0;
  return getMarketGroupChildIndex().get(parentID) || [];
}

/**
 * The published, tradable types sitting directly in one market group.
 *
 * ⚠ SAME PUBLISHED/MARKET FILTER AS `findMarketTypes`. A type that is not
 * published, or has no market group, cannot be traded — offering one would put
 * an item in front of a player that the market will always refuse.
 */
function getMarketGroupTypes(marketGroupID) {
  const groupID = Number(marketGroupID) || 0;
  if (groupID <= 0) {
    return { types: [], total: 0, capped: false };
  }
  const matches = [];
  for (const entry of buildIndex("itemTypes", "types", "typeID").values()) {
    if (!entry || entry.published !== true) {
      continue;
    }
    if ((Number(entry.marketGroupID) || 0) !== groupID) {
      continue;
    }
    matches.push({
      typeID: Number(entry.typeID) || 0,
      name: String(entry.name || ""),
      groupName: String(entry.groupName || "Unknown"),
    });
  }
  matches.sort((a, b) => a.name.localeCompare(b.name) || a.typeID - b.typeID);
  const total = matches.length;
  const capped = total > MARKET_GROUP_TYPES_MAX;
  return {
    types: capped ? matches.slice(0, MARKET_GROUP_TYPES_MAX) : matches,
    total,
    capped,
  };
}

// --- Batch name resolution (goal R7c) --------------------------------------
// The names-everywhere UI pass turns raw IDs into names across every tab. So an
// inventory list of many typeIDs (or a guest list of corp IDs) resolves in ONE
// round-trip, the BFF exposes a batch resolver over the existing static
// getters. This is read-only static reference data (like findMapLocations /
// findAgents), NOT a gateway/bridge call. Each requested `{kind, id}` resolves
// to a name STRING, or null for a definitive "unknown" (an NPC/type not in the
// static tables) — the client caches null too so it never refetches, and shows
// the raw ID as its own fallback.

const NAMES_MAX_ITEMS = 500;

// The `owner` kind resolves an ownership/standing ID whose entity type is not
// known at the call site (a station owner, or a standings `fromID`, is a corp,
// faction, character, or alliance). It tries each in turn and returns the first
// that resolves, so one request covers all four.
function resolveOwnerName(id) {
  if (getCorporation(id)) {
    return getCorporationName(id);
  }
  if (getFaction(id)) {
    return getFactionName(id);
  }
  if (getCharacter(id)) {
    return getCharacterName(id);
  }
  if (getAlliance(id)) {
    return getAllianceName(id);
  }
  return null;
}

/**
 * Resolve one `{kind, id}` to a display name string, or null when the entity is
 * genuinely not in the static tables (a definitive "unknown" the caller caches
 * without refetching). The name getters that echo an ID fallback (getTypeName,
 * getStationName, ...) are guarded by their entry getter so an unknown returns
 * null rather than "Type 99999999".
 */
function resolveOneName(kind, id) {
  const numericID = Number(id) || 0;
  if (numericID <= 0) {
    return null;
  }
  switch (String(kind)) {
    case "type":
      return getType(numericID) ? getTypeName(numericID) : null;
    case "typeGroup":
      return getType(numericID) ? getTypeGroupName(numericID) : null;
    case "typeCategory":
      return getType(numericID) ? getTypeCategoryName(numericID) : null;
    case "category":
      return getCategory(numericID) ? getCategoryName(numericID) : null;
    case "corporation":
      return getCorporation(numericID) ? getCorporationName(numericID) : null;
    case "alliance":
      return getAlliance(numericID) ? getAllianceName(numericID) : null;
    case "faction":
      return getFaction(numericID) ? getFactionName(numericID) : null;
    case "character":
      return getCharacterName(numericID);
    case "agent":
      return getAgentName(numericID);
    case "station":
      return getStation(numericID) ? getStationName(numericID) : null;
    case "system":
      return getSolarSystem(numericID) ? getSolarSystemName(numericID) : null;
    case "region":
      return getRegion(numericID) ? getRegionName(numericID) : null;
    case "owner":
      return resolveOwnerName(numericID);
    default:
      return null;
  }
}

/**
 * Batch-resolve `{ items: [{kind, id}, ...] }` to `{ names: { "kind:id": name },
 * capped, limit }`. Every requested item is echoed into `names` (a resolved
 * string, or null for a definitive unknown) so the client can cache the outcome
 * for every key. Duplicate `(kind,id)` pairs resolve once. Capped at
 * NAMES_MAX_ITEMS so an oversized request never scans the whole item table.
 */
function resolveNames(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const capped = items.length > NAMES_MAX_ITEMS;
  const slice = capped ? items.slice(0, NAMES_MAX_ITEMS) : items;
  const names = {};
  for (const item of slice) {
    const kind = item && item.kind !== undefined && item.kind !== null ? String(item.kind) : "";
    const id = Number(item && item.id) || 0;
    if (!kind || id <= 0) {
      continue;
    }
    const key = `${kind}:${id}`;
    if (Object.prototype.hasOwnProperty.call(names, key)) {
      continue;
    }
    names[key] = resolveOneName(kind, id);
  }
  return { names, capped, limit: NAMES_MAX_ITEMS };
}

// R17 mail: finding a person to write to, BY NAME.
//
// The whole names-everywhere rule (R7d) runs the other way — ID to name — but
// composing a message needs the reverse: the player types a name and the panel
// needs the characterID SendMail's args[0] wants. Asking the player for a
// numeric ID would be exactly the thing R7d forbids, so this searches the same
// read-only characters table getCharacterName reads and hands back the id
// without ever showing it.
const CHARACTER_FIND_DEFAULT_LIMIT = 25;
const CHARACTER_FIND_MAX_LIMIT = 100;
const CHARACTER_FIND_MIN_QUERY = 2;

function findCharacters(filters = {}) {
  const q = filters.q === undefined || filters.q === null ? "" : String(filters.q).trim();
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), CHARACTER_FIND_MAX_LIMIT)
    : CHARACTER_FIND_DEFAULT_LIMIT;
  if (q.length < CHARACTER_FIND_MIN_QUERY) {
    return { matches: [], total: 0, capped: false, q, limit };
  }

  // The caller's own character is excluded: mailing yourself is not something
  // the panel should offer, and the server treats a self-addressed message as a
  // sender copy with no recipient.
  const excludeID = Number(filters.excludeCharacterID) || 0;
  const needle = q.toLowerCase();
  const scored = [];
  for (const [characterID, entry] of getCharactersByID().entries()) {
    if (!entry || characterID === excludeID) {
      continue;
    }
    const name = String(entry.characterName || entry.name || "");
    if (!name) {
      continue;
    }
    const score = scoreNameMatch(name.toLowerCase(), needle);
    if (score < 0) {
      continue;
    }
    scored.push({ score, name, entry: { characterID, name } });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name) ||
    a.entry.characterID - b.entry.characterID);

  const total = scored.length;
  const capped = total > limit;
  const matches = (capped ? scored.slice(0, limit) : scored).map((s) => s.entry);
  return { matches, total, capped, q, limit };
}

function getIndustryBlueprint(blueprintTypeID) {
  return buildIndex(
    "industryBlueprints",
    "blueprintDefinitions",
    "blueprintTypeID",
  ).get(Number(blueprintTypeID) || 0) || null;
}

function getNpcIndustryFacility(facilityID) {
  return buildIndex(
    "industryFacilities",
    "npcFacilityProfiles",
    "facilityID",
  ).get(Number(facilityID) || 0) || null;
}

module.exports = {
  findAgents,
  findCharacters,
  findMapLocations,
  getAgentName,
  getAgentsByID,
  getAlliance,
  getAllianceName,
  getCategory,
  getCategoryName,
  getCharacter,
  getCharacterName,
  getCorporation,
  getCorporationName,
  getFaction,
  getFactionName,
  getIndustryBlueprint,
  resolveNames,
  getMarketGroup,
  getMarketGroupName,
  getMarketGroupPath,
  getPropulsionEffectName,
  getModuleChargeFitment,
  getChargeSize,
  findMarketTypes,
  listOreFamilies,
  getMarketGroupChildren,
  getMarketGroupTypes,
  getNpcIndustryFacility,
  getPlanetCelestial,
  getPlanetName,
  getRegion,
  getRegionName,
  getSolarSystem,
  getSolarSystemGraph,
  getSolarSystemName,
  getStargates,
  getStation,
  getStationName,
  getStationShortName,
  getLocalTypeIconUrl,
  getRemoteTypeIconUrl,
  getSkillType,
  getType,
  getTypeCategoryID,
  getTypeCategoryName,
  getTypeDogma,
  getTypeDogmaAttribute,
  getTypeGroupName,
  getTypeIconCachePath,
  getTypeIconUrl,
  getTypeName,
  listAncestries,
  normalizeIconRequest,
};
