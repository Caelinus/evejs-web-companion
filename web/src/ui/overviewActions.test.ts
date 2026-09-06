// The R23 slice A action layer as it actually RENDERS in the overview panel.
//
// Slice A's whole claim is that it is GENERIC — the same lock button and the
// same equipment table serve a mining laser and a turret. A claim like that
// rots unless something checks it, so this file checks it two ways: it renders
// the panel and reads what a player would see, and it reads the source for the
// call sites, so a later goal cannot quietly grow a mining-only branch.
//
// It also re-proves the standing invariants on the new markup: R7d (no visible
// numeric IDs), R9a (plain player language), R8 (reflow tables carry data-label
// on every cell, and controls are real buttons rather than bare links).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Overview = (await import("./Overview.svelte")).default;
const EquipmentPanel = (await import("./EquipmentPanel.svelte")).default;
const { deriveShipStats } = await import("../bridge/shipStats.ts");
// R30 slice D — where the panel's verb set now actually lives. The assertions
// below that used to grep this file's markup read it here instead.
const { actionsForRow, isDockableKind } = await import("../space/rowActions.ts");
// R70 — the picked object, and the sentinel destination row, moved out of this
// panel and into the shared selection the tactical viewport reads too. The
// assertions below that used to grep this file's source read the real module.
const { SOMEWHERE_ELSE, selectionHasVanished } = await import("../space/selection.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Overview.svelte"), "utf8");
const EQUIP_SOURCE = readFileSync(path.join(UI_DIR, "EquipmentPanel.svelte"), "utf8");

const ROCK_ID = 50001248;
const SHIP_ID = 9001;
const MODULE_ID = 7700001;
const ORE_TYPE_ID = 1230;
const LASER_TYPE_ID = 483;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/** Everything visible to a player, with markup and image sources stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

/**
 * The panel with a rock in view, that rock LOCKED, a mining laser fitted and
 * online, and the server reporting it as cycling. Every one of those facts
 * arrives the way the real app delivers it — through a store event.
 */
function loadedStore(options: {
  locked?: number[];
  acquiring?: number | null;
  activeModuleIDs?: number[] | null;
  actionError?: string | null;
  silentDecline?: string | null;
} = {}) {
  const store = createClientStore();
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: [
        {
          kind: "asteroid",
          itemID: ROCK_ID,
          typeID: ORE_TYPE_ID,
          groupID: 450,
          categoryID: 25,
          name: "Veldspar",
          ownerID: 1,
          radius: 1800,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          isSelf: false,
          shieldRatio: null,
          armorRatio: null,
          hullRatio: null,
          characterID: null,
          corporationID: null,
          allianceID: null,
          securityStatus: null,
          maxVelocity: null,
          mode: null,
          capacitorRatio: null,
          remainingQuantity: null,
          miningYieldTypeID: null,
          beltID: null,
          isNpc: false,
          npcEntityType: null,
          controllerID: null,
          droneActivity: null,
          targetEntityID: null,
        },
      ],
      ship: {
        itemID: SHIP_ID,
        typeID: 606,
        name: "Ibis",
        mode: "STOP",
        maxVelocity: 300,
        radius: 30,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 300,
        armorCapacity: 300,
        hullCapacity: 300,
        activeModuleIDs:
          options.activeModuleIDs === undefined ? [MODULE_ID] : options.activeModuleIDs,
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
    },
  });
  store.apply({ type: "targeting/targets", targetIDs: options.locked ?? [ROCK_ID] });
  if (options.acquiring) {
    store.apply({ type: "targeting/acquiring", targetID: options.acquiring });
  }
  if (options.actionError) {
    store.apply({ type: "targeting/action-error", message: options.actionError });
  }
  if (options.silentDecline) {
    store.apply({ type: "targeting/silent-decline", message: options.silentDecline });
  }
  store.apply({
    type: "fitting/loaded",
    activeShipID: SHIP_ID,
    slots: [
      {
        family: "high",
        index: 0,
        module: { itemID: MODULE_ID, typeID: LASER_TYPE_ID, groupID: 54, online: true, charge: null },
      },
    ],
    resources: {
      cpu: { used: 0, total: 0, known: false },
      powergrid: { used: 0, total: 0, known: false },
      capacitor: { used: 0, total: 0, known: false },
      calibration: { used: 0, total: 0, known: false },
    },
    stats: deriveShipStats(new Map()),
    slotsError: null,
    resourcesError: null,
  });
  store.apply({
    type: "names/resolved",
    entries: {
      [`type:${ORE_TYPE_ID}`]: "Veldspar",
      [`typeGroup:${ORE_TYPE_ID}`]: "Veldspar",
      [`typeCategory:${ORE_TYPE_ID}`]: "Asteroid",
      [`type:${LASER_TYPE_ID}`]: "Miner I",
      "type:606": "Ibis",
    },
  });
  return store;
}

/** The same panel, rendered. */
function renderLoaded(options: Parameters<typeof loadedStore>[0] = {}): string {
  return render(Overview, { props: { store: loadedStore(options), flow: fakeFlow() } }).body;
}

/**
 * The same scene, rendered through the EQUIPMENT WINDOW.
 *
 * ⚠ THE EQUIPMENT CLAIMS BELOW MOVED HERE ONE FOR ONE. Each is the assertion
 * that was made against the cockpit's "Your equipment" table, made against the
 * new component unchanged — which is what proves the lift, rather than a new
 * suite written to fit whatever was built.
 *
 * ⚠ AND ONE OF THEM IS THE REASON THE WINDOW EXISTS. Fitting is a DOCKED-ONLY
 * tab, so the row that powers an OFFLINE module up is the only way to do it in
 * space. Deleting the cockpit without this window would have taken that away
 * with every test still green.
 */
