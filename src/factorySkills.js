"use strict";
// Direct purchase used a private runtime financial transaction. No stock web
// equivalent exists. Refuse before obtaining any temporary pilot or funding.
const { skillAcquisition } = require("./stockCompatibility");
function createFactorySkills() {
  return { review: async () => skillAcquisition(), acquire: async () => skillAcquisition() };
}
module.exports = { createFactorySkills };
