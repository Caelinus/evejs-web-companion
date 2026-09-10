<script lang="ts">
  // Self-contained Scanner / Exploration Center. It reads typed props only:
  // no store, flow, API, or route import. The current SPA has site reads but no
  // scanner slice or active-probe geometry, so absent action bindings remain
  // visibly unavailable instead of being guessed from an empty object.
  import type { ScanFullState } from "../bridge/boundSmallServices.ts";
  import type { FormationsResult } from "../bridge/formations.ts";
  import {
    SCANNER_ACTION_IDS,
    buildScannerFormationView,
    buildScannerSitesView,
    scannerActionAvailability,
    type ScannerActionBindings,
    type ScannerActionID,
    type ScannerDataState,
    type ScannerNameCatalog,
  } from "../scanner/scannerCenter.ts";

  interface Props {
    readonly scan: ScannerDataState<ScanFullState>;
    readonly names?: ScannerNameCatalog;
    readonly formations?: ScannerDataState<FormationsResult>;
    readonly actions?: ScannerActionBindings;
    readonly onRefresh?: () => void | Promise<void>;
  }

  const DEFAULT_FORMATIONS: ScannerDataState<FormationsResult> = {
    status: "unavailable",
    reason: "Formation data has not been supplied to this panel.",
  };

  let {
    scan,
    names = {},
    formations = DEFAULT_FORMATIONS,
    actions = {},
    onRefresh,
  }: Props = $props();

  let pendingAction = $state<ScannerActionID | null>(null);
  let busyAction = $state<ScannerActionID | "refresh" | null>(null);
  let actionError = $state("");

  const siteView = $derived(buildScannerSitesView(scan, names));
  const formationView = $derived(buildScannerFormationView(formations));
  const actionRows = $derived(
    SCANNER_ACTION_IDS.map((id) => scannerActionAvailability(id, actions)),
  );
  const enabledActionCount = $derived(actionRows.filter((action) => action.enabled).length);
  const pendingPolicy = $derived(
    pendingAction === null ? null : scannerActionAvailability(pendingAction, actions),
  );

  function formatDistance(meters: number): string {
    if (!Number.isFinite(meters) || meters < 0) {
      return "";
    }
    if (meters >= 1_000) {
      return `${(meters / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km deviation`;
    }
    return `${Math.round(meters).toLocaleString()} m deviation`;
  }

  function validProbeIDs(ids: readonly number[]): readonly number[] {
    return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  }

  async function invokeAction(id: ScannerActionID): Promise<void> {
    const policy = scannerActionAvailability(id, actions);
    if (!policy.enabled || busyAction !== null) {
      return;
    }
    pendingAction = null;
    busyAction = id;
    actionError = "";
    try {
      switch (id) {
        case "launch": {
          const binding = actions.launch;
          if (binding) {
            await binding.run(binding.moduleID, binding.count);
          }
          break;
        }
        case "recover": {
          const binding = actions.recover;
          if (binding) {
            await binding.run(validProbeIDs(binding.probeIDs));
          }
          break;
        }
        case "analyze": {
          const binding = actions.analyze;
          if (binding) {
            await binding.run(binding.probeMap);
          }
          break;
        }
        case "reconnect":
          await actions.reconnect?.run();
          break;
      }
    } catch {
      actionError = `${policy.label} could not be completed. Refresh the scanner before trying again.`;
    } finally {
      busyAction = null;
    }
  }

  function requestAction(id: ScannerActionID): void {
    const policy = scannerActionAvailability(id, actions);
    if (!policy.enabled || busyAction !== null) {
      return;
    }
    if (policy.confirmation !== null) {
      pendingAction = id;
      return;
    }
    void invokeAction(id);
  }

  async function refresh(): Promise<void> {
    if (!onRefresh || busyAction !== null) {
      return;
    }
    busyAction = "refresh";
    actionError = "";
    try {
      await onRefresh();
    } catch {
      actionError = "Scanner data could not be refreshed just now.";
    } finally {
      busyAction = null;
    }
  }
</script>

