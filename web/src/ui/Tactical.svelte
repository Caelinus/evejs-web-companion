<script lang="ts">
  // THE TACTICAL VIEWPORT (goal R70) — the picture of space the client has never
  // had. It sits behind the in-space shell's chrome and draws what the ship can
  // see: brackets on a tilted, range-compressed disc, labelled range rings, drop
  // lines for height, velocity vectors, and the one object you have picked.
  //
  // ---------------------------------------------------------------------------
  // WHAT THIS FILE IS AND IS NOT
  //
  // It is a RENDERER. Every decision it draws — where a bracket goes, what
  // family it belongs to, which rings exist, what earns a label, what a click
  // landed on — is made in `space/tactical.ts` and pinned by its tests. This file
  // turns those answers into canvas calls and nothing else. That split is the
  // same one `space/overview.ts` and `space/rowActions.ts` already established,
  // and it is why "does a pirate draw red" is a question a test can read rather
  // than something you have to squint at a screenshot to check.
  //
  // ⚠ A CANVAS IS NOT AN ACCESSIBLE CONTROL, AND THIS ONE DOES NOT PRETEND TO BE.
  // Clicking a bracket is a convenience on top of a list that already works: the
  // overview's Select button is the keyboard path, it targets the same shared
  // selection, and the two stay in lockstep because there is only one. The canvas
  // carries a role and a summary label so a screen reader announces what is out
  // there rather than an unlabelled rectangle, and the summary is real text built
  // from the same rows the picture is drawn from.
  //
  // ⚠ THE DRAW IS WRAPPED. A `$effect` that throws wedges Svelte's scheduler and
  // the whole UI stops repainting while the bot loops keep running — a failure
  // this project has already diagnosed once and does not intend to repeat. So the
  // draw is guarded, and a failure is REPORTED (the error overlay picks it up)
  // rather than swallowed, then the viewport is left blank instead of taking the
  // cockpit down with it.
  import {
    hitTestBrackets,
    labelledBracketIDs,
    projectBrackets,
    tacticalRings,
    type TacticalBracket,
    type TacticalViewport,
  } from "../space/tactical.ts";
  import { drawTactical, readPalette } from "./tacticalDraw.ts";
  import { formatDistance } from "../space/overview.ts";
  import { spaceSelection } from "../space/selection.ts";
  import { showInfo } from "./showInfo.ts";
  import { overviewPreset } from "../space/overviewPreset.ts";
  import { applyPreset } from "../space/overviewPresets.ts";
  import { actionsForRow, type RowAction } from "../space/rowActions.ts";
  import { dispatchRowAction, isSingleCallAction } from "../space/rowActionRunner.ts";
  import { gateLinkFor } from "../space/gateLinks.ts";
  import { flyingDistances } from "./flyingDistances.ts";
  import RadialMenu from "./RadialMenu.svelte";
  import type { RadialItem } from "./RadialMenu.svelte";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  const selected = spaceSelection.selected;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  /** CSS pixels of the plot box, tracked so the canvas can match its backing store. */
  let width = $state(0);
  let height = $state(0);

  const snapshot = $derived($space.snapshot ?? null);
  const ship = $derived(snapshot?.ship ?? null);
  /**
   * R79 — the grid as the chosen overview tab sees it. The picture and the list
   * read the SAME shared preset, so switching to Mining cannot leave stargates
   * drawn on a viewport whose list says it is showing rocks.
   *
   * (R86 note: this used to narrow the auto-range as well — hiding the planet
   * pulled the rim in to the belt. The scale is fixed now, so a preset changes
   * WHAT is drawn and never where a given distance sits.)
   */
  const presetSignal = overviewPreset.preset;
  const measuredEntities = $derived(applyPreset(snapshot?.entities ?? [], $presetSignal));

  // --- R91: the picture is exactly what the server last said -----------------
  //
  // ⚠ THERE IS DELIBERATELY NO SMOOTHING HERE, AND TWO SERIOUS ATTEMPTS AT IT
  // HAVE BEEN REMOVED. Both are worth knowing about before adding a third.
  //
  // R89 drew every animation frame and PREDICTED forward from the newest
  // snapshot along each object's last reported velocity. Smooth between polls,
  // but visibly jittery AT them: reads do not take a constant time, so every
  // snapshot disagreed with the prediction and each bracket snapped to the
  // correction. Modelled at 300 m/s with reads varying 120-300 ms, that snap was
  // ±27 to ±51 m per poll — and identical at 1 Hz, 3 Hz and 5 Hz, because its
  // size comes from the variance in read time rather than from the interval.
  //
  // R90 removed the snap properly, by drawing ~420 ms in the PAST and blending
  // between the two snapshots either side of the render time. That worked —
  // nothing drawn was ever a guess — but it bought smoothness with latency and a
  // standing pile of machinery, and the operator's call was that an overview
  // answering "what is around me and roughly where" is not worth either.
  //
  // So brackets step twice a second, and every one of them is where the
  // server last said it was. If smoothness is wanted again, read the two
  // paragraphs above first: the prediction approach in particular LOOKS like the
  // obvious fix and is the one that produced the jitter.

  const entities = $derived(measuredEntities);
  /** What every bracket is measured FROM: your own hull, as last measured. */
  const origin = $derived(ship?.position ?? { x: 0, y: 0, z: 0 });

  /**
   * ⚠ R86 — THE SCALE IS FIXED, NOT AUTO-RANGED. It used to stretch to whatever
   * was farthest on grid, which meant the same rock sat at a different radius
   * depending on whether a planet happened to be in view. A plot whose meaning
   * changes as objects come and go can be read but never learnt, and the four
   * rings are worth learning. `space/tactical.ts` owns the scale now.
   */
  const view = $derived<TacticalViewport>({ width, height });

  const brackets = $derived(
    width > 0 && height > 0 ? projectBrackets(entities, origin, view) : [],
  );
  const rings = $derived(width > 0 && height > 0 ? tacticalRings() : []);
  const labelled = $derived(labelledBracketIDs(brackets, $selected));

  /** A bracket's name as the player reads it: its own, else its type's (R7d). */
  function bracketName(bracket: TacticalBracket): string {
    if (bracket.name && bracket.name.length > 0) {
      return bracket.name;
    }
    // `resolvedName` never hands back a raw id (R7d) — an unresolved type reads
    // as the fallback, which is the honest answer while the name cache is still
    // catching up.
    return resolvedName($names.resolved, "type", bracket.typeID, "Unknown object");
  }

  /**
   * What a screen reader is told. Built from the same rows the picture is drawn
   * from, so it can never describe a different grid than the one on screen.
   */
  /**
   * ⚠ THE POINTER TO THE LIST IS NOT CONDITIONAL. It used to ride on the end of
   * the "N objects on grid" sentence, which meant the one state where a player
   * most needs to be told where the real controls are — an empty or not-yet-
   * loaded grid — was the one state that did not tell them. The canvas is never
   * the only way to reach an object, and it has to say so every time.
   */
  const ACCESSIBLE_PATH = "Use the overview list to select and act on them.";

  const summary = $derived.by(() => {
    if (brackets.length === 0) {
      return `Tactical view: nothing on grid. ${ACCESSIBLE_PATH}`;
    }
    const hostiles = brackets.filter((bracket) => bracket.role === "hostile").length;
    // `brackets` is farthest-first, so the last one is the nearest.
    const nearest = brackets[brackets.length - 1];
    const threat = hostiles === 0 ? "" : ` ${hostiles} hostile${hostiles === 1 ? "" : "s"}.`;
    const near = nearest
      ? ` Nearest ${bracketName(nearest)} at ${formatDistance(nearest.distance)}.`
      : "";
    return `Tactical view: ${brackets.length} object${brackets.length === 1 ? "" : "s"} on grid.${threat}${near} ${ACCESSIBLE_PATH}`;
  });

  // --- drawing ---------------------------------------------------------------
  //
  // The paint pass itself lives in `tacticalDraw.ts` — a plain function over a 2D
  // context. That is what lets the picture be rendered and LOOKED AT without a
  // BFF, a gateway or a pilot in space (see the harness note in that file); a
  // renderer you can only exercise by flying a ship to it is one nobody checks.
  //
  // Colours are read from the design system's own tokens per paint rather than
  // written out here, so the viewport restyles with the rest of the app.
  // `getComputedStyle` at a 1 Hz repaint costs nothing, and reading it once on
  // mount would miss a theme change.

  function draw(): void {
    const element = canvas;
    if (!element || width <= 0 || height <= 0) {
      return;
    }
    const ctx = element.getContext("2d");
    if (!ctx) {
      return;
    }
    drawTactical(ctx, {
      view,
      brackets,
      rings,
      labelled,
      selectedID: $selected,
      palette: readPalette(element),
      nameOf: bracketName,
    });
  }

  /**
   * Repaint whenever anything the picture is made of changes. Reading the
   * derived values here is what subscribes this effect to them.
   *
   * The try/catch is not defensive padding: a throw inside a `$effect` wedges
   * Svelte's scheduler, and this project has already lost a cockpit that way
   * while its bot loops kept running behind a frozen screen. A drawing failure
   * must cost the picture, never the client.
   */
  $effect(() => {
    // Touch every dependency before the guard, so a resize from zero still
    // schedules a repaint.
    void brackets;
    void rings;
    void labelled;
    void $selected;
    void width;
    void height;
    try {
      draw();
    } catch (error) {
      // Surfaced, not swallowed — the error overlay listens for exactly this.
      if (typeof reportError === "function") {
        reportError(error);
      } else {
        console.error(error);
      }
    }
  });

  /**
   * Ask for the type names the labels need.
   *
   * The viewport does this ITSELF rather than free-riding on the overview,
   * because the overview is a window a player can close — and a picture whose
   * labels all read "Unknown object" because a different panel is shut is not a
   * picture anyone would keep open. Deduplicated by typeID first: two hundred
   * rocks in a belt are one type, so this is a handful of refs however busy the
   * grid gets. `requestNames` batches, caches and never throws.
   */
  $effect(() => {
    const wanted = new Map<number, NameRef>();
    for (const bracket of brackets) {
      if (bracket.typeID !== null && !wanted.has(bracket.typeID)) {
        wanted.set(bracket.typeID, { kind: "type", id: bracket.typeID });
      }
    }
    if (wanted.size > 0) {
      flow.requestNames([...wanted.values()]);
    }
  });

  /**
   * Keep the canvas backing store matched to its CSS size AND to the display's
   * pixel ratio. Without the ratio the whole picture is soft on every laptop
   * screen sold in the last decade; without the observer it is the wrong size
   * the moment a window is dragged.
   *
   * ---------------------------------------------------------------------------
   * ⚠ THIS IS WHERE "ResizeObserver loop completed with undelivered
   * notifications" CAME FROM, AND WHY IT IS WRITTEN THIS WAY.
   *
   * The first version did all of the work synchronously inside the observer
   * callback: it wrote `width`/`height` (reactive state, so Svelte re-rendered
   * and changed the canvas's inline style) and set `canvas.width/height`
   * directly. Both are layout-affecting writes to a child of the element being
   * observed, made while the browser was still delivering that element's
   * observations. The browser cannot settle that in one pass, so it drops the
   * remaining notifications and fires a global error — which flooded the error
   * overlay every time the dock panel was dragged.
   *
   * Three things fix it, and all three are load-bearing:
   *
   *   1. NOTHING IS WRITTEN FROM THE CALLBACK. The observation is stashed and
   *      applied in a `requestAnimationFrame`, i.e. after delivery is finished.
   *   2. A NO-OP RESIZE DOES NOTHING AT ALL. A drag fires this continuously with
   *      sub-pixel changes that round to the same integers; re-assigning
   *      `canvas.width` is never free (it clears the bitmap) and re-assigning
   *      the same reactive value would still schedule a frame.
   *   3. THE CANVAS NO LONGER SIZES ITSELF FROM STATE. It is stretched by CSS
   *      (`position: absolute; inset: 0`), so its display size is decided by the
   *      box rather than by a value this effect writes — which removes the
   *      feedback edge entirely instead of merely damping it.
   */
  $effect(() => {
    const element = box;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    /** The pending deferred apply: a rAF handle, or a timer handle. */
    let pending: number = 0;
    let pendingIsFrame = false;
    const applyNow = (): void => {
      pending = 0;
      const rect = element.getBoundingClientRect();
      const nextWidth = Math.max(0, Math.round(rect.width));
      const nextHeight = Math.max(0, Math.round(rect.height));
      const ratio = window.devicePixelRatio || 1;
      const target = canvas;
      // Guard 2: an observation that changes nothing must cost nothing.
      if (nextWidth === width && nextHeight === height && target) {
        if (target.width === Math.round(nextWidth * ratio)) {
          return;
        }
      }
      width = nextWidth;
      height = nextHeight;
      if (target) {
        target.width = Math.round(nextWidth * ratio);
        target.height = Math.round(nextHeight * ratio);
        const ctx = target.getContext("2d");
        // Draw in CSS pixels; the transform absorbs the ratio, so every
        // coordinate the projection produces is used as-is.
        ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
    };
    const schedule = (): void => {
      // Guard 1: never write during delivery. Coalesced, so a drag that fires
      // this fifty times in a frame applies once.
      if (pending !== 0) {
        return;
      }
      // ⚠ rAF IS SUSPENDED IN A HIDDEN TAB — it fires zero times, not late. This
      // client is routinely driven in a hidden pane, and this project has
      // already been bitten by visibility-gated code silently never running. A
      // resize that arrived while hidden must still be applied, so a hidden
      // document falls back to a timer. Both defer out of the observer's own
      // delivery, which is the only property this guard needs.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        pendingIsFrame = false;
        pending = setTimeout(applyNow, 0) as unknown as number;
        return;
      }
      pendingIsFrame = true;
      pending = requestAnimationFrame(applyNow);
    };
    applyNow();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (pending !== 0) {
        if (pendingIsFrame) {
          cancelAnimationFrame(pending);
        } else {
          clearTimeout(pending);
        }
      }
    };
  });

  /**
   * A click picks the bracket under the pointer, and a click on empty space
   * clears — the same "click away to deselect" the overview's toggle gives.
   */
  function onClick(event: MouseEvent): void {
    const element = canvas;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const hit = hitTestBrackets(brackets, event.clientX - rect.left, event.clientY - rect.top);
    if (hit) {
      spaceSelection.toggle(hit.itemID);
    } else {
      spaceSelection.clear();
    }
  }

  /**
   * Double-click opens Show Info on the bracket — the retail gesture, and the
   * reason a single click stays cheap: picking something you might be about to
   * warp at must not also throw a window over the view.
   */
  function onDoubleClick(event: MouseEvent): void {
    const element = canvas;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const hit = hitTestBrackets(brackets, event.clientX - rect.left, event.clientY - rect.top);
    if (hit) {
      showInfo({ kind: "spaceObject", itemID: hit.itemID, typeID: hit.typeID });
    }
  }

  // --- R77: the radial menu on a bracket -----------------------------------
  //
  // Right-clicking a bracket selects it and rings the pointer with its verbs —
  // the same verbs the overview's bar offers, from `actionsForRow`, dispatched
  // through the same `dispatchRowAction`. Neither list nor dispatch is written
  // twice, which is the only way the picture and the list can be guaranteed to
  // agree about what a thing can do.
  //
  // ⚠ THE MULTI-STEP VERBS ARE FILTERED OUT, NOT SILENTLY BROKEN. "Mine this"
  // and "Haul now" each run a loop with their own per-step reporting, which
  // lives in the overview; a canvas with no room to report per-module outcomes
  // must not offer them. `isSingleCallAction` is the shared predicate, so this
  // cannot drift from what the runner can actually run.
  let radial = $state<{ readonly x: number; readonly y: number } | null>(null);

  const radialActions = $derived.by<readonly RowAction[]>(() => {
    const picked = $selected;
    if (picked === null) {
      return [];
    }
    const row = entities.find((candidate) => candidate.itemID === picked);
    if (!row) {
      return [];
    }
    return actionsForRow({
      kind: row.kind,
      locked: $targeting.lockedTargetIDs.includes(picked),
      acquiring: $targeting.acquiringTargetIDs.includes(picked),
      gateLink: gateLinkFor($space.gateLinks, picked),
      // Passed even though the multi-step filter below drops "Mine this"
      // anyway: the ring and the bar must hand the SAME context to the same
      // decider, or they will one day disagree about a verb neither filters.
      categoryID: row.categoryID,
    }).filter((action) => isSingleCallAction(action.id));
  });

  const radialItems = $derived<readonly RadialItem[]>([
    { id: "showInfo", label: "Show info", disabledReason: null },
    ...radialActions.map((action) => ({
      id: action.id,
      label: action.label,
      disabledReason: action.unavailable,
    })),
  ]);

  function onContextMenu(event: MouseEvent): void {
    const element = canvas;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const hit = hitTestBrackets(brackets, event.clientX - rect.left, event.clientY - rect.top);
    // Right-clicking empty space is left to the browser: there is nothing to act
    // on, and swallowing it would take away the page menu for no gain.
    if (!hit) {
      return;
    }
    event.preventDefault();
    spaceSelection.select(hit.itemID);
    radial = { x: event.clientX, y: event.clientY };
  }

  async function pickRadial(id: string): Promise<void> {
    const picked = $selected;
    if (picked === null) {
      return;
    }
    const row = entities.find((candidate) => candidate.itemID === picked);
    if (!row) {
      return;
    }
    if (id === "showInfo") {
      showInfo({ kind: "spaceObject", itemID: row.itemID, typeID: row.typeID });
      return;
    }
    const action = radialActions.find((candidate) => candidate.id === id);
    if (!action || action.unavailable !== null) {
      return;
    }
    try {
      await dispatchRowAction(
        flow,
        action.id,
        { itemID: row.itemID, gateLink: gateLinkFor($space.gateLinks, row.itemID) },
        {
          warp: Number($flyingDistances.warp),
          orbit: Number($flyingDistances.orbit),
          hold: Number($flyingDistances.hold),
        },
      );
    } catch (error) {
      // The viewport has nowhere to put a sentence, so a refusal is surfaced the
      // same way a drawing failure is — never swallowed.
      if (typeof reportError === "function") {
        reportError(error);
      } else {
        console.error(error);
      }
    }
  }

  /** Pointer feedback: a bracket under the cursor is clickable, space is not. */
  let hovering = $state(false);
  function onMove(event: MouseEvent): void {
    const element = canvas;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    hovering =
      hitTestBrackets(brackets, event.clientX - rect.left, event.clientY - rect.top) !== null;
  }
</script>

<div class="tactical" bind:this={box}>
  <canvas
    bind:this={canvas}
    class="tactical-canvas"
    class:hovering
    role="img"
    aria-label={summary}
    onclick={onClick}
    ondblclick={onDoubleClick}
    oncontextmenu={onContextMenu}
    onmousemove={onMove}
    onmouseleave={() => (hovering = false)}
  ></canvas>
  {#if brackets.length === 0}
    <p class="tactical-empty">Nothing on grid.</p>
  {/if}
</div>

{#if radial && radialItems.length > 1}
  <RadialMenu
    items={radialItems}
    x={radial.x}
    y={radial.y}
    label="Actions for the selected object"
    onPick={(id) => void pickRadial(id)}
    onClose={() => (radial = null)}
  />
{/if}