function renderEquipment(options: Parameters<typeof loadedStore>[0] = {}): string {
  return render(EquipmentPanel, { props: { store: loadedStore(options), flow: fakeFlow() } }).body;
}

// --- The sections exist and read as a player would expect --------------------

test("the panel shows a locked-target list and an equipment list", () => {
  const text = visibleText(renderLoaded());
  assert.match(text, /Locked targets/);
  assert.match(text, /Your equipment/);
  // Each named, never numbered.
  assert.match(text, /Veldspar/);
  assert.match(text, /Miner I/);
});

test("a lock that has landed reads Locked; one still being acquired reads Locking", () => {
  assert.match(visibleText(renderLoaded()), /Locked\b/);
  const acquiring = visibleText(renderLoaded({ locked: [], acquiring: ROCK_ID }));
  assert.match(acquiring, /Locking…/);
  // A target still being acquired is not yet usable, so it must not be offered
  // as something to switch equipment on to.
  assert.doesNotMatch(acquiring, /Nothing is locked/);
});

test("with nothing locked the list says so, in plain words", () => {
  const text = visibleText(renderLoaded({ locked: [] }));
  assert.match(text, /Nothing is locked/);
});

// Regression: a player locked a rock, pressed Switch on, and the server refused
// "You need an active target to activate that module" — because the "Use it on"
// picker defaulted to "Nothing" and the module was sent with no target at all.
// Locking a thing MAKES it the thing your equipment acts on; the default must
// follow the lock, and the opt-out has to be the deliberate choice.
test("the equipment target defaults to what is LOCKED, not to nothing", () => {
  const body = renderEquipment({ locked: [ROCK_ID] });

  const auto = body.indexOf("What I have locked");
  const optOut = body.indexOf("Nothing — just switch it on");
  assert.ok(auto >= 0, "the locked target must be offered as the default choice");
  assert.ok(optOut >= 0, "an explicit no-target option must still exist");
  assert.ok(
    auto < optOut,
    "the locked target must come BEFORE the no-target option, so it is what a browser selects by default",
  );
  // And it must name the rock, so the player can see what it will be used on.
  assert.match(body.slice(auto, optOut), /Veldspar/);
});

test("with nothing locked, the target picker says so rather than implying a target", () => {
  const body = renderEquipment({ locked: [] });
  assert.match(body, /Nothing locked yet/);
});

test("a target still being acquired is never the default — it cannot be shot at yet", () => {
  const body = renderEquipment({ locked: [], acquiring: ROCK_ID });
  // Auto resolves over LOCKED targets only; an acquiring one leaves us with none.
  assert.match(body, /Nothing locked yet/);
  assert.doesNotMatch(body, /What I have locked/);
});

test("a module the server says is cycling reads Running; otherwise Idle", () => {
  assert.match(visibleText(renderEquipment({ activeModuleIDs: [MODULE_ID] })), /Running/);
  assert.match(visibleText(renderEquipment({ activeModuleIDs: [] })), /Idle/);
});

test("when the server cannot say what is running, the panel says NOT KNOWN — never Idle", () => {
  // This is the honesty rule: a wrong "Idle" invites a double activation.
  const body = renderEquipment({ activeModuleIDs: null });
  const text = visibleText(body);
  assert.match(text, /Not known/);
  assert.doesNotMatch(text, /\bIdle\b/);
  assert.match(body, /stat-unavailable/, "unavailable state uses the shared unavailable style");
});

test("a refusal and a silent decline are shown as DIFFERENT things", () => {
  const text = visibleText(
    renderLoaded({
      actionError: "Lock refused: CALL_REFUSED: TargetTooFar",
      silentDecline: "The server did not release that lock, and gave no reason.",
    }),
  );
  assert.match(text, /TargetTooFar/, "the server's own reason, verbatim");
  assert.match(text, /gave no reason/, "and the silent decline said plainly");
});

// --- R7d: no visible numeric IDs --------------------------------------------

test("R23: no itemID, typeID or moduleID is ever visible text", () => {
  const text = visibleText(renderLoaded());
  for (const id of [ROCK_ID, SHIP_ID, MODULE_ID, ORE_TYPE_ID, LASER_TYPE_ID]) {
    assert.equal(
      new RegExp(`\\b${id}\\b`).test(text),
      false,
      `${id} must never appear as text a player can read`,
    );
  }
  // And no leaked wire vocabulary.
  assert.equal(/\bflag\b/i.test(text), false);
  assert.equal(/\btypeID\b/i.test(text), false);
  assert.equal(/\bitemID\b/i.test(text), false);
});

// --- R9a: plain player language ---------------------------------------------

test("R9a: the new sections speak to a player, not to a developer", () => {
  const text = visibleText(renderLoaded());
  // No API vocabulary on screen.
  for (const jargon of [
    "AddTarget",
    "RemoveTarget",
    "GetTargets",
    "Activate",
    "Deactivate",
    "dogmaIM",
    "effect name",
    "repeat",
    "allowlist",
    "bridge",
    "BFF",
  ]) {
    assert.equal(
      text.includes(jargon),
      false,
      `"${jargon}" is developer vocabulary and must not be on screen`,
    );
  }
  // And the labels are things a player would say.
  assert.match(text, /Switch on/);
  assert.match(text, /Switch off/);
  assert.match(text, /Release lock/);
});

// --- R8: the new tables reflow, and the controls are real buttons -------------

