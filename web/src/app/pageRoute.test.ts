import test from "node:test";
import assert from "node:assert/strict";
import { isGoblinFactoryPath, isMiningCommandCenterPath, isPilotTrainingPath } from "./pageRoute.ts";

test("the dedicated Command Center accepts its direct URL and trailing slash", () => {
  assert.equal(isMiningCommandCenterPath("/mining-command-center"), true);
  assert.equal(isMiningCommandCenterPath("/mining-command-center/"), true);
});

test("ordinary workspace and other routes cannot mount the Command Center", () => {
  for (const path of ["/", "/pilot-training", "/goblin-factory", "/mining-command-center-other", "/mining-command-center/other"]) {
    assert.equal(isMiningCommandCenterPath(path), false, path);
  }
});

test("Pilot Training and its legacy alias keep their separate route ownership", () => {
  for (const path of ["/pilot-training", "/pilot-training/"]) {
    assert.equal(isPilotTrainingPath(path), true);
  }
  for (const path of ["/goblin-factory", "/goblin-factory/"]) {
    assert.equal(isGoblinFactoryPath(path), true);
  }
  assert.equal(isPilotTrainingPath("/mining-command-center"), false);
  assert.equal(isGoblinFactoryPath("/mining-command-center"), false);
});
