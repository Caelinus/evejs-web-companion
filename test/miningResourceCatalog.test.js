"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-resource-catalog-"));
process.env.EVEJS_GAMESTORE_DATA_DIR = dir;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
for (const [table, value] of Object.entries({
  itemTypes: { types: [
    { typeID: 1, name: "Ore", published: true, categoryID: 25, groupID: 462 },
    { typeID: 2, name: "Ice", published: true, categoryID: 25, groupID: 465 },
    { typeID: 3, name: "Gas", published: true, categoryID: 25, groupID: 711 },
    { typeID: 4, name: "Not named compressed", published: true, categoryID: 25, groupID: 462 },
    { typeID: 5, name: "Hidden", published: false, categoryID: 25, groupID: 462 },
    { typeID: 6, name: "Arkonor impostor", published: true, categoryID: 6, groupID: 1 },
  ] }, reprocessingStatic: { sourceTypesByCompressedTypeID: { 4: [1] } },
})) { fs.mkdirSync(path.join(dir, table)); fs.writeFileSync(path.join(dir, table, "data.json"), JSON.stringify(value)); }
test("resource picker uses catalog categories and compression identity, never type-name inference", () => {
  assert.deepEqual(require("../src/staticData").listMiningResources().map(row => row.typeID).sort(), [1, 2]);
});
