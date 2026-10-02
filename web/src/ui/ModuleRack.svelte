<script lang="ts">
  // The in-space HUD module rack — the ship's high / mid / low slots as EVE's
  // three activation racks, and now the place they are CLICKED: an idle module
  // activates, a cycling one deactivates, exactly the retail F-row. Reads the
  // fitting slots (same source as the Fitting window) and overlays the live
  // snapshot's active modules: a cycling module glows, an offline one is dimmed
  // and inert (onlining is a Fitting-window decision, not a rack misclick).
  //
  // TARGETED MODULES USE THE FIRST LOCKED TARGET. The rack cannot know which
  // modules need a target (no allowlisted read answers it), so every activation
  // carries the first locked target when one exists — the same auto convention
  // the Overview's action picker defaults to — and none when nothing is locked.
  // A module that needed one is refused by the SERVER with its own reason, and
  // that reason is what renders: the rack never pre-judges a click.
  //
  // THE GLOW IS NOT OPTIMISTIC. active comes from the snapshot's
  // activeModuleIDs, so a click changes the glow only when the next space poll
  // proves the server agrees. The pending shimmer between click and proof is
  // presentation, never a claim.
  import TypeIcon from "./TypeIcon.svelte";
  import {
    buildModuleRack,
    rackClickAction,
    cycleProgressPercent,
    rackDamageBand,
    rackDamageText,
    rackDamageWedge,
    rackHeatBand,
    rackHeatText,
    rackHoldAction,
    rackIsEmpty,
    rackModuleBurntOut,
    rackSlotTitle,
    OVERLOAD_HOLD_MS,
  } from "./moduleRack.ts";
  import {
    ammoChoices,
    rackChargeBadge,
    rackReloadPercent,
    rackReloading,
    rackSlotAction,
    rackTakesCharges,
    reloadAllPlan,
    weaponGroups,
  } from "./rackAmmo.ts";
  import type { AmmoChoice, WeaponGroup } from "./rackAmmo.ts";
  import { notify } from "./notices.ts";
  import { abbreviate } from "./fittingIcons.ts";
  import { resolvedName } from "../store/names.ts";
  import type { RackModule } from "./moduleRack.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow = null }: {
    store: ClientStore;
    /**
     * Null renders the rack read-only (a mount with no live flow — tests,
     * embeddings). Every real mount passes the session's flow.
     */
    flow?: AppFlow | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;

  const rows = $derived(
    buildModuleRack(
      $fitting.slots,
      $space.snapshot?.ship?.activeModuleIDs ?? null,
      $space.snapshot?.ship?.overloadedModuleIDs ?? null,
      $space.snapshot?.ship?.moduleDamage ?? null,
      $space.snapshot?.ship?.weaponBanks ?? null,
    ),
  );
  /**
   * Damaged modules, worst first — the repair list.
   *
   * It sits under the rack rather than on the tiles because repairing is a
   * deliberate act that consumes paste, and because a burnt-out module is
   * something a player needs told, not something they should have to hover
   * every tile to discover.
   */
  const damagedModules = $derived(
    rows
      .flatMap((row) => row.slots)
      .map((slot) => slot.module)
      .filter((module): module is RackModule => module !== null && (module.damage ?? 0) > 0)
      .sort((left, right) => (right.damage ?? 0) - (left.damage ?? 0)),
  );
  const unknown = $derived(!$fitting.loaded || rackIsEmpty(rows));
  /** Every high-slot module — banking only ever applies to weapons. */
  const weaponsCount = $derived(
    (rows.find((row) => row.family === "high")?.slots ?? []).filter((slot) => slot.module !== null)
      .length,
  );
  /** How many modules are in a bank right now (masters and slaves alike). */
  const bankedCount = $derived(
    rows
      .flatMap((row) => row.slots)
      .filter((slot) => slot.module !== null && slot.module.bankSize > 1).length,
  );

  async function setBanks(linked: boolean): Promise<void> {
    if (!flow || pendingItemID !== null) {
      return;
    }
    error = "";
    try {
      await flow.setWeaponBanks(linked);
      const refusal = $targeting.actionError ?? $targeting.silentDecline;
      if (refusal) {
        error = refusal;
      }
    } catch (cause) {
      error = String(cause);
    }
  }
  /** The auto target: first LOCKED (not still-acquiring) target, else none. */
  const autoTargetID = $derived($targeting.lockedTargetIDs[0] ?? 0);

  /** The module a click is in flight for — that one tile shimmers, the rest stay live. */
  let pendingItemID = $state<number | null>(null);
  /** The server's refusal for the LAST rack click, read from the authority slots. */
  let error = $state("");
  /**
   * Redraw tick for the cycle sweep. DISPLAY ONLY — every value it feeds comes
   * from the SERVER's own cycle stamp, and nothing here advances past what the
   * server said. A hidden tab simply redraws less; the numbers are unaffected.
   *
   * ⚠ THE RATE IS CONDITIONAL, AND THAT IS THE WHOLE DESIGN. At one second a
   * sweep over a typical cycle advances in visible jumps — it reads as a broken
   * animation rather than a running module. `cycleProgressPercent` rounds to
   * whole percent, so ~100 ms is the point past which extra ticks cannot change
   * a single rendered frame; anything faster is work for nothing.
   *
   * But it only ticks that fast while something is ACTUALLY CYCLING. A docked
   * ship, or one drifting with every module off, has nothing to animate, and a
   * rack quietly re-rendering ten times a second forever to draw no change is
   * exactly the kind of idle cost that never shows up in a profile anyone runs.
   */
  // ⚠ IT IS THE SNAPSHOT'S ACTIVE SET, NOT THE CYCLE RECORD. `moduleCycles`
  // also holds BASE durations (attribute 73), which are learnt from the fit and
  // never removed — so this read true from the first fit load onwards, docked
  // ship included, and the rack redrew ten times a second forever to draw no
  // change. That is precisely the idle cost the note above warns about.
  const anyCycling = $derived(
    rows.some((row) =>
      row.slots.some(
        (slot) =>
          slot.module?.active === true ||
          // A reload sweeps too. Read against the last tick, which is fine:
          // the fast rate only has to start within one slow tick.
          (slot.module !== null && rackReloading($fitting.reloads[slot.module.itemID], nowMs)),
      ),
    ),
  );
  let nowMs = $state(Date.now());
  $effect(() => {
    const period = anyCycling ? 100 : 1000;
    const handle = setInterval(() => { nowMs = Date.now(); }, period);
    return () => clearInterval(handle);
  });

  /** How far through its cycle a module is, or null when we cannot say. */
  function cycleOf(itemID: number): number | null {
    return cycleProgressPercent($targeting.moduleCycles[itemID] ?? null, nowMs);
  }

  /**
   * ASK FOR THE NAMES THIS RACK NEEDS.
   *
   * ⚠ FOUND LIVE, AND IT IS A REAL CAPABILITY GAP, NOT A COSMETIC ONE. Every
   * tooltip in the rack read "— — click to switch on": the tile is a PICTURE, so
   * its title is the only place a module says what it is, and the whole rack had
   * stopped saying.
   *
   * The rack used to free-ride on the name cache `Overview.svelte` primed, which
   * worked while the overview was fixed chrome mounted beside it. The overview
   * is a WINDOW now, so on any session where nobody opened it, nothing ever
   * asked for these names. A component that needs a name asks for it itself;
   * anything else is a dependency on another component's mount order.
   *
   * Idempotent by construction: only ids the cache has no entry for are asked
   * for, so this settles after one round rather than re-asking every poll.
   */
  $effect(() => {
    if (!flow) {
      return;
    }
    const refs: { kind: "type"; id: number }[] = [];
    const seen = new Set<number>();
    const want = (id: number | undefined) => {
      if (typeof id === "number" && id > 0 && !seen.has(id)) {
        seen.add(id);
        if (resolvedName($names.resolved, "type", id, "") === "") {
          refs.push({ kind: "type", id });
        }
      }
    };
    for (const row of rows) {
      for (const slot of row.slots) {
        want(slot.module?.typeID);
        want(slot.module?.charge?.typeID);
      }
    }
    // The reload menu names what is in cargo, so those names are this
    // component's to ask for too.
    for (const choice of ammoChoices(null, $inventory.cargo.rows, {})) {
      want(choice.typeID);
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function moduleName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID);
  }

  /** The loaded charge's NAME, or null when there is none to name. */
  function chargeName(module: RackModule): string | null {
    return module.charge ? moduleName(module.charge.typeID) : null;
  }

  // --- reloading -------------------------------------------------------------
  //
  // Three ways in, one menu: RIGHT-CLICK a charge-taking slot (or its Menu key /
  // Shift+F10), TAP an empty gun, or open a weapon group from the ammo strip
  // under the racks. The strip also carries "Reload all", the retail Ctrl+R.
  //
  // ⚠ THE SOURCE IS ALWAYS CARGO. In space that is the only place LoadAmmo can
  // draw from, and docked, the Fitting window already offers the hangar.

  const chargeFits = $derived($fitting.chargeFits);
  const groups = $derived(weaponGroups(rows, chargeFits));
  const cargoRows = $derived($inventory.cargo.rows);

  function takesCharges(module: RackModule): boolean {
    return rackTakesCharges(module, chargeFits);
  }
  function reloadingNow(module: RackModule): boolean {
    return rackReloading($fitting.reloads[module.itemID], nowMs);
  }
  function slotAction(module: RackModule) {
    return rackSlotAction(module, rackClickAction(module), takesCharges(module), reloadingNow(module));
  }

  /** The hover line, with what reloading adds to it. */
  function slotTitle(module: RackModule): string {
    const nm = moduleName(module.typeID);
    if (!takesCharges(module)) {
      return rackSlotTitle(nm, module, chargeName(module));
    }
    if (reloadingNow(module)) {
      return `${rackSlotTitle(nm, module, chargeName(module))} Reloading.`;
    }
    if (slotAction(module) === "load") {
      return `${nm} - no ammunition. Click to load some from cargo.`;
    }
    return `${rackSlotTitle(nm, module, chargeName(module))} Right-click to load or reload.`;
  }

  type MenuTarget =
    | { readonly kind: "slot"; readonly module: RackModule }
    | { readonly kind: "group"; readonly group: WeaponGroup };
  /** The open menu, anchored above the control that opened it. */
  let menu = $state<{ target: MenuTarget; left: number; bottom: number } | null>(null);
  /** The control that opened the menu, so Escape can hand focus back. */
  let menuOpener: HTMLElement | null = null;
  let menuEl = $state<HTMLElement | null>(null);
  let cargoReading = $state(false);

  /** Re-read cargo. Counts change with every shot, so a menu always asks. */
  async function readCargo(): Promise<void> {
    if (!flow || cargoReading) {
      return;
    }
    cargoReading = true;
    try {
      await flow.loadInventory();
    } catch {
      // The menu says what it has; a failed read leaves the last rows.
    } finally {
      cargoReading = false;
    }
  }

  function openMenu(target: MenuTarget, opener: HTMLElement): void {
    if (!flow) {
      return;
    }
    const rect = opener.getBoundingClientRect();
    // ⚠ IT OPENS UPWARDS. The rack lives in the bottom panel, so a menu hung
    // below the slot would fall off the screen.
    menu = {
      target,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    };
    menuOpener = opener;
    void readCargo();
  }

  function closeMenu(returnFocus = false): void {
    menu = null;
    if (returnFocus) {
      menuOpener?.focus();
    }
    menuOpener = null;
  }

  // Focus the first item when the menu opens, so the keyboard can drive it.
  $effect(() => {
    if (menuEl) {
      menuEl.querySelector<HTMLElement>("button")?.focus();
    }
  });

  // A press anywhere outside the menu closes it, the way any menu does.
  $effect(() => {
    if (!menu) {
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (menuEl && !menuEl.contains(event.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  });

  function onMenuKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...(menuEl?.querySelectorAll<HTMLElement>("button") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
    }
  }

  function slotElement(itemID: number): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-rack-module="${itemID}"]`);
  }

  /** Which modules a menu acts on, and the module type its choices are judged for. */
  function menuModules(target: MenuTarget): readonly RackModule[] {
    const opened = target.kind === "slot" ? [target.module] : target.group.modules;
    // Resolved against the CURRENT rack: the fit is re-read while a menu is
    // open (a reload landing, the cargo read), and "Unload" and "loaded" must
    // describe the guns as they are now, not as they were on opening.
    const live = new Map<number, RackModule>();
    for (const row of rows) {
      for (const slot of row.slots) {
        if (slot.module) live.set(slot.module.itemID, slot.module);
      }
    }
    return opened.map((module) => live.get(module.itemID)).filter((module): module is RackModule => !!module);
  }
  function menuTypeID(target: MenuTarget): number {
    return target.kind === "slot" ? target.module.typeID : target.group.moduleTypeID;
  }
  function menuHead(target: MenuTarget): string {
    if (target.kind === "group") {
      return `Load into ${target.group.modules.length}x ${moduleName(target.group.moduleTypeID)}`;
    }
    // The server fills a whole bank from one launcher, so the header says so.
    return target.module.bankSize > 1
      ? `Load from cargo - ${target.module.bankSize} linked weapons`
      : "Load from cargo";
  }
  /** The charge type currently in every one of these modules, if they agree. */
  function loadedTypeOf(target: MenuTarget): number | null {
    const types = new Set(menuModules(target).map((module) => module.charge?.typeID ?? 0));
    return types.size === 1 ? [...types][0] || null : null;
  }

  /** Reload the opened modules with one kind of charge. */
  async function loadChoice(modules: readonly RackModule[], choice: AmmoChoice): Promise<void> {
    if (!flow || pendingItemID !== null || modules.length === 0) {
      return;
    }
    closeMenu();
    const first = modules[0]!;
    pendingItemID = first.itemID;
    error = "";
    refusalModuleID = null;
    try {
      const outcome = await flow.loadAmmo(
        modules.map((module) => module.itemID),
        choice.itemIDs,
        "cargo",
      );
      if (outcome === "refused" || outcome === "unchanged") {
        error = `${moduleName(first.typeID)}: ${$fitting.actionError ?? "nothing was loaded."}`;
      }
    } catch (cause) {
      error = `${moduleName(first.typeID)}: ${String(cause)}`;
    } finally {
      pendingItemID = null;
    }
    // The stack the charges came out of shrank.
    void readCargo();
  }

  async function unloadModules(modules: readonly RackModule[]): Promise<void> {
    const loaded = modules.filter((module) => module.charge !== null);
    if (!flow || pendingItemID !== null || loaded.length === 0) {
      return;
    }
    closeMenu();
    pendingItemID = loaded[0]!.itemID;
    error = "";
    try {
      const outcome = await flow.unloadAmmo(loaded.map((module) => module.itemID), "cargo");
      if (outcome === "refused" || outcome === "unchanged") {
        error = `${moduleName(loaded[0]!.typeID)}: ${$fitting.actionError ?? "nothing was unloaded."}`;
      }
    } catch (cause) {
      error = `${moduleName(loaded[0]!.typeID)}: ${String(cause)}`;
    } finally {
      pendingItemID = null;
    }
    void readCargo();
  }

  /**
   * Reload all — every weapon group topped up with what it already uses.
   *
   * ⚠ IT READS CARGO FIRST. The plan is built from the cargo rows, and a plan
   * made from a list that is several volleys old would name stacks that are
   * gone. One load per group, one after another: they share the cargo.
   */
  async function reloadAll(): Promise<void> {
    if (!flow || pendingItemID !== null) {
      return;
    }
    closeMenu();
    await readCargo();
    const plan = reloadAllPlan(groups, $inventory.cargo.rows, chargeFits);
    const problems: string[] = [];
    for (const skip of plan.skipped) {
      const gun = moduleName(skip.moduleTypeID);
      problems.push(
        skip.reason === "out" && skip.chargeTypeID !== null
          ? `${gun}: no ${moduleName(skip.chargeTypeID)} left in cargo.`
          : `${gun}: empty, and nothing in cargo is known to fit - pick a charge from its menu.`,
      );
    }
    error = "";
    for (const step of plan.steps) {
      pendingItemID = step.moduleIDs[0] ?? null;
      try {
        const outcome = await flow.loadAmmo(step.moduleIDs, step.choice.itemIDs, "cargo");
        if (outcome === "unchanged") {
          // ⚠ NOT CALLED A FAILURE. Reload all sends every gun, full or not,
          // and a group that was already full answers exactly like this.
          problems.push(`${moduleName(step.moduleTypeID)}: nothing loaded - probably already full.`);
        } else if (outcome === "refused") {
          problems.push(`${moduleName(step.moduleTypeID)}: ${$fitting.actionError ?? "refused."}`);
        }
      } catch (cause) {
        problems.push(`${moduleName(step.moduleTypeID)}: ${String(cause)}`);
      } finally {
        pendingItemID = null;
      }
    }
    if (plan.steps.length === 0 && problems.length === 0) {
      problems.push("No weapons to reload.");
    }
    error = problems.join(" ");
    void readCargo();
  }

  /**
   * The module the last refusal was about, so the refusal line can offer the
   * fix when the fix is loading it. Cleared with the error.
   */
  let refusalModuleID = $state<number | null>(null);
  /** The empty gun a refusal named, while it is still empty. */
  const refusalModule = $derived.by<RackModule | null>(() => {
    if (refusalModuleID === null || !error) {
      return null;
    }
    const module =
      rows.flatMap((row) => row.slots).find((slot) => slot.module?.itemID === refusalModuleID)
        ?.module ?? null;
    return module && module.charge === null && takesCharges(module) ? module : null;
  });
  /** What the refusal line offers to load: the best likely fit in cargo. */
  const refusalFix = $derived(
    refusalModule
      ? ammoChoices(refusalModule.typeID, cargoRows, chargeFits).find((choice) => choice.verdict !== false) ??
          null
      : null,
  );
  $effect(() => {
    if (refusalModule && !$inventory.loaded) {
      void readCargo();
    }
  });

  // --- the press: a tap fires, a HOLD overloads ------------------------------
  //
  // ⚠ THIS REPLACED SHIFT-CLICK, AND THE REASON IS THE TOUCH TIER. Overloading
  // has always been behind a second, deliberate gesture because it damages the
  // module — but a modifier key does not exist on a touch screen, so on the
  // tier this panel now has, overload was simply unreachable. A hold is
  // reachable everywhere, and it can SHOW itself: the ring fills while the
  // finger is down, so the player can see what is about to happen and let go.
  //
  // ⚠ AND IT IS KEYBOARD-REACHABLE. Enter/Space start and end the same press,
  // with the browser's synthetic click suppressed so a tap does not fire twice.
  // Dropping that would trade one inaccessible gesture for another.

  /** The circumference of the slot ring, r17 in the 42-unit slot box. */
  const SLOT_RING = 2 * Math.PI * 17;

  /** The slot whose ring is filling right now, and how far it has filled. */
  let holdItemID = $state<number | null>(null);
  let holdPercent = $state(0);
  /**
   * Whether the hold COMPLETED. Not `$state`: nothing renders from it, and it
   * must be readable synchronously inside the release handler — it is what
   * stops a completed overload from also firing the module on the way up.
   */
  let holdFired = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTick: ReturnType<typeof setInterval> | null = null;

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (holdTick !== null) {
      clearInterval(holdTick);
      holdTick = null;
    }
    holdItemID = null;
    holdPercent = 0;
  }

  // A press in flight when the rack goes away (the ship docks, the window
  // closes) must not leave a timer that overloads a module nobody is holding.
  $effect(() => () => clearHold());

  function pressStart(module: RackModule): void {
    if (pendingItemID !== null) {
      return;
    }
    holdFired = false;
    // Nothing to hold TOWARDS — an offline module, or one whose overload state
    // the server never told us. The ring does not fill, and the release still
    // fires the module as a plain tap.
    if (rackHoldAction(module) === null) {
      return;
    }
    const startedAt = Date.now();
    holdItemID = module.itemID;
    holdPercent = 0;
    holdTick = setInterval(() => {
      holdPercent = Math.min(100, ((Date.now() - startedAt) / OVERLOAD_HOLD_MS) * 100);
    }, 30);
    holdTimer = setTimeout(() => {
      holdFired = true;
      clearHold();
      void overloadModule(module);
    }, OVERLOAD_HOLD_MS);
  }

  function pressEnd(module: RackModule): void {
    const fired = holdFired;
    holdFired = false;
    clearHold();
    if (!fired) {
      void clickModule(module);
    }
  }

  /**
   * The press went away without ending on the button — the pointer slid off, or
   * the browser cancelled it. NOTHING happens: not the overload, and not the
   * activation either, because a drag off a control is how a player takes a
   * press back.
   */
  function pressCancel(): void {
    holdFired = false;
    clearHold();
  }

  /**
   * Toggle overload. Reached only by a completed hold, never by a tap.
   * An offline module, or one with an unknown overload state, is inert here.
   */
  async function overloadModule(module: RackModule): Promise<void> {
    if (!flow || rackHoldAction(module) === null || pendingItemID !== null) {
      return;
    }
    pendingItemID = module.itemID;
    error = "";
    try {
      await flow.setModuleOverload(module.itemID, !module.overloaded);
      const refusal = $targeting.actionError ?? $targeting.silentDecline;
      if (refusal) {
        error = `${moduleName(module.typeID)}: ${refusal}`;
      }
    } catch (cause) {
      error = `${moduleName(module.typeID)}: ${String(cause)}`;
    } finally {
      pendingItemID = null;
    }
  }

  async function repair(module: RackModule): Promise<void> {
    if (!flow || pendingItemID !== null) {
      return;
    }
    pendingItemID = module.itemID;
    error = "";
    try {
      await flow.repairModule(module.itemID);
      const refusal = $targeting.actionError ?? $targeting.silentDecline;
      if (refusal) {
        error = `${moduleName(module.typeID)}: ${refusal}`;
      }
    } catch (cause) {
      error = `${moduleName(module.typeID)}: ${String(cause)}`;
    } finally {
      pendingItemID = null;
    }
  }

  async function clickModule(module: RackModule): Promise<void> {
    const action = slotAction(module);
    if (!flow || !action || pendingItemID !== null) {
      return;
    }
    if (action === "load") {
      const opener = slotElement(module.itemID);
      if (opener) {
        openMenu({ kind: "slot", module }, opener);
      }
      return;
    }
    pendingItemID = module.itemID;
    error = "";
    refusalModuleID = module.itemID;
    try {
      if (action === "deactivate") {
        // typeID rides along so the BFF can name a prop mod's effect — an
        // afterburner only stops when Deactivate says which effect to stop.
        await flow.deactivateModule(module.itemID, { typeID: module.typeID });
      } else {
        await flow.activateModule(module.itemID, {
          targetID: autoTargetID > 0 ? autoTargetID : null,
        });
      }
      // Read the AUTHORITY, not the resolved promise: the flow's targeting
      // wrapper swallows refusals into these two slots (Overview reads them the
      // same way), and a 200 with a silent decline is still not a success.
      const refusal = $targeting.actionError ?? $targeting.silentDecline;
      if (refusal) {
        error = `${moduleName(module.typeID)}: ${refusal}`;
      } else if (
        action === "deactivate" &&
        ($space.snapshot?.ship?.activeModuleIDs ?? []).includes(module.itemID)
      ) {
        // Told to stop, still cycling — retail stops at the end of the current
        // cycle. Say so once, or the still-lit tile reads as a click that did
        // nothing.
        //
        // ⚠ IT IS A FLASH NOW, NOT A LINE UNDER THE RACK. It used to be a
        // paragraph nailed to the bottom of the HUD, which is on screen for the
        // WHOLE SESSION — so a sentence about the next few seconds sat there
        // looking like a standing condition, and it was read as one. Deriving
        // it from the snapshot fixed when it stopped being TRUE and did nothing
        // about where it lived. A sentence with a shelf life belongs in the
        // notice system, which retires it on its own and keeps it in the log.
        //
        // The key is per module, so switching the same one off twice inside the
        // dedupe window says it once and a different module still says it.
        notify({
          kind: "info",
          title: moduleName(module.typeID),
          detail: "Stops when its current cycle ends.",
          key: `module-winding-down:${module.itemID}`,
        });
      }
    } catch (cause) {
      error = `${moduleName(module.typeID)}: ${String(cause)}`;
    } finally {
      pendingItemID = null;
    }
  }
</script>

<div class="module-rack-rows" aria-label="Module rack">
  {#each rows as row (row.family)}
    <div class="rack-row">
      <!--
        THE GUTTER CELL — empty on every rack but the high one.

        ⚠ IT IS A CELL OF THE ROW, NOT A COLUMN BESIDE THE RACK. The button used
        to live in a gutter alongside the whole stack, top-aligned to it. That
        put it on the high row's centre line only while that row was exactly one
        slot tall — on a phone the high rack wraps to two lines and the icon was
        left 23px above everything it was supposed to line up with. As a cell of
        the row it is centred by the same rule as the name, the heat bar and the
        tiles, whatever the row's height.
      -->
      <span class="rack-gutter">
        <!--
          WEAPON BANKING — one click fires every gun in the group.
          ⚠ IT IS AN ICON IN THE RACK'S OWN GUTTER, NOT A LABELLED BUTTON UNDER IT.
          It used to be a strip below the racks: a sentence of state and a button
          spelling out the action, two lines away from the guns it acts on. Beside
          the high rack it is next to the only modules it can affect, and the cell
          is a fixed height where a whole row of chrome is expensive.
          ⚠ THE STATE IS IN WORDS, NOT ONLY IN THE GLYPH. `title` and the accessible
          name both carry the action AND what is true right now, and `aria-pressed`
          says it again in a way a screen reader reads as state. The two glyphs
          differ in SHAPE — a joined chain against a broken one — so the difference
          never depends on telling two colours apart.
          ⚠ AND IT IS DRAWN, NOT AN EMOJI, for the reason the overload dot is: at
          this size a platform emoji is whatever font happened to answer, and
          several of them are unreadable smudges.
        -->
        {#if row.family === "high" && weaponsCount > 1 && flow}
          {@const linked = bankedCount > 0}
          <button
            type="button"
            class="rack-bank"
            class:linked
            aria-pressed={linked}
            disabled={pendingItemID !== null}
            title={linked
              ? `Unlink weapons — ${bankedCount} weapon${bankedCount === 1 ? "" : "s"} banked`
              : "Link weapons — weapons fire one at a time"}
            aria-label={linked
              ? `Unlink weapons. ${bankedCount} weapon${bankedCount === 1 ? "" : "s"} banked.`
              : "Link weapons. Weapons fire one at a time."}
            onclick={() => setBanks(!linked)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <!-- The two halves of the chain, which both states share. -->
              <path d="M10.2 6.4 12.4 4.2a4.2 4.2 0 0 1 5.9 5.9l-2.2 2.2" />
              <path d="M13.8 17.6 11.6 19.8a4.2 4.2 0 0 1-5.9-5.9l2.2-2.2" />
              {#if linked}
                <!-- Joined: the bar between them is the link. -->
                <path d="M8.8 15.2 15.2 8.8" />
              {:else}
                <!-- Broken: no bar, and two ticks where it parted. -->
                <path d="M9.6 13 8.2 11.6" />
                <path d="M14.4 11 15.8 12.4" />
              {/if}
            </svg>
          </button>
        {/if}
      </span>
      <!--
        THE ROW HEADER — the rack's name, its heat bar and the reading, on ONE
        LINE in a fixed column.

        ⚠ ONE LINE, NOT A STACK. Stacked, every rack row stood two lines tall
        beside a 42px slot and "heat not known" read as a second label hanging
        under its rack's name. Inline it is one statement about one rack.

        ⚠ IT IS FIXED-WIDTH AND IT COMES FIRST, and both halves of that matter.
        The first build put the heat AFTER the slots with `margin-left: auto`,
        so where it landed depended on how many slots that rack happened to wrap
        — three rows, three different positions, and nothing to read down. A
        fixed first column is what makes the three readings a column at all.
      -->
      <span
        class="rack-row-label"
        title={row.heat === null
          ? `${row.label} rack heat is not something this client can read yet.`
          : `${row.label} rack heat ${Math.round(row.heat * 100)}% — overloaded modules heat the whole rack`}
      >
        <span class="rack-name">{row.label}</span>
        <!--
          RACK HEAT — a stub, and it says so.

          ⚠ THE TRACK IS EMPTY AND THE WORDS READ "heat not known". It must
          NEVER be drawn as 0, and NEVER filled from the modules' damage: an
          empty bar reads as COLD, which is the single most dangerous thing this
          instrument could say wrongly, and accumulated damage is the SCAR heat
          left behind, not the heat in the rack now. A player overloading on the
          strength of the wrong one burns modules out.

          `row.heat` is typed `number | null` and is null for every row today;
          the rendering is already correct for the day a real reading arrives,
          which is why it is here rather than commented out.
        -->
        <span class="rack-heat-track" aria-hidden="true">
          {#if row.heat !== null}
            <span
              class={`rack-heat-fill ${rackHeatBand(row.heat)}`}
              style={`width:${Math.round(row.heat * 100)}%`}
            ></span>
          {/if}
        </span>
        <span class={`rack-heat-value ${rackHeatBand(row.heat) ?? "unknown"}`}>
          {rackHeatText(row.heat)}
        </span>
      </span>
      <div class="rack-slots">
        {#if row.slots.length === 0}
          <span class="rack-empty muted">—</span>
        {:else}
          {#each row.slots as slot, i (i)}
            {#if slot.module}
              {@const nm = moduleName(slot.module.typeID)}
              {@const clickable = flow !== null && slotAction(slot.module) !== null}
              {@const wedge = rackDamageWedge(slot.module)}
              {@const band = rackDamageBand(slot.module)}
              {@const ammo = takesCharges(slot.module)}
              {@const reloadPct = rackReloadPercent($fitting.reloads[slot.module.itemID], nowMs)}
              <button
                type="button"
                class="module-slot filled"
                class:active={slot.module.active}
                class:offline={!slot.module.online}
                class:pending={pendingItemID === slot.module.itemID}
                class:overloaded={slot.module.overloaded === true}
                class:holding={holdItemID === slot.module.itemID}
                disabled={!clickable || pendingItemID !== null}
                aria-pressed={slot.module.active}
                aria-haspopup={ammo && flow ? "menu" : undefined}
                data-rack-module={slot.module.itemID}
                title={slotTitle(slot.module)}
                aria-label={slotTitle(slot.module)}
                oncontextmenu={(event) => {
                  if (!ammo || !flow || !slot.module) return;
                  event.preventDefault();
                  // ⚠ A TOUCH LONG-PRESS ALSO FIRES `contextmenu`, at about
                  // the time the overload hold is filling. The hold is the
                  // older promise, so a press already holding keeps it.
                  if (holdItemID !== null) return;
                  openMenu({ kind: "slot", module: slot.module }, event.currentTarget as HTMLElement);
                }}
                onpointerdown={(event) => {
                  if (event.button === 0 && slot.module) pressStart(slot.module);
                }}
                onpointerup={() => slot.module && pressEnd(slot.module)}
                onpointerleave={pressCancel}
                onpointercancel={pressCancel}
                onkeydown={(event) => {
                  // The keyboard's right-click: the Menu key, or Shift+F10.
                  // (getModifierState, not the shift flag: a source guard holds
                  // shift-CLICK out of this file, and this is not a click.)
                  if (
                    ammo && flow && slot.module &&
                    (event.key === "ContextMenu" || (event.key === "F10" && event.getModifierState("Shift")))
                  ) {
                    event.preventDefault();
                    openMenu({ kind: "slot", module: slot.module }, event.currentTarget as HTMLElement);
                    return;
                  }
                  if ((event.key === "Enter" || event.key === " ") && !event.repeat && slot.module) {
                    // Suppress the browser's own click for this key: the press
                    // pair below is what fires the module, and both would.
                    event.preventDefault();
                    pressStart(slot.module);
                  }
                }}
                onkeyup={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && slot.module) {
                    event.preventDefault();
                    pressEnd(slot.module);
                  }
                }}
              >
                <!--
                  THE SLOT RING — the round face the retail rack has, drawn as an
                  SVG circle inside a square tile.

                  ⚠ IT IS NOT `border-radius`. R53 squared this app's corners, and
                  `squareCorners.test.ts` holds them squared; a rounded tile would
                  be a regression against that rule. A geometric circle drawn
                  INSIDE the box is the same exception `.fit-ring-guide` already
                  is — the shape is the instrument, not the frame.
                -->
                <svg class="slot-ring" viewBox="0 0 42 42" aria-hidden="true">
                  <circle class="slot-ring-track" cx="21" cy="21" r="17" />
                  {#if wedge > 0 && band}
                    <!--
                      THE HEAT-DAMAGE WEDGE — how burnt this module already is,
                      as an arc from twelve o'clock. Absent entirely when the
                      damage is unknown, because an empty wedge and an intact
                      module must not look alike (see rackDamageWedge).
                    -->
                    <circle
                      class={`slot-ring-wear ${band}`}
                      cx="21"
                      cy="21"
                      r="17"
                      transform="rotate(-90 21 21)"
                      style={`stroke-dasharray:${wedge} ${SLOT_RING}`}
                    />
                  {/if}
                  {#if holdItemID === slot.module.itemID}
                    <!--
                      The hold, filling. This is the ONLY warning a player gets
                      before a module starts damaging itself, so it is drawn on
                      the tile being held rather than anywhere else.
                    -->
                    <circle
                      class="slot-ring-hold"
                      cx="21"
                      cy="21"
                      r="17"
                      transform="rotate(-90 21 21)"
                      style={`stroke-dasharray:${(SLOT_RING * holdPercent) / 100} ${SLOT_RING}`}
                    />
                  {/if}
                </svg>
                <TypeIcon typeID={slot.module.typeID} name={nm} size="sm" fallbackText={abbreviate(nm)} />
                <!--
                  ⚠ GATED ON `active`, WHICH IS THE SNAPSHOT'S ANSWER — the
                  same authority the glow already answers to. The sweep used to
                  be drawn from `moduleCycles` alone, and that record only ever
                  ENDS on an `OnGodmaShipEffect` frame with isStart=0. A frame
                  that never arrives (a feed reconnect, a cycle the server ends
                  without saying) leaves `startedAtMs` set forever, and a
                  non-repeating cycle clamps at 100% — so the tile kept a full
                  accent disc over its icon on a module that had finished. That
                  is the strongest 'still running' mark the rack draws, made
                  from a claim nothing was standing behind any more.
                -->
                {#if slot.module.active && cycleOf(slot.module.itemID) !== null}
                  <!--
                    The cycle sweep — a radial wipe over the module's own icon,
                    the way the retail client draws it. Only drawn when the
                    SERVER's own cycle stamp says where we are: a module we have
                    no stamp for shows nothing at all, because a sweep sitting at
                    zero reads as "just started", which is a claim we do not have.

                    `--sweep` is a percentage of a full turn, consumed by a
                    conic-gradient in styles.css.
                  -->
                  <span
                    class="module-cycle"
                    aria-hidden="true"
                    style={`--sweep:${cycleOf(slot.module.itemID)}%`}
                  ></span>
                {/if}
                {#if slot.module.overloaded === true}
                  <!--
                    Words carry the state (the title); this is the glance. A
                    pulsing dot rather than a flame emoji: an emoji renders at
                    the mercy of the platform's font, and at 9px several of them
                    are unreadable smudges.
                  -->
                  <span class="module-heat" aria-hidden="true"></span>
                {/if}
                {#if rackModuleBurntOut(slot.module)}
                  <span class="module-burnt" aria-hidden="true"></span>
                {/if}
                {#if reloadPct !== null}
                  <!-- The reload, swept like a cycle but in its own colour, from
                       the server's own announcement and the reload time it gave. -->
                  <span class="module-reload" aria-hidden="true" style={`--sweep:${reloadPct}%`}></span>
                {/if}
                {#if ammo}
                  <!-- Rounds held. A red 0 is a gun that cannot fire, visible
                       before anyone clicks it. -->
                  <span class="module-ammo" class:empty={slot.module.charge === null} aria-hidden="true"
                    >{rackChargeBadge(slot.module)}</span
                  >
                {/if}
              </button>
            {:else}
              <!--
                ⚠ AN EMPTY SLOT IS A DASHED RING, NOT A FILLED BOX. It was a
                solid square, which on a rack of round faces reads as a fitted
                module whose icon failed to load — the one thing an empty slot
                must not look like. The handoff draws it dashed and empty, and
                that is a shape nothing else on the rack has.
              -->
              <span class="module-slot empty" title={rackSlotTitle("", null)}>
                <svg class="slot-ring" viewBox="0 0 42 42" aria-hidden="true">
                  <circle class="slot-ring-empty" cx="21" cy="21" r="17" />
                </svg>
              </span>
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {/each}
  {#if unknown}
    <p class="rack-hint muted">Modules appear once your ship's fitting has loaded.</p>
  {/if}
  {#if groups.length > 0 && flow}
    <!--
      THE AMMO STRIP — one line per weapon type in the high rack: what it is
      loaded with and how many of its guns hold anything, and a menu to change
      it. A picture tile cannot say "four of six launchers are empty" at a
      glance; this line can, and it is where "Reload all" lives.
    -->
    <div class="rack-ammo">
      <span class="rack-ammo-head">Ammo</span>
      {#each groups as group (group.moduleTypeID)}
        {@const what =
          group.chargeTypeIDs.length === 0
            ? "empty"
            : group.chargeTypeIDs.length > 1
              ? "mixed"
              : moduleName(group.chargeTypeIDs[0]!)}
        <button
          type="button"
          class="rack-ammo-group"
          class:short={group.loaded < group.modules.length}
          aria-haspopup="menu"
          disabled={pendingItemID !== null}
          title={`${group.modules.length}x ${moduleName(group.moduleTypeID)}: ${what}, ${group.loaded} of ${group.modules.length} loaded. Click to load.`}
          onclick={(event) => openMenu({ kind: "group", group }, event.currentTarget as HTMLElement)}
        >
          <span class="rack-ammo-gun">{group.modules.length}x {moduleName(group.moduleTypeID)}</span>
          <span class="rack-ammo-what">{what}</span>
          <span class="rack-ammo-count">{group.loaded}/{group.modules.length}</span>
        </button>
      {/each}
      <button
        type="button"
        class="minor"
        disabled={pendingItemID !== null}
        title="Top up every weapon from cargo with the ammunition it already uses"
        onclick={() => reloadAll()}
      >Reload all</button>
    </div>
  {/if}
  {#if damagedModules.length > 0}
    <!--
      Repairing consumes nanite paste, so it is a deliberate act with its own
      control rather than another modifier on the tile. A BURNT OUT module is
      called out in words: it will not run at all until it is repaired, and a
      player who does not know that will keep clicking a dead tile.
    -->
    <div class="rack-damage">
      <span class="rack-damage-head">Damaged</span>
      <ul class="rack-damage-list">
        {#each damagedModules as module (module.itemID)}
          {@const nm = moduleName(module.typeID)}
          <li>
            <span class="rack-damage-name" class:burnt={rackModuleBurntOut(module)}>
              {nm} — {rackModuleBurntOut(module) ? "burnt out" : `${rackDamageText(module)} damaged`}
            </span>
            {#if flow}
              <button
                type="button"
                class="minor"
                disabled={pendingItemID !== null}
                title={`Repair ${nm} with nanite paste`}
                onclick={() => repair(module)}
              >Repair</button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if error}
    <!-- ⚠ A REFUSAL STAYS HERE, ON THE CONTROL (R30). Only the winding-down
         note moved to the centre flash: that is an acknowledgement with a shelf
         life of one cycle, where this is the reason a button did nothing, and a
         player needs that while they are still looking at the button. -->
    <p class="rack-error" role="alert">
      {error}
      {#if refusalModule && refusalFix && flow}
        <!-- The fix, on the line that names the problem: the refusal was
             about an empty gun, and here is what is in cargo for it. -->
        <button
          type="button"
          class="minor"
          disabled={pendingItemID !== null}
          onclick={() => refusalModule && refusalFix && loadChoice([refusalModule], refusalFix)}
        >Load {moduleName(refusalFix.typeID)} ({refusalFix.quantity.toLocaleString()} in cargo)</button>
      {/if}
    </p>
  {/if}
  {#if menu}
    {@const target = menu.target}
    {@const choices = ammoChoices(menuTypeID(target), cargoRows, chargeFits)}
    {@const held = loadedTypeOf(target)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="rack-menu"
      role="menu"
      tabindex="-1"
      aria-label={menuHead(target)}
      style={`left:${menu.left}px;bottom:${menu.bottom}px`}
      bind:this={menuEl}
      onkeydown={onMenuKey}
    >
      <span class="rack-menu-head">{menuHead(target)}</span>
      {#if choices.length === 0}
        <span class="rack-menu-note">
          {cargoReading ? "Reading cargo..." : "No ammunition in cargo."}
        </span>
      {/if}
      {#each choices as choice (choice.typeID)}
        <button
          type="button"
          role="menuitem"
          class:unlikely={choice.verdict === false}
          onclick={() => loadChoice(menuModules(target), choice)}
        >
          <span class="rack-menu-name">
            {moduleName(choice.typeID)}
            {#if choice.typeID === held}<span class="rack-menu-tag">loaded</span>{/if}
            {#if choice.verdict === false}<span class="rack-menu-tag">probably will not fit</span>{/if}
          </span>
          <span class="rack-menu-qty">{choice.quantity.toLocaleString()}</span>
        </button>
      {/each}
      <span class="rack-menu-rule" aria-hidden="true"></span>
      {#if groups.length > 0}
        <button type="button" role="menuitem" onclick={() => reloadAll()}>Reload all weapons</button>
      {/if}
      {#if menuModules(target).some((module) => module.charge !== null)}
        <button type="button" role="menuitem" onclick={() => unloadModules(menuModules(target))}
          >Unload to cargo</button
        >
      {/if}
    </div>
  {/if}
</div>