<section class="panel scanner-center" aria-busy={busyAction !== null}>
  <header class="panel-head">
    <div>
      <h2>Scanner / Exploration Center</h2>
      <p class="subtitle">Signals and supported probe controls for the current system.</p>
    </div>
    {#if onRefresh}
      <p class="controls">
        <button
          type="button"
          class="primary"
          disabled={busyAction !== null}
          onclick={() => void refresh()}
        >
          {busyAction === "refresh" ? "Refreshing…" : "Refresh scanner"}
        </button>
      </p>
    {/if}
  </header>

  {#if actionError}
    <p class="error" aria-live="polite">{actionError}</p>
  {/if}

  {#if siteView.status === "loading"}
    <p class="note">Reading the current system’s scanner state…</p>
  {:else if siteView.status === "unavailable"}
    <p class="error">
      {siteView.message} No conclusion about sites in this system can be drawn from that failure.
    </p>
  {:else if siteView.status === "empty"}
    <p class="empty">
      The scanner successfully reported no anomalies, signatures, static sites, or structures in this system.
    </p>
  {:else}
    <p class="note">
      {siteView.totalSites === 1
        ? "One scannable result is available."
        : `${siteView.totalSites} scannable results are available.`}
    </p>

    <div class="scanner-groups">
      {#each siteView.groups as group (group.kind)}
        <section class="scanner-group">
          <header class="group-head">
            <h3>{group.label}</h3>
            <span class="badge">{group.sites.length}</span>
          </header>
          {#if group.sites.length === 0}
            <p class="empty compact">{group.emptyMessage}</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Group</th>
                    <th>Name</th>
                    <th>Reported detail</th>
                  </tr>
                </thead>
                <tbody>
                  {#each group.sites as site (site.key)}
                    <tr>
                      <td data-label="Signal">
                        {#if site.signalLabel}
                          <span class="signal-code">{site.signalLabel}</span>
                        {:else}
                          <span class="muted">No signal label</span>
                        {/if}
                      </td>
                      <td data-label="Group">
                        {#if site.groupLabel}
                          <span>{site.groupLabel}</span>
                        {:else}
                          <span class="muted">Not reported</span>
                        {/if}
                      </td>
                      <td data-label="Name">
                        <strong>{site.name}</strong>
                        {#if site.typeName && site.typeName !== site.name}
                          <span class="meta">{site.typeName}</span>
                        {/if}
                      </td>
                      <td data-label="Reported detail">
                        <span class="detail-list">
                          {#if site.difficulty !== null}
                            <span>Difficulty {site.difficulty}</span>
                          {/if}
                          {#if site.deviationMeters !== null}
                            <span>{formatDistance(site.deviationMeters)}</span>
                          {/if}
                          {#if site.difficulty === null && site.deviationMeters === null}
                            <span class="muted">No additional detail</span>
                          {/if}
                        </span>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  <section class="panel inner probe-controls">
    <header class="panel-head">
      <div>
        <h3>Probe controls</h3>
        <p class="subtitle">Only proven launch, recover, analyze, and reconnect routes are shown.</p>
      </div>
    </header>

    {#if enabledActionCount === 0}
      <p class="note">
        This panel is currently read-only. The SPA does not store active-probe IDs or geometry,
        and scanner action callbacks have not been connected yet.
      </p>
    {/if}

    <div class="action-grid">
      {#each actionRows as action (action.id)}
        <article class="action-card">
          <button
            type="button"
            class:primary={action.id === "analyze"}
            disabled={!action.enabled || busyAction !== null || pendingAction !== null}
            title={action.enabled ? undefined : action.detail}
            onclick={() => requestAction(action.id)}
          >
            {busyAction === action.id ? "Working…" : action.label}
          </button>
          <p class:muted={!action.enabled}>{action.detail}</p>
        </article>
      {/each}
    </div>

    {#if pendingAction !== null && pendingPolicy?.confirmation}
      <div
        class="confirmation"
        role="alertdialog"
        aria-labelledby="scanner-confirm-title"
        aria-describedby="scanner-confirm-message"
      >
        <h4 id="scanner-confirm-title">{pendingPolicy.confirmation.title}</h4>
        <p id="scanner-confirm-message">{pendingPolicy.confirmation.message}</p>
        <p class="controls">
          <button
            type="button"
            class="primary"
            onclick={() => pendingAction !== null && void invokeAction(pendingAction)}
          >
            {pendingPolicy.confirmation.confirmLabel}
          </button>
          <button type="button" onclick={() => (pendingAction = null)}>Cancel</button>
        </p>
      </div>
    {/if}
  </section>

  <section class="panel inner formation-reference">
    <h3>Formation reference</h3>
    {#if formationView.status === "loading"}
      <p class="note">{formationView.message}</p>
    {:else if formationView.status === "unavailable"}
      <p class="note">{formationView.message}</p>
    {:else if formationView.status === "empty"}
      <p class="empty">{formationView.message}</p>
    {:else}
      <ul class="plain-list compact-list">
        {#each formationView.names as formationName (formationName)}
          <li><strong>{formationName || "Unnamed formation"}</strong></li>
        {/each}
      </ul>
      <p class="note">{formationView.message}</p>
    {/if}
  </section>
</section>

<style>
  .panel-head > div {
    min-width: 0;
  }
  .subtitle {
    color: var(--color-muted);
    margin: 0.2rem 0 0;
  }
  .scanner-groups {
    display: grid;
    gap: 0.7rem;
  }
  .scanner-group {
    border: 1px solid var(--color-row-line);
    background: var(--color-panel-raised);
    min-width: 0;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.55rem 0.65rem;
    border-bottom: 1px solid var(--color-row-line);
  }
  .group-head h3 {
    margin: 0;
  }
  .compact {
    margin: 0;
    padding: 0.65rem;
  }
  .signal-code {
    color: var(--color-text-bright);
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.06em;
  }
  td strong,
  td .meta {
    display: block;
  }
  .meta,
  .muted {
    color: var(--color-muted);
  }
  .meta {
    font-size: 12px;
  }
  .detail-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.65rem;
  }
  .probe-controls,
  .formation-reference {
    margin-top: 0.8rem;
  }
  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    gap: 0.55rem;
  }
  .action-card {
    border: 1px solid var(--color-row-line);
    padding: 0.6rem;
    min-width: 0;
  }
  .action-card button {
    width: 100%;
  }
  .action-card p {
    margin: 0.45rem 0 0;
    font-size: 12px;
  }
  .confirmation {
    border: 1px solid var(--color-warning, #b98a3d);
    margin-top: 0.7rem;
    padding: 0.7rem;
  }
  .confirmation h4,
  .confirmation p:last-child {
    margin-bottom: 0;
  }
  .compact-list {
    margin-bottom: 0.45rem;
  }
  @media (max-width: 640px) {
    .panel-head {
      align-items: stretch;
    }
    .controls,
    .controls button {
      width: 100%;
    }
  }
</style>
