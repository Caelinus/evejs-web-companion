"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}

test("active WC acquisition has no private HTTP endpoint or Factory selector dependency", () => {
  const active = ["src","scripts","web/src"].flatMap(d=>files(path.join(root,d)))
    .filter(p=>/\.(?:js|ts|svelte)$/.test(p) && !/\.test\./.test(p));
  for (const p of active) {
    assert.doesNotMatch(fs.readFileSync(p,"utf8"), /selectFactoryCharacter|getProvisioningObservation|\/factory\/(?:session|quote|acquire)|\/provisioning-observation/, path.relative(root,p));
  }
  assert.equal(fs.existsSync(path.join(root,"runtime-patches")), false);
  for (const p of ["scripts/provisioning-runtime-patch.js","scripts/prepare-runtime-test-reference.js"])
    assert.equal(fs.existsSync(path.join(root,p)), false);
});

test("private structure service methods refuse before any gateway request", async t => {
  const original = global.fetch; let requests = 0;
  global.fetch = async()=>{ requests++; assert.fail("Unavailable authority must never dispatch"); };
  t.after(()=>{global.fetch=original;});
  const gateway = require("../src/eveGatewayClient");
  for (const [service,method] of [["structureDirectory","GetMyAccessibleStructureServices"],["officeManager","RentOffice"]])
    await assert.rejects(gateway.callMethod(service,method,[],null,{characterID:7},"held"), {code:"STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE",statusCode:409});
  assert.equal(requests,0);
  for (const key of ["selectFactoryCharacter","quoteFactorySkills","acquireFactorySkills","getProvisioningObservation"])
    assert.equal(gateway[key],undefined,key);
});

test("WC contract stays within clean stock allowlist while basic structure navigation stays available", {skip:!process.env.STOCK_EVEJS_ROOT}, () => {
  const previous = process.env.EVEJS_REPO;
  process.env.EVEJS_REPO = process.env.STOCK_EVEJS_ROOT;
  try {
    const {buildContract}=require("../scripts/build-bridge-contract");
    const generated=buildContract(), checked=require("../contracts/evejs-web-bridge-contract.json");
    assert.deepEqual(generated,checked);
    const pairs=new Set(checked.gatewayAllowlist.pairs);
    for (const p of ["structureDirectory.GetMyDockableStructures",
      "structureDirectory.CheckMyDockingAccessToStructures","corpFittingMgr.GetFittings","invbroker.GetInventory"])
      assert.ok(pairs.has(p),p);
    const stockGateway=fs.readFileSync(path.join(process.env.STOCK_EVEJS_ROOT,"server/src/_secondary/express/evejsWebGateway.js"),"utf8");
    assert.match(stockGateway,/\/session\/select/);
    assert.equal(pairs.has("structureDirectory.GetMyAccessibleStructureServices"),false);
    assert.equal(pairs.has("officeManager.RentOffice"),false);
    assert.equal(pairs.has("skillHandler.PurchaseSkills"),false);
  } finally { if(previous===undefined) delete process.env.EVEJS_REPO; else process.env.EVEJS_REPO=previous; }
});
