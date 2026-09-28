<script lang="ts">
  // WHAT IS IN THE HOLDS, in the HUD, while you are flying.
  //
  // The cell already answers "what shape is my ship" and "what are my modules
  // doing". This is the third question a pilot asks without opening anything —
  // and for a miner or a hauler it is the one that decides when the trip ends.
  // Until now it lived only in the Mining and Inventory panels, which is a
  // window you have to open to learn something you need on a two-second cycle.
  //
  // ---------------------------------------------------------------------------
  // ⚠ IT IS NOT ON THE PHONE, AND THAT IS DELIBERATE.
  //
  // The card is already a scroll; a third block above the gauge would push the
  // rack below the fold on the tier where the fold is tightest. The mobile card
  // hides it in CSS rather than this component knowing which tier it is on.
  //
  // ---------------------------------------------------------------------------
  // ⚠ ABSENT ≠ EMPTY ≠ UNKNOWN. All three rules live in `holdFill.ts` and none
  // of them is re-decided here: a hull with no ore hold shows no ore hold, a
  // hold the ship did not measure says "not known" and draws NO bar, and a hold
  // that measured empty says 0 of N. An empty bar for an unmeasured hold is how
  // a player decides they have room for another twenty minutes of mining.
  import { holdCapacityText, holdFillBand, holdFillPercent, holdFillShort, presentHolds } from "./holdFill.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow | null } = $props();

  // svelte-ignore state_referenced_locally
  const mining = store.mining;

  const bays = $derived(presentHolds($mining.holds));

  /**
   * ⚠ ONE READ, NOT A POLL. The holds re-read themselves off the server's own
   * item-changed frames (see `scheduleHoldRefresh` in flow.ts), so once they
   * have been read once they stay current for free. What was missing is the
   * FIRST read: nothing asked for it unless you opened the Mining panel, so a
   * pilot who never opened it saw an empty readout forever.
   *
   * `asked` is local and never reset, so a read that FAILS is not retried in a
   * loop — `holdsLoaded` stays false on failure, and without this flag that
   * would be a request per render for the rest of the session.
   */
  let asked = $state(false);
  $effect(() => {
    if (!flow || asked || $mining.holdsLoaded) {
      return;
    }
    asked = true;
    void Promise.resolve(flow.loadMiningHolds()).catch(() => {});
  });
</script>

<div class="cargo-bays" aria-label="Cargo">
  <span class="cargo-head">Cargo</span>
  {#if $mining.holdsError && bays.length === 0}
    <!-- The read failed and there is nothing older to show. Say so, rather than
         showing an empty list that reads as "no holds". -->
    <p class="cargo-note">{$mining.holdsError}</p>
  {:else if bays.length === 0}
    <p class="cargo-note">{$mining.holdsLoaded ? "This hull has no holds." : "Reading…"}</p>
  {:else}
    <ul class="cargo-list">
      {#each bays as bay (bay.key)}
        {@const percent = holdFillPercent(bay)}
        <li class="cargo-bay" title={`${bay.label} — ${holdCapacityText(bay)}`}>
          <span class="cargo-bay-name">{bay.label}</span>
          <span class="cargo-track" aria-hidden="true">
            <!-- No bar at all for a null. See the header. -->
            {#if percent !== null}
              <span class={`cargo-fill ${holdFillBand(bay)}`} style={`width:${percent}%`}></span>
            {/if}
          </span>
          <!-- The reading as a WORD or a number, always — the bar's colour is
               reinforcement and never the only telling. -->
          <span class={`cargo-bay-value ${holdFillBand(bay)}`} class:unknown={percent === null}>
            {holdFillShort(bay)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
