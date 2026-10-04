"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createFactorySkills}=require("../src/factorySkills");
for(const action of ["review","acquire"])test(`stock ${action} refuses before session, quote, funding or purchase`,async()=>{
  const forbidden=new Proxy({}, {get:()=>()=>assert.fail("Private acquisition must not run")});
  const service=createFactorySkills({gateway:forbidden,sessions:forbidden,queues:forbidden});
  await assert.rejects(service[action]({account:{accountID:1}},{confirm:true,funding:{token:"ignored"}}),{code:"SKILL_ACQUISITION_UNAVAILABLE",statusCode:409});
});
