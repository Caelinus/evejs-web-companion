<script lang="ts">
  // The ship's equipment, as its own window — lifted out of `Overview.svelte`'s
  // "Your equipment" table.
  //
  // ⚠ WHY THIS EXISTS AT ALL, WHEN THE HUD ALREADY HAS A MODULE RACK. The rack
  // is a DIFFERENT INSTRUMENT, not a smaller version of this one. It is the
  // F-row: pictures you press to fire something, read at a glance while flying.
  // It cannot power an OFFLINE module up, it has no target picker, and it shows
  // no cycle length. This table is the readout — the place a pilot goes to find
  // out what is fitted, what state it is in, and how long its cycle runs.
  //
  // ⚠ AND WITHOUT IT THERE IS NO WAY TO ONLINE A MODULE IN SPACE. Fitting is a
  // DOCKED-ONLY tab. R30 slice E deleted the sentence that told players to go
  // there for that one click, precisely because the click had to be reachable
  // where they actually are. Deleting the cockpit without this window would
  // have quietly restored the problem — with every test still green, because no
  // test asserts the absence of a capability nobody thought to remove.
  import {
    AUTO_TARGET,
    NO_TARGET,
    cycleIsBaseFigure,
    cycleLengthLabel,
    equipmentRows,
    runningText,
    targetChoice,
  } from "./equipmentRows.ts";
  import { cycleProgressPercent } from "./moduleRack.ts";
  import { nameKey, resolvedName } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { EquipmentRow } from "./equipmentRows.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { NameRef, SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  const snapshot = $derived($space.snapshot);
  const activeModuleIDs = $derived(snapshot?.ship?.activeModuleIDs ?? null);

  const rows = $derived(
    equipmentRows(
      $fitting.slots,
      activeModuleIDs,
      (typeID) => [
        resolvedName($names.resolved, "type", typeID, "Unknown module"),
        // Raw read, null-aware: an unresolved group must stay null so anything
        // asking "is this a miner" reads it as "cannot tell" rather than as a
        // definitive no.
        $names.resolved[nameKey("typeGroup", typeID)] ?? null,
      ],
      $targeting.moduleCycles,
    ),
  );

  // The fit is what this window is about, and Fitting is docked-only — so it
  // asks for its own rather than relying on another component being mounted.
  $effect(() => {
    if (!$fitting.loaded) {
      void flow.loadFitting().catch(() => {});
    }
  });

  // Module and group names come from the shared cache (R7d). Same rule.
  $effect(() => {
    const refs: NameRef[] = [];
    const seen = new Set<number>();
    for (const slot of $fitting.slots) {
      const typeID = slot.module?.typeID;
      if (typeof typeID !== "number" || seen.has(typeID)) {
        continue;
      }
      seen.add(typeID);
      refs.push({ kind: "type", id: typeID });
      refs.push({ kind: "typeGroup", id: typeID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  /**
   * A ticking clock, so a running cycle's bar actually moves.
   *
   * ⚠ DISPLAY ONLY, AND ONLY WHILE SOMETHING IS CYCLING. Every value it feeds
   * comes from the SERVER's own cycle stamp; nothing here advances past what the
   * server said. And an idle panel does not need a five-a-second timer running
   * forever to redraw nothing.
   */
  let nowMs = $state(Date.now());
  $effect(() => {
    if (!rows.some((row) => row.cycle !== null)) {
      return;
    }
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 200);
    return () => clearInterval(timer);
  });

  // --- what a module is switched on AGAINST ----------------------------------

  const lockedIDs = $derived($targeting.lockedTargetIDs);
  const acquiringIDs = $derived($targeting.acquiringTargetIDs);

  /** What to call something on the grid. Never an id (R7d). */
  function displayLabel(entity: SpaceEntity | null): string {
    if (!entity) {
      return "No longer in view";
    }
    if (entity.name && entity.name.length > 0) {
      return entity.name;
    }
    const type = resolvedName($names.resolved, "type", entity.typeID, "");
    return type.length > 0 ? type : "Unknown object";
  }

  /**
   * The targets the picker offers: LOCKED ones only.
   *
   * A target still being ACQUIRED cannot be shot at yet, so offering it would
   * be offering a refusal. It appears in the list the moment the server says
   * the lock landed.
   */
  const selectableTargets = $derived.by(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    return lockedIDs.map((itemID) => ({
      itemID,
      label: displayLabel(byID.get(itemID) ?? null),
    }));
  });

  let targetPick = $state(AUTO_TARGET);
  const effectiveTargetID = $derived(targetChoice(targetPick, lockedIDs));

  // --- running one ------------------------------------------------------------

  /**
   * Per-concern busy tracking.
   *
   * ⚠ A SET, NOT A FLAG. A single shared flag greys out every control whenever
   * any one of them is in flight, which is how a player ends up unable to
   * switch a hardener off because a power-up request happened to be pending.
   */
  type Concern = "module" | "power";
  let busy = $state<readonly Concern[]>([]);
  let error = $state("");
  /** A power change the server accepted and then did not make. See below. */
  let moduleNotice = $state("");

  function concernBusy(concern: Concern): boolean {
    return busy.includes(concern);
  }

  async function runFor(concern: Concern, action: () => Promise<void>): Promise<void> {
    if (concernBusy(concern)) {
      return;
    }
    busy = [...busy, concern];
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "The live session ended (idle timeout or another client took over)."
        : panelErrorWords(cause);
    } finally {
      busy = busy.filter((entry) => entry !== concern);
    }
  }

  /**
   * Power a module up or down, without a trip to a window that does not exist
   * in space.
   *
   * ⚠ VERIFIED AGAINST A RE-READ, NOT AGAINST THE CALL'S ANSWER.
   * `setModuleOnline` re-reads the fitting itself, so the check below is
   * against freshly-read authoritative state: if the module's own `online` flag
   * did not move, the server declined and said nothing — and that is reported
   * as exactly that, rather than as a success the player would believe.
   */
  async function setModulePower(module: EquipmentRow, online: boolean): Promise<void> {
    moduleNotice = "";
    await runFor("power", async () => {
      await flow.setModuleOnline(module.itemID, online);
      const after = $fitting.slots.find((slot) => slot.module?.itemID === module.itemID);
      const now = after?.module?.online ?? null;
      if (now !== null && now !== online) {
        moduleNotice = online
          ? `${module.label} did not power up, and your ship gave no reason.`
          : `${module.label} did not power down, and your ship gave no reason.`;
      }
    });
  }
</script>

<section class="panel equipment-panel">
  <div class="panel-head"><h2>Your equipment</h2></div>

  <p class="note">
    Everything fitted that can be switched on. Pick a locked target first if the
    equipment needs one — your ship will say so if it does.
  </p>
  <!--
    ⚠ R30 slice E — the sentence that used to be here told the player to go to
    the Fitting tab to power equipment up. It is DELETED, not reworded: the
    table below lists offline equipment with Power up on the row, and the
    Fitting tab does not exist in space at all. A test asserts it cannot come
    back — which is why this comment describes it rather than quoting it.
  -->

  {#if rows.length === 0}
    <p class="empty">
      {$fitting.loaded
        ? "This ship has nothing fitted that can be switched on."
        : "Reading what your ship has fitted…"}
    </p>
  {:else}
    <p class="controls">
      <label>
        Use it on
        <select bind:value={targetPick}>
          {#if selectableTargets.length > 0}
            <option value={AUTO_TARGET}>
              What I have locked ({selectableTargets[0].label})
            </option>
            {#each selectableTargets as locked (locked.itemID)}
              <option value={String(locked.itemID)}>{locked.label}</option>
            {/each}
          {:else}
            <option value={AUTO_TARGET}>Nothing locked yet</option>
          {/if}
          <option value={NO_TARGET}>Nothing — just switch it on</option>
        </select>
      </label>
      {#if selectableTargets.length === 0 && acquiringIDs.length > 0}
        <!-- Acquiring is not locked. Saying so beats an empty picker. -->
        <span class="note">Still locking on.</span>
      {/if}
    </p>

    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Equipment</th>
            <th>Fitted in</th>
            <th>Running</th>
            <!--
              R24 slice C — one cycle's length. Where the ship has reported a
              cycle it is the pilot's real figure, skills and bonuses already
              counted; otherwise it is the equipment's own starting figure and
              the row SAYS so rather than quietly passing it off as the other.
            -->
            <th>Cycle</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as module (module.itemID)}
            <tr>
              <td data-label="Equipment">{module.label}</td>
              <td data-label="Fitted in">{module.slotLabel}</td>
              <td data-label="Running">
                <!--
                  R30 slice E — POWERED UP and RUNNING are two different
                  questions and are never collapsed into one word. See
                  `equipmentRows.ts`, which is where the rule is tested.
                -->
                {#if module.online && module.running === null}
                  <span class="stat-unavailable">{runningText(module)}</span>
                {:else}
                  {runningText(module)}
                {/if}
              </td>
              <td data-label="Cycle">
                {#if !module.cycle}
                  <span class="stat-unavailable">Not known</span>
                {:else}
                  <span>{cycleLengthLabel(module.cycle)}</span>
                  {#if cycleIsBaseFigure(module.cycle)}
                    <!--
                      R9a in one phrase. The player is told plainly that this is
                      the equipment's own figure and not theirs, rather than
                      being handed a number that will not match their ship.
                    -->
                    <span class="note"> before skills</span>
                  {/if}
                  {#if cycleProgressPercent(module.cycle, nowMs) !== null}
                    <progress
                      max="100"
                      value={cycleProgressPercent(module.cycle, nowMs)}
                      aria-label="Cycle progress"
                    ></progress>
                  {/if}
                {/if}
              </td>
              <td data-label="">
                <span class="row-actions">
                  <!--
                    R30 slice E — POWER, on the row. This is the one click the
                    panel used to send the player to the Fitting tab for.
                    Powering up is not the same as switching on: a module has to
                    be online before it can run at all, so both controls are
                    here and they are labelled as the different things they are.
                  -->
                  {#if !module.online}
                    <button
                      type="button"
                      disabled={concernBusy("power")}
                      onclick={() => setModulePower(module, true)}
                    >
                      Power up
                    </button>
                  {:else}
                    <button
                      type="button"
                      class:on={module.running === true}
                      disabled={concernBusy("module") || module.running === true}
                      onclick={() =>
                        runFor("module", () =>
                          flow.activateModule(module.itemID, {
                            targetID: effectiveTargetID > 0 ? effectiveTargetID : null,
                          }),
                        )}
                    >
                      Switch on
                    </button>
                    <button
                      type="button"
                      disabled={concernBusy("module") || module.running === false}
                      onclick={() =>
                        runFor("module", () =>
                          flow.deactivateModule(module.itemID, { typeID: module.typeID }),
                        )}
                    >
                      Switch off
                    </button>
                    <button
                      type="button"
                      disabled={concernBusy("power")}
                      onclick={() => setModulePower(module, false)}
                    >
                      Power down
                    </button>
                  {/if}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!--
    Two different failures, said differently on purpose. A refusal carries the
    server's OWN words. A silent decline is when the call came back fine, the
    re-read showed nothing changed, and the server gave no reason — the page
    says exactly that rather than inventing a cause.
  -->
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if $targeting.actionError}
    <p class="error">{$targeting.actionError}</p>
  {/if}
  {#if $targeting.silentDecline}
    <p class="error">{$targeting.silentDecline}</p>
  {/if}
  {#if moduleNotice}
    <p class="error">{moduleNotice}</p>
  {/if}
  {#if $fitting.actionError}
    <p class="error">{$fitting.actionError}</p>
  {/if}
</section>
