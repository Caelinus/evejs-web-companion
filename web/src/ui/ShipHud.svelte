<script lang="ts">
  // The in-space ship readout (goal R71) — EVE's circular HUD.
  //
  // Three concentric arcs, outer to inner: SHIELD, ARMOR, HULL, wrapped around a
  // discrete CAPACITOR ring with the charge in the middle. That arrangement is
  // the most recognisable image in the whole game, and it is not decoration: a
  // pilot reads their condition off the SHAPE — which ring is eaten into, and how
  // far — long before they read a number. Three stacked horizontal bars carry the
  // same data and read as a settings page.
  //
  // The geometry lives in `shipHudArcs.ts` and is pinned by its tests; this file
  // only decides what is shown and what it is called.
  //
  // ⚠ NOTHING HERE IS CONVEYED BY COLOUR ALONE. Every ring is paired with its
  // name and its percentage as TEXT beneath the wheel, and a layer with no
  // reading shows a dash — never a fabricated 0%, and never an empty ring that
  // could be mistaken for a destroyed one. That distinction is the whole reason
  // `gaugeArc` refuses to draw for a null.
  import { resourceGauges, capacitorSegments as filledSegments } from "./shipHud.ts";
  import { capacitorSegments, gaugeArc, gaugeTrack } from "./shipHudArcs.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store }: { store: ClientStore } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;

  const SEGMENTS = 12;
  // A 150x150 viewBox — the in-space handoff's box, so its radii can be used as
  // written. Everything below is still a proportion of the wheel: the
  // instrument scales with its container and nothing is in CSS pixels.
  const CX = 75;
  const CY = 75;
  /** Outer to inner, matching EVE's own shield → armor → hull order. */
  const RADII = { shield: 66, armor: 57, hull: 48 } as const;
  /**
   * ⚠ THE CAPACITOR STAYS DISCRETE, at the handoff's radius.
   *
   * The handoff draws it as a dashed arc. A dash pattern is a TEXTURE, not a
   * count: `6 3` does not divide into a fixed number of segments as the ratio
   * changes, so you cannot read "three left" off it — and counting what is left
   * is the whole reason EVE's capacitor has never been a smooth bar. The ring
   * moved to r37 and the handoff's stroke; the twelve segments stayed.
   */
  const CAP_RADIUS = 37;

  const ship = $derived($space.snapshot?.ship ?? null);
  const capRatio = $derived(ship?.capacitorRatio ?? null);
  const capFilled = $derived(filledSegments(capRatio, SEGMENTS));
  const capPct = $derived(capRatio != null ? Math.round(capRatio * 100) : null);
  const gauges = $derived(resourceGauges(ship));
  const segments = capacitorSegments(SEGMENTS, CX, CY, CAP_RADIUS);

  /**
   * How fast the ship is going, in the words the gap under the gauge shows.
   *
   * ⚠ A SHIP IN WARP IS NOT A NUMBER OF m/s. The server reports a warping hull's
   * speed as whatever it happens to be mid-acceleration, which is meaningless to
   * read; the state is the useful fact. And an absent reading is a dash, never a
   * confident 0 m/s on a ship that is moving.
   */
  const speedText = $derived.by(() => {
    const mode = ship?.mode ?? null;
    if (typeof mode === "string" && /warp/i.test(mode)) {
      return "WARP";
    }
    const speed = ship?.velocity
      ? Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z)
      : null;
    if (speed === null || !Number.isFinite(speed)) {
      return "—";
    }
    return `${Math.round(speed)} m/s`;
  });

  /**
   * One accessible sentence for the whole instrument, so a screen reader gets
   * the ship's condition in one read rather than as four unlabelled graphics.
   */
  const conditionText = $derived(
    [
      ...gauges.map(
        (gauge) => `${gauge.label} ${gauge.ratio != null ? `${Math.round(gauge.ratio * 100)}%` : "unknown"}`,
      ),
      `Capacitor ${capPct != null ? `${capPct}%` : "unknown"}`,
    ].join(", "),
  );
</script>

<div class="ship-hud">
  <div class="hud-wheel" role="img" aria-label={conditionText}>
    <svg viewBox="0 0 150 150" aria-hidden="true">
      <!-- Tracks first, so a partly-eaten ring reads against the whole it is a
           part of. Without them a 20% shield is just a short arc floating in
           space with nothing to be 20% OF. -->
      {#each gauges as gauge (gauge.key)}
        <path class="wheel-track" d={gaugeTrack(CX, CY, RADII[gauge.key])} />
      {/each}
      {#each gauges as gauge (gauge.key)}
        {@const d = gaugeArc(gauge.ratio, CX, CY, RADII[gauge.key])}
        {#if d}
          <path class={`wheel-fill ${gauge.key}`} {d} />
        {/if}
      {/each}

      <!-- The capacitor: discrete segments, never a smooth bar. A pilot counts
           what is left rather than reading a percentage off it. -->
      {#each segments as segment (segment.index)}
        <path
          class="wheel-cap"
          class:filled={segment.index < capFilled}
          d={segment.path}
        />
      {/each}
    </svg>
    <div class="wheel-centre">
      <span class="wheel-cap-value">{capPct != null ? `${capPct}%` : "—"}</span>
      <span class="wheel-cap-label">Cap</span>
    </div>
    <!-- The speed sits in the gap the gauges leave, which is what the gap is
         for — see shipHudArcs.ts. -->
    <span class="wheel-speed">{speedText}</span>
  </div>

  <!-- The numbers, as text. The rings are the fast read; this is the exact one,
       and it is what makes the instrument legible with no colour perception. -->
  <dl class="hud-readout">
    {#each gauges as gauge (gauge.key)}
      {@const pct = gauge.ratio != null ? Math.round(gauge.ratio * 100) : null}
      <div class={`hud-readout-row ${gauge.key}`}>
        <dt>{gauge.label}</dt>
        <dd>{pct != null ? `${pct}%` : "—"}</dd>
      </div>
    {/each}
  </dl>
</div>
