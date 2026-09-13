<script lang="ts">
  // Standings page (goal R55): who the character — and their corporation —
  // stands with among NPC factions, corporations and agents, and by how much on
  // the classic −10..+10 scale. A pure reader of the store; the read lives in
  // app/flow.ts (loadStandings) and the BFF holds the session.
  //
  // ⚠ R7d is the whole point of this page. A standing's `fromID` is an ENTITY id
  // (an NPC faction / NPC corporation / agent). It is NEVER rendered as a number:
  // classifyStandingKind maps the id to its /api/names kind by its EVE id range,
  // and resolvedName turns it into a name — degrading to a plain "Unknown entity"
  // fallback, never leaking the id. The rows are GROUPED by that same
  // classification (Factions / Corporations / Agents), exactly as the retail
  // panel groups them.
  //
  // ⚠ empty vs failed. `char`/`corp` are null while unread OR when the read
  // FAILED (reason in the matching *Error); an empty list is the real "no
  // standings with anyone yet" answer (worldHasNoContracts precedent).
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { classifyStandingKind } from "../bridge/standings.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CharStanding } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const standings = store.standings;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<void> | void): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        return;
      }
      error =
        panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  function refresh(): void {
    void run(() => flow.loadStandings());
  }

  onMount(() => {
    refresh();
  });

  // The name for a standing's entity, ALWAYS a name and never the id (R7d).
  // The kind is the same one the flow resolved the id under.
  function entityName(fromID: number): string {
    const kind = classifyStandingKind(fromID);
    if (kind === null) {
      return "Unknown entity";
    }
    return resolvedName($names.resolved, kind, fromID, "Unknown entity");
  }

  // A composition owner is a corporation member (a player character); it may not
  // resolve from static data, so it degrades honestly rather than leaking the id.
  function memberName(ownerID: number): string {
    return resolvedName($names.resolved, "character", ownerID, "Unknown entity");
  }

  const GROUPS: readonly { readonly kind: NameKind; readonly label: string }[] = [
    { kind: "faction", label: "Factions" },
    { kind: "corporation", label: "Corporations" },
    { kind: "agent", label: "Agents" },
  ];

  // Split one standings list into the retail groups (Factions / Corporations /
  // Agents), each sorted strongest-standing first. A row whose id falls outside
  // every known range lands in "Other" so it is still shown (by name), never
  // dropped silently.
  function grouped(
    rows: readonly CharStanding[],
  ): readonly { readonly label: string; readonly rows: readonly CharStanding[] }[] {
    const out: { label: string; rows: CharStanding[] }[] = [];
    for (const { kind, label } of GROUPS) {
      const inGroup = rows
        .filter((row) => classifyStandingKind(row.fromID) === kind)
        .slice()
        .sort((left, right) => right.standing - left.standing);
      if (inGroup.length > 0) {
        out.push({ label, rows: inGroup });
      }
    }
    const other = rows
      .filter((row) => classifyStandingKind(row.fromID) === null)
      .slice()
      .sort((left, right) => right.standing - left.standing);
    if (other.length > 0) {
      out.push({ label: "Other", rows: other });
    }
    return out;
  }

  // The signed standing to two decimals, e.g. "+2.14" / "−1.30" / "0.00".
  function standingText(standing: number): string {
    const rounded = Math.round(standing * 100) / 100;
    if (rounded > 0) {
      return `+${rounded.toFixed(2)}`;
    }
    if (rounded < 0) {
      // A real minus sign, not a hyphen.
      return `−${Math.abs(rounded).toFixed(2)}`;
    }
    return "0.00";
  }

  function standingTone(standing: number): "good" | "bad" | "neutral" {
    if (standing > 0) {
      return "good";
    }
    if (standing < 0) {
      return "bad";
    }
    return "neutral";
  }

  // The meter fill as a percentage of half the −10..+10 track (0..100), so the
  // bar grows out from the centre line toward the sign's end.
  function meterFraction(standing: number): number {
    const clamped = Math.max(-10, Math.min(10, standing));
    return Math.min(100, (Math.abs(clamped) / 10) * 100);
  }

  function toggleDetail(fromID: number, scope: "char" | "corp"): void {
    if ($standings.detailFromID === fromID && $standings.detailScope === scope) {
      flow.closeStandingDetail();
      return;
    }
    void run(() => flow.loadStandingDetail(fromID, scope));
  }

  function isOpen(fromID: number, scope: "char" | "corp"): boolean {
    return $standings.detailFromID === fromID && $standings.detailScope === scope;
  }

  // A standing-history event's plain-language label (R9a), from its eventTypeID.
  const EVENT_LABELS: Readonly<Record<number, string>> = {
    25: "Standing reset",
    65: "Standing set",
    68: "Corp standing set",
    73: "Mission completed",
    74: "Mission failed",
    75: "Mission declined",
    76: "Combat aggression",
    80: "Mission bonus",
    82: "Derived (rise)",
    83: "Derived (fall)",
    84: "Standing set",
    90: "Offer expired",
    126: "Contraband trafficking",
    485: "Group reward (corporation)",
    486: "Group reward (faction)",
  };

  function eventLabel(eventTypeID: number): string {
    return EVENT_LABELS[eventTypeID] ?? "Standing change";
  }

  // A retail FILETIME (100 ns ticks since 1601) as a plain date. Never a number.
  function whenText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs)) {
      return "—";
    }
    return new Date(unixMs).toLocaleDateString();
  }
</script>