test("R8: every remaining table is a reflow table inside a scroll wrapper", () => {
  const body = renderLoaded();
  // ⚠ TWO NOW, NOT THREE. R82 turned the overview grid itself into a LIST — it
  // was the widest of the three and the one read in the narrowest column, and a
  // six-column table there meant scrolling sideways to read it. The two record
  // tables left are locked targets and equipment.
  const reflowTables = body.match(/<table class="guests[^"]*reflow"/g) ?? [];
  assert.ok(reflowTables.length >= 2, `expected 2+ reflow tables, saw ${reflowTables.length}`);
  const wrappers = body.match(/table-wrap overflow-x-auto/g) ?? [];
  assert.ok(wrappers.length >= 2, "each table scrolls inside its own wrapper");
});

test("R82: the overview grid is a list that cannot scroll sideways", () => {
  const body = renderLoaded();
  // The claim the rework exists for. A table would come back as
  // `<table class="guests ... overview`; the list is rows of real buttons.
  assert.match(body, /<ul class="overview-list/, "the grid must be a list");
  assert.equal(
    /<table[^>]*class="[^"]*overview/.test(body),
    false,
    "the overview grid must not be a table again",
  );
  // Every row is a real control, not a clickable <tr> beside a Select button.
  const rows = body.match(/class="ov-row[^"]*"/g) ?? [];
  assert.ok(rows.length > 0, "expected overview rows");
  assert.match(body, /<button[^>]*class="ov-row/, "a row must be a button");
  // ...and it announces its own selected state, which is what replaced the
  // separate Select control that used to sit in the last column.
  assert.match(body, /class="ov-row[^"]*"[^>]*aria-pressed=/, "a row must report its selection");
});

test("R8: every cell in the new tables carries a data-label for the narrow layout", () => {
  const body = renderLoaded();
  // At the R8 breakpoint each row becomes a stack of label/value pairs driven by
  // td::before { content: attr(data-label) }. A cell without the attribute
  // renders as an unlabelled value on a phone.
  const cells = body.match(/<td\b[^>]*>/g) ?? [];
  assert.ok(cells.length > 0, "the loaded panel must render cells");
  for (const cell of cells) {
    assert.match(cell, /data-label="/, `every <td> needs data-label; saw ${cell}`);
  }
});

test("R8: every offered action is a real <button>, sized by the shared button rule", () => {
  // ⚠ RE-POINTED IN R30 SLICE D, and deliberately made stronger.
  //
  // This used to be `assert.match(SOURCE, /class="row-actions"/)` — a regex
  // proving that eleven characters were still somewhere in a 1,900-line
  // template. It could not tell whether the actions were buttons, whether every
  // action reached the screen, or whether any of them were still rendered at
  // all. Slice D moved the verbs out of the grid and into a bar, so the regex
  // would have kept passing while testing nothing.
  //
  // The claim was always "these are real buttons in the shared group, so they
  // inherit min-height: 2.5rem (40px) for touch". That is now checked against
  // the ACTION LIST the panel actually renders from: every action `rowActions`
  // returns for a row must come out as a `<button type="button">`.
  const context = {
    kind: "station",
    locked: false,
    acquiring: false,
    gateLink: {
      gateID: 5001,
      toSystemID: 30000142,
      toSystemName: "Jita",
      destinationGateID: 5002,
    },
  } as const;
  const actions = actionsForRow(context);
  assert.ok(actions.length >= 7, `a station with a gate offers the full set, saw ${actions.length}`);

  // Every one of them is drawn by the bar's single {#each} as a real button in
  // the shared .row-actions group. That is one loop over this exact array, so
  // pinning the loop pins every action it can ever produce.
  const bar = section(SOURCE, "R30 slice D — THE SELECTION BAR", "</section>");
  assert.ok(bar.length > 500, "the selection bar must be found in the panel");
  assert.match(bar, /class="row-actions"/, "the bar uses the shared, touch-sized group");
  assert.match(bar, /\{#each selectionActions as action/, "it draws the returned actions");
  assert.match(bar, /<button\s+type="button"/, "each one is a real button");
  // And a button is only ever disabled by its OWN concern, never a shared flag.
  assert.match(bar, /disabled=\{concernBusy\(action\.concern\)/);

  // No bare anchors standing in for actions.
  assert.equal(/<a\s+href="#/.test(SOURCE), false, "actions are buttons, not fake links");
});

test("R30 slice D: an action that cannot be used is DRAWN, wearing its reason", () => {
  // The other half of the same rule, and the reason `unavailable` is a sentence
  // rather than a boolean: a disabled control must say why. This is checked on
  // the returned data (a gate with no far side is the one blocked case the
  // module has) and on the bar rendering that sentence rather than the label.
  const blocked = actionsForRow({
    kind: "stargate",
    locked: false,
    acquiring: false,
    gateLink: { gateID: 5001, toSystemID: 3, toSystemName: "Jita", destinationGateID: 0 },
  }).find((action) => action.id === "jump");
  assert.ok(blocked, "the action is still offered, not dropped");
  assert.ok((blocked.unavailable ?? "").length > 10, "and carries a sentence, not a flag");

  const bar = section(SOURCE, "R30 slice D — THE SELECTION BAR", "</section>");
  assert.match(bar, /action\.unavailable !== null/, "an unusable action is disabled");
  assert.match(bar, /\{action\.unavailable \?\? action\.label\}/, "and says why, on the control");
});

// --- The generality claim, pinned in source ----------------------------------

test("the reusable layer is GENERIC: no domain vocabulary in the BFF client", () => {
  // This is the real test of the claim. `Overview.svelte` legitimately talks
  // about rocks and ore — it is the mining PRESENTATION built on top. What must
  // stay domain-free is the layer combat inherits: the typed BFF calls and the
  // flow methods behind them. If a later goal has to add "if this is a mining
  // laser…" THERE, the abstraction was wrong.
  const apiSource = readFileSync(path.join(UI_DIR, "..", "app", "api.ts"), "utf8");
  const sliceA = section(
    apiSource,
    "--- R23 slice A: targeting + module activation ---",
    "--- R23 slice B: the mining loop ---",
  );
  assert.ok(sliceA.length > 500, "the slice A section must be found in api.ts");
  for (const word of ["mining", "asteroid", "ore", "turret", "missile", "laser", "salvage"]) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, "i").test(stripComments(sliceA)),
      false,
      `the reusable layer must not mention "${word}" — it is generic`,
    );
  }

  // And the same for the flow methods.
  const flowSource = readFileSync(path.join(UI_DIR, "..", "app", "flow.ts"), "utf8");
  const flowSliceA = section(
    flowSource,
    "--- R23 slice A: targeting + module activation ---",
    "--- R23 slice B: the mining loop ---",
  );
  assert.ok(flowSliceA.length > 500, "the slice A section must be found in flow.ts");
  for (const word of ["mining", "asteroid", "ore", "turret", "missile", "laser"]) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, "i").test(stripComments(flowSliceA)),
      false,
      `the reusable flow layer must not mention "${word}" — it is generic`,
    );
  }
});

