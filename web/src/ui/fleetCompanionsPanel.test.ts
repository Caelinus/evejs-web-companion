// THE FLEET COMPANIONS WINDOW — the global roster, as it actually renders.
//
// ⚠ WHAT A RENDER TEST CAN AND CANNOT SEE HERE. This window reads every
// session's own store through subscriptions in an `$effect`, and it polls the
// server's companions in `onMount`; SSR runs neither. So a rendered roster is
// always the EMPTY one, and the live rows are proven where they can be: the
// words and sums in nav/companionRoster.test.ts, the per-pilot panel in
// fleetCompanionPanel.test.ts, and the structural rules below read off the
// source — which is the same technique fleetCompanionPanel.test.ts uses for the
// sections that must never come back.
//
// What this file is really guarding is the SEPARATION. The companion stopped
// being a bot; if this window ever grows a bot catalogue, or the per-pilot
// panel gets forked into a second readout, the thing that made a fleet readout
// live inside a bot library has simply moved house.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const FleetCompanions = (await import("./FleetCompanions.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "FleetCompanions.svelte"), "utf8");

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function renderWindow(props: Record<string, unknown> = {}): string {
  return render(FleetCompanions as never, { props } as never).body;
}

// ─── it stands up on nothing ─────────────────────────────────────────────────

test("with no pilot signed in it says so, and offers no start it cannot honour", () => {
  const text = visibleText(renderWindow({ sessions: [] }));
  assert.match(text, /No pilot is signed in here/);
  assert.match(text, /Pilot hangar/, "and names where pilots come from");
});

// ─── the roster is built, not mirrored ───────────────────────────────────────

