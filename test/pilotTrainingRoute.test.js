"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/server");

const ACCOUNT = { username: "BMiner4", accountID: 4, role: "0", banned: false };
const CHARACTER_ID = 90000001;
const requests = [];
const CORP = 98000001;
const fit = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
  ["fittingID", 7], ["ownerID", CORP], ["shipTypeID", 32880], ["name", "Start Venture"],
  ["savedDate", { type: "long", value: "134285151537020000" }],
  ["fitData", { type: "list", items: [{ type: "tuple", items: [483, 27, 2] }] }],
] } };
const corpLibrary = { type: "object", name: { type: "rawstr", value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
  args: [{}, { type: "substream", value: { type: "dict", entries: [[7, fit]] } }] };

function app({ structurePilot = false, gatewayCall = null } = {}) {
  const equipment = new Set([32880, 89240, 17480, 22542, 578, 444, 439, 483,
    2464, 10246, 2046, 31370, 31752, 3829, 17482, 31790, 31754, 15508]);
  return createApp({
    webAuth: {
      createSessionToken: () => "test-token",
      verifySessionToken: (token) => token === "test-token"
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "test-session" }
        : null,
    },
    eveStore: {
      async getAccount(name) { return name === ACCOUNT.username ? ACCOUNT : null; },
      async createAccount() { throw new Error("Factory must never create an account"); },
      async getCharacterForAccount(accountID, characterID) {
        if (structurePilot && accountID === ACCOUNT.accountID && characterID === CHARACTER_ID)
          return { characterID, corporationID: CORP };
        throw new Error("Factory must never request a broad snapshot");
      },
      async listCharactersForAccount() { return [{ accountID: ACCOUNT.accountID, characterID: CHARACTER_ID, characterName: "Test Miner", corporationID: CORP, corporationName: "Mining Corp" }]; },
    },
    eveGatewayClient: {
      async getSkills(accountID, id) {
        requests.push(["getSkills", accountID, id]);
        return { characterName: "Test Miner", serverNowMs: 1_800_000_000_000,
          skills: [], queue: { active: false, entries: [] } };
      },
      async callMethod(service, method, args, kwargs, session, bridgeSessionID) {
        requests.push(["callMethod", service, method, args, session.corpid, bridgeSessionID]);
        if (gatewayCall) return gatewayCall(service, method, args, session, bridgeSessionID);
        return { result: corpLibrary };
      },
      async saveSkillQueue() { throw new Error("A qualification read must not save a queue."); },
    },
    staticData: {
      getType: (id) => equipment.has(id) || id > 0 ? { typeID: id, categoryID: [32880,89240,17480].includes(id) ? 6 : 7 } : null,
      getStation: (id) => id === 60010825 ? { stationName:"Test home", solarSystemID:30004504 } : null,
      getSolarSystemName: (id) => id === 30001401 ? "Nonni" : null,
      findMapLocations: () => ({ matches: [], capped: false }),
      getSkillType: (id) => ({ typeID: id, name: `Skill ${id}` }),
      getTypeDogma: (id) => ({ attributes: [32880, 89240, 17480].includes(id) ? { 182: 3386, 277: 3 } : {} }),
    },
    errorLogger() {},
  });
}

test("training routes read only account-owned pilots without selecting a gameplay session", async (t) => {
  const server = app().listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer test-token" };
  const roster = await fetch(`${base}/api/pilot-training/characters`, { headers });
  assert.equal(roster.status, 200);
  assert.deepEqual((await roster.json()).characters, [{ characterID: CHARACTER_ID, name: "Test Miner", corporationID: CORP, corporationName: "Mining Corp" }]);
  const own = await fetch(`${base}/api/pilot-training/miner?characterID=${CHARACTER_ID}`, { headers });
  assert.equal(own.status, 200);
  const payload = await own.json();
  assert.equal(payload.report.role, "MINER");
  assert.equal(payload.report.stages[0].skillQualification, "UNKNOWN");
  assert.equal(payload.report.stages[0].fitting.status, "UNCONFIGURED");
  assert.equal(payload.fittings[0].name, "Start Venture");
  assert.equal(payload.corporationID, CORP);
  assert.deepEqual(requests[0], ["callMethod", "corpFittingMgr", "GetFittings", [], CORP, undefined]);
  assert.deepEqual(requests[1], ["getSkills", ACCOUNT.accountID, CHARACTER_ID]);
  const selections = { VENTURE: { scope: "CORPORATION", ownerID: CORP, fittingID: 7,
    acceptedSavedDate: payload.fittings[0].savedDate, acceptedFingerprint: payload.fittings[0].fingerprint } };
  const qualified = await fetch(`${base}/api/pilot-training/miner?characterID=${CHARACTER_ID}&selections=${encodeURIComponent(JSON.stringify(selections))}`, { headers });
  const accepted = await qualified.json();
  assert.equal(accepted.report.stages[0].fitting.status, "READY");
  assert.equal(accepted.report.stages[0].skillQualification, "NOT_READY");
  assert.equal(accepted.report.stages[0].hard.find((row) => row.typeID === 3386).level, 3);
  const other = await fetch(`${base}/api/pilot-training/miner?characterID=90000009`, { headers });
  assert.equal(other.status, 404);
  assert.equal(requests.length, 4);
  const unauthenticated = await fetch(`${base}/api/pilot-training/miner?characterID=${CHARACTER_ID}`);
  assert.equal(unauthenticated.status, 401);
});

