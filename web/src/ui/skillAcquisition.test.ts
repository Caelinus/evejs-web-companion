import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import type { AcquisitionReview } from "../training/types.ts";
register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const Panel = (await import("./SkillAcquisition.svelte")).default;
test("historical acquisition review preserves finance while unavailable purchase stays disabled",()=>{
  let calls=0;
  const review={mode:"FAST",stage:"PROCURER",canAcquire:true,reviewID:"one-shot",skills:[{typeID:11,name:"Astrogeology",price:"450000.00"}],
    total:"31500000.00",personalBalance:"12000000.00",shortfall:"19500000.00",blockers:[],cleanup:[],
    funding:{characterID:10,corporationID:98,division:1000,balance:"100000000.00"}} as unknown as AcquisitionReview;
  const html=render(Panel,{props:{review,outcome:null,busy:false,mode:"FAST",stage:"PROCURER",officers:[],message:"",onReview(){calls++;},onAcquire(){calls++;},onChange(){}}}).body;
  for(const value of ["31,500,000 ISK","12,000,000 ISK","19,500,000 ISK","Astrogeology","Corporation 98","Acquire missing skills · FAST → PROCURER","Character wallet only","Direct purchase is unavailable on stock EveJS web gateway","Inject skillbooks in the game client"]) assert.ok(html.includes(value),value);
  assert.equal((html.match(/<button[^>]*disabled[^>]*>/g)||[]).length,2,"neither stale review nor fresh panel can purchase");
  assert.equal(calls,0);
});
test("Farmer's owned cockpit retains its existing release authority",()=>{
  const stationPanel=readFileSync(new URL("./StationPanel.svelte",import.meta.url),"utf8");
  assert.match(stationPanel,/flow\.releaseSession\(\)/);
  const flow=readFileSync(new URL("../app/flow.ts",import.meta.url),"utf8");
  assert.match(flow,/await api\.releaseSession\(callOptions\)/);
});
test("Factory remains standalone: no space polling, queue writes only separate Apply; purchase never on mount",()=>{
  const src=readFileSync(new URL("./GoblinFactory.svelte",import.meta.url),"utf8");
  // The only recurring callback updates local evidence age; it performs no read or Apply.
  const localClock = "const freshnessClock = setInterval(() => observationNow = Date.now(), 1000);";
  assert.ok(src.includes(localClock));
  assert.match(src, /return \(\) => clearInterval\(freshnessClock\)/);
  assert.doesNotMatch(src.replace(localClock, ""),/readSpaceSnapshot|setInterval/);
  assert.doesNotMatch(src.slice(src.indexOf("  onMount(")),/acquireFactorySkills\(/);
  const acquisition=src.slice(src.indexOf("  async function acquireSkills("),src.indexOf("  async function reviewQueue("));
  assert.doesNotMatch(acquisition,/applyTrainingQueue\(/);
});

test("shared creator consumes authoritative recovery on reopen and on explicit check", () => {
  const source = readFileSync(new URL("./CharacterCreate.svelte", import.meta.url), "utf8");
  assert.match(source, /if \(creationState.recoveredCharacterID\) \{ onCreated/);
  assert.match(source, /if \(creationState.recoveredCharacterID \|\| found\) onCreated/);
  assert.match(source, /creationState.freeSlots > 0/);
  assert.match(source, /nameCode === 1/);
  const factory = readFileSync(new URL("./GoblinFactory.svelte", import.meta.url), "utf8");
  assert.match(factory, /<CharacterCreate\b[^>]*\bflow=\{creatorFlow\(creatingAccount\)\}/);
  assert.match(factory, /Target qualification for/);
  assert.doesNotMatch(factory, /CreateCharacterWithDoll/);
});
