import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import type { QueueReview, MinerTrainingRead } from "../training/types.ts";
register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const QueueReviewPanel = (await import("./TrainingQueueReview.svelte")).default;
const SkillAcquisition = (await import("./SkillAcquisition.svelte")).default;

test("acquisition receipt retains its reviewed target when current plan target changes",()=>{
  const outcome={mode:"FAST",stage:"later-id",status:"SKILLS_ACQUIRED",verified:true,at:1800000000000,purchased:[],funded:"0",wallet:"0",cleanup:[],readyForQueueReview:true};
  const html=render(SkillAcquisition,{props:{outcome,review:null,busy:false,mode:"MASTERY",stage:"Current hull",officers:[],message:"",targetName:(id:string)=>id==="later-id"?"Reviewed later hull":id,onReview(){},onAcquire(){},onChange(){}}}).body;
  assert.match(html,/Last acquisition · FAST → Reviewed later hull/);assert.doesNotMatch(html,/Last acquisition · FAST → Current hull/);
});

test("review distinguishes coverage/blockers, explicit mode/stage, and does not apply on rendering", () => {
  let mutations = 0;
  const result = { report: { stages: [{ id: "PIONEER", hard: [], support: [], fitting: { status: "READY" } }],
    previews: { MASTERY: { stage: "PIONEER", targets: [] } } } } as unknown as MinerTrainingRead;
  const review = { mode: "MASTERY", stage: "PIONEER", reviewID: "ephemeral-review", expiresAt: 1_800_000_000_000,
    status: "BLOCKED", canApply: false, activate: false, existing: [{ typeID: 11, toLevel: 1 }], maxEntries: 150,
    additions: [{ typeID: 12, toLevel: 1, name: "Mining" }, { typeID: 12, toLevel: 2, name: "Mining" }],
    requirements: (["ALREADY_TRAINED", "ALREADY_QUEUED", "WILL_APPEND", "BLOCKED", "UNKNOWN"] as const).map((reviewState, index) =>
      ({ typeID: index + 1, name: `Skill ${index}`, level: 1, trainedLevel: 0, skillPoints: 0, state: "MISSING" as const, queuePosition: -1, reviewState })),
    blockers: [{ code: "SKILLBOOK_REQUIRED", message: "Not injected", typeID: 4 }], fresh: result,
    queue: { active: false, maxEntries: 150, entries: [{ typeID: 11, toLevel: 1 }] },
  } as QueueReview;
  const html = render(QueueReviewPanel, { props: { result, queue: review.queue, review, mode: "MASTERY", busy: false,
    message: "", lastApply: null, onReview() {}, onApply() { mutations++; } } }).body;
  for (const text of ["ALREADY_TRAINED", "ALREADY_QUEUED", "WILL_APPEND", "BLOCKED", "UNKNOWN", "SKILLBOOK_REQUIRED",
    "Apply MASTERY plan → PIONEER", "Exact additions (in order)", "Existing: 1", "queue remains paused"]) assert.ok(html.includes(text), text);
  assert.match(html, /button[^>]*disabled[^>]*>Apply MASTERY plan/);
  assert.equal(mutations, 0);
});
test("queue review is ephemeral; mount/refresh never calls Apply or starts queue polling", () => {
  const source = readFileSync(new URL("./GoblinFactory.svelte", import.meta.url), "utf8");
  const localClock = "const freshnessClock = setInterval(() => observationNow = Date.now(), 1000);";
  assert.ok(source.includes(localClock));
  assert.doesNotMatch(source.slice(source.indexOf("  onMount(")).replace(localClock, ""), /applyTrainingQueue\(|setInterval\(|readSpaceSnapshot/);
  assert.match(source, /review: null, queue: null/);
  assert.match(source, /onApply=\{\(\) => void applyQueue\(row\)\}/);
});
