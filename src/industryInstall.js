"use strict";

// Invention with a decryptor: the materials an InstallJob request must carry.
//
// ---------------------------------------------------------------------------
// WHY THE BFF HAS TO SEND MATERIALS AT ALL. For every other install the
// request's `materials` is advisory and the BFF sends an empty map, which the
// server reads as "recompute from the blueprint" (industryRuntimeState.js,
// after Job._get_errors). A decryptor is the exception: the server takes it
// from the request's materials ONLY (resolveInventionDecryptorSelection: one
// decryptor, quantity equal to the runs), and once that map is non-empty it
// must match the server's own map EXACTLY (materialMapsMatchExactly) or the
// install is refused with MISMATCH_MATERIAL. So the map is built here the way
// the server builds it, which is the way the retail client builds it:
//
//     quantity = max(trunc(ceil(round(base x runs x facility, 2))), runs)
//
// per invention material (industryParityHelpers.js buildIndustryActivityMaterials
// and roundMaterialQuantity; no blueprint efficiency applies to invention),
// where `facility` is the product of the facility's material modifiers for
// invention that match the product (resolveFacilityActivityModifier), plus the
// decryptor at one per run.

const DECRYPTOR_GROUP_ID = 1304;
const INVENTION_ACTIVITY_ID = 8;
/** activities[activityID] is a tuple of modifier lists: time, material, cost, ... */
const MATERIAL_MODIFIER_INDEX = 1;

function entriesOf(value) {
  if (value && typeof value === "object" && value.type === "dict" && Array.isArray(value.entries)) {
    return value.entries;
  }
  if (value && typeof value === "object" && value.args) {
    return entriesOf(value.args);
  }
  return [];
}

function itemsOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value.items)) {
    return value.items;
  }
  return [];
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

/**
 * One facility's material modifiers for an activity, from a GetFacilities row
 * (a util.KeyVal whose `activities` is a dict of activityID to a tuple). Each
 * is [value, categoryID, groupID, typeID, reference]; null ids mean "any".
 */
function facilityMaterialModifiers(facilityRow, activityID) {
  const field = entriesOf(facilityRow).find(([key]) => key === "activities");
  const activity = entriesOf(field ? field[1] : null).find(([key]) => toInt(key) === activityID);
  const lists = itemsOf(activity ? activity[1] : null);
  return itemsOf(lists[MATERIAL_MODIFIER_INDEX]).filter(Array.isArray);
}

/** The facility row for `facilityID` in a GetFacilities answer, or null. */
function findFacilityRow(facilities, facilityID) {
  for (const row of itemsOf(facilities)) {
    const field = entriesOf(row).find(([key]) => key === "facilityID");
    if (field && toInt(field[1]) === facilityID) {
      return row;
    }
  }
  return null;
}

/** The server's modifierMatchesProduct: category, else group, else type. */
function modifierMatchesProduct(modifier, productType) {
  const categoryID = toInt(modifier[1]);
  const groupID = toInt(modifier[2]);
  const typeID = toInt(modifier[3]);
  if (categoryID <= 0 && groupID <= 0 && typeID <= 0) {
    return true;
  }
  if (!productType) {
    return false;
  }
  if (categoryID > 0) {
    return toInt(productType.categoryID) === categoryID;
  }
  if (groupID > 0) {
    return toInt(productType.groupID) === groupID;
  }
  return toInt(productType.typeID) === typeID;
}

/** The server's roundMaterialQuantity (two decimals, then up, at least one per run). */
function roundMaterialQuantity(quantity, runs) {
  return Math.max(Math.trunc(Math.ceil(Math.round(quantity * 100) / 100)), runs);
}

/**
 * The exact materials map for an invention install with a decryptor, keyed by
 * typeID. `invention` is the blueprint definition's invention activity
 * (static data), `modifiers` the facility's invention material modifiers, and
 * `productType` the invented blueprint's type record (for group and category).
 */
function inventionRequestMaterials({ invention, runs, modifiers, productType, decryptorTypeID }) {
  let facility = 1;
  for (const modifier of modifiers || []) {
    if (modifierMatchesProduct(modifier, productType)) {
      facility *= Math.max(0, Number(modifier[0]) || 0);
    }
  }
  const materials = {};
  for (const material of (invention && invention.materials) || []) {
    const typeID = toInt(material && material.typeID);
    const quantity = roundMaterialQuantity(Math.max(0, toInt(material && material.quantity)) * runs * facility, runs);
    if (typeID > 0 && quantity > 0) {
      materials[String(typeID)] = (materials[String(typeID)] || 0) + quantity;
    }
  }
  materials[String(decryptorTypeID)] = runs;
  return materials;
}

/** The single product an invention makes, as the server resolves it when none is asked for. */
function inventionProductTypeID(invention, requested) {
  const products = ((invention && invention.products) || []).filter((product) => toInt(product && product.typeID) > 0);
  if (requested > 0) {
    return products.some((product) => toInt(product.typeID) === requested) ? requested : 0;
  }
  return products.length === 1 ? toInt(products[0].typeID) : 0;
}

module.exports = {
  DECRYPTOR_GROUP_ID,
  INVENTION_ACTIVITY_ID,
  facilityMaterialModifiers,
  findFacilityRow,
  inventionProductTypeID,
  inventionRequestMaterials,
  modifierMatchesProduct,
  roundMaterialQuantity,
};
