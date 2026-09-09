<script lang="ts">
  // THE SHOW INFO WINDOW (goal R76) — what this thing is, from everything the
  // client already knows about it.
  //
  // ⚠ IT NEVER INVENTS A SECTION. Each block below is drawn only when its source
  // actually answered: a rock that has left the grid loses its distance rather
  // than keeping a stale one, a module we have no dogma read for shows no
  // attribute table rather than an empty one, and a type the name cache has not
  // resolved says so instead of printing an id (R7d).
  //
  // That discipline is why the window is worth having. EVE's Show Info is
  // trusted precisely because every figure in it is real; one fabricated zero
  // would make a player check every other number by hand.
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfoTarget, subjectTypeID, type InfoSubject } from "./showInfo.ts";
  import { moduleEffectiveStats } from "../bridge/moduleAttributes.ts";
  import { formatDistance, hostileLabel, isHostile, ratioPercent } from "../space/overview.ts";
  import { distanceMeters } from "../space/overview.ts";
  import { spaceSelection } from "../space/selection.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { abbreviate } from "./fittingIcons.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const standings = store.standings;
  const subject = showInfoTarget.subject;

  const typeID = $derived(subjectTypeID($subject));

  /** The live snapshot row for a space subject, or null once it has left grid. */
  const entity = $derived.by<SpaceEntity | null>(() => {
    const current = $subject;
    if (current === null || current.kind !== "spaceObject") {
      return null;
    }
    return (
      ($space.snapshot?.entities ?? []).find((row) => row.itemID === current.itemID) ?? null
    );
  });

  /** The fitted module for a module subject, from the same fit the window shows. */
  const fittedModule = $derived.by(() => {
    const current = $subject;
    if (current === null || current.kind !== "module") {
      return null;
    }
    for (const slot of $fitting.slots) {
      if (slot.module && slot.module.itemID === current.itemID) {
        return slot.module;
      }
    }
    return null;
  });

  /**
   * The SERVER's post-dogma attributes for that module — skills, hull bonuses
   * and in-space effects already applied. This is the only place in the client
   * where a module's real numbers exist; the static SDE values would be a
   * different (and wrong) claim.
   */
  const moduleStats = $derived.by(() => {
    const current = $subject;
    if (current === null || current.kind !== "module") {
      return [];
    }
    const entry = $fitting.dogma?.items?.find((item) => item.itemID === current.itemID);
    return moduleEffectiveStats(entry?.attributes);
  });

  const title = $derived.by(() => {
    const current = $subject;
    if (current === null) {
      return "Show Info";
    }
    if (current.kind === "character") {
      return resolvedName($names.resolved, "character", current.characterID, "Unknown pilot");
    }
    // A space object's own name beats its type name — "Asteroid Belt 1" is more
    // use than "Asteroid Belt".
    const own = entity?.name;
    if (typeof own === "string" && own.length > 0) {
      return own;
    }
    return resolvedName($names.resolved, "type", typeID, "Unknown object");
  });

  const groupName = $derived(
    entity?.groupID != null
      ? resolvedName($names.resolved, "typeGroup", entity.groupID, "")
      : "",
  );
  const categoryName = $derived(
    entity?.categoryID != null
      ? resolvedName($names.resolved, "typeCategory", entity.categoryID, "")
      : "",
  );
  /** The type's own name, shown under a space object that has its own name. */
  const typeName = $derived(resolvedName($names.resolved, "type", typeID, ""));

  const shipPosition = $derived($space.snapshot?.ship?.position ?? null);
  const distance = $derived(
    entity && shipPosition ? distanceMeters(shipPosition, entity.position) : null,
  );
  const speed = $derived.by(() => {
    if (!entity) {
      return null;
    }
    const { x, y, z } = entity.velocity;
    const value = Math.sqrt(x * x + y * y + z * z);
    return Number.isFinite(value) ? value : null;
  });

  const condition = $derived(
    entity
      ? [
          { label: "Shield", pct: ratioPercent(entity.shieldRatio) },
          { label: "Armor", pct: ratioPercent(entity.armorRatio) },
          { label: "Hull", pct: ratioPercent(entity.hullRatio) },
        ].filter((row) => row.pct !== null)
      : [],
  );

  /** The standing we hold toward a pilot, when the standings slice has one. */
  const standing = $derived.by(() => {
    const current = $subject;
    if (current === null || current.kind !== "character") {
      return null;
    }
    return ($standings.char ?? []).find((row) => row.fromID === current.characterID) ?? null;
  });

  /** Ask for the names this window needs. Batched, cached, never throws. */
  $effect(() => {
    const refs: NameRef[] = [];
    if (typeID !== null) {
      refs.push({ kind: "type", id: typeID });
    }
    const current = $subject;
    if (current?.kind === "character") {
      refs.push({ kind: "character", id: current.characterID });
    }
    if (entity?.groupID != null) {
      refs.push({ kind: "typeGroup", id: entity.groupID });
    }
    if (entity?.categoryID != null) {
      refs.push({ kind: "typeCategory", id: entity.categoryID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function subjectKindLabel(current: InfoSubject): string {
    switch (current.kind) {
      case "spaceObject":
        return "On this grid";
      case "module":
        return "Fitted to your ship";
      case "character":
        return "Pilot";
      case "type":
        return "Item";
    }
  }
</script>

<section class="show-info">
  {#if $subject === null}
    <p class="empty">
      Nothing selected. Pick something and choose Show Info — from the overview, a
      target, or a fitting socket.
    </p>
  {:else}
    <header class="info-head">
      <TypeIcon {typeID} name={title} size="lg" fallbackText={abbreviate(title)} />
      <div class="info-identity">
        <h2>{title}</h2>
        <p class="info-kind">{subjectKindLabel($subject)}</p>
        {#if typeName && typeName !== title}
          <p class="info-type">{typeName}</p>
        {/if}
        {#if groupName || categoryName}
          <p class="info-class">
            {[categoryName, groupName].filter((part) => part.length > 0).join(" · ")}
          </p>
        {/if}
      </div>
    </header>

    {#if $subject.kind === "spaceObject"}
      {#if entity}
        <h3>Where it is</h3>
        <dl class="kv">
          <dt>Distance</dt>
          <dd>{distance != null ? formatDistance(distance) : "—"}</dd>
          <dt>Speed</dt>
          <dd>{speed != null ? `${Math.round(speed)} m/s` : "—"}</dd>
          {#if isHostile(entity)}
            <dt>Threat</dt>
            <dd>{hostileLabel(entity) ?? "Hostile"}</dd>
          {/if}
          {#if entity.remainingQuantity != null}
            <!-- Only a rock the server gave a mining record for. Null stays
                 absent rather than becoming a 0 that reads as mined out. -->
            <dt>Ore left</dt>
            <dd>{entity.remainingQuantity.toLocaleString("en-US")}</dd>
          {/if}
          {#if entity.oreValuePerM3 != null}
            <!-- What the retail client's Mining Surveyor shows as a colour: the
                 ore's reprocessed value per cubic metre. Absent when it could
                 not be priced — never a 0, which would read as worthless. -->
            <dt>Ore value</dt>
            <dd>{Math.round(entity.oreValuePerM3).toLocaleString("en-US")} ISK/m³</dd>
          {/if}
        </dl>

        {#if condition.length > 0}
          <h3>Condition</h3>
          <dl class="kv">
            {#each condition as row (row.label)}
              <dt>{row.label}</dt>
              <dd>{row.pct}%</dd>
            {/each}
          </dl>
        {/if}

        <div class="controls">
          <button type="button" onclick={() => spaceSelection.select($subject.itemID)}>
            Select it
          </button>
        </div>
      {:else}
        <!-- ⚠ Said, not silently blanked. The window keeps the thing's identity
             and reports that it has gone, rather than showing stale numbers. -->
        <p class="note">This is no longer on your grid, so there is nothing live to report about it.</p>
      {/if}
    {:else if $subject.kind === "module"}
      {#if fittedModule}
        <dl class="kv">
          <dt>State</dt>
          <dd>{fittedModule.online ? "Online" : "Offline"}</dd>
          {#if fittedModule.charge}
            <dt>Loaded</dt>
            <dd>
              {resolvedName($names.resolved, "type", fittedModule.charge.typeID, "Unknown charge")}
              × {fittedModule.charge.quantity.toLocaleString("en-US")}
            </dd>
          {/if}
        </dl>
      {/if}
      {#if moduleStats.length > 0}
        <h3>Attributes</h3>
        <!-- The SERVER's effective values, with skills and hull bonuses already
             applied — not the static table's base numbers. -->
        <dl class="kv">
          {#each moduleStats as stat (stat.id)}
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          {/each}
        </dl>
      {:else}
        <p class="note">
          No attribute reading for this module yet — the fitting window's dogma read is what
          supplies them.
        </p>
      {/if}
    {:else if $subject.kind === "character"}
      {#if standing}
        <h3>Standing</h3>
        <dl class="kv">
          <dt>Yours toward them</dt>
          <dd>{standing.standing.toFixed(2)}</dd>
        </dl>
      {:else}
        <p class="note">You hold no recorded standing toward this pilot.</p>
      {/if}
    {:else}
      <p class="note">
        Nothing further is loaded about this item. Fit one to your ship to see its effective
        attributes.
      </p>
    {/if}
  {/if}
</section>