/** The source between two banner comments (exclusive of the second). */
function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) {
    return "";
  }
  const end = source.indexOf(to, start);
  return source.slice(start, end < 0 ? undefined : end);
}

/** Code only: prose in comments may name examples without being a branch. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

test("the panel calls the generic flow methods, once each, with no parallel path", () => {
  // ⚠ COUNTS UPDATED IN R30 SLICE D — because the duplication they were
  // tolerating is gone, not because the rule was relaxed.
  //
  // The overview row used to carry its own copy of every verb, so unlock had
  // FOUR call sites (two row states, the locked list, a threat row) and each
  // movement verb had one buried in markup. Slice D moved the row's verbs into
  // a single `runRowAction` dispatch, so each verb now has exactly one call
  // site and the remaining duplicates are the two blocks that genuinely are
  // separate surfaces: the threat list and the locked-target list.
  //
  // Every number here went DOWN or stayed the same. If one ever goes up, a
  // parallel path has grown.
  const callSites: Readonly<Record<string, number>> = {
    // R30 slice E added a second activate site: "Mine this", which runs the
    // fan-out over every powered-up mining module with repeat: -1. It is the
    // SAME generic flow method as the equipment table's Switch on — the two
    // differ in what they pass, not in what they call, which is the whole point
    // of this test. A third site would mean a parallel path.
    "flow.activateModule(": 2,
    "flow.deactivateModule(": 1,
    // R30 slice E — powering equipment up and down, the click that used to
    // require the Fitting tab. One site, both directions.
    "flow.setModuleOnline(": 1,
    "flow.unloadMiningHolds(": 1,
    // R77 — the MOVEMENT verbs are no longer dispatched from this panel at all.
    // They moved to `space/rowActionRunner.ts` when the radial menu began
    // dispatching the same verbs from a different component, and the counts
    // below (all zero) are what keeps a copy from creeping back in here.
    "flow.warpTo(": 0,
    "flow.approach(": 0,
    "flow.orbit(": 0,
    "flow.keepAtRange(": 0,
    "flow.alignTo(": 0,
    "flow.jump(": 0,
    // These are NOT the verb bar's, which is why they survived the move. They
    // are the DIRECT controls that live on their own surfaces — the threat block
    // (lock the pirate that just arrived without hunting for it in a 200-row
    // list), the locked-targets table, and the "Haul now" ladder. Each is a
    // deliberate site; none is a second copy of a bar verb.
    "flow.dockAt(": 1,
    "flow.lockTarget(": 1,
    "flow.unlockTarget(": 2,
  };
  for (const [call, expected] of Object.entries(callSites)) {
    assert.equal(
      SOURCE.split(call).length - 1,
      expected,
      `${call} must have exactly ${expected} call site(s)`,
    );
  }
});

test("R77: the movement verbs have exactly ONE dispatch site, in the shared runner", () => {
  // The other half of "no parallel path". The panel above proves it does not
  // dispatch these any more; this proves the place they moved to holds exactly
  // one of each.
  //
  // ⚠ Two copies of that switch would not fail loudly. They would differ in ONE
  // branch — Orbit from the verb bar holding the configured range, Orbit from
  // the radial holding the default — and nothing would look broken.
  const RUNNER = readFileSync(
    path.join(UI_DIR, "..", "space", "rowActionRunner.ts"),
    "utf8",
  );
  for (const call of [
    "flow.warpTo(",
    "flow.approach(",
    "flow.orbit(",
    "flow.keepAtRange(",
    "flow.alignTo(",
    "flow.dockAt(",
    "flow.jump(",
    "flow.lockTarget(",
    "flow.unlockTarget(",
  ]) {
    assert.equal(
      RUNNER.split(call).length - 1,
      1,
      `${call} must have exactly one dispatch site in the runner`,
    );
  }
});

test("R30 slice D: the verb set is DATA from one module, not {#if} blocks in markup", () => {
  // The structural claim the slice rests on. `actionsForRow` is the only thing
  // that decides what a selected row offers, and the bar renders whatever it
  // returns — so the decision can be tested directly (see space/rowActions.test.ts)
  // instead of being inferred from a regex over a template.
  assert.match(SOURCE, /import \{[\s\S]{0,200}actionsForRow[\s\S]{0,200}from "\.\.\/space\/rowActions\.ts"/);
  assert.equal(
    SOURCE.split("actionsForRow(").length - 1,
    1,
    "exactly one place asks for the verb set",
  );
  // And the panel no longer decides dockability for itself — that moved out
  // with the rest of the verb set, so there is no second source of truth.
  assert.equal(
    /function isDockable\b/.test(SOURCE),
    false,
    "the panel must not keep its own copy of the dockable test",
  );
});

// --- R30 slice E: the contextual verbs, and the tab switches they killed -----

test("R30 slice E: the app no longer sends the player to another tab to power equipment up", () => {
  // ⚠ AND IT MUST NOT COME BACK IN THE NEW WINDOW EITHER. That window is
  // in-space only, where the Fitting tab does not exist at all, so the sentence
  // would be worse than stale — it would name a place a flying pilot cannot go.
  assert.equal(
    EQUIP_SOURCE.includes("Turn equipment on in the Fitting tab first"),
    false,
    "the equipment window told the player to visit a docked-only tab",
  );
  // Deleting these sentences IS the acceptance test for the slice. Offline
  // equipment is listed right here with Power up on the row, so every one of
  // them is now false — and they must be gone, not reworded.
  const miningBot = readFileSync(path.join(UI_DIR, "MiningBot.svelte"), "utf8");
  const mining = readFileSync(path.join(UI_DIR, "Mining.svelte"), "utf8");

  assert.equal(
    SOURCE.includes("Turn equipment on in the Fitting tab first"),
    false,
    "Overview must no longer point at the Fitting tab",
  );
  assert.equal(
    miningBot.includes("Switch your equipment on in the Fitting tab first"),
    false,
    "the mining bot must no longer point at the Fitting tab",
  );
  assert.equal(
    mining.includes("switch your mining equipment on from Around Your Ship"),
    false,
    "the Mining tab must no longer direct traffic to another tab",
  );
  // And nothing a PLAYER can read says "Fitting tab" any more.
  assert.equal(/Fitting tab/.test(visibleText(renderLoaded())), false);
});

test("R30 slice E: offline equipment is LISTED, with the one click that used to be a tab away", () => {
  const store = loadedStore();
  // The same laser, not powered up.
  store.apply({
    type: "fitting/loaded",
    activeShipID: SHIP_ID,
    slots: [
      {
        family: "high",
        index: 0,
        module: { itemID: MODULE_ID, typeID: LASER_TYPE_ID, groupID: 54, online: false, charge: null },
      },
    ],
    resources: {
      cpu: { used: 0, total: 0, known: false },
      powergrid: { used: 0, total: 0, known: false },
      capacitor: { used: 0, total: 0, known: false },
      calibration: { used: 0, total: 0, known: false },
    },
    stats: deriveShipStats(new Map()),
    slotsError: null,
    resourcesError: null,
  });
  const body = render(EquipmentPanel, { props: { store, flow: fakeFlow() } }).body;
  const text = visibleText(body);

  assert.match(text, /Miner I/, "an offline module is listed, not hidden");
  assert.match(body, /<button[^>]*>[\s\S]{0,80}Power up/, "with a real Power up button");
  // ⚠ POWERED UP and RUNNING are different questions. An offline module reads
  // as not powered up — never as "Idle", which would invite a switch-on that
  // cannot work, and never as "Not known", which is reserved for the case where
  // the server genuinely did not say.
  assert.match(text, /Not powered up/);
  assert.doesNotMatch(text, /\bIdle\b/);
});

test("R30 slice E: Mine this reports EVERY module by name, never one shared answer", () => {
  // ⚠ THE RULE: "Mine this" is a fan-out, and every one of those calls lands
  // its outcome in the SAME store slot. A loop that fired them all and showed
  // what was left would tell a player with two lasers that it worked while one
  // of them never started. The dispatch must therefore read each module back
  // right after its OWN call, and render one line per module.
  const mine = section(SOURCE, "async function mineThis", "const stationsOnGrid");
  assert.ok(mine.length > 400, "the Mine this dispatch must be found");
  assert.match(mine, /for \(const module of minerRows\)/, "it walks the modules one at a time");
  assert.match(mine, /await flow\.activateModule\(/);
  // Read back INSIDE the loop — a read after the loop would only see the last.
  const loopBody = mine.slice(mine.indexOf("for (const module of minerRows)"));
  assert.match(loopBody, /\$targeting\.actionError/, "a refusal is read per module");
  assert.match(loopBody, /\$targeting\.silentDecline/, "so is a silent decline");
  assert.match(
    loopBody,
    /activeModuleIDs/,
    "and confirmed against the ship's own list of what is running",
  );
  assert.match(loopBody, /reports\.push/, "each module gets its own line");
  // Three distinguishable outcomes, not a boolean: refused, accepted-then-not-
  // running, and running. The middle one is the silent decline the goal names.
  assert.match(mine, /does not show it running/);

  // And the panel draws one line per module rather than a single verdict.
  assert.match(SOURCE, /\{#each mineReports as report/);
});

test("R30 slice E: powering a module is verified against a RE-READ, not the call's answer", () => {
  // A 200 is not proof. setModuleOnline re-reads the fitting itself, so the
  // check is against freshly-read authoritative state: if the module's own
  // online flag did not move, that is reported as exactly that.
  const power = section(EQUIP_SOURCE, "async function setModulePower", "</script>");
  assert.ok(power.length > 200, "the power dispatch must be found");
  assert.match(power, /await flow\.setModuleOnline\(module\.itemID, online\)/);
  assert.match(power, /\$fitting\.slots\.find/, "the fitting is re-read afterwards");
  assert.match(power, /gave no reason/, "and a decline says so plainly");
});

// --- R30 slice F: the collapses, the reorder, and "Somewhere else…" ----------

test("R30 slice F: the grid comes BEFORE the panels that used to bury it", () => {
  // The overview was the LAST thing on the page, under ship condition, threats,
  // drones, the range pickers, locked targets, equipment and the damage log. A
  // player who came to look at what is around their ship scrolled past all of
  // it, every time.
  const body = renderLoaded();
  const at = (needle: string) => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `expected to find ${needle}`);
    return index;
  };
  const grid = at(">Overview<");
  assert.ok(at("selection-bar") < grid, "the bar sits above the grid it acts on");
  assert.ok(grid < at("Flying distances"), "the range pickers moved below the grid");
  assert.ok(grid < at(">Drones<"), "so did the drone panel");
  assert.ok(grid < at("Shots fired"), "and the damage log");
  // Ship condition stays ABOVE: it is a HUD, not a panel you go looking for.
  assert.ok(at("Ship condition") < grid);
});

test("R30 slice F: the collapses are native <details>, and never hide their state", () => {
  const body = renderLoaded();
  // Native <details>/<summary>: no JS, no component state to fall out of sync,
  // keyboard-operable and screen-reader-announced for free.
  const collapses = body.match(/<details class="collapsible"/g) ?? [];
  assert.equal(collapses.length, 2, "the range pickers and the drone panel fold away");
  // ⚠ Neither is `open`. They are collapsed by DEFAULT — that is the point.
  assert.doesNotMatch(body, /<details class="collapsible"[^>]*\bopen\b/);

  // ⚠ AND THE SUMMARY CARRIES THE CURRENT STATE. A collapsed panel that hid
  // what it was set to would be worse than the section it replaced. The range
  // summary reads back the labels from the SAME fixed menu the picker offers,
  // so it can only ever say something the player could have chosen — never a
  // raw metre count and never "10.0 km".
  //
  // ⚠ The two hold defaults are the in-space handoff's (5 km / 10 km), not
  // retail's 1 km each — a 1 km orbit is the wrong first answer for almost
  // every hull this client flies, and a player who has never opened Settings
  // should not find that out by scraping an asteroid. See flyingDistances.ts.
  assert.match(body, /Warp\s+As close as it can/, "the warp default, in its own words");
  assert.match(body, /Orbit\s+5 km/);
  assert.match(body, /Hold\s+10 km/);
  assert.doesNotMatch(body, /Warp\s+1000\b/, "R7d/R9a: never the raw number");
  // The drone summary carries the one fact it may not hide: how many are OUT.
  assert.match(body, /class="collapse-hint">[\s\S]{0,40}(None|out|Looking|Could not)/);
});

test("R30 slice F: 'Somewhere else…' is the last row, and invents no distance", () => {
  const body = renderLoaded();
  assert.match(body, /Somewhere else…/, "the destination row exists");
  // It is a row in the grid, after every real one — and it is marked as not
  // being a thing in space so it does not read as another ball on the grid.
  //
  // ⚠ RE-POINTED IN R82: the grid became a list, so this is an `.ov-row` inside a
  // `<ul>` rather than a `<tr>` of labelled cells. The claim is unchanged.
  assert.ok(
    body.indexOf("synthetic-row") > body.indexOf("Veldspar"),
    "it sits below the real rows",
  );
  // ⚠ It has no distance, because it does not have one. A fabricated 0 m would
  // put this row nearest in a distance sort.
  const row = body.slice(body.indexOf("synthetic-row"));
  const rowMarkup = row.slice(0, row.indexOf("</li>"));
  assert.match(rowMarkup, /class="ov-range">—</, "no distance is invented");
  assert.match(rowMarkup, /Anywhere not on this grid/, "it says what it is instead");
});

test("R30 slice F: the destination sentinel cannot collide with a real thing in space", () => {
  // Every itemID the server issues is positive. A negative sentinel therefore
  // cannot be mistaken for a ball — and the "did my selection leave the
  // snapshot" check must SKIP it, or it would announce the destination row as
  // vanished on every single poll.
  //
  // ⚠ R70 moved both the sentinel and that check into `space/selection.ts`, so
  // this now asserts the BEHAVIOUR rather than the presence of a line of source.
  // The old version matched `/const SOMEWHERE_ELSE = -1;/` against this file's
  // text, which would have gone on passing if the skip had been deleted and
  // would have failed the moment the constant was merely renamed — the exact
  // inversion of what it was there to protect.
  assert.ok(SOMEWHERE_ELSE < 0, "the sentinel must not collide with a real itemID");
  assert.equal(
    selectionHasVanished(SOMEWHERE_ELSE, new Set()),
    false,
    "the destination row is not a ball in space and can never leave one",
  );
  assert.equal(
    selectionHasVanished(SOMEWHERE_ELSE, new Set([1, 2, 3])),
    false,
    "…on a busy grid either",
  );
  // And the panel must genuinely delegate to it rather than keep a second copy
  // of the rule that could drift from the one the viewport uses.
  assert.match(SOURCE, /selectionHasVanished\(selectedID, present\)/);
});

test("R30 slice F: destination results are COMPONENT-LOCAL, never a store slice", () => {
  // They are a transient answer to a question this panel asked; the store holds
  // what the SHIP reports. Travel.svelte made the same call for the same
  // reason, and two panels holding the same search would be two things to keep
  // in sync for no gain.
  assert.match(SOURCE, /let destinationResults = \$state<DestinationMatch\[\]>\(\[\]\)/);
  assert.equal(
    /store\.apply\(\s*\{\s*type:\s*"travel\//.test(SOURCE),
    false,
    "the panel must not write search results into the store",
  );
  // And setting one reuses the EXISTING autopilot path rather than a second.
  assert.equal(SOURCE.split("flow.startRoute(").length - 1, 1);
  assert.equal(SOURCE.split("flow.searchDestinations(").length - 1, 1);
});

test("activateModule is called WITHOUT naming an effect — the server picks it", () => {
  // The browser must never guess which effect a module runs. Passing no effect
  // name is what makes one button correct for a laser, a turret and a repper.
  const call = SOURCE.slice(SOURCE.indexOf("flow.activateModule("));
  assert.doesNotMatch(call.slice(0, 200), /effect:/, "the panel must not name an effect");
});

// --- R24 slice B: the Dock action on the overview row ------------------------

const STATION_ID = 60003760;

/** One ball of a chosen runtime kind, alongside the ship, rendered in the panel. */
function renderWithEntity(kind: string, itemID: number): string {
  const store = createClientStore();
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: [
        {
          kind,
          itemID,
          typeID: ORE_TYPE_ID,
          groupID: 15,
          categoryID: 3,
          name: "Jita IV - Moon 4",
          ownerID: 1,
          radius: 12000,
          position: { x: 400_000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          isSelf: false,
          shieldRatio: null,
          armorRatio: null,
          hullRatio: null,
          characterID: null,
          corporationID: null,
          allianceID: null,
          securityStatus: null,
          maxVelocity: null,
          mode: null,
          capacitorRatio: null,
          remainingQuantity: null,
          miningYieldTypeID: null,
          beltID: null,
          isNpc: false,
          npcEntityType: null,
          controllerID: null,
          droneActivity: null,
          targetEntityID: null,
        },
      ],
      ship: {
        itemID: SHIP_ID,
        typeID: 606,
        name: "Ibis",
        mode: "STOP",
        maxVelocity: 300,
        radius: 30,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 300,
        armorCapacity: 300,
        hullCapacity: 300,
        activeModuleIDs: [],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
    },
  });
  return render(Overview, { props: { store, flow: fakeFlow() } }).body;
}

