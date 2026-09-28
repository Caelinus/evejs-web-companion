<script lang="ts">
  // Wallet page (goal R50, extended R54): the character's personal ISK balance
  // (account.GetCashBalance) plus the personal LEDGER — the wallet journal
  // (account.GetJournal, a Rowset) and market transactions
  // (account.GetTransactions), ref-types labelled from account.GetEntryTypes. A
  // pure reader of the store; the read lives in app/flow.ts (loadWallet) and the
  // BFF holds the session. The Corp Wallet tab reads divisions from the SAME pull.
  //
  // ⚠ R7d: a ledger row shows only WHEN, WHAT (the human ref-type label) and the
  // ISK amount — never a raw refID/ownerID (those are dropped in the decoder) and
  // never the server's free-text description (it embeds typeIDs/systemIDs).
  // ⚠ empty vs failed. `journal`/`transactions` are null while unread OR when the
  // read FAILED (the reason is in the matching *Error); an empty list is the real
  // "no wallet activity yet" answer (worldHasNoContracts precedent).
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatIsk } from "./isk.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { LedgerEntry } from "../store/types.ts";
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

  // A retail FILETIME (100 ns ticks since 1601) as a plain date + time. Never
  // rendered as a number.
  function whenText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs)) {
      return "—";
    }
    return new Date(unixMs).toLocaleString();
  }

  // A signed ISK amount for a ledger row: a credit carries a leading "+", a debit
  // keeps its own "-" (formatIsk preserves the sign). "0" gets no sign.
  function amountText(amount: string): string {
    const formatted = formatIsk(amount);
    if (amount.startsWith("-") || amount === "0" || amount === "0.00") {
      return formatted;
    }
    return `+${formatted}`;
  }

  function amountFlow(amount: string): "credit" | "debit" | "flat" {
    if (amount.startsWith("-")) {
      return "debit";
    }
    return amount === "0" || amount === "0.00" ? "flat" : "credit";
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
    <h2 class="panel-title">Wallet</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read the wallet: {error}</p>
  {/if}
  {#if $wallet.cashError}
    <p class="error">The balance read failed: {$wallet.cashError}</p>
  {/if}

  {#if !$wallet.loaded}
    <p class="empty">Reading your balance…</p>
  {:else}
    <table class="guests">
      <tbody>
        <tr>
          <th scope="row">Balance</th>
          <td class="num">{formatIsk($wallet.cashBalance)}</td>
        </tr>
      </tbody>
    </table>
  {/if}

  {#snippet ledger(rows: readonly LedgerEntry[] | null, err: string | null, emptyMsg: string)}
    {#if err}
      <p class="error">The read failed: {err}</p>
    {:else if rows === null}
      <p class="empty">Reading…</p>
    {:else if rows.length === 0}
      <p class="empty">{emptyMsg}</p>
    {:else}
      <table class="guests ledger">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col" class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as entry (entry.id)}
            <tr>
              <td>{whenText(entry.date)}</td>
              <td>{entry.refType}</td>
              <td class="num {amountFlow(entry.amount)}">{amountText(entry.amount)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/snippet}

  <h3>Recent activity</h3>
  {@render ledger($wallet.journal, $wallet.journalError, "No wallet activity yet.")}

  <h3>Market transactions</h3>
  {@render ledger($wallet.transactions, $wallet.transactionsError, "No market transactions yet.")}

</section>

<style>
  /* A credit reads green, a debit red — the sign is already in the text, so the
     colour is a redundant cue, not the only one (accessible in both themes). */
  .ledger .credit {
    color: #2e7d32;
  }
  .ledger .debit {
    color: #c62828;
  }
  @media (prefers-color-scheme: dark) {
    .ledger .credit {
      color: #7fce82;
    }
    .ledger .debit {
      color: #ef8a8a;
    }
  }
</style>
