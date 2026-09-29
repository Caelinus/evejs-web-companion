<script lang="ts">
  import { untrack } from "svelte";
  import type { TrainingSettings, TrainingCorporation, TrainingAuthority, TrainingHomeMatch } from "../training/settings.ts";
  let { settings, corporations, authorities, homeAccessPilots = [], homeAccessPilot = $bindable(""), busy, contextError = "", onSave, onResolve, onSearch }: {
    settings: TrainingSettings; corporations: readonly TrainingCorporation[]; authorities: readonly TrainingAuthority[];
    homeAccessPilots?: readonly { key: string; label: string }[]; homeAccessPilot?: string;
    busy: boolean; contextError?: string; onSave: (value: TrainingSettings) => void;
    onResolve: (id: number) => Promise<TrainingSettings["home"]>;
    onSearch: (query: string) => Promise<{ matches: TrainingHomeMatch[]; capped: boolean; structureWarning?: string | null }>;
  } = $props();
  let enabled = $state(untrack(() => settings.onboarding.enabled)), corporation = $state(untrack(() => String(settings.onboarding.corporationID || "")));
  let rights = $state(untrack(() => settings.onboarding.rights)), authority = $state(untrack(() => settings.onboarding.authorityKey));
  let walletCorp = $state(untrack(() => String(settings.trainingWallet?.corporationID || ""))), walletKey = $state(untrack(() => String(settings.trainingWallet?.accountKey || "")));
  let home = $state<TrainingSettings["home"]>(untrack(() => settings.home)), message = $state("");
  let search = $state(""), matches = $state<TrainingHomeMatch[]>([]), searching = $state(false), capped = $state(false), searched = $state(false);
  $effect(() => {
    enabled = settings.onboarding.enabled; corporation = String(settings.onboarding.corporationID || "");
    rights = settings.onboarding.rights; authority = settings.onboarding.authorityKey;
    walletCorp = String(settings.trainingWallet?.corporationID || ""); walletKey = String(settings.trainingWallet?.accountKey || ""); home = settings.home;
  });
  const selectedCorporation = $derived(corporations.find((c) => c.corporationID === Number(corporation)));
  const eligible = $derived(authorities.filter((a) => a.eligible && a.corporationID === Number(corporation)));
  const selectedAuthority = $derived(authorities.find((a) => a.key === authority));
  const differentWalletCorp = $derived(!!walletCorp && walletCorp !== corporation);
  const walletOwner = $derived(corporations.find((c) => c.corporationID === Number(walletCorp || corporation)));
  const divisions = $derived(walletOwner?.divisions || []);
  const authorityValid = $derived(eligible.some((a) => a.key === authority));
  const invalid = $derived((!!corporation && !selectedCorporation) || (enabled && (!selectedCorporation || !authorityValid)) ||
    (!!walletKey && (!walletOwner || !divisions.some((d) => String(d.accountKey) === walletKey))));
  function changeCorporation(value: string) {
    if (!walletCorp || walletCorp === corporation) walletCorp = value;
    corporation = value;
    message = "Review the onboarding authority and wallet for this corporation before saving.";
  }
  async function searchHome() {
    searching = true; searched = false; message = ""; matches = [];
    try { const result = await onSearch(search.trim()); matches = result.matches; capped = result.capped; searched = true;
      if (result.structureWarning) message = result.structureWarning; }
    catch { message = "Dockable destination search is unavailable. Existing home has been preserved."; }
    finally { searching = false; }
  }
  async function chooseHome(id: number) {
    searching = true;
    try { const resolved = await onResolve(id); if (!resolved) throw new Error(); home = resolved; matches = []; search = ""; searched = false; message = "Home selected. Save to keep this change."; }
    catch { message = "This home could not be resolved. Existing home has been preserved."; }
    finally { searching = false; }
  }
  function save() {
    if (invalid || busy || searching) return;
    onSave({ onboarding: { enabled, corporationID: corporation ? Number(corporation) : null, rights, authorityKey: authority },
      trainingWallet: walletKey ? { corporationID: Number(walletCorp || corporation), accountKey: Number(walletKey) } : null, home });
    message = "Training settings submitted. Any save error is shown on the page.";
  }
