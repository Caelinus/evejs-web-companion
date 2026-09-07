<script lang="ts">
  // R107 — the character bar across the top of the tab: every online pilot as a
  // chip, the active one highlighted, a server-connection indicator, plus "Add
  // character". One cockpit shows at a time (the active pilot's Workspace, below);
  // clicking a chip switches which. All the pilots stay live on the BFF while
  // backgrounded — this bar just picks which one the workspace is driving.
  import CharacterChip from "./CharacterChip.svelte";
  import type { Session } from "../app/sessions.ts";

  let { sessions, activeId, serverStatus, onSwitch, onAdd, onHangar }: {
    sessions: Session[];
    activeId: string | null;
    serverStatus: "checking" | "online" | "offline";
    onSwitch: (id: string) => void;
    onAdd: () => void;
    /**
     * Reopen the Pilot Hangar over the cockpit. Without this the hangar was a
     * one-way door: the moment the first pilot came online, the only screen that
     * can bring the OTHER twenty online, edit squads or forget a pilot became
     * unreachable for the life of the tab.
     */
    onHangar: () => void;
  } = $props();

  const statusLabel = $derived(
    serverStatus === "online"
      ? "Connected"
      : serverStatus === "offline"
        ? "Server offline"
        : "Connecting…",
  );
</script>

<div class="char-bar">
  <span class="char-bar-brand">EVEJS</span>
  <div class="char-bar-list">
    {#each sessions as session (session.id)}
      <CharacterChip
        {session}
        active={session.id === activeId}
        onSelect={() => onSwitch(session.id)}
      />
    {/each}
  </div>
  <span class="char-bar-status char-bar-status-{serverStatus}" title={`Server: ${statusLabel}`}>
    <span class="char-bar-status-dot"></span>
    <span class="char-bar-status-text">{statusLabel}</span>
  </span>
  <button type="button" class="char-bar-hangar" onclick={onHangar} title="Pilot hangar — every pilot, squads and accounts">
    Pilots
  </button>
  <!--
    ⚠ THE LABEL IS TWO PIECES SO A NARROW BAR CAN DROP ONE.

    At 375px the whole bar is 359px of usable width and this button alone took
    119 of it, which crushed the pilot CHIP — the one thing the bar exists to
    show — down to an 11px stub with nothing readable in it. The "+" carries
    the button on a phone; the words come back as soon as there is room.

    `aria-label` is unconditional, so the button is never just a plus sign to
    anything that reads it aloud.
  -->
  <button type="button" class="char-bar-add" onclick={onAdd} aria-label="Add character">
    <span aria-hidden="true">+</span>
    <span class="char-bar-add-text">Add character</span>
  </button>
</div>
