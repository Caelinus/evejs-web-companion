import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { readTrainingSettings, saveTrainingSettings, defaultTrainingSettings, type TrainingSettings } from "../training/settings.ts";
register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const Settings = (await import("./TrainingSettings.svelte")).default;
const NewTrainee = (await import("./NewTrainee.svelte")).default;
const settings: TrainingSettings = {
  onboarding: { enabled: true, corporationID: 98000002, authorityKey: '["BHauler1",140000022]', rights: "FULL_ACCESS_EXCEPT_CEO" },
  trainingWallet: { corporationID: 98000002, accountKey: 1000 },
  home: { locationID: 60010825, name: "4C-B7X V - Moon 7 - Chemal Tech Factory", systemID: 30004504, kind: "NPC_STATION", relocation: "MANUAL_GM_ONLY", capability: "DOCKABLE_STATION" },
};
const props = { settings, busy: false,
  corporations: [{ corporationID: 98000002, name: "Marked By Luck", divisions: [{ accountKey: 1000, name: "Division 1" }] }],
  authorities: [{ key: settings.onboarding.authorityKey, name: "BHauler1", account: "BHauler1", corporationID: 98000002, eligible: true },
    { key: "ceo", name: "CEO must not appear", account: "CEO", corporationID: 98000002, eligible: false }],
  onSave() {}, async onResolve() { return settings.home; }, async onSearch() { return { matches: [], capped: false }; },
};
test("settings render names with stored IDs only as option values or collapsed read-only details", () => {
  const html = render(Settings, { props }).body, normal = html.split('<details class="advanced')[0]!;
  for (const label of ["Marked By Luck", "BHauler1", "Full access (except CEO)", "Division 1", settings.home!.name, "Search NPC stations or accessible structures"]) assert.ok(normal.includes(label), label);
  assert.doesNotMatch(normal, /CEO must not appear|Onboarding corporation ID|Training wallet corporation ID|\(1000\)|>FULL_ACCESS_EXCEPT_CEO</);
  assert.doesNotMatch(normal, /<input[^>]*value="(?:98000002|60010825|1000)"/);
  assert.match(html, /Advanced details/); assert.match(html, /<dd[^>]*>98000002<\/dd>/); assert.match(html, /60010825 \/ 30004504 \/ NPC_STATION/);
  assert.match(html, /value="1000" selected/); assert.match(html, /value="FULL_ACCESS_EXCEPT_CEO" selected/);
});
test("legacy v1 settings survive load/save/F5 unchanged; unavailable context keeps saved IDs and blocks unsafe save", () => {
  const data = new Map([["pilot-training:settings:v1", JSON.stringify(settings)]]);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) };
  const before = readTrainingSettings(storage); saveTrainingSettings(storage, before);
  assert.deepEqual(readTrainingSettings(storage), settings); assert.equal(data.size, 1);
  const html = render(Settings, { props: { ...props, corporations: [], authorities: [] } }).body;
  assert.match(html, /Saved corporation/); assert.match(html, /Saved authority/); assert.match(html, /Saved division/);
  assert.match(html, /button[^>]*disabled[^>]*>Save training settings/);
  assert.equal(defaultTrainingSettings().onboarding.enabled, false);
});
test("wallet inherits selected corporation without a second numeric input; home search resolves selection before save", () => {
  const source = readFileSync(new URL("./TrainingSettings.svelte", import.meta.url), "utf8");
  assert.match(source, /if \(!walletCorp \|\| walletCorp === corporation\) walletCorp = value/);
  assert.match(source, /corporationID: Number\(walletCorp \|\| corporation\)/);
  assert.match(source, /await onSearch\(search.trim\(\)\)/); assert.match(source, /await onResolve\(id\)/);
  assert.doesNotMatch(source, /bind:value=\{(?:homeID|walletCorp|corporation)\}[^>]*input|type="number"/);
});
test("new trainee form clearly separates account creation from existing character creator", () => {
  const html = render(NewTrainee, { props: { onContinue() {}, onCancel() {}, onBusy() {} } }).body;
  for (const text of ["Account name", "Password", "Confirm password", "Use account name as initial character name", "Character name", "Create account and continue", "does not store a login password"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /CreateCharacterWithDoll|SelectCharacterID|readSpaceSnapshot/);
});


test("new account form refuses competing page actions while parent is busy", () => {
  const html = render(NewTrainee, { props: { externalBusy: true, onContinue() {}, onCancel() {}, onBusy() {} } }).body;
  assert.match(html, /input[^>]*disabled/); assert.match(html, /button[^>]*disabled[^>]*>Cancel/);
  const source = readFileSync(new URL("./NewTrainee.svelte", import.meta.url), "utf8");
  assert.match(source, /if \(locked \|\| recoveryUnreadable\) return/);
});
