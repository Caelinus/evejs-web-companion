<script lang="ts">
  // Flight page (goal R5a): manually-stepped space movement — undock, warp to a
  // chosen gate/celestial, jump, and dock — plus a live status readout (current
  // system, in-space vs docked, ship state, last action, failure reason). A
  // pure reader of the store's flight slice; all ship.Undock / beyonce.Cmd*
  // logic runs on the BFF (which holds the beyonce bound park handle) and in
  // app/flow.ts. Manual buttons only — the autopilot decide-loop is R5b.
  import { onMount } from "svelte";
  import { isSessionLost } from "../app/flow.ts";
  import GridPicker from "./GridPicker.svelte";
  import { rowOptions } from "./gridPicker.ts";
  import { doingText, whereText, wrongText } from "./flightNarration.ts";
  import { buildOverviewRows } from "../space/overview.ts";
  import { jumpBlockedReason, jumpLabel } from "../space/gateLinks.ts";
  import { isDockableKind } from "../space/rowActions.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { OverviewRow } from "../space/overview.ts";
  import type { PickOption } from "./gridPicker.ts";
  import { nameKey, resolvedName } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const bot = store.bot;
  // svelte-ignore state_referenced_locally
  const travel = store.travel;

  // R7c — the flight status carries the active ship's ITEM id but no typeID, so
  // resolve the ship TYPE name by cross-referencing the inventory slice (the
  // active ship sits in the docked hangar/cargo rows, which carry the typeID).
  // Best-effort: in space, or before the inventory tab has loaded, we fall back
  // to the raw ship item ID.
  const activeShipTypeID = $derived.by<number | null>(() => {
    const shipID = $flight.status?.shipID ?? null;
    if (shipID === null || $inventory.activeShipID !== shipID) {
      return null;
    }
    const row =
      $inventory.hangar.rows.find((r) => r.itemID === shipID) ??
      $inventory.cargo.rows.find((r) => r.itemID === shipID);
    return row ? row.typeID : null;
  });

  $effect(() => {
    if (activeShipTypeID !== null) {
      flow.requestNames([{ kind: "type", id: activeShipTypeID }]);
    }
  });

  function activeShipText(): string {
    if (($flight.status?.shipID ?? null) === null) {
      return "—";
    }
    // Ship TYPE name only (e.g. "Algos"); the raw ship item ID is never rendered.
    const typeName = activeShipTypeID !== null ? $names.resolved[nameKey("type", activeShipTypeID)] : null;
    return typeName ?? "active ship";
  }

  let busy = $state(false);
  let error = $state("");

  // What the player has PICKED, by id — but never typed. Each one is filled by
  // choosing a named thing off the grid; see the pickers below.
  let warpTargetID = $state(0);
  let jumpGateID = $state(0);
  let dockStationID = $state(0);

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
    void run(() => flow.loadFlightStatus());
    // R30 slice B — claim the space feed. This panel reads live flight status
    // for a ship that is moving, so the feed must not go still because the
    // Overview tab happens to be closed. Released on unmount; the feed only
    // actually stops when the LAST viewer lets go.
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });

  // Show the resolved system/station/structure NAME (goal R7a), falling back to
  // the raw ID only until the flow resolves it (or when it has no static name).
  function locationText(): string {
    const status = $flight.status;
    if (!status) {
      return "—";
    }
    if (status.inSpace) {
      return `In space · ${$flight.solarSystemName ?? "unknown system"}`;
    }
    if (status.stationID) {
      return `Docked · ${$flight.stationName ?? "the station"}`;
    }
    if (status.structureID) {
      return `Docked · ${$flight.structureName ?? "a structure"}`;
    }
    return "—";
  }

  // The "Solar system" row: the resolved system NAME only (never the raw ID).
  function solarSystemText(): string {
    if (($flight.status?.solarSystemID ?? null) === null) {
      return "—";
    }
    return $flight.solarSystemName ?? "unknown system";
  }

  // --- the grid, as things you can pick ---------------------------------------
  //
  // ⚠ THIS IS WHERE THE RAW-ID FIELDS WENT. The panel used to ask a player to
  // type a "stargate / celestial ID", a "source stargate ID" and a "destination
  // station ID" — numbers the client is forbidden to show them (R7d), so the
  // three controls could only be used by someone reading the server's database.
  // Everything below is picked BY NAME off the grid the ship is actually on.

  const snapshot = $derived($space.snapshot);
  const origin = $derived(snapshot?.ship?.position ?? { x: 0, y: 0, z: 0 });

  /** What to call a row. Its own name where it has one, else what kind it is. */
  function rowName(row: OverviewRow): string {
    if (row.name && row.name.length > 0) {
      return row.name;
    }
    return resolvedName($names.resolved, "type", row.typeID, "");
  }

  /** Everything on the grid, nearest first — the ship's own row already dropped. */
  const gridRows = $derived(
    buildOverviewRows(snapshot, origin, { sort: "distance", cap: 400 }).rows,
  );

  /** Warp takes anything on the grid. */
  const warpOptions = $derived(rowOptions(gridRows, rowName));

  /**
   * Dock takes stations and structures.
   *
   * ⚠ THE ROW'S KIND DECIDES, exactly as `rowActions.ts` decides it — never the
   * name, the distance or the category number. One rule, one place.
   */
  const dockOptions = $derived(
    rowOptions(gridRows.filter((row) => isDockableKind(row.kind)), rowName),
  );

  /**
   * Jump takes ONE gate, and that is the whole fix.
   *
   * ⚠ THE FAR SIDE IS NOT A SECOND CHOICE. `GateLink` carries
   * `destinationGateID`, so picking a gate in this system already determines
   * the gate you arrive at. The old panel asked for both and let a player pair
   * two gates that have nothing to do with each other — a command the server
   * can only refuse.
   *
   * ⚠ AND BEING IN THE GATE GRAPH IS WHAT MAKES SOMETHING A GATE. Not the
   * snapshot's coarse `kind`, which does not tell a stargate from any other
   * structure, and not a group number. `gateLinks.ts` says so in as many words,
   * and this reads the same graph the autopilot flies.
   */
  const jumpOptions = $derived.by<PickOption[]>(() => {
    const byID = new Map(gridRows.map((row) => [row.itemID, row] as const));
    return $space.gateLinks.map((link) => {
      const row = byID.get(link.gateID) ?? null;
      const blocked = jumpBlockedReason(link);
      return {
        id: link.gateID,
        // `jumpLabel` names the far system, or says plainly that it cannot.
        label: row ? rowName(row) || jumpLabel(link) : jumpLabel(link),
        // The destination, and the reason when there is one — a gate we cannot
        // send is still LISTED, wearing its reason, rather than hidden.
        hint: blocked ?? (link.toSystemName ? `to ${link.toSystemName}` : "destination not in the star map"),
      };
    });
  });

  const pickedGate = $derived($space.gateLinks.find((link) => link.gateID === jumpGateID) ?? null);
  /** Why the picked gate cannot be jumped, or null. Rendered ON the control. */
  const jumpUnavailable = $derived(pickedGate === null ? null : jumpBlockedReason(pickedGate));

  // --- what is happening, in the words of whatever is doing it ----------------
  //
  // Lifted from the cockpit's flight strip. The rules are in
  // `flightNarration.ts`; nothing here synthesizes a sentence.

  const whereLine = $derived(whereText($flight, snapshot, $names.resolved));
  const doingLine = $derived(doingText($bot, $travel));
  const wrongLine = $derived(
    wrongText({
      flightActionError: $flight.actionError,
      travelFailureReason: $travel.failureReason,
      botFailureReason: $bot.failureReason,
      targetingActionError: $targeting.actionError,
    }),
  );

  function shipStateText(): string {
    const status = $flight.status;
    if (!status) {
      return "—";
    }
    if (!status.inSpace) {
      return "Docked";
    }
    const mode = status.shipMode ?? "unknown";
    const fraction =
      status.shipSpeedFraction !== null
        ? ` · speed ${Math.round(status.shipSpeedFraction * 100)}%`
        : "";
    return `${mode}${fraction}`;
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Flight</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => run(() => flow.loadFlightStatus())}>
        Refresh flight status
      </button>
    </p>
  </header>
  <p class="note">
    Fly manually, one step at a time: undock, warp, jump, and dock. Use the
    Travel tab to let the autopilot do it for you.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<!--
  R30 slice C — the three lines the cockpit's flight strip answered: WHERE am I,
  what is happening, and what went wrong. They came here when that panel was
  taken apart, and the rules came with them (`flightNarration.ts`):

  ⚠ NOTHING IS SYNTHESIZED. Hand-flying shows no "doing" line at all, because
  there is no authority to quote — an invented "Approaching…" is
  indistinguishable, to a player, from a sentence the autopilot really wrote.
