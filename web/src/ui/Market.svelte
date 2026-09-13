<script lang="ts">
  // Market page (goal R16): an item's order book by station name, the player's
  // own orders, their trades, what they have locked in escrow, and their ISK.
  //
  // A pure reader of the store's market slice. Every call lives on the BFF and
  // in app/flow.ts; every identifier is translated to a name in
  // bridge/market.ts or resolved through the shared name cache before it
  // reaches this file. Nothing here shows a typeID, a stationID, a systemID or
  // an orderID (R7d) — an order is identified by what it is for, where it is
  // and at what price. Prices are decimal strings formatted by `formatIsk`,
  // never JS numbers, because ISK exceeds 2^53 in ordinary play.
  //
  // THE SORTING AND FILTERING HERE IS THE POINT. Retail implements it in a
  // client-local service called `marketQuote`; there is no server call for it.
  // So it is implemented client-side here too, which is also why re-sorting the
  // book costs no round-trip.
  import { onMount } from "svelte";
  import {
    DURATION_CHOICES,
    FILL_STATE_LABELS,
    bestPrices,
    checkPrice,
    checkQuantity,
    distanceLabel,
    estimateBrokerFee,
    filterByJumps,
    formatIsk,
    rangeLabel,
    sortOrderBook,
  } from "../bridge/market.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { MarketTypeMatch } from "../app/api.ts";
  import type { MarketOrderRow, MarketOwnOrderRow, MarketSide } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  import type { MarketGroupNode } from "../app/api.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const market = store.market;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // ⚠ SELLING NEEDS THE HANGAR. PlaceMultiSellOrder moves a specific STACK into
  // escrow, so a sell must name an itemID — "10 of Tritanium" is not something
  // the market can act on. The hangar the Inventory page already reads is where
  // those stacks come from.
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;

  let busy = $state(false);
  let error = $state("");

  /** Which of the four views is showing. */
  let tab = $state<"book" | "orders" | "trades" | "escrow">("book");

  // --- Item search ---------------------------------------------------------
  let query = $state("");
  let matches = $state<readonly MarketTypeMatch[]>([]);
  let chosenName = $state("");

  // --- Client-local book controls (retail's `marketQuote`) -----------------
  /** -1 means "no limit"; anything else caps how far away an order may be. */
  let maxJumps = $state(-1);

  // --- Placing / changing orders (Slice B) ---------------------------------
  type Draft = {
    readonly side: MarketSide;
    price: string;
    quantity: string;
    durationDays: number;
  };
  let draft = $state<Draft | null>(null);
  /** True once the player has asked to see the confirmation step. */
  let confirming = $state(false);
  /** The order the player has armed a cancel for. */
  let cancellingOrderID = $state<string | null>(null);
  /** The order being repriced, and the new price they typed. */
  let modifyingOrderID = $state<string | null>(null);
  let modifyPrice = $state("");
  let confirmingModify = $state(false);
  /** The hangar stack a sell will hand over. Null until one is picked. */
  let sellItemID = $state<number | null>(null);

  function typeName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "an unnamed item");
  }

  function stationName(stationID: number): string {
    return resolvedName($names.resolved, "station", stationID, "an unnamed station");
  }

  function systemName(solarSystemID: number): string {
    return resolvedName($names.resolved, "system", solarSystemID, "an unknown system");
  }

  /** A retail FILETIME as a plain date. Never rendered as a number. */
  function dateText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs) || unixMs <= 0) {
      return "—";
    }
    return new Date(unixMs).toLocaleDateString();
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function search(): void {
    void run(async () => {
      matches = await flow.findMarketTypes(query);
    });
  }

  function chooseItem(match: MarketTypeMatch): void {
    chosenName = match.name;
    matches = [];
    query = "";
    closeDraft();
    void run(() => flow.loadMarket(match.typeID));
  }

  function refresh(): void {
    void run(() => flow.loadMarket($market.typeID));
  }

  // --- The book, sorted and filtered client-side ---------------------------

  const sells = $derived.by(() =>
    filterByJumps(sortOrderBook($market.sells, "sell"), maxJumps),
  );
  const buys = $derived.by(() =>
    filterByJumps(sortOrderBook($market.buys, "buy"), maxJumps),
  );
  const best = $derived.by(() => bestPrices({ sells: $market.sells, buys: $market.buys }));

  const openOrders = $derived.by(() =>
    $market.ownOrders.filter((order) => order.state === "open"),
  );

  /**
   * The stacks of the chosen item the player is actually holding at this
   * station. A sell is offered only against one of these: the market moves a
   * real stack into escrow, so offering a sell for goods the player does not
   * have would produce a refusal they could make no sense of.
   */
  const sellableStacks = $derived.by(() =>
    $market.typeID === null
      ? []
      : $inventory.hangar.rows.filter((row) => row.typeID === $market.typeID),
  );

  const chosenStack = $derived.by(
    () => sellableStacks.find((row) => row.itemID === sellItemID) ?? null,
  );

  // --- The order draft, and what it will cost ------------------------------

  const draftPriceCheck = $derived.by(() =>
    draft === null ? null : checkPrice(Number(draft.price)),
  );
  const draftQuantityCheck = $derived.by(() =>
    draft === null ? null : checkQuantity(Number(draft.quantity)),
  );
  /** price x quantity, at the ROUNDED price that will actually be sent. */
  const draftValue = $derived.by(() => {
    if (draft === null || !draftPriceCheck?.ok || !draftQuantityCheck?.ok) {
      return null;
    }
    return (draftPriceCheck.price * Number(draft.quantity)).toFixed(2);
  });
  /** ⚠ AN ESTIMATE at the standard 3% rate — see bridge/market.ts. */
  const draftFee = $derived.by(() => {
    if (draft === null || !draftPriceCheck?.ok || !draftQuantityCheck?.ok) {
      return null;
    }
    return estimateBrokerFee(draftPriceCheck.price, Number(draft.quantity));
  });
  const draftReady = $derived.by(() => {
    if (draft === null || draftPriceCheck?.ok !== true || draftQuantityCheck?.ok !== true) {
      return false;
    }
    if (draft.side === "buy") {
      return true;
    }
    // A sell must name a stack, and cannot offer more than that stack holds.
    return chosenStack !== null && Number(draft.quantity) <= chosenStack.quantity;
  });

  function startDraft(side: MarketSide): void {
    const suggested = side === "buy" ? best.bestBuy : best.bestSell;
    const stack = side === "sell" ? sellableStacks[0] ?? null : null;
    sellItemID = stack ? stack.itemID : null;
    draft = {
      side,
      price: suggested ?? "",
      // A sell defaults to the whole stack; a buy to one unit.
      quantity: stack ? String(stack.quantity) : "1",
      durationDays: 30,
    };
    confirming = false;
  }

  /**
   * R84 — TAKE A PRICE OFF THE BOOK.
   *
   * Placing an order meant typing a price and a quantity by hand while the
   * numbers you wanted were sitting on screen a few centimetres away. Clicking
   * a row carries them into the draft.
   *
   * ⚠ IT PRE-FILLS A DRAFT, IT DOES NOT BUY. The wording everywhere is "use this
   * price", never "buy it now", and the existing confirm step is untouched.
   * Placing a buy at a seller's price is not the same act as taking that
   * specific listing — whether it matches immediately is the SERVER's business,
   * and this panel has never been willing to claim an outcome it has not read
   * back. `lastOutcome` still reports what actually happened to the wallet.
   *
   * Clicking a SELL order (someone is selling) drafts a BUY; clicking a BUY
   * order (someone is buying) drafts a SELL.
   */
  function useOrderPrice(order: MarketOrderRow, side: MarketSide): void {
    startDraft(side);
    const current = draft;
    if (current === null) {
      return;
    }
    if (side === "buy") {
      draft = { ...current, price: order.price, quantity: String(order.volumeRemaining) };
      return;
    }
    // Selling: never offer more than the counterparty wants, and never more than
    // the stack actually holds. Both caps are real refusals if ignored.
    const stack = sellableStacks[0] ?? null;
    const most = stack
      ? Math.min(stack.quantity, order.volumeRemaining)
      : order.volumeRemaining;
    draft = { ...current, price: order.price, quantity: String(most) };
  }

  function closeDraft(): void {
    draft = null;
    confirming = false;
    sellItemID = null;
  }

  function placeOrder(): void {
    const current = draft;
    const priceCheck = draftPriceCheck;
    if (current === null || !priceCheck?.ok || $market.typeID === null) {
      return;
    }
    void run(async () => {
      await flow.placeMarketOrder({
        side: current.side,
        typeID: $market.typeID as number,
        price: priceCheck.price,
        quantity: Number(current.quantity),
        durationDays: current.durationDays,
        // Only a sell carries one, and it is required there.
        itemID: current.side === "sell" ? sellItemID ?? 0 : undefined,
      });
      closeDraft();
    });
  }

  function cancelOrder(order: MarketOwnOrderRow): void {
    cancellingOrderID = null;
    void run(() => flow.cancelMarketOrder(order.orderID));
  }

  function startModify(order: MarketOwnOrderRow): void {
    modifyingOrderID = order.orderID;
    modifyPrice = order.price;
    confirmingModify = false;
  }

  function closeModify(): void {
    modifyingOrderID = null;
    modifyPrice = "";
    confirmingModify = false;
  }

  const modifyCheck = $derived.by(() =>
    modifyingOrderID === null ? null : checkPrice(Number(modifyPrice)),
  );

  function applyModify(order: MarketOwnOrderRow): void {
    const check = modifyCheck;
    if (!check?.ok) {
      return;
    }
    void run(async () => {
      await flow.modifyMarketOrder(order.orderID, check.price);
      closeModify();
    });
  }

  /** What the last write ACTUALLY did, in words. Never a prediction. */
  const outcomeText = $derived.by(() => {
    const outcome = $market.lastOutcome;
    if (outcome === null) {
      return null;
    }
    if (outcome.declinedSilently) {
      return "The server did not apply that change, and gave no reason.";
    }
    if (outcome.charged === null) {
      return "That went through. The server did not report a wallet change.";
    }
    const negative = outcome.charged.startsWith("-");
    const magnitude = negative ? outcome.charged.slice(1) : outcome.charged;
    if (magnitude === "0.00" || magnitude === "0") {
      return "That went through. Nothing was taken from your wallet.";
    }
    return negative
      ? `That went through. ${formatIsk(magnitude)} was returned to your wallet.`
      : `That went through. You were actually charged ${formatIsk(magnitude)}.`;
  });

  // --- R83: BROWSING, not just searching -------------------------------------
  //
  // The only way into this panel was to TYPE an item's name — fine when you know
  // what you want, useless when you do not. "What ammunition fits this?" and
  // "what is even on sale?" are the questions a market is for and neither can be
  // typed. So the market tree is the way in, and the search box narrows it.
  //
  // The tree is STATIC reference data (see space of `/api/market/groups`), which
  // is why it loads before — and independently of — anything the market daemon
  // says. A player can find out what exists even when prices cannot be read.
  interface Crumb {
    readonly marketGroupID: number;
    readonly name: string;
  }
  let crumbs = $state<Crumb[]>([]);
  let groups = $state<readonly MarketGroupNode[]>([]);
  let groupTypes = $state<readonly MarketTypeMatch[]>([]);
  let groupTypesCapped = $state(false);
  let browsing = $state(false);

  /** Where in the tree we are — 0 is the root. */
  const currentGroupID = $derived(crumbs.length === 0 ? 0 : crumbs[crumbs.length - 1]!.marketGroupID);

  async function openGroupID(groupID: number): Promise<void> {
    browsing = true;
    try {
      groups = await flow.loadMarketGroups(groupID);
      if (groupID === 0) {
        // The root holds no items of its own.
        groupTypes = [];
        groupTypesCapped = false;
      } else {
        const result = await flow.loadMarketGroupTypes(groupID);
        groupTypes = result.types;
        groupTypesCapped = result.capped;
      }
    } catch (cause) {
      // Browsing is reference data; failing it must not blank the prices that
      // are already on screen.
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      browsing = false;
    }
  }

  function enterGroup(node: MarketGroupNode): void {
    crumbs = [...crumbs, { marketGroupID: node.marketGroupID, name: node.name }];
    void openGroupID(node.marketGroupID);
  }

  /** Jump to a crumb; -1 is "All items". */
  function goToCrumb(index: number): void {
    crumbs = index < 0 ? [] : crumbs.slice(0, index + 1);
    void openGroupID(index < 0 ? 0 : crumbs[index]!.marketGroupID);
  }

  onMount(() => {
    void run(() => flow.loadMarket(null));
    // The tree, so the panel opens on something to look AT rather than an empty
    // search box. Independent of the market read: it is static data.
    void openGroupID(0);
    // The hangar, so a sell can name a real stack. Deliberately NOT part of the
    // market load: it is a different panel's read, and failing it must cost the
    // player only the ability to sell, not the whole market page.
    void flow.loadInventory().catch(() => {});
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Market</h2>
    <p class="controls">
      <input
        type="search"
        bind:value={query}
        placeholder="Search for an item to trade"
        onkeydown={(event) => event.key === "Enter" && search()}
      />
      <button type="button" class="primary" disabled={busy || query.trim().length < 2} onclick={search}>
        Search
      </button>
      <button type="button" class="minor" disabled={busy} onclick={refresh}>Refresh</button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $market.marketUnavailable}
    <p class="error">{$market.marketUnavailable}</p>
  {/if}
  {#if $market.actionError}
    <p class="error">Your last order was not placed: {$market.actionError}</p>
  {/if}
  {#if outcomeText}
    <p class="note">{outcomeText}</p>
  {/if}
  <!--
    R83 — THE WAY IN IS A TREE, and the search box narrows it.

    Before this the only route to an item was typing its name, which answers
    "how much is Veldspar" and nothing else. The market's real questions —
    what ammunition exists, what is worth hauling — are BROWSING questions.

    Groups and items are both plain rows in one list: a group descends, an item
    opens its order books. They are visibly different (a group carries a chevron
    and its own icon; an item carries its picture) but they behave consistently,
    which is what makes the list scannable in a narrow window.
  -->
  <nav class="market-crumbs" aria-label="Where you are in the market">
    <button type="button" class="crumb" disabled={busy || browsing} onclick={() => goToCrumb(-1)}>
      All items
    </button>
    {#each crumbs as crumb, index (crumb.marketGroupID)}
      <span class="crumb-sep" aria-hidden="true">›</span>
      <button
        type="button"
        class="crumb"
        disabled={busy || browsing}
        aria-current={index === crumbs.length - 1 ? "page" : undefined}
        onclick={() => goToCrumb(index)}
      >{crumb.name}</button>
    {/each}
  </nav>

  {#if matches.length > 0}
    <!-- A search is showing: its results replace the branch, and the breadcrumb
         above is still the way back to browsing. -->
    <h3>Search results</h3>
    <ul class="market-picker">
      {#each matches as match (match.typeID)}
        <li>
          <button type="button" class="pick-row" disabled={busy} onclick={() => chooseItem(match)}>
            <TypeIcon typeID={match.typeID} name={match.name} />
            <span class="pick-main">
              <span class="pick-name">{match.name}</span>
              <span class="pick-meta">{match.groupName}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if browsing}
    <p class="note">Opening…</p>
  {:else}
    {#if groups.length === 0 && groupTypes.length === 0}
      <p class="empty">This part of the market holds nothing.</p>
    {/if}
    <ul class="market-picker">
      {#each groups as node (node.marketGroupID)}
        <li>
          <button type="button" class="pick-row pick-group" disabled={busy} onclick={() => enterGroup(node)}>
            <span class="pick-main">
              <span class="pick-name">{node.name}</span>
            </span>
            <span class="pick-chevron" aria-hidden="true">›</span>
          </button>
        </li>
      {/each}
      {#each groupTypes as item (item.typeID)}
        <li>
          <button type="button" class="pick-row" disabled={busy} onclick={() => chooseItem(item)}>
            <TypeIcon typeID={item.typeID} name={item.name} />
            <span class="pick-main">
              <span class="pick-name">{item.name}</span>
              <span class="pick-meta">{item.groupName}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if groupTypesCapped}
      <!-- Never a silent slice: the panel says it capped so a player can narrow
           with the search box instead of believing they have seen everything. -->
      <p class="note">Only the first {groupTypes.length} items here are listed — search to narrow it.</p>
    {/if}
  {/if}
  {#if !$market.loaded}
    <p class="note">Loading the market…</p>
  {:else}
    <p class="note">
      Your ISK: <strong>{formatIsk($market.cashBalance)}</strong>.
      {#if $market.escrow}
        {formatIsk($market.escrow.isk)} of it is tied up in buy orders.
      {/if}
    </p>
  {/if}
</section>

{#if $market.loaded}
  <section>
    <p class="controls">
      <button type="button" class:active={tab === "book"} onclick={() => (tab = "book")}>
        What is on sale
      </button>
      <button type="button" class:active={tab === "orders"} onclick={() => (tab = "orders")}>
        Your orders
      </button>
      <button type="button" class:active={tab === "trades"} onclick={() => (tab = "trades")}>
        Your trades
      </button>
      <button type="button" class:active={tab === "escrow"} onclick={() => (tab = "escrow")}>
        What is tied up
      </button>
    </p>
  </section>
{/if}

{#if $market.loaded && tab === "book"}
  <section>
    <h2>
      {#if $market.typeID === null}
        Pick an item
      {:else}
        {chosenName || typeName($market.typeID)}
      {/if}
    </h2>
    {#if $market.typeID === null}
      <p class="note">Search for an item above to see who is buying and selling it.</p>
    {:else}
      {#if $market.bookError}
        <p class="error">This item's market could not be read: {$market.bookError}</p>
      {/if}
      <p class="note">
        Cheapest on sale: <strong>{formatIsk(best.bestSell)}</strong> ·
        Best price anyone is paying: <strong>{formatIsk(best.bestBuy)}</strong>.
        These are what is on offer right now — the server works out what a trade
        actually costs when you place an order.
      </p>
      <p class="controls">
        <label>
          Show orders
          <select bind:value={maxJumps}>
            <option value={-1}>Anywhere in the region</option>
            <option value={0}>Where you are only</option>
            <option value={1}>Within 1 jump</option>
            <option value={5}>Within 5 jumps</option>
            <option value={10}>Within 10 jumps</option>
          </select>
        </label>
        <button type="button" disabled={busy} onclick={() => startDraft("buy")}>
          Offer to buy…
        </button>
        <button
          type="button"
          disabled={busy || sellableStacks.length === 0}
          onclick={() => startDraft("sell")}
        >
          Offer to sell…
        </button>
      </p>

      <!--
        R84 — THE BOOKS ARE LISTS, AND THE ROWS DO SOMETHING.

        They were six-column tables, so reading them in a market window meant
        scrolling sideways — the same failure the overview had (R82), and the
        same fix: price and quantity are what a trader reads, everything else is
        a muted line underneath that truncates.

        Each row is a button that carries its price into the order draft. The
        numbers you want were already on screen; typing them again by hand was
        the only way to use them.
      -->
      <h3>On sale (you can buy these)</h3>
      {#if sells.length === 0}
        <p class="empty">Nobody is selling this here right now.</p>
      {:else}
        <ul class="market-book">
          {#each sells as order (order.orderID)}
            <li>
              <button
                type="button"
                class="book-row"
                disabled={busy}
                title={`Use ${formatIsk(order.price)} as your buy price`}
                onclick={() => useOrderPrice(order, "buy")}
              >
                <span class="book-price">{formatIsk(order.price)}</span>
                <span class="book-main">
                  <span class="book-where">{stationName(order.stationID)}</span>
                  <span class="book-meta">
                    {systemName(order.solarSystemID)} · {distanceLabel(order.jumps)}{order.minimumVolume >
                    1
                      ? ` · ${order.minimumVolume} minimum`
                      : ""}
                  </span>
                </span>
                <span class="book-qty">×{order.volumeRemaining}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <h3>Wanted (you can sell to these)</h3>
      {#if buys.length === 0}
        <p class="empty">Nobody is buying this here right now.</p>
      {:else}
        <ul class="market-book">
          {#each buys as order (order.orderID)}
            <li>
              <button
                type="button"
                class="book-row"
                disabled={busy}
                title={`Use ${formatIsk(order.price)} as your sell price`}
                onclick={() => useOrderPrice(order, "sell")}
              >
                <span class="book-price">{formatIsk(order.price)}</span>
                <span class="book-main">
                  <span class="book-where">{stationName(order.stationID)}</span>
                  <span class="book-meta">
                    {systemName(order.solarSystemID)} · {distanceLabel(order.jumps)} · reaches {rangeLabel(
                      order.range,
                    )}
                  </span>
                </span>
                <span class="book-qty">×{order.volumeRemaining}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if $market.priceHistory.length > 0}
        <h3>Recent prices</h3>
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr><th>Day</th><th class="num">Lowest</th><th class="num">Highest</th><th class="num">Average</th><th class="num">Traded</th></tr>
            </thead>
            <tbody>
              {#each $market.priceHistory as day (day.day)}
                <tr>
                  <td data-label="Day">{dateText(day.day)}</td>
                  <td class="num" data-label="Lowest">{formatIsk(day.low)}</td>
                  <td class="num" data-label="Highest">{formatIsk(day.high)}</td>
                  <td class="num" data-label="Average">{formatIsk(day.average)}</td>
                  <td class="num" data-label="Traded">{day.volume}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </section>

  {#if draft !== null && $market.typeID !== null}
    <section class="bulk">
      <h2>
        {draft.side === "buy" ? "Offer to buy" : "Offer to sell"}
        {chosenName || typeName($market.typeID)}
      </h2>
      {#if !confirming}
        {#if draft.side === "sell"}
          <p class="controls">
            <label>
              Which of yours to sell
              <select bind:value={sellItemID}>
                {#each sellableStacks as stack (stack.itemID)}
                  <option value={stack.itemID}>
                    {typeName(stack.typeID)} — {stack.quantity} you are holding
                  </option>
                {/each}
              </select>
            </label>
          </p>
          {#if chosenStack === null}
            <p class="note">
              You are not holding any of this here, so there is nothing to sell.
            </p>
          {/if}
        {/if}
        <p class="controls">
          <label>
            Price for each one
            <input type="number" min="0.01" step="0.01" bind:value={draft.price} />
          </label>
          <label>
            How many
            <input type="number" min="1" step="1" bind:value={draft.quantity} />
          </label>
          <label>
            How long to leave it open
            <select bind:value={draft.durationDays}>
              {#each DURATION_CHOICES as choice (choice.days)}
                <option value={choice.days}>{choice.label}</option>
              {/each}
            </select>
          </label>
        </p>
        {#if draftPriceCheck && !draftPriceCheck.ok && draft.price !== ""}
          <p class="error">{draftPriceCheck.message}</p>
        {/if}
        {#if draftQuantityCheck && !draftQuantityCheck.ok && draft.quantity !== ""}
          <p class="error">{draftQuantityCheck.message}</p>
        {/if}
        {#if draft.side === "sell" && chosenStack !== null && Number(draft.quantity) > chosenStack.quantity}
          <p class="error">
            You only have {chosenStack.quantity} of these to sell.
          </p>
        {/if}
        <p class="controls">
          <button type="button" disabled={busy || !draftReady} onclick={() => (confirming = true)}>
            Check this order…
          </button>
          <button type="button" class="minor" disabled={busy} onclick={closeDraft}>
            Never mind
          </button>
        </p>
      {:else}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <tbody>
              <tr>
                <th>Item</th>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={$market.typeID} name={chosenName || typeName($market.typeID)} />
                    {chosenName || typeName($market.typeID)}
                  </span>
                </td>
              </tr>
              <tr>
                <th>Price for each one</th>
                <td class="num" data-label="Price for each one">
                  {formatIsk(draftPriceCheck?.price.toFixed(2) ?? null)}
                </td>
              </tr>
              <tr>
                <th>How many</th>
                <td class="num" data-label="How many">{draft.quantity}</td>
              </tr>
              <tr>
                <th>That comes to</th>
                <td class="num" data-label="That comes to">{formatIsk(draftValue)}</td>
              </tr>
              <tr>
                <th>Broker's fee (estimate)</th>
                <td class="num" data-label="Broker's fee (estimate)">
                  about {formatIsk(draftFee?.amount ?? null)}
                </td>
              </tr>
              <tr>
                <th>Your ISK right now</th>
                <td class="num" data-label="Your ISK right now">{formatIsk($market.cashBalance)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="note">
          The broker's fee above is an <strong>estimate</strong> worked out at the
          standard rate. Your trading skills and your standing with this station's
          owner change what you are really charged, and this app cannot see either
          of them. Once the order goes through, the amount you were actually
          charged is shown here.
        </p>
        <p class="controls">
          <button type="button" class="danger" disabled={busy} onclick={placeOrder}>
            {draft.side === "buy" ? "Yes, place this buy order" : "Yes, place this sell order"}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (confirming = false)}>
            Go back and change it
          </button>
        </p>
      {/if}
    </section>
  {/if}
{/if}

{#if $market.loaded && tab === "orders"}
  <section>
    <h2>Orders you have open</h2>
    {#if $market.ownOrdersError}
      <p class="error">Your orders could not be read: {$market.ownOrdersError}</p>
    {/if}
    {#if openOrders.length === 0}
      <p class="empty">You have no orders open right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Buying or selling</th>
              <th class="num">Price each</th>
              <th class="num">Left</th>
              <th>Where</th>
              <th class="num">Tied up</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each openOrders as order (order.orderID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={order.typeID} name={typeName(order.typeID)} />
                    {typeName(order.typeID)}
                  </span>
                </td>
                <td data-label="Buying or selling">
                  {order.side === "buy" ? "Buying" : "Selling"}
                </td>
                <td class="num" data-label="Price each">{formatIsk(order.price)}</td>
                <td class="num" data-label="Left">{order.volumeRemaining} of {order.volumeEntered}</td>
                <td data-label="Where">{stationName(order.stationID)}</td>
                <td class="num" data-label="Tied up">
                  {order.side === "buy" ? formatIsk(order.escrow) : "—"}
                </td>
                <td data-label="Action">
                  <div class="row-actions">
                    {#if modifyingOrderID === order.orderID}
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        bind:value={modifyPrice}
                        aria-label="New price for each one"
                      />
                      {#if confirmingModify}
                        <button
                          type="button"
                          class="danger"
                          disabled={busy || modifyCheck?.ok !== true}
                          onclick={() => applyModify(order)}
                        >
                          Yes, change the price
                        </button>
                        <button
                          type="button"
                          class="minor"
                          disabled={busy}
                          onclick={() => (confirmingModify = false)}
                        >
                          Go back
                        </button>
                      {:else}
                        <button
                          type="button"
                          disabled={busy || modifyCheck?.ok !== true}
                          onclick={() => (confirmingModify = true)}
                        >
                          Check this change…
                        </button>
                        <button type="button" class="minor" disabled={busy} onclick={closeModify}>
                          Never mind
                        </button>
                      {/if}
                    {:else if cancellingOrderID === order.orderID}
                      <button
                        type="button"
                        class="danger"
                        disabled={busy}
                        onclick={() => cancelOrder(order)}
                      >
                        Yes, take this order down
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingOrderID = null)}
                      >
                        Leave it up
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => startModify(order)}
                      >
                        Change the price…
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingOrderID = order.orderID)}
                      >
                        Take it down…
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if modifyingOrderID !== null && confirmingModify}
        <p class="note">
          Changing the price of an order costs a fee, and on a buy order it also
          changes how much ISK is tied up. The exact amount is worked out by the
          server, and what you were actually charged is shown once it goes
          through.
        </p>
      {/if}
      {#if cancellingOrderID !== null}
        <p class="note">
          Taking a buy order down returns the ISK it had tied up. The fee you
          paid to place it is not returned.
        </p>
      {/if}
    {/if}
  </section>

  {#if $market.orderHistory.length > 0}
    <section>
      <h2>Orders that have finished</h2>
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Buying or selling</th>
              <th class="num">Price each</th>
              <th>Where</th>
              <th>What happened</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {#each $market.orderHistory as order (order.orderID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={order.typeID} name={typeName(order.typeID)} />
                    {typeName(order.typeID)}
                  </span>
                </td>
                <td data-label="Buying or selling">
                  {order.side === "buy" ? "Buying" : "Selling"}
                </td>
                <td class="num" data-label="Price each">{formatIsk(order.price)}</td>
                <td data-label="Where">{stationName(order.stationID)}</td>
                <td data-label="What happened">{FILL_STATE_LABELS[order.state]}</td>
                <td data-label="Placed">{dateText(order.issuedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}

{#if $market.loaded && tab === "trades"}
  <section>
    <h2>Trades you have made</h2>
    {#if $market.transactionsError}
      <p class="error">Your trades could not be read: {$market.transactionsError}</p>
    {/if}
    {#if $market.transactions.length === 0}
      <p class="empty">You have not traded anything yet.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Bought or sold</th>
              <th class="num">How many</th>
              <th class="num">Price each</th>
              <th>Where</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {#each $market.transactions as trade (trade.transactionID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={trade.typeID} name={typeName(trade.typeID)} />
                    {typeName(trade.typeID)}
                  </span>
                </td>
                <td data-label="Bought or sold">
                  {trade.side === "bought"
                    ? "You bought"
                    : trade.side === "sold"
                      ? "You sold"
                      : "—"}
                </td>
                <td class="num" data-label="How many">{trade.quantity}</td>
                <td class="num" data-label="Price each">{formatIsk(trade.price)}</td>
                <td data-label="Where">{stationName(trade.stationID)}</td>
                <td data-label="When">{dateText(trade.transactedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if $market.loaded && tab === "escrow"}
  <section>
    <h2>What your orders have tied up</h2>
    {#if $market.escrow === null}
      <p class="note">This could not be read right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <tbody>
            <tr>
              <th>ISK held for your buy orders</th>
              <td class="num" data-label="ISK held for your buy orders">
                {formatIsk($market.escrow.isk)}
              </td>
            </tr>
            <tr>
              <th>Goods held for your sell orders</th>
              <td class="num" data-label="Goods held for your sell orders">
                {$market.escrow.items}
              </td>
            </tr>
            <tr>
              <th>ISK you can still spend</th>
              <td class="num" data-label="ISK you can still spend">{formatIsk($market.cashBalance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note">
        When you offer to buy something, the ISK is set aside straight away and
        held until the order is filled or you take it down. Goods you have
        offered for sale are held the same way.
      </p>
    {/if}
  </section>
{/if}
