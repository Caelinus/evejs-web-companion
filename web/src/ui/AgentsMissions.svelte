<script lang="ts">
  // Agents & Missions page (goal R4; extended for the R6 courier capstone): the
  // docked station's agents (with a courier/level/text filter + capped render so
  // the page stays responsive with ~1,700 agents), an agent conversation,
  // accepting a courier in person, the mission briefing (with load-package-into-
  // ship + set-autopilot-to-dropoff controls), Complete, and the post-completion
  // wallet / LP / standings readout. A pure reader of the store; all bind /
  // DoAction / GetMission* / Step-12 logic lives on the BFF (which holds the
  // bound agent handle) and in app/flow.ts. The browser addresses agents and
  // missions by their game IDs only.
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AgentAction, AgentRow, JournalMission } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  // R36 — the mission bot sits with the agents it works for.
  import MissionBot from "./MissionBot.svelte";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const agents = store.agents;
  // svelte-ignore state_referenced_locally
  const rewards = store.rewards;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");

  // Agent-roster filter (the live-test found the raw ~1,678-agent render — Jita
  // 4-4 alone has 882 courier agents — strains the browser). Default to
  // courier-only since that is the milestone; the render is capped and the count
  // is shown so the operator can refine rather than scroll a 1,700-row list.
  const RENDER_CAP = 60;
  let courierOnly = $state(true);
  let levelFilter = $state("all");
  let searchText = $state("");

  const filteredAgents = $derived.by<AgentRow[]>(() => {
    const query = searchText.trim().toLowerCase();
    const level = levelFilter === "all" ? null : Number(levelFilter);
    return $agents.agents.filter((agent) => {
      if (courierOnly && (agent.missionKind ?? "").toLowerCase() !== "courier") {
        return false;
      }
      if (level !== null && agent.level !== level) {
        return false;
      }
      if (query) {
        const haystack = [
          String(agent.agentID),
          agent.missionKind ?? "",
          agent.missionTypeLabel ?? "",
          `l${agent.level ?? ""}`,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
      return true;
    });
  });
  const cappedAgents = $derived(filteredAgents.slice(0, RENDER_CAP));

  // R7c — resolve names for everything the page shows by ID: the rendered agents
  // + the open conversation + journal agents (→ agent names), the briefing's
  // cargo type / pickup / destination (→ type + station + system names), and the
  // reward LP corps + standings (→ corp / owner names). Batched + cached by the
  // flow; fire-and-forget so IDs render immediately and swap to names as they land.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const agent of cappedAgents) {
      refs.push({ kind: "agent", id: agent.agentID });
    }
    if ($agents.activeAgentID) {
      refs.push({ kind: "agent", id: $agents.activeAgentID });
    }
    const journal = $agents.journal;
    if (journal) {
      for (const mission of [...journal.active, ...journal.offered]) {
        if (mission.agentID) {
          refs.push({ kind: "agent", id: mission.agentID });
        }
      }
    }
    const briefing = $agents.briefing;
    if (briefing) {
      if (briefing.cargoTypeID) {
        refs.push({ kind: "type", id: briefing.cargoTypeID });
      }
      for (const stationID of [briefing.pickupLocationID, briefing.destinationLocationID]) {
        if (stationID) {
          refs.push({ kind: "station", id: stationID });
        }
      }
      for (const systemID of [briefing.pickupSystemID, briefing.destinationSystemID]) {
        if (systemID) {
          refs.push({ kind: "system", id: systemID });
        }
      }
    }
    for (const lp of $rewards.lpBalances) {
      refs.push({ kind: "corporation", id: lp.issuerCorpID });
    }
    for (const standing of $rewards.standings) {
      refs.push({ kind: "owner", id: standing.fromID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run(async () => {
      await flow.loadAgents();
      await flow.loadJournal();
    });
  });

  // Agent name (R7c/R7d) from the name cache — never the raw agent ID (it stays
  // in the onclick / key args); "—" until it resolves.
  function agentName(agentID: number | null): string {
    return resolvedName($names.resolved, "agent", agentID, "—");
  }

  function agentLabel(agent: AgentRow): string {
    const kind = agent.missionKind ? ` · ${agent.missionKind}` : "";
    const name = resolvedName($names.resolved, "agent", agent.agentID, "Agent");
    return `${name} (L${agent.level ?? "?"}${kind})`;
  }

  function stationText(id: number | null): string {
    return resolvedName($names.resolved, "station", id, "—");
  }

  function systemText(id: number | null): string {
    return resolvedName($names.resolved, "system", id, "—");
  }

  function missionLabel(mission: JournalMission): string {
    const type = mission.missionTypeLabel ? mission.missionTypeLabel.split("/").pop() : "Mission";
    // missionTitleID is a localization message id with no static name and no
    // player value, so it is not rendered (R7d: drop nameless IDs).
    return `${type} · ${agentName(mission.agentID)}`;
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Agents &amp; Missions</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => run(async () => { await flow.loadAgents(); await flow.loadJournal(); })}>
        Refresh
      </button>
    </p>
  </header>
  {#if $agents.actionError}
    <p class="error">Last agent action failed: {$agents.actionError}</p>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<section>
  <h2>Station agents</h2>
  <div class="agent-filter">
    <label>
      <input type="checkbox" bind:checked={courierOnly} />
      Courier only
    </label>
    <label>
      Level
      <select bind:value={levelFilter}>
        <option value="all">All</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
      </select>
    </label>
    <label>
      Search
      <input type="search" placeholder="mission type or level" bind:value={searchText} />
    </label>
  </div>
  {#if $agents.agents.length === 0}
    <p class="empty">{$agents.loaded ? "No agents at this station." : "Loading agents…"}</p>
  {:else}
    <p class="note">
      Showing {cappedAgents.length} of {filteredAgents.length} matching
      ({$agents.agents.length} at this station).
      {#if filteredAgents.length > cappedAgents.length}
        Refine the filter to narrow the list.
      {/if}
    </p>
    {#if cappedAgents.length === 0}
      <p class="empty">No agents match the filter.</p>
    {:else}
      <ul class="agent-list">
        {#each cappedAgents as agent (agent.agentID)}
          <li>
            <button
              type="button"
              class:active={agent.agentID === $agents.activeAgentID}
              disabled={busy}
              onclick={() => run(() => flow.openConversation(agent.agentID))}
            >
              {agentLabel(agent)}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if $agents.conversation}
  <section>
    <h2>Conversation · {agentName($agents.activeAgentID)}</h2>
    <p class="agent-says">{$agents.conversation.agentSays}</p>
    <p class="controls">
      {#each $agents.conversation.actions as action (action.actionID)}
        <button
          type="button"
          disabled={busy}
          onclick={() => run(() => flow.chooseAction($agents.activeAgentID as number, action as AgentAction))}
        >
          {action.label}
        </button>
      {/each}
      {#if $agents.conversation.actions.length === 0}
        <span class="note">No actions available.</span>
      {/if}
    </p>
    {#if $agents.conversation.lastActionInfo.missionCompleted}
      <p class="note">Mission completed — reward applied.</p>
    {/if}
    {#if $agents.conversation.lastActionInfo.missionDeclined}
      <p class="note">Mission declined.</p>
    {/if}
  </section>
{/if}

{#if $agents.briefing}
  <section>
    <h2>Courier briefing</h2>
    <table class="guests">
      <tbody>
        <tr><th>Cargo type</th><td>{resolvedName($names.resolved, "type", $agents.briefing.cargoTypeID, "—")}</td></tr>
        <tr><th>Quantity</th><td class="num">{$agents.briefing.cargoQuantity ?? "—"}</td></tr>
        <tr><th>Volume (m³)</th><td class="num">{$agents.briefing.cargoVolume ?? "—"}</td></tr>
        <tr><th>Pickup</th><td>{stationText($agents.briefing.pickupLocationID)} · {systemText($agents.briefing.pickupSystemID)}</td></tr>
        <tr><th>Destination</th><td>{stationText($agents.briefing.destinationLocationID)} · {systemText($agents.briefing.destinationSystemID)}</td></tr>
        <tr><th>Reward (ISK)</th><td class="num">{$agents.briefing.rewardISK ?? "—"}</td></tr>
        <tr><th>Time bonus (ISK)</th><td class="num">{$agents.briefing.bonusISK ?? "—"}</td></tr>
        <tr><th>Loyalty points</th><td class="num">{$agents.briefing.loyaltyPoints ?? "—"}</td></tr>
      </tbody>
    </table>
    <p class="controls">
      <button
        type="button"
        disabled={busy || $agents.briefing.cargoTypeID === null}
        onclick={() =>
          run(() =>
            flow.loadPackageIntoShip(
              $agents.briefing!.cargoTypeID as number,
              ($agents.briefing!.cargoQuantity ?? 1) as number,
            ),
          )}
      >
        Load package into ship
      </button>
      <button
        type="button"
        disabled={busy || $agents.briefing.destinationLocationID === null}
        onclick={() => run(() => flow.setAutopilotToDropoff($agents.briefing!.destinationLocationID as number))}
      >
        Set autopilot to dropoff
      </button>
    </p>
    <p class="note">
      Load the package into the active ship, autopilot to the dropoff station,
      dock, then Complete Mission in the agent conversation.
    </p>
  </section>
{/if}

{#if $rewards.loaded}
  <section>
    <h2>Reward &amp; wallet</h2>
    {#if $rewards.error}
      <p class="error">Some reward details could not be loaded: {$rewards.error}</p>
    {/if}
    <table class="guests">
      <tbody>
        <tr><th>Wallet balance (ISK)</th><td class="num">{$rewards.cashBalance ?? "—"}</td></tr>
      </tbody>
    </table>
    <h3 class="note">Loyalty points ({$rewards.lpBalances.length})</h3>
    {#if $rewards.lpBalances.length === 0}
      <p class="empty">No loyalty-point balances.</p>
    {:else}
      <ul class="journal">
        {#each $rewards.lpBalances as lp (lp.issuerCorpID)}
          <li>{resolvedName($names.resolved, "corporation", lp.issuerCorpID, "—")} · {lp.loyaltyPoints} LP</li>
        {/each}
      </ul>
    {/if}
    <h3 class="note">Standings ({$rewards.standings.length})</h3>
    {#if $rewards.standings.length === 0}
      <p class="empty">No standings.</p>
    {:else}
      <ul class="journal">
        {#each $rewards.standings as standing (standing.fromID)}
          <li>toward {resolvedName($names.resolved, "owner", standing.fromID, "—")} · {standing.standing}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<section>
  <h2>Mission journal</h2>
  {#if !$agents.journal}
    <p class="note">Loading journal…</p>
  {:else}
    <h3 class="note">Active ({$agents.journal.active.length})</h3>
    {#if $agents.journal.active.length === 0}
      <p class="empty">No active missions.</p>
    {:else}
      <ul class="journal">
        {#each $agents.journal.active as mission (mission.missionID)}
          <li>{missionLabel(mission)}</li>
        {/each}
      </ul>
    {/if}
    <h3 class="note">Offered ({$agents.journal.offered.length})</h3>
    {#if $agents.journal.offered.length === 0}
      <p class="empty">No offered missions.</p>
    {:else}
      <ul class="journal">
        {#each $agents.journal.offered as mission (mission.missionID)}
          <li>{missionLabel(mission)}</li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<MissionBot {store} {flow} />
