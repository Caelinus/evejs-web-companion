<script lang="ts">
  // The bridge's mount point. Renders nothing.
  //
  // All it does is keep `watchNotices` alive for as long as this pilot's
  // workspace is on screen, and tear it down when they are switched away — see
  // noticeBridge.ts, which holds every decision worth reading.
  //
  // ⚠ MOUNTED EXACTLY ONCE PER WORKSPACE, ALONGSIDE THE FLASH. Two of these
  // over the same store would double every notice past the dedupe window.
  import { watchNotices } from "./noticeBridge.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store }: { store: ClientStore } = $props();

  $effect(() => watchNotices(store));
</script>
