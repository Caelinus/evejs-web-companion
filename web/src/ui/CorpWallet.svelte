<script lang="ts">
  // Corp Wallet page (goal R50): the corporation's per-division balances
  // (account.GetWalletDivisionsInfo — R50's one new allowlist pair), the read
  // the retail corp-wallet window itself issues. A pure reader of the store; the
  // read shares the loadWallet pull with the personal Wallet tab, and the BFF
  // holds the session + resolves the division names.
  //
  // ⚠ empty vs failed. `corpDivisions === null` means the corp read failed (the
  // reason is in `corpError`) OR has not answered yet; an empty list is the real
  // "this corporation has no wallet divisions" answer. The two are shown
  // differently on purpose (the worldHasNoContracts precedent).
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatIsk } from "./isk.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpWalletDivision } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;

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
    void run(() => flow.loadWallet());
  }

  onMount(() => {
    refresh();
  });

  // The player-authored division name, or a plain "Division N" fallback — never
  // the raw account key / division flag (R7d).
  function divisionLabel(division: CorpWalletDivision): string {
    return division.name ?? `Division ${division.division}`;
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
    <h2 class="panel-title">Corp Wallet</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read the corp wallet: {error}</p>
  {/if}
  {#if $wallet.corpError}
    <p class="error">The corp wallet read failed: {$wallet.corpError}</p>
  {/if}

  {#if !$wallet.loaded || ($wallet.corpDivisions === null && $wallet.corpError === null)}
    <p class="empty">Reading your corporation's wallet…</p>
  {:else if $wallet.corpDivisions === null}
    <!-- Failed read: the reason is shown above; do not imply an empty wallet. -->
  {:else if $wallet.corpDivisions.length === 0}
    <p class="empty">This corporation has no wallet divisions.</p>
  {:else}
    <table class="guests">
      <thead>
        <tr>
          <th scope="col">Division</th>
          <th scope="col" class="num">Balance</th>
        </tr>
      </thead>
      <tbody>
        {#each $wallet.corpDivisions as division (division.key)}
          <tr>
            <th scope="row">{divisionLabel(division)}</th>
            <td class="num">{formatIsk(division.balance)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

</section>