test("R24: a station offers Dock; a rock does not — decided from the ball's KIND", () => {
  // ⚠ RE-POINTED IN R30 SLICE D. This used to render the panel and grep the
  // visible text for the word "Dock", which worked only while every verb was
  // stamped onto every row. The verbs are now on a bar that acts on the row you
  // picked, and there is no selection in a server-rendered snapshot — so the
  // old grep would have failed for a reason that has nothing to do with the
  // claim it was making.
  //
  // The claim is unchanged and is now read where the decision is made. Note it
  // is exercised on the SAME entity kinds the panel feeds in, so this is a
  // stronger check than the word-search ever was: it proves a rock is refused,
  // not merely that four letters were absent from a page.
  const base = { locked: false, acquiring: false, gateLink: null } as const;
  const dockable = (kind: string) =>
    actionsForRow({ ...base, kind }).some((action) => action.id === "dock");

  assert.equal(dockable("station"), true, "a station is something you can dock at");
  assert.equal(dockable("structure"), true, "and so is a player structure");
  assert.equal(dockable("asteroid"), false, "you cannot dock at a rock");
  assert.equal(dockable("ship"), false, "or at another ship");
  // And the predicate behind it — the server's own runtime kind for the ball,
  // never its name, its distance or its category number.
  assert.equal(isDockableKind("station"), true);
  assert.equal(isDockableKind("asteroid"), false);

  // The panel still renders both kinds of row, each pickable.
  //
  // ⚠ RE-POINTED IN R82. This used to look for a button whose text was "Select",
  // which lived in the grid's last column. The row IS that button now — the
  // separate control was doing what clicking the row already did — so what makes
  // a row pickable is that it is a `.ov-row` button reporting `aria-pressed`.
  for (const [kind, id] of [["station", STATION_ID], ["asteroid", ROCK_ID]] as const) {
    assert.match(
      renderWithEntity(kind, id),
      /<button[^>]*class="ov-row[^"]*"[^>]*aria-pressed=/,
      `a ${kind} row must be a selectable control`,
    );
  }
});

