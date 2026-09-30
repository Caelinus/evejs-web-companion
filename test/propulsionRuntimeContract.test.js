"use strict";
// Optional read-only source-contract verifier. Never loads the EveJS service or
// space runtime, starts a scene, or reads/writes user state. Only pure movement
// helpers and isolated function bodies are evaluated against synthetic entities.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.EVEJS_PROPULSION_AUDIT_ROOT;

test("read-only EveJS contract: explicit AB/MWD dispatch populates physical motion, empty effect takes generic path", { skip: !root }, () => {
  const sourceRoot = fs.existsSync(path.join(root, "server/src")) ? path.join(root, "server") : root;
  const read = name => fs.readFileSync(path.join(sourceRoot, name), "utf8");
  // Current EveJS extracts these handlers into modules. Verify their wiring as
  // well as the same function bodies, without loading a service or the world.
  let dogma = read("src/services/dogma/dogmaService.js");
  if (!dogma.includes("Handle_Activate(args")) {
    assert.match(dogma, /attachDogmaServiceMethods\(require\(path.join\(__dirname, "\.\/dogmaService\/moduleOperation"\)\)\)/);
    dogma = read("src/services/dogma/dogmaService/moduleOperation.js");
  }
  let runtime = read("src/space/runtime.js");
  if (!runtime.includes("function applyPropulsionEffectStateToEntity(")) {
    assert.match(runtime, /require\("\.\/runtime\/propulsionModule"\)/);
    runtime = read("src/space/runtime/propulsionModule.js");
  }
  assert.ok(dogma.includes("Handle_Activate(args") && runtime.includes("function applyPropulsionEffectStateToEntity("));
  const routing = dogma.slice(dogma.indexOf("const isPropulsion =", dogma.indexOf("Handle_Activate(args")));
  const selector = routing.slice(0, routing.indexOf(";") + 1);
  const dispatch = routing.slice(routing.indexOf("const result = isPropulsion"), routing.indexOf("if (!result.success)"));
  const routes = [];
  for (const effectName of ["", "moduleBonusAfterburner", "moduleBonusMicrowarpdrive"]) {
    vm.runInNewContext(selector + dispatch, { effectName, session: {}, item: {}, targetID: null, activationRepeat: -1,
      spaceRuntime: {
        activatePropulsionModule: (_s, _m, name, opts) => routes.push({ path: "physical", name, repeat: opts.repeat }),
        activateGenericModule: (_s, _m, name, opts) => routes.push({ path: "generic", name, repeat: opts.repeat }),
      } });
  }
  assert.deepEqual(routes.map(row => row.path), ["generic", "physical", "physical"]);
  assert.ok(routes.every(row => row.repeat === -1));
  const effects = fs.readFileSync(path.join(root, "_local/sde/eve-online-static-data-3396210-jsonl/dogmaEffects.jsonl"), "utf8").split(/\r?\n/)
    .filter(line => line.includes('"moduleBonusAfterburner"') || line.includes('"moduleBonusMicrowarpdrive"')).map(JSON.parse);
  assert.equal(effects.length, 2);
  assert.ok(effects.every(effect => !effect.modifierInfo?.length), "generic modifiers do not implement propulsion");
  const source = runtime.slice(runtime.indexOf("function applyPropulsionEffectStateToEntity("), runtime.indexOf("function getPropulsionEffectID("));
  const commands = require(path.join(sourceRoot, "src/space/destiny/commands/shipDerivedMotion.js"));
  const { integrateCarbonMotion } = require(path.join(sourceRoot, "src/space/destiny/simulation/carbonIntegration.js"));
  for (const effectName of ["moduleBonusAfterburner", "moduleBonusMicrowarpdrive"]) {
    const ship = { mass: 10_000_000, maxVelocity: 187, inertia: 0.5, signatureRadius: 100,
      passiveDerivedState: { mass: 10_000_000, maxVelocity: 187, signatureRadius: 100 } };
    const context = { ...commands, ship, effect: { effectName, speedFactor: effectName.endsWith("Afterburner") ? 135 : 500,
      speedBoostFactor: 15_000_000, massAddition: 5_000_000, signatureRadiusBonus: 500 },
      isPropulsionModuleEffectState: () => true, toFiniteNumber: (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback,
      roundNumber: v => v, clampMaxVelocityToShipSpeedLimit: (_e, v) => v,
      PROPULSION_EFFECT_MICROWARPDRIVE: "moduleBonusMicrowarpdrive",
      calculateAlignTimeSecondsFromMassInertia: () => 10, deriveAgilitySeconds: () => 10,
    };
    vm.runInNewContext(source + "applyPropulsionEffectStateToEntity(ship, effect)", context);
    assert.ok(ship.maxVelocity > 187);
    assert.equal(ship.mass, 15_000_000);
    const mass = ship.mass * ship.inertia, friction = 1_000_000;
    const motion = integrateCarbonMotion({ x: 0, y: 0, z: 0 }, { x: 187, y: 0, z: 0 },
      { x: ship.maxVelocity * friction / mass, y: 0, z: 0 }, mass, friction, 30);
    assert.ok(motion.velocity.x > 187 && motion.velocity.x <= ship.maxVelocity);
  }
  const movement = read("src/space/destiny/simulation/movement.js");
  assert.match(movement.slice(movement.indexOf("function advanceFollowMovement")), /const desiredSpeed =[\s\S]*?entity.maxVelocity/);
});