test("⚠ the rows come from the saved op, never from the session list", () => {
  // This is the change the window exists for now. It used to list every pilot
  // signed into the tab automatically, so a pilot brought online to check a
  // contract sat in the fleet roster beside the three you meant.
  assert.match(SOURCE, /roster\.members\.map/);
  assert.doesNotMatch(SOURCE, /pilots\.map\(\(session\) => \{/, "no roster built from sessions");
  assert.match(SOURCE, /loadCompanionRoster|saveCompanionRoster/);
});

test("only pilots already signed in can be added", () => {
  // Bringing one online needs an account password and is the Pilot hangar's
  // job; this window takes pilots that are already flying.
  assert.match(SOURCE, /Add a pilot/);
  assert.match(SOURCE, /const addable = \$derived\(/);
  assert.doesNotMatch(SOURCE, /bringOnline/);
});

test("the op names ONE fleet, for every pilot in it", () => {
  assert.match(SOURCE, /id="companion-op-fleet"/);
  assert.match(SOURCE, /setRosterFleetName/);
});

test("⚠ the limits are asked for once, because adding a pilot STARTS it", () => {
  // A per-pilot form is a form nobody fills in before the start it gates. The
  // six controls that used to live on the per-pilot panel live here now, and
  // the panel is handed the answer.
  for (const control of [
    "companion-flee-floor",
    "companion-cap-floor",
    "companion-flee-attempts",
    "companion-drone-floor",
    "companion-drone-holdoff",
  ]) {
    assert.match(SOURCE, new RegExp(`id="${control}"`));
  }
  assert.match(SOURCE, /setup=\{roster\.setup\}/, "and the embedded panel flies it");
});

test("the drone number inputs are never disabled — there is no useDrones flag to gate them", () => {
  const body = renderWindow({ sessions: [] });
  const droneFloorInput = body.match(/<input[^>]*id="companion-drone-floor"[^>]*>/)?.[0] ?? "";
  const droneHoldoffInput = body.match(/<input[^>]*id="companion-drone-holdoff"[^>]*>/)?.[0] ?? "";
  assert.notEqual(droneFloorInput, "", "the drone floor input must render");
  assert.notEqual(droneHoldoffInput, "", "the drone hold-off input must render");
  assert.doesNotMatch(droneFloorInput, /disabled/);
  assert.doesNotMatch(droneHoldoffInput, /disabled/);
});

// ─── the join, which is the other half of adding a pilot ─────────────────────

test("⚠ the join is APPLY then ACCEPT, never an apply that waits for membership", () => {
  // The defect docs/join-advertised-fleet-handoff.md records: an apply mints an
  // INVITE and notifies the applicant; membership happens only when the client
  // accepts it. A driver that applied and waited hangs on a healthy fleet.
  assert.match(SOURCE, /applyToJoinFleet/);
  assert.match(SOURCE, /acceptFleetInvite\(verdict\.action\.fleetID\)/);
});

test("every rule about joining lives in the decider, not in this component", () => {
  // The window performs and reports; nav/fleetJoinWatch.ts decides. A component
  // cannot be tested against a fleet finder that is empty for three minutes.
  assert.match(SOURCE, /decideFleetJoin/);
  assert.doesNotMatch(SOURCE, /pickAdvertisedFleet/, "matching belongs to the decider");
});

test("⚠ the watch is driven by each pilot's OWN flow", () => {
  assert.match(SOURCE, /session\.flow\.applyToJoinFleet/);
  assert.match(SOURCE, /session\.flow\.acceptFleetInvite/);
  assert.match(SOURCE, /session\.flow\.startFleetCompanion/);
});

test("⚠ a flying companion's own fleet reading is used, not re-fetched every beat", () => {
  // `loadFleet` is five bridge reads. A companion that is flying reads its own
  // fleet every tick and reports what it saw, so paying for a second copy per
  // pilot per beat is the pile-up skipWhileBusy's header is about, arriving
  // from the other direction.
  assert.match(SOURCE, /if \(runReading !== true\) \{/);
  assert.match(SOURCE, /inFleetFrom\(fleetSlice\.availability/);
});

test("⚠ a refused apply is reported, not silently retried for ever", () => {
  // The swallowing is what cost an afternoon last time: a watch that retries
  // quietly shows the same patient sentence whether the fleet is merely not
  // advertised yet or every apply is being refused outright.
  assert.match(SOURCE, /refusal = panelErrorWords\(cause\)/);
  assert.match(SOURCE, /row\.joinRefusal/);
});

test("⚠ a start that the player stopped is not started again ten seconds later", () => {
  // Adding a pilot starts it, so the tick needs a latch — otherwise Stop (and
  // Stop all) would undo itself on the next beat.
  assert.match(SOURCE, /readonly started: boolean/);
  assert.match(SOURCE, /verdict\.state === "watching" \? false : watch\.started/);
});

test("⚠ a companion that stood down alone is not dragged back into the fleet", () => {
  // The abandonment protocol ends by releasing the ship; a watch that read that
  // as "not in the fleet" would rejoin, be alone again, and stand down again
  // half an hour later, for ever.
  assert.match(SOURCE, /stoodDown/);
  assert.match(SOURCE, /companion\?\.abandonment != null/);
});

test("⚠ removing a pilot stops it AND takes it out of the fleet", () => {
  // Removing undoes the add, membership included: leaving a ship in a fleet
  // warp chain that nothing on this screen is watching any more is the one
  // outcome a removal must not have.
  assert.match(SOURCE, /session\.flow\.stopFleetCompanion\(\);/);
  assert.match(SOURCE, /session\.flow\.leaveFleet\(\)/);
  assert.match(SOURCE, /removeRosterMember/);
});

test("Stop all stops, and does NOT disband", () => {
  // A stop is how you take a ship back by hand mid-op; pulling it out of the
  // fleet as well is the one thing you would not want at that moment.
  const at = SOURCE.indexOf("async function stopAll");
  assert.notEqual(at, -1, "the function this test is about must exist");
  const body = SOURCE.slice(at, SOURCE.indexOf("\n  }", at));
  assert.match(body, /stopFleetCompanion/, "and it must be the body that stops things");
  assert.doesNotMatch(body, /leaveFleet/);
});

test("Stop all is dead while there is nothing to stop", () => {
  // ⚠ NOT MERELY COSMETIC. This button reaches across every pilot and every
  // headless run at once; an enabled one on an empty roster invites a click
  // whose only possible outcome is a confusing no-op.
  assert.match(renderWindow({ sessions: [] }), /disabled/);
});

test("it renders without a flow at all, rather than throwing", () => {
  // Harnesses and the mobile panel host may mount it before a pilot's flow
  // exists; the server-roster read is the only thing that needs one, and it is
  // guarded rather than assumed.
  const text = visibleText(renderWindow({}));
  assert.match(text, /Fleet companions/);
});

// ─── R9a / R7d: the standing invariants ──────────────────────────────────────

test("R7d — no bare numeric id reaches the player", () => {
  const text = visibleText(renderWindow({ sessions: [] }));
  assert.doesNotMatch(text, /\b\d{4,}\b/);
});

test("R9a — the empty state is a sentence, not a state token", () => {
  const text = visibleText(renderWindow({ sessions: [] }));
  assert.doesNotMatch(text, /\bidle\b/);
  assert.doesNotMatch(text, /\bnull\b/);
});

// ─── the separation this window exists to make ───────────────────────────────

test("⚠ it embeds the REAL per-pilot panel and forks no second readout", () => {
  // A second copy of a readout drifts, and a drifted readout does not go quiet:
  // it keeps rendering, confidently, about a companion doing something else.
  assert.match(SOURCE, /import FleetCompanion from ".\/FleetCompanion.svelte"/);
  assert.match(SOURCE, /<FleetCompanion\s+store=\{selectedSession.store\}/);
});

test("⚠ the embedded panel is KEYED on the pilot it is for", () => {
  // `FleetCompanion.svelte` binds its store's slices once at init, so handing a
  // live instance another pilot's store changes nothing: it would go on
  // rendering the previous pilot, under the new one's name. The `{#key}` is
  // what forces the remount. CharacterBar.svelte keys its one chip for exactly
  // this reason.
  assert.match(SOURCE, /\{#key selectedSession\.id\}/);
});

test("it knows nothing about the bot catalogue", () => {
  // The companion is not a bot: no `BOTS`, no script library, no picker. The
  // one thing it borrows from that layer is `holdsTheShip`, which is about
  // ownership of a hull and not about bots at all.
  assert.doesNotMatch(SOURCE, /\bBOTS\b/);
  assert.doesNotMatch(SOURCE, /listBotScripts|BotScriptSummary/);
  assert.match(SOURCE, /holdsTheShip/);
});

test("it reads each session's OWN store, never the active pilot's", () => {
  // The whole point of the window: what another pilot is doing while you are
  // looking at this one. Reading the mounted store would report the active
  // pilot's companion on every row.
  assert.match(SOURCE, /session\.store\.companion\.subscribe/);
  // The lookbehind is what makes this test mean anything: `session.store.…` is
  // the right read and a bare `store.…` is the wrong one, and a plain substring
  // match cannot tell them apart.
  assert.doesNotMatch(SOURCE, /(?<![.\w])store\.\w+/, "no mounted-store reads");
});

test("a pilot's own flow drives that pilot, never another's", () => {
  // A window that reached across pilots with one pilot's flow would stop the
  // wrong ship — the one failure mode a multibox roster must not have.
  assert.match(SOURCE, /row\.session\.flow\.stopFleetCompanion\(\)/);
});

test("the headless half is polled, not read once and trusted", () => {
  // A server companion changes phase, joins a fleet and hits its runtime cap
  // with no local event to notice; a frozen "Running" is a lie a player acts on.
  assert.match(SOURCE, /SERVER_ROSTER_POLL_MS/);
  assert.match(SOURCE, /listServerBots/);
});

test("⚠ a headless companion can still be STOPPED from here", () => {
  // The Bot Manager used to be the only screen that could stop one. It no
  // longer shows companions at all, so if this goes, a companion flying on the
  // server has no door anywhere in the app.
  assert.match(SOURCE, /stopServerBot/);
});

test("a server run is not offered a setup form it cannot apply", () => {
  // Its limits were taken when it was started from the Pilot hangar; fields
  // here would change numbers that reach nothing.
  assert.match(SOURCE, /NO SETUP FORM, AND THAT IS NOT AN OVERSIGHT/);
});

test("⚠ THE ROSTER IS FIVE COLUMNS, AND 'CAN TAG' IS NOT ONE OF THEM", () => {
  // A column head is a label, not a sentence: "Following orders from" and
  // "Last order heard" were each about twice the width of the value beneath
  // them. And the Can tag column printed a verdict on every row that was "yes"
  // for nearly every pilot nearly always — a column whose interesting value is
  // rare is one a player stops reading before the day it matters.
  const heads = [...SOURCE.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Pilot", "Companion", "In fleet", "Orders from", "Last order"]);
});

test("⚠ DROPPING THE COLUMN DID NOT DROP THE FACT, OR FLATTEN ITS THREE STATES", () => {
  // This is the whole risk of removing that column. The server drops a
  // non-commander's tag while answering ok, so a companion that CANNOT tag
  // looks exactly like one with nothing to tag — and `null` means "could not
  // tell", which must never be read as "no" (see canTagWords). Both failing
  // states still reach the roster, in the Companion cell, in their own words;
  // only a plain "yes" is now silent.
  assert.match(SOURCE, /canTag === false/, "a pilot that cannot tag says nothing");
  assert.match(SOURCE, /cannot tag, not a fleet commander/);
  assert.match(SOURCE, /tagging not known/, "an unknown tag verdict is being flattened away");
  // Both halves of the roster carry it: a server-flown companion has nobody
  // sitting in front of it to notice its tags going nowhere.
  assert.equal(
    (SOURCE.match(/cannot tag, not a fleet commander/g) ?? []).length,
    2,
    "only one of the tab rows and the server rows reports a failed tag",
  );
});
