<script lang="ts">
  import { onMount } from "svelte";
  import { isSessionLost } from "../app/flow.ts";
  import { nameKey, resolvedName } from "../store/names.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { FleetMember, FleetSquad, FleetWing } from "../bridge/boundFleet.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  let refreshError = $state("");
  let inviteeText = $state("");

  const roster = $derived($fleet.fleet?.initState.value.members ?? []);
  const wings = $derived($fleet.fleet?.initState.value.wings ?? []);
  const joinRequests = $derived($fleet.fleet?.joinRequests.value ?? []);
  const inviteeID = $derived(parseCharacterID(inviteeText));
  const inviteeName = $derived(
    inviteeID === null ? null : ($names.resolved[nameKey("character", inviteeID)] ?? null),
  );
  const busy = $derived($fleet.activeAction !== null);

  function positiveID(value: number | string | null): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  }

  function parseCharacterID(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function memberName(member: FleetMember): string {
    const characterID = positiveID(member.charID);
    if (characterID !== null && characterID === $station.online?.characterID) {
      return $station.online.characterName || "You";
    }
    return resolvedName($names.resolved, "character", characterID, "Fleet member");
  }

  function memberRole(member: FleetMember): string {
    switch (member.role) {
      case 1:
        return "Fleet commander";
      case 2:
        return "Wing commander";
      case 3:
        return "Squad commander";
      default:
        return "Member";
    }
  }

  function memberShip(member: FleetMember): string {
    return resolvedName($names.resolved, "type", positiveID(member.shipTypeID), "Ship unavailable");
  }

  function memberLocation(member: FleetMember): string {
    const stationID = positiveID(member.stationID);
    if (stationID !== null) {
      return resolvedName($names.resolved, "station", stationID, "Docked location unavailable");
    }
    return resolvedName(
      $names.resolved,
      "system",
      positiveID(member.solarSystemID),
      "Location unavailable",
    );
  }

  function memberInSquad(member: FleetMember, squad: FleetSquad): boolean {
    const squadID = positiveID(squad.squadID);
    return squadID !== null && positiveID(member.squadID) === squadID;
  }

  function wingStaff(member: FleetMember, wing: FleetWing): boolean {
    const wingID = positiveID(wing.wingID);
    return (
      member.role !== 1 &&
      wingID !== null &&
      positiveID(member.wingID) === wingID &&
      positiveID(member.squadID) === null
    );
  }

  function fleetCommand(): readonly FleetMember[] {
    return roster.filter(
      (member) =>
        member.role === 1 ||
        (positiveID(member.wingID) === null && positiveID(member.squadID) === null),
    );
  }

  function placedMembers(): Set<FleetMember> {
    const placed = new Set<FleetMember>(fleetCommand());
    for (const wing of wings) {
      for (const member of roster) {
        if (wingStaff(member, wing)) placed.add(member);
      }
      for (const squad of wing.squads) {
        for (const member of roster) {
          if (memberInSquad(member, squad)) placed.add(member);
        }
      }
    }
    return placed;
  }

  function unplacedMembers(): readonly FleetMember[] {
    const placed = placedMembers();
    return roster.filter((member) => !placed.has(member));
  }

  function inviteSender(): string {
    return resolvedName(
      $names.resolved,
      "character",
      $fleet.pendingInvite?.inviterID ?? null,
      "another pilot",
    );
  }

  function confirmAction(message: string): boolean {
    return typeof window !== "undefined" && window.confirm(message);
  }

  function resolveInvitee(): void {
    if (inviteeID !== null) {
      flow.requestNames([{ kind: "character", id: inviteeID }]);
    }
  }

  async function refresh(): Promise<void> {
    refreshError = "";
    try {
      await flow.loadFleet();
    } catch (cause) {
      if (!isSessionLost(cause)) refreshError = "Fleet membership could not be refreshed just now.";
    }
  }

  async function formFleet(): Promise<void> {
    if (confirmAction("Form a new fleet with you in command?")) await flow.formFleet();
  }

  async function acceptInvite(): Promise<void> {
    if (confirmAction(`Accept the fleet invitation from ${inviteSender()}?`)) {
      await flow.acceptFleetInvite();
    }
  }

  async function inviteMember(): Promise<void> {
    if (inviteeID === null) return;
    const who = inviteeName ?? `character ID ${inviteeID}`;
    if (confirmAction(`Invite ${who} to your fleet?`)) {
      await flow.inviteFleetMember(inviteeID);
    }
  }

  async function leaveFleet(): Promise<void> {
    if (confirmAction("Leave your current fleet?")) await flow.leaveFleet();
  }

  onMount(() => {
    void refresh();
  });
</script>

{#snippet memberRow(member: FleetMember)}
  <li class="member-row">
    <div class="member-main">
      <strong>{memberName(member)}</strong>
      <span class="meta">{memberShip(member)} · {memberLocation(member)}</span>
    </div>
    <span class="badge">{memberRole(member)}</span>
  </li>
{/snippet}

<section class="panel" aria-busy={$fleet.loading || busy}>
  <header class="panel-head">
    <div>
      <h2 class="panel-title">Fleet Center</h2>
      <p class="subtitle">Your live fleet roster, command structure, and invitations.</p>
    </div>
    <button type="button" class="primary" disabled={$fleet.loading || busy} onclick={() => void refresh()}>
      {$fleet.loading ? "Refreshing…" : "Refresh"}
    </button>
  </header>

  {#if refreshError}<p class="error">{refreshError}</p>{/if}
  {#if $fleet.readError}<p class="error">{$fleet.readError}</p>{/if}
  {#if $fleet.actionError}<p class="error">{$fleet.actionError}</p>{/if}
  {#if $fleet.activeAction !== null}
    <p class="note">Updating the fleet and checking the authoritative roster…</p>
  {/if}

  {#if !$fleet.loaded}
    <p class="note">Reading your fleet membership…</p>
  {:else if $fleet.availability === "unavailable"}
    <section class="state-card">
      <h3>Fleet status unavailable</h3>
      <p>The companion could not tell whether you are in a fleet. No fleet action is offered until a clean read succeeds.</p>
    </section>
  {:else if $fleet.availability === "not-in-fleet"}
    <section class="state-card empty-state">
      <h3>You are not in a fleet</h3>
      <p>The fleet service explicitly reported no membership for this character.</p>
      <div class="action-row">
        <button type="button" class="primary" disabled={busy} onclick={() => void formFleet()}>
          Form fleet
        </button>
      </div>
    </section>

    <section class="state-card invite-card">
      <h3>Fleet invitation</h3>
      {#if $fleet.pendingInvite === null}
        <p class="empty">No pending invitation has arrived in this live session.</p>
      {:else}
        <p><strong>{inviteSender()}</strong> invited you to join a fleet.</p>
        <button type="button" class="primary" disabled={busy} onclick={() => void acceptInvite()}>
          Accept invitation
        </button>
      {/if}
    </section>
  {:else if $fleet.fleet !== null}
    <section class="fleet-summary">
      <div>
        <span class="eyebrow">Current fleet</span>
        <strong class="count">{roster.length} {roster.length === 1 ? "member" : "members"}</strong>
      </div>
      <button type="button" class="danger" disabled={busy} onclick={() => void leaveFleet()}>
        Leave fleet
      </button>
    </section>

    {#if $fleet.fleet.initState.value.motd || $fleet.fleet.motd.value}
      <section class="state-card motd">
        <h3>Message of the day</h3>
        <p>{$fleet.fleet.motd.value || $fleet.fleet.initState.value.motd}</p>
      </section>
    {/if}

    <section class="state-card invite-card">
      <h3>Invite a pilot</h3>
      <form onsubmit={(event) => { event.preventDefault(); void inviteMember(); }}>
        <label for="fleet-character-id">Character ID</label>
        <div class="invite-controls">
          <input
            id="fleet-character-id"
            inputmode="numeric"
            autocomplete="off"
            placeholder="Enter a character ID"
            bind:value={inviteeText}
            oninput={resolveInvitee}
          />
          <button type="submit" class="primary" disabled={busy || inviteeID === null}>
            Send invitation
          </button>
        </div>
        {#if inviteeID !== null}
          <p class="resolution">
            {inviteeName ? `Resolved pilot: ${inviteeName}` : "Pilot name is not available yet."}
          </p>
        {/if}
      </form>
    </section>

    <section class="hierarchy" aria-label="Fleet hierarchy">
      <h3>Fleet hierarchy</h3>
      {#if roster.length === 0}
        <p class="empty">The fleet roster is empty.</p>
      {:else}
        {@const command = fleetCommand()}
        {#if command.length > 0}
          <section class="command-group">
            <h4>Fleet command</h4>
            <ul>{#each command as member, index (positiveID(member.charID) ?? `command-${index}`)}{@render memberRow(member)}{/each}</ul>
          </section>
        {/if}

        {#each wings as wing, wingIndex (positiveID(wing.wingID) ?? `wing-${wingIndex}`)}
          {@const staff = roster.filter((member) => wingStaff(member, wing))}
          <section class="wing-group">
            <h4>{wing.name || "Wing"}</h4>
            {#if staff.length > 0}
              <ul>{#each staff as member, index (positiveID(member.charID) ?? `staff-${index}`)}{@render memberRow(member)}{/each}</ul>
            {/if}
            <div class="squad-grid">
              {#each wing.squads as squad, squadIndex (positiveID(squad.squadID) ?? `squad-${squadIndex}`)}
                {@const members = roster.filter((member) => memberInSquad(member, squad))}
                <section class="squad-group">
                  <h5>{squad.name || "Squad"}</h5>
                  {#if members.length === 0}
                    <p class="empty">No members assigned.</p>
                  {:else}
                    <ul>{#each members as member, index (positiveID(member.charID) ?? `member-${index}`)}{@render memberRow(member)}{/each}</ul>
                  {/if}
                </section>
              {/each}
            </div>
          </section>
        {/each}

        {@const unplaced = unplacedMembers()}
        {#if unplaced.length > 0}
          <section class="command-group">
            <h4>Unassigned</h4>
            <ul>{#each unplaced as member, index (positiveID(member.charID) ?? `unplaced-${index}`)}{@render memberRow(member)}{/each}</ul>
          </section>
        {/if}
      {/if}
    </section>

    {#if joinRequests.length > 0}
      <section class="state-card">
        <h3>Join requests</h3>
        <ul class="request-list">
          {#each joinRequests as request, index (positiveID(request.charID) ?? index)}
            <li>{resolvedName($names.resolved, "character", positiveID(request.charID), "Applicant")}</li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</section>

<style>
  .panel-head > div { min-width: 0; }
  .subtitle { color: var(--color-muted); margin: 0.2rem 0 0; }
  .state-card,
  .hierarchy,
  .fleet-summary { margin: 0 0 0.75rem; }
  .state-card,
  .hierarchy { border: 1px solid var(--color-row-line); border-radius: 8px; padding: 0.8rem; }
  .state-card h3,
  .hierarchy > h3 { margin-top: 0; }
  .fleet-summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .fleet-summary > div { display: flex; flex-direction: column; }
  .eyebrow { color: var(--color-muted); font-size: 12px; text-transform: uppercase; }
  .count { color: var(--color-text-bright); font-size: 1.3rem; }
  .action-row,
  .invite-controls { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
  .invite-controls input { flex: 1 1 15rem; min-width: 0; }
  .resolution { color: var(--color-muted); font-size: 12px; margin-bottom: 0; }
  .motd p { white-space: pre-wrap; overflow-wrap: anywhere; }
  .command-group,
  .wing-group { border-top: 1px solid var(--color-row-line); padding-top: 0.65rem; margin-top: 0.65rem; }
  .command-group h4,
  .wing-group h4,
  .squad-group h5 { margin: 0 0 0.4rem; }
  .squad-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 0.55rem; }
  .squad-group { background: var(--color-row); border-radius: 6px; padding: 0.55rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  .member-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0; border-bottom: 1px solid var(--color-row-line); }
  .member-row:last-child { border-bottom: 0; }
  .member-main { display: flex; flex-direction: column; min-width: 0; }
  .member-main strong,
  .meta { overflow-wrap: anywhere; }
  .meta { color: var(--color-muted); font-size: 12px; }
  .request-list li { padding: 0.35rem 0; }
  .danger { border-color: var(--color-danger, #b94b55); color: var(--color-danger, #ff8790); }
  @media (max-width: 640px) {
    .fleet-summary,
    .member-row { align-items: stretch; flex-direction: column; }
  }
</style>