<section class="panel">
  <!-- ⚠ REFRESH LIVES IN THE STRIP, NOT AT THE BOTTOM OF THE PAGE. It used
       to be a bare <p><button> after the last section, so this window put its
       one action somewhere no other window puts one — below content of
       unpredictable length, which on a full read meant scrolling past
       everything to reach it. Nothing was added or taken away; the control
       moved to the band every other window keeps its controls in. -->
  <header class="panel-head">
    <h2 class="panel-title">Standings</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>
  <!-- ⚠ WHAT SURVIVED IS THE LEGEND, NOT THE DESCRIPTION. "Who you and your
       corporation stand with" is the window's name again; the scale is the key
       to every number in the tables below, and without it a "−4.1" means
       nothing in particular. -->
  <p class="note">Standings run from −10 to +10.</p>

  {#if error}
    <p class="error">Could not read your standings: {error}</p>
  {/if}

  {#snippet standingRow(row: CharStanding, scope: "char" | "corp")}
    <li class="standing">
      <button
        type="button"
        class="row"
        class:open={isOpen(row.fromID, scope)}
        onclick={() => toggleDetail(row.fromID, scope)}
      >
        <span class="name">{entityName(row.fromID)}</span>
        <span class="meter" aria-hidden="true">
          <span class="track">
            <span
              class="fill {standingTone(row.standing)}"
              class:left={row.standing < 0}
              style="width: {meterFraction(row.standing) / 2}%"
            ></span>
          </span>
        </span>
        <span class="value {standingTone(row.standing)}">{standingText(row.standing)}</span>
      </button>

      {#if isOpen(row.fromID, scope)}
        <div class="detail">
          {#if $standings.detailError}
            <p class="error">The details could not be read: {$standings.detailError}</p>
          {:else if scope === "char"}
            {#if $standings.transactions === null}
              <p class="empty">Reading the history…</p>
            {:else if $standings.transactions.length === 0}
              <p class="empty">No recorded changes for this standing.</p>
            {:else}
              <table class="drill">
                <thead>
                  <tr><th scope="col">When</th><th scope="col">Event</th><th scope="col" class="num">Change</th></tr>
                </thead>
                <tbody>
                  {#each $standings.transactions as tx (tx.id)}
                    <tr>
                      <td>{whenText(tx.date)}</td>
                      <td>{eventLabel(tx.eventTypeID)}</td>
                      <td class="num">{standingText(tx.modification)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          {:else if $standings.compositions === null}
            <p class="empty">Reading the breakdown…</p>
          {:else if $standings.compositions.length === 0}
            <p class="empty">No members contribute to this corporation standing.</p>
          {:else}
            <table class="drill">
              <thead>
                <tr><th scope="col">Member</th><th scope="col" class="num">Standing</th></tr>
              </thead>
              <tbody>
                {#each $standings.compositions as comp (comp.ownerID)}
                  <tr>
                    <td>{memberName(comp.ownerID)}</td>
                    <td class="num {standingTone(comp.standing)}">{standingText(comp.standing)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}
    </li>
  {/snippet}

  {#snippet standingList(
    rows: readonly CharStanding[] | null,
    err: string | null,
    scope: "char" | "corp",
    emptyMsg: string,
  )}
    {#if err}
      <p class="error">{err}</p>
    {:else if rows === null}
      <p class="empty">Reading standings…</p>
    {:else if rows.length === 0}
      <p class="empty">{emptyMsg}</p>
    {:else}
      {#each grouped(rows) as group (group.label)}
        <h4>{group.label}</h4>
        <ul class="standings">
          {#each group.rows as row (row.fromID)}
            {@render standingRow(row, scope)}
          {/each}
        </ul>
      {/each}
    {/if}
  {/snippet}

  <h3>Your standings</h3>
  {@render standingList($standings.char, $standings.charError, "char", "You have no standings with anyone yet.")}

  <h3>Your corporation's standings</h3>
  {@render standingList($standings.corp, $standings.corpError, "corp", "Your corporation has no standings with anyone yet.")}

</section>

<style>
  ul.standings {
    list-style: none;
    margin: 0 0 0.75rem 0;
    padding: 0;
  }
  .standing {
    margin: 0;
  }
  button.row {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) minmax(4rem, 12rem) 4.5rem;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 40px;
    padding: 0.35rem 0.5rem;
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgba(128, 128, 128, 0.25);
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  button.row:hover,
  button.row.open {
    background: rgba(128, 128, 128, 0.12);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  /* The meter: a centre-anchored track; the fill grows toward the sign's end. */
  .track {
    position: relative;
    display: block;
    height: 8px;
    border-radius: 2px;
    background: rgba(128, 128, 128, 0.2);
  }
  .track::before {
    content: "";
    position: absolute;
    left: 50%;
    top: -2px;
    bottom: -2px;
    width: 1px;
    background: rgba(128, 128, 128, 0.6);
  }
  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    border-radius: 2px;
  }
  .fill.left {
    left: auto;
    right: 50%;
  }
  .good {
    color: #2e7d32;
  }
  .bad {
    color: #c62828;
  }
  .fill.good {
    background: #2e7d32;
  }
  .fill.bad {
    background: #c62828;
  }
  .fill.neutral {
    background: rgba(128, 128, 128, 0.5);
  }
  .detail {
    padding: 0.25rem 0.5rem 0.75rem;
  }
  table.drill {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  table.drill th,
  table.drill td {
    padding: 0.2rem 0.4rem;
    text-align: left;
  }
  table.drill .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  @media (prefers-color-scheme: dark) {
    .good,
    .fill.good {
      color: #7fce82;
    }
    .fill.good {
      background: #7fce82;
    }
    .bad,
    .fill.bad {
      color: #ef8a8a;
    }
    .fill.bad {
      background: #ef8a8a;
    }
  }
</style>