test("R24: Dock is dispatched as the LADDER (dockAt), never the raw dock command", () => {
  // ⚠ RE-POINTED IN R30 SLICE D. The old assertion was the exact source text
  // /flow\.dockAt\(row\.itemID\)/ — which pinned a variable name in markup, not
  // a behaviour, and would have gone on passing or failing for reasons no
  // player could observe.
  //
  // The real claim: dockAt is the ladder (warp, approach, then dock, narrating
  // each phase); flow.dock is the raw single command that fails unless the ship
  // is already in range. The bar must send the one that finishes the job.
  //
  // ⚠ RE-POINTED AGAIN IN R77. The dispatch switch moved out of this panel into
  // `space/rowActionRunner.ts` when the radial menu began dispatching the same
  // verbs from a different component, so the branch to inspect lives there now.
  // The claim is unchanged; only its address is.
  const RUNNER = readFileSync(path.join(UI_DIR, "..", "space", "rowActionRunner.ts"), "utf8");
  const dockBranch = section(RUNNER, 'case "dock"', "case \"jump\"");
  assert.ok(dockBranch.length > 20, "the dock branch must be found in the runner");
  assert.match(dockBranch, /flow\.dockAt\(/, "Dock goes through the ladder");
  assert.doesNotMatch(
    dockBranch,
    /flow\.dock\(/,
    "the raw single command must never be what the row offers",
  );
  // And the raw command appears in neither file.
  assert.equal(/\bflow\.dock\(/.test(SOURCE), false, "flow.dock has no call site in this panel");
  assert.equal(/\bflow\.dock\(/.test(RUNNER), false, "nor in the shared runner");
  assert.equal(/<a\s+href="#/.test(SOURCE), false, "actions are buttons, not fake links");
});

test("R24: the station row keeps the standing invariants (no ids, plain words, data-label)", () => {
  const body = renderWithEntity("station", STATION_ID);
  const text = visibleText(body);
  // ⚠ `\\b`, NOT `\b` — in a template literal `\b` is the BACKSPACE character,
  // so this swept rendered text for a control code and could never fail (R34).
  for (const id of [STATION_ID, SHIP_ID, ORE_TYPE_ID]) {
    assert.equal(new RegExp(`\\b${id}\\b`).test(text), false, `${id} must not be visible`);
  }
  for (const jargon of ["CmdDock", "DockingApproach", "stationID", "surface distance", "bridge"]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" is developer vocabulary`);
  }
  for (const cell of body.match(/<td\b[^>]*>/g) ?? []) {
    assert.match(cell, /data-label="/, `every <td> needs data-label; saw ${cell}`);
  }
});

// --- R24 slices C + D: cycle times and the live hold, as they RENDER ---------

const HOLD_STORE_EVENT = {
  type: "mining/holds" as const,
  holds: [
    {
      key: "ore",
      label: "Ore hold",
      items: [{ itemID: 77000001, typeID: ORE_TYPE_ID, quantity: 350 }],
      capacity: { capacity: 5000, used: 1250 },
      present: true,
      error: null,
    },
    // A hold this hull does not have: no capacity attribute, so it must not
    // be drawn at all — not as an empty bar, not as 0 / 0.
    { key: "ice", label: "Ice hold", items: [], capacity: null, present: false, error: null },
  ],
};

test("R24 slice C: an unknown cycle reads NOT KNOWN, never an instant one", () => {
  const text = visibleText(renderEquipment());
  assert.match(text, /Cycle/, "the equipment table has a cycle column");
  // Nothing has told us this module's cycle length yet.
  assert.match(text, /Not known/);
});

test("R24 slice C: a BASE cycle length says so; a server one does not", () => {
  const baseStore = loadedStore();
  baseStore.apply({ type: "targeting/base-cycles", cycles: { [MODULE_ID]: 15000 } });
  const base = visibleText(render(EquipmentPanel, { props: { store: baseStore, flow: fakeFlow() } }).body);
  assert.match(base, /15s/, "the length is shown");
  assert.match(base, /before skills/, "and it is named as the equipment's own figure");

  const serverStore = loadedStore();
  serverStore.apply({
    type: "targeting/cycle",
    moduleID: MODULE_ID,
    durationMs: 12750,
    running: true,
    repeating: true,
    observedAtMs: Date.now(),
  });
  const server = visibleText(
    render(EquipmentPanel, { props: { store: serverStore, flow: fakeFlow() } }).body,
  );
  assert.match(server, /12\.8s|13s/, "the pilot's real cycle length");
  assert.doesNotMatch(
    server,
    /before skills/,
    "a figure that already HAS the skills in it must not be hedged as if it did not",
  );
});

test("R24 slice D: only holds the hull HAS are drawn, with used out of total", () => {
  const store = loadedStore();
  store.apply(HOLD_STORE_EVENT);
  const text = visibleText(render(Overview, { props: { store, flow: fakeFlow() } }).body);

  assert.match(text, /Ore hold/);
  assert.match(text, /1,250 \/ 5,000 m³/, "used out of total, as the ship reported it");
  assert.doesNotMatch(text, /Ice hold/, "a hold this hull lacks is not rendered at all");
});

test("R24 slice D: a hold the ship could not measure reads NOT KNOWN, not empty", () => {
  const store = loadedStore();
  store.apply({
    type: "mining/holds",
    holds: [
      {
        key: "ore",
        label: "Ore hold",
        items: [{ itemID: 77000001, typeID: ORE_TYPE_ID, quantity: 350 }],
        capacity: null,
        present: false,
        error: null,
      },
    ],
  });
  const text = visibleText(render(Overview, { props: { store, flow: fakeFlow() } }).body);
  assert.match(text, /Ore hold/, "there IS ore in it, so it is shown");
  assert.match(text, /not known/, "but how full it is, is not");
  assert.doesNotMatch(text, /0 \/ 0/, "an unknown reading is never a zero one");
});

test("R24: the new cockpit readouts keep the standing invariants", () => {
  const store = loadedStore();
  store.apply(HOLD_STORE_EVENT);
  store.apply({ type: "targeting/base-cycles", cycles: { [MODULE_ID]: 15000 } });
  const body = render(Overview, { props: { store, flow: fakeFlow() } }).body;
  const text = visibleText(body);

  // R7d — no numeric ids on screen.
  // ⚠ `\\b`, NOT `\b` — see the note on the station-row sweep above (R34).
  for (const id of [ROCK_ID, SHIP_ID, MODULE_ID, ORE_TYPE_ID, LASER_TYPE_ID, 77000001]) {
    assert.equal(new RegExp(`\\b${id}\\b`).test(text), false, `${id} must not be visible`);
  }
  // R9a — plain words, no wire vocabulary.
  for (const jargon of [
    "OnGodmaShipEffect",
    "OnItemsChanged",
    "attribute 73",
    "durationMs",
    "flagID",
    "capacity attribute",
  ]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" is developer vocabulary`);
  }
  // R8 — every cell still carries its narrow-layout label.
  for (const cell of body.match(/<td\b[^>]*>/g) ?? []) {
    assert.match(cell, /data-label="/, `every <td> needs data-label; saw ${cell}`);
  }
});