</script>
<details class="settings"><summary>Pilot Training settings</summary>
  <p>Saved in this browser. Authenticate the relevant accounts to load corporation and authority choices.</p>
  {#if contextError}<p class="notice">{contextError} Saved settings are preserved.</p>{/if}
  <label class="check"><input type="checkbox" bind:checked={enabled} disabled={busy} /> Automatic corporation onboarding</label>
  <div class="fields">
    <label>Corporation <select value={corporation} disabled={busy} onchange={(event) => changeCorporation(event.currentTarget.value)}>
      <option value="">Unconfigured</option>
      {#if corporation && !selectedCorporation}<option value={corporation}>Saved corporation — unavailable; authenticate a member</option>{/if}
      {#each corporations as corp}<option value={String(corp.corporationID)}>{corp.name}</option>{/each}
    </select></label>
    <label>Onboarding authority <select bind:value={authority} disabled={busy || !selectedCorporation}>
      <option value="">Choose a dedicated character</option>
      {#if authority && !authorityValid}<option value={authority}>{selectedAuthority?.name ?? "Saved authority"} — unavailable or not eligible</option>{/if}
      {#each eligible as actor}<option value={actor.key}>{actor.name}{eligible.filter((a) => a.name === actor.name).length > 1 ? ` · ${actor.account}` : ""}</option>{/each}
    </select></label>
    <label>New member permissions <select bind:value={rights} disabled={busy}>
      <option value="NONE">No additional permissions</option><option value="FULL_ACCESS_EXCEPT_CEO">Full access (except CEO)</option>
    </select></label>
    <label>Training wallet <select bind:value={walletKey} disabled={busy || !walletOwner}>
      <option value="">Unconfigured</option>
      {#if walletKey && !divisions.some((d) => String(d.accountKey) === walletKey)}<option value={walletKey}>Saved division — unavailable</option>{/if}
      {#each divisions as division}<option value={String(division.accountKey)}>{division.name}</option>{/each}
    </select></label>
  </div>
  <p>Full access grants ordinary corporation rights and delegation. It does not transfer CEO ownership or promote the trainee to Director. The authority must be a dedicated non-CEO Director; busy pilots are never taken over.</p>
  <p>Funding is opt-in and covers only the reviewed shortfall. Wallet permissions and balances are checked again before any transfer.</p>
  {#if differentWalletCorp}<p class="notice">A different wallet corporation is saved. Review it under Advanced details; funding still requires matching trainee membership.</p>{/if}
  <label>Check structure access as pilot
    <select bind:value={homeAccessPilot} disabled={busy || searching}>
      <option value="">NPC station search only</option>
      {#each homeAccessPilots as pilot}<option value={pilot.key}>{pilot.label}</option>{/each}
    </select>
  </label>
  <label>Training / provisioning home
    <input bind:value={search} disabled={busy || searching} placeholder="Search NPC stations or accessible structures…" onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (search.trim().length >= 2) void searchHome(); } }} />
  </label>
  <button class="minor" type="button" disabled={busy || searching || search.trim().length < 2} onclick={searchHome}>{searching ? "Searching…" : "Search destinations"}</button>
  {#if matches.length}<ul class="matches">{#each matches as match}<li><button type="button" class="minor" disabled={busy || searching} onclick={() => chooseHome(match.id)}>{match.name} · {match.kind === "structure" ? "Upwell structure" : "NPC station"}{match.solarSystemName ? ` · ${match.solarSystemName}` : ""}</button></li>{/each}</ul>
  {:else if searched}<p>No matching dockable destinations.</p>{/if}
  {#if capped && searched}<p>Showing 25 results. Refine your search.</p>{/if}
  <p>Selected: <strong>{home?.name ?? "Unconfigured"}</strong></p>
  {#if home}<button class="minor" type="button" disabled={busy || searching} onclick={() => home = null}>Clear home</button>{/if}
  <p>Home is configuration only; saving does not move pilots. NPC stations support manual GM relocation. Player-structure relocation remains a separate unverified workflow.</p>
  <button type="button" disabled={busy || searching || invalid} onclick={save}>Save training settings</button>
  {#if invalid}<p class="notice">Resolve unavailable choices or select an eligible authority before saving.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <details class="advanced"><summary>Advanced details</summary>
    <dl><dt>Corporation ID</dt><dd>{corporation || "Unconfigured"}</dd>
      <dt>Authority identity</dt><dd>{authority || "Unconfigured"}</dd>
      <dt>Rights policy</dt><dd>{rights}</dd>
      <dt>Wallet corporation ID / accountKey</dt><dd>{walletCorp || corporation || "Unconfigured"} / {walletKey || "Unconfigured"}</dd>
      <dt>Home location ID / system ID / kind</dt><dd>{home ? `${home.locationID} / ${home.systemID ?? "Unknown"} / ${home.kind}` : "Unconfigured"}</dd></dl>
    {#if differentWalletCorp}<button type="button" class="minor" disabled={busy} onclick={() => walletCorp = corporation}>Use selected corporation for training wallet</button>{/if}
  </details>
</details>
<style>
  .settings { margin:1rem 0; border:1px solid #455569; padding:1rem; } summary { cursor:pointer; }
  .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:1rem; margin:1rem 0; }
  label { display:flex; flex-direction:column; gap:.4rem; } .check { flex-direction:row; }
  input,select { background:#16202e; color:#e4edf7; padding:.5rem; border:1px solid #455569; } p { max-width:90ch; }
  button { margin:.4rem .5rem .4rem 0; } .notice { color:#e9c982; } .matches { max-height:16rem; overflow:auto; padding-left:1rem; }
  .advanced { margin-top:1rem; } dl { display:grid; grid-template-columns:max-content 1fr; gap:.4rem 1rem; } dd { margin:0; overflow-wrap:anywhere; }
</style>
