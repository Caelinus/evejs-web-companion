<script lang="ts">
  // The main-area host for a SELECTED tab — static (a Neocom pick) or
  // state-specific (a shell control). One place the tab -> real component
  // mapping lives, so App and both shells stay thin routers. Every panel here is
  // a pre-existing, working component; only the two state SHELLS themselves are
  // still placeholder chrome.
  import InventoryShip from "./InventoryShip.svelte";
  import Fitting from "./Fitting.svelte";
  import Industry from "./Industry.svelte";
  import Market from "./Market.svelte";
  import Activity from "./Activity.svelte";
  import FleetCenter from "./FleetCenter.svelte";
  import Scanner from "./Scanner.svelte";
  import Mail from "./Mail.svelte";
  import Contracts from "./Contracts.svelte";
  import PersonalAssets from "./PersonalAssets.svelte";
  import AgentsMissions from "./AgentsMissions.svelte";
  import AgentFinder from "./AgentFinder.svelte";
  import Flight from "./Flight.svelte";
  import Overview from "./Overview.svelte";
  import Mining from "./Mining.svelte";
  import Skills from "./Skills.svelte";
  import Planets from "./Planets.svelte";
  import Travel from "./Travel.svelte";
  import Bots from "./Bots.svelte";
  import BotBuilder from "./BotBuilder.svelte";
  import ServerBots from "./ServerBots.svelte";
  import BotManager from "./BotManager.svelte";
  import Wallet from "./Wallet.svelte";
  import CorpWallet from "./CorpWallet.svelte";
  import Standings from "./Standings.svelte";
  import CharacterSheet from "./CharacterSheet.svelte";
  import Settings from "./Settings.svelte";
import ShowInfo from "./ShowInfo.svelte";
import NoticeLog from "./NoticeLog.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { tabLabel, type TabID } from "./tabs.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let {
    store,
    flow,
    tab,
    onOpen,
  }: {
    store: ClientStore;
    flow: AppFlow;
    tab: TabID;
    // Lets a panel navigate to another tab (e.g. Agent Finder -> Travel).
    onOpen?: (tab: TabID) => void;
  } = $props();
</script>

<!-- One panel's failure is that panel's failure: a boundary per host keeps a
     broken Market from taking the Overview, the HUD and the character bar down
     with it, and names the panel in the report (see ErrorBoundary.svelte). -->
<ErrorBoundary name={tabLabel(tab)}>
{#if tab === "inventory"}
  <InventoryShip {store} {flow} />
{:else if tab === "fitting"}
  <Fitting {store} {flow} showInventory={() => onOpen?.("inventory")} />
{:else if tab === "industry"}
  <Industry {store} {flow} />
{:else if tab === "market"}
  <Market {store} {flow} />
{:else if tab === "activity"}
  <Activity {store} {flow} showMail={() => onOpen?.("mail")} />
{:else if tab === "fleet"}
  <FleetCenter {store} {flow} />
{:else if tab === "scanner"}
  <Scanner {store} {flow} />
{:else if tab === "mail"}
  <Mail {store} {flow} />
{:else if tab === "contracts"}
  <Contracts {store} {flow} />
{:else if tab === "assets"}
  <PersonalAssets {store} {flow} />
{:else if tab === "agents"}
  <AgentsMissions {store} {flow} />
{:else if tab === "finder"}
  <AgentFinder {store} {flow} showTravel={() => onOpen?.("travel")} />
{:else if tab === "flight"}
  <Flight {store} {flow} />
{:else if tab === "overview"}
  <Overview {store} {flow} />
{:else if tab === "mining"}
  <Mining {store} {flow} />
{:else if tab === "skills"}
  <Skills {store} {flow} />
{:else if tab === "planets"}
  <Planets {store} {flow} />
{:else if tab === "travel"}
  <Travel {store} {flow} />
{:else if tab === "bots"}
  <Bots {store} {flow} />
{:else if tab === "botBuilder"}
  <BotBuilder {store} {flow} />
{:else if tab === "serverBots"}
  <ServerBots />
{:else if tab === "botManager"}
  <BotManager {store} {flow} onOpen={(id) => onOpen?.(id)} />
{:else if tab === "wallet"}
  <Wallet {store} {flow} />
{:else if tab === "corpWallet"}
  <CorpWallet {store} {flow} />
{:else if tab === "standings"}
  <Standings {store} {flow} />
{:else if tab === "characterSheet"}
  <CharacterSheet {store} {flow} />
{:else if tab === "settings"}
  <Settings {store} {flow} />
{:else}
  <p class="error">This panel is no longer available.</p>
{/if}
</ErrorBoundary>
