"use strict";

// Same gameStore reference tables consumed by EveJS typeListAuthority and
// reprocessingStaticData. This is static compatibility, never live availability.
function compressionCompatibility(types, typeListIDs, typeLists, recipes) {
  const knownRecipes = recipes && typeof recipes === "object" && !Array.isArray(recipes);
  const lists = Array.isArray(typeLists) ? new Map(typeLists.map(row => [row.listID, row])) : null;
  return types.map(type => {
    if (!type || !Number.isSafeInteger(type.typeID) || !Number.isSafeInteger(type.groupID) || !Number.isSafeInteger(type.categoryID))
      return { typeID: type?.typeID ?? null, compressedTypeID: null, matchingTypeListIDs: null, availability: "unknown" };
    const matching = [];
    for (const listID of typeListIDs) {
      const list = lists?.get(listID);
      const fields = ["includedTypeIDs", "includedGroupIDs", "includedCategoryIDs", "excludedTypeIDs", "excludedGroupIDs", "excludedCategoryIDs"];
      if (!list || fields.some(key => !Array.isArray(list[key]) || list[key].some(id => !Number.isSafeInteger(id) || id <= 0)))
        return { typeID: type.typeID, compressedTypeID: null, matchingTypeListIDs: null, availability: "unknown" };
      const includes = list.includedTypeIDs.includes(type.typeID) || list.includedGroupIDs.includes(type.groupID) || list.includedCategoryIDs.includes(type.categoryID);
      const excludes = list.excludedTypeIDs.includes(type.typeID) || list.excludedGroupIDs.includes(type.groupID) || list.excludedCategoryIDs.includes(type.categoryID);
      if (includes && !excludes) matching.push(listID);
    }
    const rawOutput = knownRecipes ? recipes[String(type.typeID)] : undefined;
    const compressedTypeID = Number.isSafeInteger(rawOutput) && rawOutput > 0 ? rawOutput : null;
    const known = knownRecipes && (rawOutput === undefined || compressedTypeID !== null);
    return { typeID: type.typeID, compressedTypeID, matchingTypeListIDs: known ? matching : null, availability: known ? "available" : "unknown" };
  });
}
module.exports = { compressionCompatibility };
