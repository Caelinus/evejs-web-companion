"use strict";
// Same authoritative inventory groups as EveJS miningInventory. No labels.
function miningResourceFamily(type) {
  if (!type) return null;
  if ([465, 903, 2022].includes(Number(type.groupID))) return "ice";
  if ([711, 4168].includes(Number(type.groupID))) return "gas";
  if (Number(type.categoryID) === 25 && ![519, 4094, 4714].includes(Number(type.groupID))) return "ore";
  return null;
}
module.exports = { miningResourceFamily };