-->
<section class="flight-strip">
  <p class="strip-where">{whereLine}</p>
  {#if doingLine}
    <p class="strip-doing">{doingLine}</p>
  {/if}
  {#if wrongLine}
    <p class="strip-wrong error">{wrongLine}</p>
  {/if}
</section>

<section>
  <h2>Status</h2>
  {#if !$flight.loaded}
    <p class="note">Loading flight status…</p>
  {:else}
    <table class="guests">
      <tbody>
        <tr><th>Location</th><td>{locationText()}</td></tr>
        <tr><th>Solar system</th><td>{solarSystemText()}</td></tr>
        <tr><th>Active ship</th><td>{activeShipText()}</td></tr>
        <tr><th>Ship state</th><td>{shipStateText()}</td></tr>
        <tr><th>Last action</th><td>{$flight.lastAction ?? "—"}</td></tr>
        <tr>
          <th>Last failure</th>
          <td>{#if $flight.actionError}<span class="error">{$flight.actionError}</span>{:else}—{/if}</td>
        </tr>
      </tbody>
    </table>
  {/if}
</section>

{#if $flight.loaded && $flight.status && !$flight.status.inSpace}
  <section>
    <h2>Undock</h2>
    <p class="note">Leave the station and enter space to warp, jump, and dock.</p>
    <p>
      <button type="button" disabled={busy} onclick={() => run(() => flow.undock())}>
        Undock
      </button>
    </p>
  </section>
{/if}

{#if $flight.loaded && $flight.status && $flight.status.inSpace}
  <section>
    <h2>Stop the ship</h2>
    <p class="controls">
      <button type="button" disabled={busy} onclick={() => run(() => flow.stopShip())}>
        Stop the ship
      </button>
    </p>
    <p class="note">
      Cuts the engines and switches the autopilot off, so nothing starts flying
      you somewhere again. To orbit something, hold a distance from it, line up
      with it or warp to a chosen distance, open the Overview tab and use the
      buttons on the row for the thing you want.
    </p>
  </section>

  <section>
    <h2>Warp to something</h2>
    <p class="controls">
      <GridPicker
        label="Warp to"
        options={warpOptions}
        bind:value={warpTargetID}
        emptyText="Nothing on the grid to warp to yet."
      />
      <button
        type="button"
        disabled={busy || warpTargetID === 0}
        onclick={() => run(() => flow.warpTo(warpTargetID))}
      >
        Warp to it
      </button>
    </p>
  </section>

  <section>
    <h2>Jump through a stargate</h2>
    <p class="controls">
      <!--
        ⚠ ONE GATE, NOT TWO. This asked for a source AND a destination gate id.
        The link carries its own far side, so the second field could only ever
        be filled correctly by copying what the first one implied — or wrongly,
        pairing two unrelated gates into a command the server can only refuse.
      -->
      <GridPicker
        label="Gate"
        options={jumpOptions}
        bind:value={jumpGateID}
        emptyText="No stargates in the star map for this system."
      />
      <!--
        R30's rule: a control that cannot work is DRAWN, wearing its reason.
        The only blocking case is a graph edge with no gate recorded on the far
        side — `CmdStargateJump` needs both ends, so there is nothing honest to
        send. Being far from the gate is NOT blocked here: the server owns that
        refusal and states its own range.
      -->
      <button
        type="button"
        disabled={busy || pickedGate === null || jumpUnavailable !== null}
        title={jumpUnavailable ?? ""}
        onclick={() =>
          pickedGate && run(() => flow.jump(pickedGate.gateID, pickedGate.destinationGateID))}
      >
        {jumpUnavailable ?? (pickedGate ? jumpLabel(pickedGate) : "Jump")}
      </button>
    </p>
    {#if $space.gateLinksError}
      <p class="error">{$space.gateLinksError}</p>
    {/if}
    <p class="note">Refresh flight status to see the new system.</p>
  </section>

  <section>
    <h2>Dock at a station</h2>
    <p class="controls">
      <!-- One picked place, two different verbs — see the note below. -->
      <GridPicker
        label="Station"
        options={dockOptions}
        bind:value={dockStationID}
        emptyText="Nothing on this grid you could dock at."
      />
      <!--
        R24 slice B — two different things, named as two different things.
        "Dock" is the raw single command: it only works if the ship is already
        alongside. "Take me there and dock" closes the distance first — it
        warps, approaches and then docks, and it keeps going until the station
        has actually taken the ship or it can tell you why not.
      -->
      <button
        type="button"
        disabled={busy || dockStationID === 0}
        onclick={() => run(() => flow.dockAt(dockStationID))}
      >
        Take me there and dock
      </button>
      <button
        type="button"
        disabled={busy || dockStationID === 0}
        onclick={() => run(() => flow.dock(dockStationID))}
      >
        Dock
      </button>
    </p>
    <p class="note">
      Dock on its own needs the ship to be alongside already. Take me there and
      dock will fly the rest of the way for you and report each step as it goes.
      Either way the station itself confirms it — the ship is only docked once
      your flight status says so.
    </p>
  </section>
{/if}