test("standalone Training Home uses account-owned structure access without selecting a pilot", async (t) => {
  const structureID = 1030000000001;
  let access = true;
  const calls = [];
  const instance = app({ structurePilot: true, gatewayCall(service, method, args, session, bridgeSessionID) {
    calls.push({ service, method, args, session, bridgeSessionID });
    if (method === "GetMyDockableStructures" || method === "CheckMyDockingAccessToStructures")
      return { result: { type: "list", items: access ? [structureID] : [] } };
    if (method === "GetStructureInfo") return { result: { type: "object", name: "util.KeyVal", args: {
      type: "dict", entries: [["itemName", "QA Astrahus"], ["solarSystemID", 30001401], ["typeID", 35832]],
    } } };
    throw new Error(`Unexpected structure read: ${method}`);
  } });
  const server = instance.listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer test-token" };
  const found = await fetch(`${base}/api/pilot-training/homes?q=Astrahus&characterID=${CHARACTER_ID}`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual((await found.json()).matches, [{ id: structureID, kind: "structure", name: "QA Astrahus",
    solarSystemID: 30001401, solarSystemName: "Nonni" }]);
  const home = await fetch(`${base}/api/pilot-training/home?locationID=${structureID}&characterID=${CHARACTER_ID}`, { headers });
  assert.equal(home.status, 200);
  assert.deepEqual((await home.json()).home, { locationID: structureID, name: "QA Astrahus", systemID: 30001401,
    kind: "PLAYER_STRUCTURE", relocation: "CONFIG_ONLY", capability: "DOCKABLE_STRUCTURE" });
  assert.ok(calls.every((call) => call.service === "structureDirectory" && call.bridgeSessionID === undefined));
  assert.ok(calls.filter((call) => call.method === "GetMyDockableStructures").every((call) =>
    call.session.characterID === CHARACTER_ID && call.session.corporationID === CORP));
  access = false;
  const denied = await fetch(`${base}/api/pilot-training/home?locationID=${structureID}&characterID=${CHARACTER_ID}`, { headers });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, "STRUCTURE_DOCK_ACCESS_DENIED");
});

test("Factory authentication is existing-only and does not replace cockpit cookies", async (t) => {
  const server = app().listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (path, username) => fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
  for (const path of ["/api/pilot-training/login", "/api/goblin-factory/login", "/api/goblin-factory/login/", "/API/GOBLIN-FACTORY/LOGIN"]) {
    for (const username of ["", "NotAnExistingAccount"]) {
      const denied = await login(path, username);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("set-cookie"), null);
    }
  }
  const auth = await login("/api/goblin-factory/login", ACCOUNT.username);
  assert.equal(auth.status, 200);
  assert.equal(auth.headers.get("set-cookie"), null);
  const payload = await auth.json();
  assert.equal(payload.sessionToken, "test-token");
  assert.equal(payload.accountCreated, false);
  assert.equal(payload.account.username, ACCOUNT.username);
  const normal = await login("/api/login", ACCOUNT.username);
  assert.equal(normal.status, 200);
  assert.ok(normal.headers.get("set-cookie"), "normal WC login retains its cookie behavior");
});

