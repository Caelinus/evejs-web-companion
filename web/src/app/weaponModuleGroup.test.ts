// isWeaponModuleGroup: which high-slot GROUP names a bot fires at a target.
//
// The names below are the SDE's own module groups. Every group whose name says
// "launcher" is listed, because that word is the one that used to sweep in a
// probe launcher: a combat bot cycled a Core Probe Launcher at rats.

import test from "node:test";
import assert from "node:assert/strict";

import { isWeaponModuleGroup } from "./flow.ts";

test("turret and missile groups are weapons", () => {
  for (const group of [
    "Projectile Weapon",
    "Hybrid Weapon",
    "Energy Weapon",
    "Precursor Weapon",
    "Missile Launcher Light",
    "Missile Launcher Rapid Light",
    "Missile Launcher Heavy",
    "Missile Launcher Heavy Assault",
    "Missile Launcher Rapid Heavy",
    "Missile Launcher Cruise",
    "Missile Launcher Rocket",
    "Missile Launcher Torpedo",
    "Missile Launcher Rapid Torpedo",
    "Missile Launcher XL Torpedo",
    "Missile Launcher XL Cruise",
    "Missile Launcher Bomb",
    "Breacher Pod Launchers",
  ]) {
    assert.equal(isWeaponModuleGroup(group), true, group);
  }
});

test("launchers that are not weapons are excluded", () => {
  for (const group of [
    "Scan Probe Launcher",
    "Survey Probe Launcher",
    "Interdiction Sphere Launcher",
    "Festival Launcher",
  ]) {
    assert.equal(isWeaponModuleGroup(group), false, group);
  }
});

test("other high-slot groups are not weapons", () => {
  for (const group of ["Salvager", "Tractor Beam", "Mining Laser", "Cloaking Device"]) {
    assert.equal(isWeaponModuleGroup(group), false, group);
  }
});
