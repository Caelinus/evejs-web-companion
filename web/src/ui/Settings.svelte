<script lang="ts">
  // The Settings panel (a normal window / mobile tab). Today it manages the local
  // item-icon cache: how many icons are cached, an opt-in "auto-fill" that has the
  // BFF fetch a missing icon the first time it's shown, and one-shot bulk pulls
  // (the common gamestore set, or every published type). Why this exists: icons
  // are LOCAL-ONLY (see ui/typeIcons.ts), so an item whose icon was never cached
  // shows a lettered tile — this is where you fill the cache so pictures appear.
  import {
    fetchIconStatus,
    setIconAutoDownload,
    startIconPull,
    type IconCacheStatus,
  } from "../app/iconCache.ts";
  import { flyingDistances, WARP_RANGES, HOLD_RANGES, setDistance } from "./flyingDistances.ts";
  // R81 — sound cues. Off by default; see ui/sound.ts for why the audio device
  // is not opened until someone asks for one.
  import { CUE_NAMES, closeSound, playCue, soundSettings, type CueName } from "./sound.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";

  let { flow }: { store?: ClientStore; flow?: AppFlow } = $props();

  // --- The GM console --------------------------------------------------------
  //
  // ⚠⚠ DEV-ONLY, AND IT REACHES EVERYTHING. This runs the world's own chat
  // commands: ~150 of them, including destructive ones. It lives here rather
  // than on a game panel because it is not a game action — it is the operator
  // reaching past the game to stage state, and it exists because the web client
  // otherwise cannot give a pilot so much as a round of ammunition to test with.
  //
  // ⚠ A 200 IS NOT SUCCESS. eve.js catches a bad command and RETURNS
  // "Command failed: …" instead of throwing, so the reply is rendered as the
  // server's own words either way and the panel never says "done".
  const GM_EXAMPLES: readonly { readonly command: string; readonly what: string }[] = [
    { command: "/gmships", what: "a set of ships in your hangar" },
    { command: "/gmweapons", what: "a set of weapons and ammunition" },
    { command: "/giveitem 150mm Light AutoCannon I 2", what: "any item, by name, in any amount" },
    { command: "/giveitem Phased Plasma S 5000", what: "ammunition to load" },
    { command: "/allskills", what: "every skill, trained" },
    { command: "/help", what: "the world's own list of every command" },
  ];

  let gmCommand = $state("");
  let gmReply = $state("");
  let gmError = $state("");
  let gmBusy = $state(false);

  async function runGm(): Promise<void> {
    const command = gmCommand.trim();
    if (!flow || gmBusy || !command) {
      return;
    }
    gmBusy = true;
    gmError = "";
    gmReply = "";
    try {
      // The reply is the server's, verbatim — including its refusals.
      gmReply = (await flow.runGmCommand(command)) || "The command ran and said nothing.";
    } catch (cause) {
      gmError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      gmBusy = false;
    }
  }

  let status = $state<IconCacheStatus | null>(null);
  let error = $state("");
  let busy = $state(false);

  async function refresh(): Promise<void> {
    try {
      status = await fetchIconStatus();
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  // One read on open; keep polling only while a bulk pull is running. Guarded,
  // because 1.5 s is the tightest beat in the client and a bulk icon pull is
  // exactly when the server has least to spare — see app/skipWhileBusy.ts.
  const beat = skipWhileBusy(refresh);
  $effect(() => {
    void beat();
    const handle = setInterval(() => {
      if (status?.running) void beat();
    }, 1500);
    return () => clearInterval(handle);
  });

  async function toggleAuto(): Promise<void> {
    if (!status || busy) return;
    busy = true;
    try {
      const value = await setIconAutoDownload(!status.autoDownload);
      status = { ...status, autoDownload: value };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function pull(source: "gamestore" | "all-types"): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await startIconPull(source);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section class="settings-panel">
  <div class="panel-head"><h2 class="panel-title">Settings</h2></div>

  <section class="settings-group">
    <h3>Item icons</h3>
    <p class="muted">
      Icons are served from a local cache. An item whose icon isn't cached shows a lettered tile
      instead of a picture — fill the cache below to make pictures appear.
    </p>

    {#if status === null && error === ""}
      <p class="muted">Loading…</p>
    {:else if status !== null}
      <p class="settings-stat">
        <strong>{status.cachedCount.toLocaleString()}</strong> icons cached locally.
      </p>

      <label class="settings-toggle">
        <input type="checkbox" checked={status.autoDownload} disabled={busy} onchange={toggleAuto} />
        <span class="settings-toggle-text">
          <strong>Auto-fill missing icons</strong>
          <span class="muted">
            Fetch an icon the first time it's shown, then keep it. Icons fill in as you browse — the
            best option unless you need to work fully offline.
          </span>
        </span>
      </label>

      <div class="settings-actions">
        <button type="button" disabled={busy || status.running} onclick={() => pull("all-types")}>
          Pull all icons
        </button>
        <button type="button" class="minor" disabled={busy || status.running} onclick={() => pull("gamestore")}>
          Pull common icons
        </button>
      </div>

      {#if status.running}
        <p class="settings-progress" aria-live="polite">
          <span class="spin" aria-hidden="true"></span>
          Pulling {status.source} icons… <span class="muted">{status.progress}</span>
        </p>
      {:else if status.lastResult}
        <p class="muted" aria-live="polite">Last pull ({status.source}): {status.lastResult}</p>
      {/if}

      {#if error}<p class="error">{error}</p>{/if}
    {:else}
      <p class="error">{error}</p>
    {/if}
  </section>

  <section class="settings-group">
    <h3>Flying distances</h3>
    <p class="muted">
      The ranges Warp to, Orbit and Keep at range use on whatever you have selected
      in the overview.
    </p>
    <div class="settings-field">
      <label for="fd-warp">Warp to within</label>
      <select id="fd-warp" value={$flyingDistances.warp} onchange={(e) => setDistance("warp", e.currentTarget.value)}>
        {#each WARP_RANGES as choice (choice.metres)}
          <option value={String(choice.metres)}>{choice.label}</option>
        {/each}
      </select>
    </div>
    <div class="settings-field">
      <label for="fd-orbit">Orbit at</label>
      <select id="fd-orbit" value={$flyingDistances.orbit} onchange={(e) => setDistance("orbit", e.currentTarget.value)}>
        {#each HOLD_RANGES as choice (choice.metres)}
          <option value={String(choice.metres)}>{choice.label}</option>
        {/each}
      </select>
    </div>
    <div class="settings-field">
      <label for="fd-hold">Keep at range</label>
      <select id="fd-hold" value={$flyingDistances.hold} onchange={(e) => setDistance("hold", e.currentTarget.value)}>
        {#each HOLD_RANGES as choice (choice.metres)}
          <option value={String(choice.metres)}>{choice.label}</option>
        {/each}
      </select>
    </div>
  </section>

  <section class="settings-group">
    <h3>Sound</h3>
    <p class="muted">
      Short tones for the moments worth noticing without looking: a target lock, a
      warp, docking, and anything the client raises an alert about. Off unless you
      turn it on.
    </p>
    <div class="settings-field">
      <label for="sound-on">Play sound cues</label>
      <input
        id="sound-on"
        type="checkbox"
        checked={$soundSettings.enabled}
        onchange={(e) => {
          const enabled = e.currentTarget.checked;
          soundSettings.set({ ...$soundSettings, enabled });
          // Switching off hands the audio device back rather than leaving one
          // open for a player who has said they do not want it.
          if (!enabled) closeSound();
        }}
      />
    </div>
    <div class="settings-field">
      <label for="sound-volume">Volume</label>
      <input
        id="sound-volume"
        type="range"
        min="0"
        max="100"
        step="5"
        disabled={!$soundSettings.enabled}
        value={Math.round($soundSettings.volume * 100)}
        oninput={(e) =>
          soundSettings.set({ ...$soundSettings, volume: Number(e.currentTarget.value) / 100 })}
      />
    </div>
    <!-- Previews. The only honest way to choose a volume is to hear it, and
         these double as the user gesture the browser requires before any audio
         will play at all. -->
    <div class="controls">
      {#each CUE_NAMES as cue (cue)}
        <button
          type="button"
          class="minor"
          disabled={!$soundSettings.enabled}
          onclick={() => playCue(cue as CueName)}
        >{cue}</button>
      {/each}
    </div>
  </section>

  {#if flow}
    <section class="settings-group gm-console">
      <h3>GM console</h3>
      <p class="muted">
        Runs this server's own commands as the character you have online — the
        same ones the game client's chat accepts. This is how you give yourself a
        ship, modules or ammunition to try something with.
      </p>
      <p class="gm-warning" role="note">
        These change the live world and some cannot be undone. There is no
        confirmation beyond this button.
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void runGm();
        }}
      >
        <div class="settings-field">
          <label for="gm-command">Command</label>
          <input
            id="gm-command"
            type="text"
            bind:value={gmCommand}
            autocomplete="off"
            spellcheck="false"
            placeholder="/giveitem Phased Plasma S 5000"
            disabled={gmBusy}
          />
        </div>
        <button type="submit" class="primary" disabled={gmBusy || !gmCommand.trim()}>
          {gmBusy ? "Running…" : "Run command"}
        </button>
      </form>

      {#if gmError}
        <p class="error" role="alert">{gmError}</p>
      {:else if gmReply}
        <!--
          The SERVER's words, verbatim. eve.js returns "Command failed: …" for a
          bad command rather than throwing, so this is the only place a refusal
          shows up — the panel must never replace it with "done".
        -->
        <p class="gm-reply" aria-live="polite">{gmReply}</p>
      {/if}

      <h4 class="gm-examples-head">Some useful ones</h4>
      <ul class="gm-examples">
        {#each GM_EXAMPLES as example (example.command)}
          <li>
            <button
              type="button"
              class="minor"
              disabled={gmBusy}
              onclick={() => (gmCommand = example.command)}
            >{example.command}</button>
            <span class="muted">{example.what}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>
