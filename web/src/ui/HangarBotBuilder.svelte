<script lang="ts">
  // The Bot Builder with NOBODY IN THE CLIENT — the window the Bot Manager's
  // New and Edit buttons open over the Pilot Hangar.
  //
  // The Builder itself is unchanged; this only supplies what a pilot's desktop
  // would have. Its flow rides an ACCOUNT sign-in, the same one the Manager's
  // library calls use (app/pilotReach.ts), and its store is an empty one: no
  // ship, no cargo, no station, so the pickers that read those start empty
  // rather than showing somebody's. See bots/builderFlow.ts.
  import { onMount } from "svelte";
  import BotBuilder from "./BotBuilder.svelte";
  import { createPilotReach } from "../app/pilotReach.ts";
  import { loadKnownAccounts, loadKnownCharacters } from "../app/knownCharacters.ts";
  import type { Session } from "../app/sessions.ts";
  import { createPilotlessBuilderFlow } from "../bots/builderFlow.ts";
  import { createClientStore } from "../store/clientStore.ts";

  let { sessions }: { sessions: readonly Session[] } = $props();

  const reach = createPilotReach({
    held: () => sessions,
    known: () => loadKnownCharacters(),
    accounts: () => loadKnownAccounts(),
  });
  onMount(() => () => void reach.release());

  const flow = createPilotlessBuilderFlow(() => reach.libraryOptions());
  const store = createClientStore();
</script>

<BotBuilder {store} {flow} />
