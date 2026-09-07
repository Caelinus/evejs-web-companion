<script lang="ts">
  // The mining loop's dockside half (goal R23 slice B): what you mined, getting
  // it out of the ship, and turning it into minerals.
  //
  // The other half — flying to a belt, locking a rock and running the laser —
  // is not here, and deliberately so: it is the GENERIC targeting and module
  // layer on the Around Your Ship tab, which a mining laser and a turret use
  // identically. This panel is only the parts that are actually about ore.
  //
  // A pure reader of the store's mining slice. It computes nothing about
  // mining: it does not predict a yield, does not price minerals, and does not
  // decide what reprocessing will produce. Every number on screen came from the
  // server, and anything the server did not give reads as "not known".
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  import GridPicker from "./GridPicker.svelte";
  import {
    compressionFacilities,
    compressionRefusal,
    facilityDistanceMeters,
  } from "../space/compression.ts";
  import { formatDistance } from "../space/overview.ts";
  import type { PickOption } from "./gridPicker.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { MiningHold } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const space = store.space;

  let busy = $state(false);
  let error = $state("");
  let selected = $state<number[]>([]);
  // The armed half of the two-step reprocess. Keyed by the exact stacks it was
  // armed for, so changing the selection disarms it: a confirmation must never
  // outlive the thing it was shown for.
  let confirmingFor = $state<string | null>(null);

  const docked = $derived($flight.status?.docked === true);
  // Only holds worth showing: one the ship actually HAS, one with something in
  // it, or one whose read failed (which the player should know about). A hull
  // with no gas bay would otherwise draw an empty 0 / 0 bar that means nothing.
  const holds = $derived(
    $mining.holds.filter(
      (hold) => hold.present || (hold.items?.length ?? 0) > 0 || hold.error !== null,
    ),
  );

  function selectionKey(ids: readonly number[]): string {
    return [...ids].sort((a, b) => a - b).join(",");
  }
  const armed = $derived(confirmingFor !== null && confirmingFor === selectionKey(selected));

  function itemName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "Unknown");
  }

  /**
   * A hold's fill, as the SERVER reported it. Anything the ship did not say
   * reads as "not known" — never as 0, which would look like an empty hold.
   */
  function capacityText(hold: MiningHold): string {
    const capacity = hold.capacity;
    if (!capacity || capacity.capacity === null) {
      return "not known";
    }
    const used = capacity.used === null ? null : capacity.used;
    if (used === null) {
      return `holds ${capacity.capacity.toLocaleString()} m³`;
    }
    return `${used.toLocaleString()} of ${capacity.capacity.toLocaleString()} m³`;
  }
  function fillPercent(hold: MiningHold): number | null {
    const capacity = hold.capacity;
    if (!capacity || capacity.capacity === null || capacity.used === null || capacity.capacity <= 0) {
      return null;
    }
    return Math.min(100, Math.round((capacity.used / capacity.capacity) * 100));
  }

  const allItems = $derived(holds.flatMap((hold) => hold.items ?? []));

  function toggle(itemID: number): void {
    selected = selected.includes(itemID)
      ? selected.filter((id) => id !== itemID)
      : [...selected, itemID];
    // Any change to WHAT is selected disarms the confirmation.
    confirmingFor = null;
  }

  // Everything this panel names resolves through the shared name cache, so ore
  // and minerals read as "Veldspar" and "Tritanium" and never as a typeID (R7d).
  $effect(() => {
    const refs: NameRef[] = [];
    for (const item of allItems) {
      refs.push({ kind: "type", id: item.typeID });
    }
    for (const quote of $mining.quotes) {
      if (quote.typeID !== null) {
        refs.push({ kind: "type", id: quote.typeID });
      }
      for (const output of quote.outputs) {
        refs.push({ kind: "type", id: output.typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // The tax the station will charge, as a percentage. null stays "not known":
  // reprocessing DEBITS this from the wallet, so a confident 0 would tell the
  // player the refinery is free.
  const taxText = $derived(
    $mining.taxRate === null ? null : `${($mining.taxRate * 100).toFixed(2)}%`,
  );

  /** A quote is on screen at all (server state, independent of what is picked). */
  const hasQuote = $derived($mining.quotesFor.length > 0);
  /**
   * ...and it is the quote for what is picked RIGHT NOW. Only then may the
   * destructive control appear: confirming against numbers computed for a
   * different set of stacks is exactly the mistake this gate exists to stop.
   */
  const quotedForSelection = $derived(
    hasQuote && selectionKey($mining.quotesFor) === selectionKey(selected),
  );

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

  // --- in space: what you can do with a full hold out here --------------------
  //
  // ⚠ THE HOLD SECTIONS ABOVE ALREADY WORKED IN SPACE; THE ACTIONS DID NOT.
  // Unload and Refine both need a station, so a flying miner with a full hold
  // had a panel that could only tell them to dock. These two are what the game
  // actually offers out here.

  /** Every stack sitting in a hold — what a jettison or a compress acts on. */
  const heldStacks = $derived(
    holds.flatMap((hold) =>
      (hold.items ?? []).map((item) => ({
        itemID: item.itemID,
        label: itemName(item.typeID),
        quantity: item.quantity,
      })),
    ),
  );

  /**
   * The support ships on grid that could compress for you — own hull first.
   *
   * The rule is `space/compression.ts`, shared with the `compress-ore` bot
   * macro rather than copied: the branch two copies get wrong is the absent
   * reading, which must mean "not a facility" and never "worth trying".
   */
  const facilities = $derived(compressionFacilities($space.snapshot));
  const facilityOptions = $derived<PickOption[]>(
    facilities.map((facility) => {
      const own = facility.itemID === ($space.snapshot?.ship?.itemID ?? null);
      const distance = facilityDistanceMeters($space.snapshot, facility);
      return {
        id: facility.itemID,
        label: facility.name && facility.name.length > 0
          ? facility.name
          : resolvedName($names.resolved, "type", facility.typeID, "A support ship"),
        hint: own ? "your own ship" : distance === null ? "range not known" : formatDistance(distance),
      };
    }),
  );
  /**
   * What the player explicitly picked, or 0 for "they have not".
   *
   * ⚠ THE DEFAULT IS DERIVED, NOT WRITTEN IN BY AN EFFECT. It falls back to the
   * first candidate — own hull when it qualifies, which is the one with no
   * range problem to solve and no fleet check to fail. Seeding it through an
   * effect instead would leave one frame where the select says "Pick one…" and
   * the button is already armed with something else, and would not happen at
   * all on a server-rendered first paint.
   */
  let pickedFacilityID = $state(0);
  const facilityID = $derived(
    pickedFacilityID !== 0 ? pickedFacilityID : (facilities[0]?.itemID ?? 0),
  );
  const pickedFacility = $derived(facilities.find((f) => f.itemID === facilityID) ?? null);
  /**
   * Why compressing would not work, or null. Only the two things the BROWSER
   * can know: there is no facility, or we are measurably outside its own stated
   * reach. Everything else is the server's call, refused with one silence.
   */
  const compressRefusal = $derived(compressionRefusal($space.snapshot, pickedFacility));

  /**
   * The armed half of the two-step jettison, keyed to the exact stacks.
   *
   * ⚠ JETTISON IS DESTRUCTIVE IN THE WAY THAT MATTERS TO A MINER: the ore is
   * not destroyed, it is sitting on the grid in a container anyone can take. So
   * it gets the same two-step treatment reprocessing has, and the confirmation
   * disarms the moment the selection changes — a confirmation must never
   * outlive the thing it was shown for.
   */
  let jettisonArmedFor = $state<string | null>(null);
  const jettisonArmed = $derived(
    jettisonArmedFor !== null && jettisonArmedFor === selectionKey(selected),
  );

  async function jettison(): Promise<void> {
    await run(() => flow.jettisonItems(selected));
    selected = [];
    jettisonArmedFor = null;
  }

  async function compress(itemID: number): Promise<void> {
    if (facilityID === 0) {
      return;
    }
    await run(() => flow.compressOre(itemID, facilityID));
  }

  async function unload(): Promise<void> {
    await run(() => flow.unloadMiningHolds(selected));
    selected = [];
    confirmingFor = null;
  }

  async function quote(): Promise<void> {
    await run(() => flow.loadReprocessingQuote(selected));
  }

  async function reprocess(): Promise<void> {
    await run(() => flow.reprocessItems(selected));
    selected = [];
    confirmingFor = null;
  }

  onMount(() => {
    void run(() => flow.loadMiningHolds());
    // R30 slice B — claim the space feed while this tab is open, so a player
    // watching the hold fill is not also freezing the grid the ore comes from.
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Mining</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={() => run(() => flow.loadMiningHolds())}>
        Refresh
      </button>
    </span>
  </header>
  <!--
    R30 slice E — this note used to end by telling the player to go and do the
    actual mining on the Around Your Ship tab. That instruction is DELETED, not
    reworded: that tab now has a Mine this verb on the thing you picked, so this
    page has no reason to direct traffic. It says what it shows, and stops
    there. A test asserts the sentence cannot come back — which is why this
    comment describes it rather than quoting it.
  -->
  <p class="note">
    What you have mined, and what to do with it.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $mining.holdsError}
    <p class="error">{$mining.holdsError}</p>
  {/if}
  {#if $mining.actionError}
    <p class="error">{$mining.actionError}</p>
  {/if}
  {#if $mining.silentDecline}
    <p class="error">{$mining.silentDecline}</p>
  {/if}
</section>

<section>
  <h2>Your holds</h2>
  {#if !$mining.holdsLoaded}
    <p class="note">Looking in your holds…</p>
  {:else if holds.length === 0}
    <p class="empty">
      This ship has no mining hold, and nothing has been mined into its cargo.
    </p>
  {:else}
    {#each holds as hold (hold.key)}
      <h3>{hold.label} <small class="note">{capacityText(hold)}</small></h3>
      {#if fillPercent(hold) !== null}
        <div
          class="hud-track"
          role="meter"
          aria-label={`${hold.label} fill`}
          aria-valuenow={fillPercent(hold) ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="hud-fill" style={`width: ${fillPercent(hold)}%`}></span>
        </div>
      {/if}
      {#if hold.error}
        <p class="error">That hold could not be read, so what is in it is unknown.</p>
      {:else if hold.items === null}
        <p class="error">That hold could not be read, so what is in it is unknown.</p>
      {:else if hold.items.length === 0}
        <p class="empty">Nothing in here yet.</p>
      {:else}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Pick</th>
                <th>Ore</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {#each hold.items as item (item.itemID)}
                <tr>
                  <td data-label="Pick">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.itemID)}
                      onchange={() => toggle(item.itemID)}
                      aria-label={`Pick ${itemName(item.typeID)}`}
                    />
                  </td>
                  <td data-label="Ore">
                    <span class="cell-item">
                      <TypeIcon typeID={item.typeID} name={itemName(item.typeID)} />
                      {itemName(item.typeID)}
                    </span>
                  </td>
                  <td class="num" data-label="Amount">{item.quantity.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/each}
  {/if}
</section>

<!--
  ============================================================== IN SPACE =====
  What a full hold can do out here. Both sections are drawn only in space, for
  the same reason Unload and Refine are drawn only docked: a control that could
  never work in the current state is not a control, it is a decoration that
  wastes a press.
-->
{#if !docked}
  <section class="bulk">
    <h2>Compress it</h2>
    <!--
      ⚠ COMPRESSION HAPPENS AT A SHIP, NOT A FACILITY YOU FLY TO. It is a mining
      support hull on this grid — your own or a fleet-mate's — running an
      Industrial Core plus a compression module. `space/compression.ts` decides
      which hulls qualify, and the bot macro reads the same rule.
    -->
    {#if facilityOptions.length === 0}
      <!--
        R30's rule: nothing on grid to compress against is a SENTENCE, not a
        hidden button. The player is told what would have to be true.
      -->
      <p class="note">
        No mining support ship on this grid is running its compression gear.
        Bring one, or switch yours on, and it will appear here.
      </p>
    {:else if heldStacks.length === 0}
      <p class="note">Nothing in your holds to compress.</p>
    {:else}
      <p class="controls">
        <GridPicker
          label="Compress at"
          options={facilityOptions}
          value={facilityID}
          onPick={(id) => (pickedFacilityID = id)}
          emptyText="No support ship on this grid."
        />
      </p>
      {#if compressRefusal}
        <!-- Drawn, wearing its reason — never a greyed control in silence. -->
        <p class="note error">{compressRefusal}</p>
      {/if}
      <ul class="compress-list">
        {#each heldStacks as stack (stack.itemID)}
          <li>
            <span class="compress-name">{stack.label}</span>
            <span class="compress-qty">{stack.quantity.toLocaleString()}</span>
            <button
              type="button"
              disabled={busy || facilityID === 0 || compressRefusal !== null}
              title={compressRefusal ?? ""}
              onclick={() => compress(stack.itemID)}
            >
              Compress
            </button>
          </li>
        {/each}
      </ul>
      <p class="note">
        One stack at a time, and your ship has the last word: ore with no
        compressed form is simply left as it is.
      </p>
    {/if}
  </section>

  <section class="bulk">
    <h2>Dump it into space</h2>
    <!--
      ⚠ JETTISON IS NOT "DELETE", AND IT IS NOT SAFE EITHER. The ore ends up in
      a container floating on the grid that ANYONE can take. That is why it gets
      the same two-step arming that reprocessing has, and why the words say
      plainly what happens rather than calling it "drop".
    -->
    {#if selected.length === 0}
      <p class="note">Pick what you want to dump from the list above.</p>
    {:else if !jettisonArmed}
      <p class="controls">
        <button
          type="button"
          disabled={busy}
          onclick={() => (jettisonArmedFor = selectionKey(selected))}
        >
          Dump {selected.length} into space…
        </button>
      </p>
      <p class="note">
        It goes into a container floating right here, which anyone who comes
        past can take. Nothing is destroyed and nothing is yours any more.
      </p>
    {:else}
      <p class="controls">
        <button type="button" class="danger" disabled={busy} onclick={jettison}>
          Yes — dump {selected.length} into space
        </button>
        <button type="button" disabled={busy} onclick={() => (jettisonArmedFor = null)}>
          Keep it
        </button>
      </p>
    {/if}
  </section>
{/if}

<section class="bulk">
  <h2>Move it to your hangar</h2>
  {#if !docked}
    <p class="note">Dock at a station to unload.</p>
  {:else if selected.length === 0}
    <p class="note">Pick what you want to unload from the list above.</p>
  {:else}
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={unload}>
        Unload {selected.length} to the hangar
      </button>
    </p>
  {/if}
</section>

<section class="bulk">
  <h2>Refine it into minerals</h2>
  <!--
    ⚠ Reprocessing CONSUMES the ore and CHARGES the station's tax in ISK. So it
    is two deliberate steps with the server's own numbers in between: ask the
    station what it would give you AND what it will take, and only then offer
    the button that actually does it. The BFF refuses this call outright without
    an explicit confirmation, so the gate exists on both sides.
  -->
  {#if !docked}
    <p class="note">Dock at a station to use its refinery.</p>
  {:else if selected.length === 0 && !hasQuote}
    <p class="note">Pick what you want to refine from the list above.</p>
  {:else}
    {#if selected.length > 0}
      <p class="controls">
        <button type="button" disabled={busy} onclick={quote}>
          What would I get for {selected.length}?
        </button>
      </p>
    {/if}
    {#if $mining.quotesError}
      <p class="error">{$mining.quotesError}</p>
    {:else if hasQuote}
      <p class="note">
        The station takes a cut of everything it refines:
        {#if taxText === null}
          <span class="stat-unavailable">its cut is not known</span>
        {:else}
          <strong>{taxText}</strong>
        {/if}
      </p>
      {#if $mining.quotes.length === 0}
        <p class="empty">The station would not refine any of that.</p>
      {:else}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Ore</th>
                <th class="num">Refined</th>
                <th class="num">Left over</th>
                <th class="num">Its cut</th>
                <th>You would get</th>
              </tr>
            </thead>
            <tbody>
              {#each $mining.quotes as quote (quote.itemID)}
                <tr>
                  <td data-label="Ore">
                    <span class="cell-item">
                      <TypeIcon
                        typeID={quote.typeID}
                        name={quote.typeID === null ? "Unknown" : itemName(quote.typeID)}
                      />
                      {quote.typeID === null ? "Unknown" : itemName(quote.typeID)}
                    </span>
                  </td>
                  <td class="num" data-label="Refined">
                    {quote.quantityToProcess === null
                      ? "—"
                      : quote.quantityToProcess.toLocaleString()}
                  </td>
                  <td class="num" data-label="Left over">
                    {quote.leftOvers === null ? "—" : quote.leftOvers.toLocaleString()}
                  </td>
                  <td class="num" data-label="Its cut">
                    {#if quote.iskCost === null}
                      <span class="stat-unavailable">not known</span>
                    {:else}
                      {quote.iskCost.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })} ISK
                    {/if}
                  </td>
                  <td data-label="You would get">
                    {#if quote.outputs.length === 0}
                      <span class="stat-unavailable">not known</span>
                    {:else}
                      {quote.outputs
                        .map((out) => `${out.quantity.toLocaleString()} ${itemName(out.typeID)}`)
                        .join(", ")}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <!--
          The destructive control is reachable ONLY when the quote on screen is
          the quote for what is currently picked. Change the selection and this
          whole block goes away again — a confirmation must never outlive the
          numbers it was shown for.
        -->
        {#if quotedForSelection}
          <p class="controls">
            {#if armed}
              <button type="button" class="danger" disabled={busy} onclick={reprocess}>
                Yes, refine it
              </button>
              <button
                type="button"
                class="minor"
                disabled={busy}
                onclick={() => (confirmingFor = null)}
              >
                Keep the ore
              </button>
            {:else}
              <button
                type="button"
                class="minor"
                disabled={busy}
                onclick={() => (confirmingFor = selectionKey(selected))}
              >
                Refine it…
              </button>
            {/if}
          </p>
        {:else}
          <p class="note">
            That quote is for a different pick. Ask again for what you have
            picked now.
          </p>
        {/if}
        {#if armed}
          <p class="error">
            This uses up the ore for good, and the station takes
            {taxText === null ? "a cut it has not told us" : taxText} in ISK.
          </p>
        {/if}
      {/if}
    {:else}
      <p class="note">
        Ask first — the station tells you what you would get and what its cut is
        before anything is used up.
      </p>
    {/if}
  {/if}
</section>