test("generic qualification HTTP uses explicit contract identity, authoritative hulls and ownership",async(t)=>{
  const server=app().listen(0,"127.0.0.1");t.after(()=>server.close());await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:"Bearer test-token"};
  const get=(configs=[],extra="")=>fetch(`${base}/api/pilot-training/qualification?characterID=${CHARACTER_ID}&role=HAULER&configurations=${encodeURIComponent(JSON.stringify(configs))}${extra}`,{headers});
  const fresh=await (await get()).json();assert.deepEqual(fresh.report.stages,[]);
  const f=fresh.fittings[0],c={configurationID:"custom-fit",roleID:"HAULER",order:0,corporationOwnerID:CORP,fittingID:7,hullTypeID:32880,acceptedSavedDate:f.savedDate,acceptedFingerprint:f.fingerprint};
  const chosen=await (await get([c],"&targetConfigurationID=custom-fit")).json();
  assert.equal(chosen.report.previews.FAST.stage,"custom-fit");assert.equal(chosen.report.stages[0].fitting.status,"READY");assert.equal(chosen.report.previews.BALANCED.disabled,true);
  assert.equal((await get([{...c,hullTypeID:483}])).status,400);
  assert.equal((await get([c],"&targetConfigurationID=other")).status,400);
  assert.equal((await fetch(`${base}/api/pilot-training/qualification?characterID=123&role=HAULER`,{headers})).status,404);
  assert.equal((await fetch(`${base}/api/pilot-training/qualification?characterID=${CHARACTER_ID}&role=HAULER`)).status,401);
});

test("canonical redirect and generic home resolution never claim structure relocation",async(t)=>{
  const server=app().listen(0,"127.0.0.1");t.after(()=>server.close());await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:"Bearer test-token"};
  const old=await fetch(`${base}/goblin-factory`,{redirect:"manual"});assert.equal(old.status,308);assert.equal(old.headers.get("location"),"/pilot-training");
  const home=await (await fetch(`${base}/api/pilot-training/home?locationID=60010825`,{headers})).json();
  assert.deepEqual(home.home,{locationID:60010825,name:"Test home",systemID:30004504,kind:"NPC_STATION",relocation:"MANUAL_GM_ONLY",capability:"DOCKABLE_STATION"});
  const unsupported=await fetch(`${base}/api/pilot-training/home?locationID=100000000001`,{headers});
  assert.equal(unsupported.status,400);assert.equal((await unsupported.json()).error,"UNSUPPORTED_HOME_LOCATION");
  assert.equal((await fetch(`${base}/api/pilot-training/home?locationID=60010825`)).status,401);
});

test("qualification HTTP read retains explicit Pioneer even before Venture and refuses unsupported targets", async (t) => {
  const server = app().listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/pilot-training/miner?characterID=${CHARACTER_ID}`;
  const headers = { authorization: "Bearer test-token" };
  const read = await (await fetch(`${base}&targetStage=PIONEER`, { headers })).json();
  assert.equal(read.report.currentStage, null);
  assert.equal(read.report.targetStage, "PIONEER"); assert.equal(read.report.previews.FAST.stage, "PIONEER");
  assert.equal(read.report.previews.FAST.eta.kind, "UNKNOWN", "target fitting still must be accepted");
  const invalid = await fetch(`${base}&targetStage=HAULER`, { headers });
  assert.equal(invalid.status, 400);
});

test("training authentication refuses expired/deleted/banned identities without cockpit cleanup", async (t) => {
  let released = 0;
  const held = { accountID: ACCOUNT.accountID, characterID: CHARACTER_ID, bridgeSessionID: "held-gameplay" };
  const sessions = new Map([["cockpit-session", held]]);
  const instance = createApp({
    bridgeSessionStore: sessions,
    webAuth: { verifySessionToken(token, options) {
      assert.equal(options?.allowExpired, undefined, "read-only auth never seeks cleanup authority");
      return token === "expired" ? null : { username: token, accountID: ACCOUNT.accountID, sessionID: "cockpit-session" };
    } },
    eveStore: { async getAccount(name) { return name === "deleted" ? null : { ...ACCOUNT, banned: true }; } },
    eveGatewayClient: { async releaseBridgeSession() { released++; } },
    errorLogger() {},
  });
  const server = instance.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  for (const route of ["characters", `miner?characterID=${CHARACTER_ID}`]) {
    for (const [token, code] of [["expired", 401], ["deleted", 401], ["banned", 403]]) {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/api/pilot-training/${route}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(result.status, code);
      assert.equal(result.headers.get("set-cookie"), null);
      assert.equal(sessions.get("cockpit-session"), held);
    }
  }
  assert.equal(released, 0);
});
