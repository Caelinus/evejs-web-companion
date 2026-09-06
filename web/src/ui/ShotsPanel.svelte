<script lang="ts">
  // The combat log, as its own window — lifted out of `Overview.svelte`'s
  // "Shots fired" section, unchanged in what it claims.
  //
  // ⚠ WHY IT IS A WINDOW AND NOT PART OF THE HUD. It is a scrolling list of
  // sentences, and that is the one shape which cannot share a fixed-height cell
  // with two instruments: either the log gets three rows, or the gauges get
  // squeezed. It briefly lived in the HUD bar and did exactly that.
  //
  // ⚠ AND WHAT IT MAY NEVER CLAIM. The store keeps a bounded TAIL of the push
  // channel, which is allowed to drop and resynchronise. So this is a running
  // commentary, not a tally — the totals below name the number of shots they
  // are over, every time, and the condition gauges on the HUD remain the
  // numbers to trust.
  import { resolvedName } from "../store/names.ts";
  import { damageText, shotTotals, totalsCaption } from "./shotsLog.ts";
  import type { ShotRow } from "./shotsLog.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { NameRef, SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  const snapshot = $derived($space.snapshot);

  /** What to call something that was shot, or shot at us. Never an id (R7d). */
  function displayLabel(entity: SpaceEntity | null): string {
    if (!entity) {
      return "something no longer in view";
    }
    if (entity.name && entity.name.length > 0) {
      return entity.name;
    }
    const type = resolvedName($names.resolved, "type", entity.typeID, "");
    return type.length > 0 ? type : "Unknown object";
  }

  const rows = $derived.by<ShotRow[]>(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    // Newest first: the shot you care about is the one that just landed.
    return [...$targeting.damageLog].reverse().map((shot) => {
      const other = shot.otherPartyID === null ? null : (byID.get(shot.otherPartyID) ?? null);
      const otherLabel = displayLabel(other);
      const missed = shot.amount <= 0;
      return {
        id: shot.id,
        summary:
          shot.direction === "dealt"
            ? missed
              ? `You shot at ${otherLabel} and missed`
              : `You hit ${otherLabel}`
            : missed
              ? `${otherLabel} shot at you and missed`
              : `${otherLabel} hit you`,
        weaponLabel:
          shot.weaponTypeID === null
            ? "—"
            : resolvedName($names.resolved, "type", shot.weaponTypeID, "—"),
        amountLabel: damageText(shot.amount),
      };
    });
  });

  const totals = $derived(shotTotals($targeting.damageLog));

  // The weapons in the log arrive as bare typeIDs, and an id must never reach
  // the screen (R7d). This panel asks for its own names rather than relying on
  // another component being mounted — the same lesson the module rack learned.
  $effect(() => {
    const refs: NameRef[] = [];
    const seen = new Set<number>();
    for (const shot of $targeting.damageLog) {
      const id = shot.weaponTypeID;
      if (id !== null && id > 0 && !seen.has(id)) {
        seen.add(id);
        if (resolvedName($names.resolved, "type", id, "") === "") {
          refs.push({ kind: "type", id });
        }
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });
</script>

<section class="panel shots-panel">
  <div class="panel-head"><h2>Shots fired</h2></div>

  <!--
    THE TOTALS, WITH THEIR DENOMINATOR ATTACHED.

    ⚠ NEVER "DAMAGE THIS FIGHT". These are a sum over the rows below and nothing
    more; `totalsCaption` prints how many shots that is, and says so plainly when
    the log is full and earlier shots have already been dropped.
  -->
  <dl class="shot-totals">
    <div class="shot-total dealt">
      <dt>Damage dealt</dt>
      <dd>{totals.dealt > 0 ? totals.dealt.toFixed(1) : "—"}</dd>
    </div>
    <div class="shot-total taken">
      <dt>Damage taken</dt>
      <dd>{totals.taken > 0 ? totals.taken.toFixed(1) : "—"}</dd>
    </div>
  </dl>
  <p class="note shot-totals-caption">{totalsCaption(totals)}</p>

  {#if rows.length === 0}
    <p class="empty">Nothing has been shot at, or by, your ship since this page came online.</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>What happened</th>
            <th>Weapon</th>
            <th class="num">Damage</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as shot (shot.id)}
            <tr>
              <td data-label="What happened">{shot.summary}</td>
              <td data-label="Weapon">{shot.weaponLabel}</td>
              <td class="num" data-label="Damage">{shot.amountLabel}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
