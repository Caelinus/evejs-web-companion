import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { iceHoldFraction, iceMiningType, miningSiteFamily, siteIdentity, siteMiningFitRefusal } from "./miningSite.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { ensureSiteLogisticsBookmark } from "./siteLogisticsBookmark.ts";
import { freightHoldItemIDs } from "./miningBotLoop.ts";
import { preferredBays } from "../bridge/bayRouting.ts";
import type { MiningHold } from "../store/types.ts";
import type { ActiveBookmarks, BookmarkFolder, Bookmark } from "../bridge/bookmarks.ts";
import type { MiningOperationTarget } from "./scriptConditions.ts";
const require = createRequire(import.meta.url);
const { miningResourceFamily } = require("../../../src/miningResourceFamily.js");
const { buildStandardProfile } = require("../../../src/miningOperationProfiles.js");

test("site mining capability is rejected at start, before the standard program can undock", () => {
  for (const family of ["ORE_ANOMALY", "ICE"]) {
    for (const role of ["MINER", "HAULER"]) {
      const profile = buildStandardProfile({ area: { targetClasses: [family] }, unloadPolicy: "HAULER_SERVICE",
        unloadDestination: { stationID: 60003760, stationName: "Home", systemName: "Jita", corporationDivision: 1 } }, { role });
      const decoded = decodeScriptValue(profile.doc); assert.ok(decoded.ok);
      const refused = siteMiningFitRefusal(decoded.doc, [], []);
      assert.equal(refused !== null, role === "MINER");
      assert.equal(siteMiningFitRefusal(decoded.doc, [1], [2]), null);
    }
  }
});

test("scanner families and identity require authoritative fields, not names", () => {
  assert.equal(miningSiteFamily({ label: "Ice Haven", kind: "ore", archetypeID: 27 }), "ORE_ANOMALY");
  assert.equal(miningSiteFamily({ label: "Ordinary ore", kind: "ore", archetypeID: 28 }), "ICE");
  assert.equal(miningSiteFamily({ label: "Ice", kind: "ore" }), null);
  assert.equal(miningSiteFamily({ label: "Ice", kind: "gas", archetypeID: 28 }), null);
  assert.equal(siteIdentity({ label: "ABC", kind: "ore", siteID: 100, instanceID: 200 }), "site:100:instance:200");
  assert.equal(siteIdentity({ label: "ABC", kind: "ore" }), null);
});

test("Ice capability comes from mining amount and required skill dogma, never display names", () => {
  // Audited Ice Harvester I (16278): miningAmount 1000, requiredSkill1 16281.
  assert.equal(iceMiningType({ 77: 1000, 182: 16281 }), true);
  assert.equal(iceMiningType({ 77: 540, 182: 3386 }), false);
  assert.equal(iceMiningType({ 182: 16281 }), false, "an upgrade/rig is not an active harvester");
  assert.equal(iceMiningType(undefined), false);
  assert.equal(miningResourceFamily({ groupID: 465, categoryID: 25 }), "ice");
  assert.equal(miningResourceFamily({ groupID: 462, categoryID: 25 }), "ore");
  assert.equal(miningResourceFamily({ groupID: 711, categoryID: 25 }), "gas");
  assert.equal(miningResourceFamily({ groupID: 4094, categoryID: 25 }), null);
});

test("Ice freight uses ice/general mining holds; unrelated cargo remains aboard", () => {
  const holds: MiningHold[] = [{ key: "ice", label: "Ice", present: true, error: null,
    capacity: { capacity: 10000, used: 9000 } as MiningHold["capacity"],
    items: [{ itemID: 10, typeID: 16265, quantity: 9, groupID: 465, categoryID: 25 }] },
  { key: "ore", label: "Mining", present: true, error: null, capacity: { capacity: 10000, used: 0 } as MiningHold["capacity"], items: [] },
  { key: "cargo", label: "Cargo", present: true, error: null, capacity: null, items: [{ itemID: 20, typeID: 1, quantity: 5, categoryID: 8, groupID: 1 }] }];
  assert.equal(iceHoldFraction(holds), 0.9);
  assert.equal(iceHoldFraction(null), null);
  assert.deepEqual(freightHoldItemIDs(holds), [10]);
  assert.deepEqual(preferredBays({ groupID: 465, categoryID: 25 }), ["ice", "ore"]);
});

test("logistics return bookmark is scoped, coordinate-confirmed, reused, and fails closed", async () => {
  const target = { targetKey: "ICE:30000142:site:1:instance:2", targetName: "ICE-001", systemID: 30000142,
    position: { x: 1000, y: 0, z: 0 } } as MiningOperationTarget;
  let all: ActiveBookmarks = { folders: [{ folderID: 5, isPersonal: true, isActive: true } as BookmarkFolder], bookmarks: [], subfolders: [] };
  let writes = 0;
  const deps = { read: async () => all, create: async (ship: number, folder: number, name: string, note: string) => {
    writes++; assert.equal(ship, 9); assert.equal(folder, 5); assert.match(name, /MCC tail/);
    all = { ...all, bookmarks: [{ bookmarkID: 90, note, itemID: null, locationID: target.systemID, x: 1000, y: 0, z: 0 } as Bookmark] };
  } };
  assert.equal(await ensureSiteLogisticsBookmark(target, "a", 9, deps), 90);
  assert.equal(await ensureSiteLogisticsBookmark(target, "a", 9, deps), 90);
  assert.equal(writes, 1);
  await assert.rejects(ensureSiteLogisticsBookmark(target, "b", 9, { ...deps, create: async () => {} }), /UNCONFIRMED/);
  await assert.rejects(ensureSiteLogisticsBookmark(target, "b", 9, { ...deps, read: async () => ({ ...all, folders: [] }) }), /UNAVAILABLE/);
});
