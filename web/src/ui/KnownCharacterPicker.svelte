<script lang="ts">
  // R107 — the "pilots you've flown before" quick-pick shown above the login
  // form in the onboarding flow. One click brings a remembered pilot online
  // (sign in to its account, select it) instead of retyping the account name
  // and re-picking. A pilot already live in this window is shown disabled; the
  // × forgets a stale one from the local roster.
  import type { KnownCharacter } from "../app/knownCharacters.ts";
  import type { ActiveServerBot } from "../app/api.ts";
  // The bot phrases are shared with the Pilot Hangar's row — see bots/pilotRoster.ts.
  import { activeBotCommandWords, activeBotVitalsWords } from "../bots/pilotRoster.ts";

  let {
    known,
    onlineIDs,
    busyID,
    botFlownIDs = new Set<number>(),
    botStatuses = new Map<number, ActiveServerBot>(),
    stoppingID = null,
    onPick,
    onForget,
    onStopBot,
  }: {
    known: KnownCharacter[];
    onlineIDs: Set<number>;
    busyID: number | null;
    /** Pilots a SERVER BOT is flying right now — marked so a click isn't a surprise refusal. */
    botFlownIDs?: Set<number>;
    /** Per-pilot bot status + ship vitals (host samples ~15s) for the readout line. */
    botStatuses?: Map<number, ActiveServerBot>;
    /** The pilot whose bot a stop is in flight for (disables the stop buttons). */
    stoppingID?: number | null;
    onPick: (character: KnownCharacter) => void;
    onForget: (characterID: number) => void;
    /** Stop the server bot flying this pilot — the landing page's own Stop, so a fully bot-flown roster can never lock the player out. */
    onStopBot?: (character: KnownCharacter) => void;
  } = $props();

</script>

{#if known.length > 0}
  <section class="panel known-chars">
    <header class="panel-head">
      <h2>Your pilots</h2>
    </header>
    <p class="note">Bring a pilot you've flown before online in one click — or sign in below.</p>
    <ul class="known-list">
      {#each known as character (character.characterID)}
        {@const online = onlineIDs.has(character.characterID)}
        {@const botFlown = botFlownIDs.has(character.characterID)}
        <li class="known-row">
          <button
            type="button"
            class="known"
            disabled={online || busyID !== null}
            onclick={() => onPick(character)}
          >
            <span class="name">
              {character.characterName}
              {#if botFlown}
                <!-- Words with the mark, never the mark alone (R9a). -->
                <span class="bot-flying-badge" title="A server bot is flying this pilot">⚙ Bot flying</span>
              {/if}
            </span>
            <span class="detail">
              {character.accountName}{#if character.shipName} · {character.shipName}{/if}{#if character.skillPoints != null} · {character.skillPoints} SP{/if}
            </span>
            {#if online}
              <span class="detail known-state">Already in this window</span>
            {:else if busyID === character.characterID}
              <span class="detail known-state">Bringing online…</span>
            {:else if botFlown}
              {@const botRow = botStatuses.get(character.characterID)}
              {#if botRow}
                <!-- The at-a-glance ship readout: what the bot is doing, then
                     health and hold fill from the host's ~15s vitals sample. -->
                <span class="detail known-state">{activeBotCommandWords(botRow)}</span>
                {@const vitals = activeBotVitalsWords(botRow.vitals)}
                {#if vitals}
                  <span class="detail bot-vitals">{vitals}</span>
                {/if}
              {:else}
                <span class="detail known-state">A server bot is flying this pilot — stop it to fly it yourself.</span>
              {/if}
            {/if}
          </button>
          {#if botFlown && onStopBot}
            <button
              type="button"
              class="known-stop"
              title="Stop the server bot flying {character.characterName}"
              disabled={stoppingID !== null || busyID !== null}
              onclick={() => onStopBot(character)}
            >
              {stoppingID === character.characterID ? "Stopping…" : "Stop bot"}
            </button>
          {/if}
          <button
            type="button"
            class="known-forget"
            title="Forget {character.characterName}"
            aria-label="Forget {character.characterName}"
            disabled={busyID !== null}
            onclick={() => onForget(character.characterID)}
          >×</button>
        </li>
      {/each}
    </ul>
  </section>
{/if}
