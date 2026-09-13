<script lang="ts">
  // A read-only, player-facing digest across existing companion sources. The
  // panel never receives notification/calendar mutators and never renders the
  // internal IDs, service names, method names or live payloads it joins on.
  import { onMount } from "svelte";
  import {
    calendarResponseText,
    filetimeToUnixMs,
    liveActivityTitle,
  } from "../bridge/activity.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { resolvedName } from "../store/names.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let {
    store,
    flow,
    showMail,
  }: {
    store: ClientStore;
    flow: AppFlow;
    showMail?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const activity = store.activity;
  // svelte-ignore state_referenced_locally
  const mail = store.mail;
  // svelte-ignore state_referenced_locally
  const live = store.live;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let refreshError = $state("");

  const responsesByEvent = $derived(
    new Map(
      $activity.calendarResponses.status === "ready"
        ? $activity.calendarResponses.value.map((response) => [
            response.eventID,
            response.status,
          ] as const)
        : [],
    ),
  );

  const liveTail = $derived([...$live.notifications].slice(-8).reverse());

  function ownerName(ownerID: number, fallback: string): string {
    return resolvedName($names.resolved, "owner", ownerID, fallback);
  }

  function whenText(filetime: bigint | null): string {
    const unixMs = filetimeToUnixMs(filetime);
    return unixMs === null ? "Time not available" : new Date(unixMs).toLocaleString();
  }

  function receivedText(unixMs: number): string {
    return Number.isFinite(unixMs) && unixMs > 0
      ? new Date(unixMs).toLocaleString()
      : "Time not available";
  }

  function eventResponse(eventID: number): string {
    if ($activity.calendarResponses.status !== "ready") {
      return "Response unavailable";
    }
    return calendarResponseText(responsesByEvent.get(eventID));
  }

  async function refresh(): Promise<void> {
    refreshError = "";
    try {
      await flow.loadActivity();
    } catch (cause) {
      if (!isSessionLost(cause)) {
        // Detailed failures already live on the independent read arms. This is
        // only an unexpected whole-flow failure, so do not leak an error code.
        refreshError = "Activity could not be refreshed just now.";
      }
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<section class="panel" aria-busy={$activity.loading}>
  <header class="panel-head">
    <h2 class="panel-title">Activity Center</h2>
    <!-- ⚠ THE SUBTITLE WENT, THE COUNTS DID NOT. "A read-only overview of what
         needs your attention" only restated what the title bar and the Mail /
         Recent notifications sections below already say - the panel-never-
         describes-itself rule. The two badges are different: they are live
         counts, not description, so they stayed, moved from `.controls` into
         `.stat-line` on the strip's left. Their conditions are unchanged. -->
    {#if ($activity.unprocessedCount.status === "ready" && $activity.unprocessedCount.value > 0) || $mail.unreadCount > 0}
      <p class="stat-line">
        {#if $activity.unprocessedCount.status === "ready" && $activity.unprocessedCount.value > 0}
          <span class="badge accent">{$activity.unprocessedCount.value} new notices</span>
        {/if}
        {#if $mail.unreadCount > 0}
          <span class="badge accent">{$mail.unreadCount} unread mail</span>
        {/if}
      </p>
    {/if}
    <p class="controls">
      <button type="button" class="primary" disabled={$activity.loading} onclick={() => void refresh()}>
        {$activity.loading ? "Refreshing…" : "Refresh"}
      </button>
    </p>
  </header>

  {#if refreshError}
    <p class="error">{refreshError}</p>
  {/if}
  {#if !$activity.loaded}
    <p class="note">Loading your recent activity…</p>
  {:else if $activity.loading}
    <p class="note">Refreshing while the last good activity stays visible…</p>
  {/if}

  <div class="activity-grid">
    <section class="activity-card">
      <h3>Mail</h3>
      {#if $activity.mailError}
        <p class="error">{$activity.mailError}</p>
      {:else if !$mail.loaded}
        <p class="note">Mail has not been read yet.</p>
      {:else if $mail.unreadCount === 0}
        <p class="empty">No unread mail.</p>
      {:else}
        <p class="summary">
          <strong>{$mail.unreadCount}</strong>
          {$mail.unreadCount === 1 ? "message is" : "messages are"} waiting for you.
        </p>
        {#if showMail}
          <button type="button" class="minor" onclick={showMail}>Open Mail</button>
        {/if}
      {/if}
    </section>

    <section class="activity-card notifications">
      <h3>Recent notifications</h3>
      {#if $activity.unprocessedCount.status === "error"}
        <p class="error">{$activity.unprocessedCount.error}</p>
      {/if}
      {#if $activity.notifications.status === "error"}
        <p class="error">{$activity.notifications.error}</p>
      {:else if $activity.notifications.status === "unavailable"}
        <p class="note">Recent notifications are unavailable in this response.</p>
      {:else if $activity.notifications.value.length === 0}
        <p class="empty">No recent notifications.</p>
      {:else}
        <ol class="activity-list">
          {#each $activity.notifications.value as notification (notification.notificationID)}
            <li class:unread={!notification.processed}>
              <div class="row-main">
                <strong>{notification.title}</strong>
                <span class="meta">
                  From {ownerName(notification.senderID, "Notification sender")}
                  · {whenText(notification.created)}
                </span>
              </div>
              <span class="badge" class:accent={!notification.processed}>
                {notification.processed ? "Seen" : "Unread"}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="activity-card calendar">
      <h3>Upcoming calendar</h3>
      {#if $activity.calendarResponses.status === "error"}
        <p class="error">{$activity.calendarResponses.error}</p>
      {:else if $activity.calendarResponses.status === "unavailable"}
        <p class="note">Your calendar responses are unavailable.</p>
      {/if}
      {#if $activity.calendarEvents.status === "error"}
        <p class="error">{$activity.calendarEvents.error}</p>
      {:else if $activity.calendarEvents.status === "unavailable"}
        <p class="note">Upcoming events are unavailable in this response.</p>
      {:else if $activity.calendarEvents.value.length === 0}
        <p class="empty">No upcoming events this month.</p>
      {:else}
        <ol class="activity-list">
          {#each $activity.calendarEvents.value as event (event.eventID)}
            <li>
              <div class="row-main">
                <strong>{event.title}</strong>
                <span class="meta">
                  {whenText(event.eventDateTime)}
                  · hosted by {ownerName(event.ownerID, "Calendar host")}
                </span>
              </div>
              <span class="response">
                {#if event.importance > 0}<span class="badge warn">Important</span>{/if}
                <span class="badge">{eventResponse(event.eventID)}</span>
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="activity-card live-activity">
      <h3>Live activity</h3>
      {#if liveTail.length === 0}
        <p class="empty">Live session activity will appear here as it arrives.</p>
      {:else}
        <ol class="activity-list compact">
          {#each liveTail as notification, index (`${notification.receivedAtMs}:${index}`)}
            <li>
              <div class="row-main">
                <strong>{liveActivityTitle(notification)}</strong>
                <span class="meta">{receivedText(notification.receivedAtMs)}</span>
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  </div>

  {#if $activity.refreshedAtMs !== null}
    <p class="refreshed note">Last refreshed {new Date($activity.refreshedAtMs).toLocaleString()}.</p>
  {/if}
</section>

<style>
  /* ⚠ `.panel-head > div` and `.subtitle` used to style the title+blurb
     wrapper this strip no longer has (see the panel-head comment above) -
     removed rather than left to style nothing. Do not add them back for a
     future subtitle; the rule they'd support is the one that just got
     deleted. */
  .activity-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    gap: 0.7rem;
  }
  .activity-card {
    min-width: 0;
    margin: 0;
  }
  .notifications,
  .calendar {
    grid-column: span 2;
  }
  .activity-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .activity-list li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.7rem;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--color-row-line);
  }
  .activity-list li:last-child {
    border-bottom: 0;
  }
  .activity-list li.unread strong {
    color: var(--color-text-bright);
  }
  .row-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row-main strong {
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--color-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .response {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.3rem;
  }
  .summary strong {
    color: var(--color-text-bright);
    font-size: 1.4rem;
    font-variant-numeric: tabular-nums;
  }
  .refreshed {
    margin-bottom: 0;
    text-align: right;
  }
  @media (max-width: 52rem) {
    .notifications,
    .calendar {
      grid-column: auto;
    }
  }
  @media (max-width: 640px) {
    .activity-list li {
      flex-direction: column;
    }
    .response {
      justify-content: flex-start;
    }
  }
</style>
