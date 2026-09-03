<script lang="ts">
  // R107 multibox — the whole tab. Several pilots are online at once, each a
  // fully isolated session (its own store + its own per-session-token flow, see
  // app/sessions.ts). This component owns the roster:
  //   • `sessions`  — the ONLINE pilots, one chip each in the character bar,
  //   • `activeId`  — which pilot's cockpit (Workspace) is showing right now,
  //   • `onboarding`— the pilot currently logging in / selecting a character,
  //                   shown full-screen at boot or over the workspace for "Add".
  // Exactly one Workspace is mounted (the active pilot); every other pilot's
  // store+flow stay live in memory and keep refreshing themselves on the BFF, so
  // switching is instant and safe. Login/select and all fetch/decode live
  // elsewhere; this file is pure orchestration.
  import CharacterBar from "./CharacterBar.svelte";
  import Onboarding from "./Onboarding.svelte";
  import PilotHangar from "./PilotHangar.svelte";
  import Workspace from "./Workspace.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { createSession, type Session } from "../app/sessions.ts";
  import type { LaunchEntry, LaunchTarget } from "../app/hangarLaunch.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import {
    loadPersistedSessions,
    savePersistedSessions,
    type PersistedSessions,
  } from "../app/persistedSessions.ts";
  import { setSessionToken, clearSessionToken } from "../app/sessionToken.ts";
  import { getHealth } from "../app/api.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { healthPollIntervalMs, resolveServerStatus } from "../app/serverStatus.ts";
  import type { LiveStreamStatus } from "../store/types.ts";

  // Read the roster retained across a refresh ONCE, before any write effect can
  // clobber it, so a reload can bring the same pilots back online.
  const retained = loadPersistedSessions();
  const hasRetained = retained.pilots.length > 0;

  // The online roster, the active pilot, and the one being added. On a fresh tab
  // the PILOT HANGAR is the landing screen — every pilot this browser knows,
  // grouped by account, with the login behind a modal; when there's a retained
  // roster we restore straight into the cockpit instead.
  //
  // The hangar is not only the boot screen: it stays up over a live cockpit
  // after it launches a batch, so its progress dialog survives the first pilot
  // coming online and its "in client" markers mean something. `onboarding` is
  // still the "Add character" overlay reached from the character bar, which is
  // also where creating a character and stopping a server bot live.
  let sessions = $state<Session[]>([]);
  let activeId = $state<string | null>(null);
  let restoring = $state(hasRetained);
  let hangarOpen = $state(!hasRetained);
  let onboarding = $state<Session | null>(null);

  const active = $derived(sessions.find((s) => s.id === activeId) ?? null);

  // Restore-on-refresh: bring each retained pilot back online by re-signing in
  // (any password) and re-selecting — the same tested path as a manual add, so
  // no token is persisted and a since-expired BFF session just re-selects. Done
  // sequentially: the first sign-in warms a cold gateway, and pilots light up in
  // the bar one at a time. A pilot that can't come back (account gone, character
  // taken, server down) is skipped rather than blocking the rest.
  async function restoreSessions(saved: PersistedSessions): Promise<void> {
    for (const pilot of saved.pilots) {
      const session = createSession();
      try {
        await session.flow.login(pilot.accountName, "");
        await session.flow.selectCharacter(pilot.characterID);
        sessions = [...sessions, session];
        if (activeId === null || pilot.characterID === saved.activeCharacterID) {
          activeId = session.id;
        }
      } catch {
        try {
          await session.flow.logout();
        } catch {
          // best-effort teardown of a half-restored session
        }
      }
    }
    restoring = false;
    // Nothing came back (e.g. the server was down) — fall through to the hangar,
    // which shows the same pilots and can try them again one at a time.
    if (sessions.length === 0) {
      hangarOpen = true;
    }
  }

  // Kick the restore off once, after mount. `retained` is a plain const, so this
  // effect has no reactive dependencies and never re-runs.
  let restoreStarted = false;
  $effect(() => {
    if (restoreStarted) return;
    restoreStarted = true;
    if (hasRetained) void restoreSessions(retained);
  });

  // A pilot finished login+select: promote it from onboarding into the online
  // roster and make it the active cockpit (matches "Add character makes it
  // active", and is the natural landing for the first pilot too).
  function completeOnboarding(): void {
    const s = onboarding;
    if (!s) return;
    sessions = [...sessions, s];
    activeId = s.id;
    onboarding = null;
  }

  // Log another pilot in WITHOUT disturbing the current ones: a fresh isolated
  // session in an overlay. One add at a time.
  function addCharacter(): void {
    if (onboarding) return;
    onboarding = createSession();
  }

  // Abandon an in-progress add: tear the pending session down (best-effort, so a
  // partial BFF login does not linger past its TTL) and drop the overlay.
  function cancelOnboarding(): void {
    const s = onboarding;
    onboarding = null;
    if (s) void s.flow.logout().catch(() => {});
  }

  function switchTo(id: string): void {
    activeId = id;
  }

  // --- the hangar's "bring online" -------------------------------------------
  //
  // The hangar decides WHICH pilots; only this component can create a session,
  // so the doing lives here. It is the restore loop above generalised: sign in
  // (any password), select, keep the session — one pilot at a time, and for the
  // same reason. A browser allows about six connections per origin, and six
  // simultaneous sign-ins fill that pool with sign-ins, so the seventh request
  // of any kind waits behind them. Sequentially, each pilot also LANDS
  // separately, which is what makes the progress dialog honest: a row flips
  // because that pilot is actually in the client, not because a timer fired.
  //
  // A pilot that cannot come online (already flown by a bot, account gone,
  // server down) is reported and skipped. One refusal must not strand the rest
  // of a squad.
  function launchFailureWords(cause: unknown): string {
    if (cause instanceof BridgeCallError) {
      if (cause.code === "UNKNOWN_EVEJS_ACCOUNT") return "account is gone";
      if (cause.code === "CALL_REFUSED") return cause.message;
      return panelErrorWords(cause);
    }
    return "could not connect";
  }

  async function bringOnline(
    targets: readonly LaunchTarget[],
    onProgress: (characterID: number, state: LaunchEntry["state"], note?: string) => void,
  ): Promise<void> {
    for (const target of targets) {
      onProgress(target.characterID, "connecting");
      const session = createSession();
      try {
        await session.flow.login(target.accountName, "");
        await session.flow.selectCharacter(target.characterID);
        sessions = [...sessions, session];
        // The first pilot up becomes the cockpit behind the hangar, so "Go to
        // first pilot" has somewhere to land and closing the hangar is not a
        // blank page.
        if (activeId === null) activeId = session.id;
        onProgress(target.characterID, "online");
      } catch (cause) {
        try {
          await session.flow.logout();
        } catch {
          // best-effort teardown of a half-started session
        }
        onProgress(target.characterID, "failed", launchFailureWords(cause));
      }
    }
  }

  /** Show one pilot's cockpit and leave the hangar. */
  function goToPilot(characterID: number): void {
    const match = sessions.find((s) => s.store.station.get().online?.characterID === characterID);
    if (match) activeId = match.id;
    hangarOpen = false;
  }

  // The characters already live in this tab, so the "Add character" picker can
  // disable a quick-add that would just be refused as "already in use". Kept in
  // sync by the same station subscriptions that drive pruning, below.
  let onlineIDs = $state<Set<number>>(new Set());
  function recomputeOnline(): void {
    const ids = new Set<number>();
    for (const s of sessions) {
      const on = s.store.station.get().online;
      if (on) ids.add(on.characterID);
    }
    onlineIDs = ids;
  }

  // Remove a pilot the instant its store reports offline — release, logout, or a
  // lost session from inside its own workspace. Re-fix the active cockpit, and if
  // the tab is now empty, drop back to a fresh full-screen login.
  function removeSession(id: string): void {
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === sessions.length) return;
    sessions = remaining;
    if (activeId === id) {
      activeId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    }
    if (remaining.length === 0 && onboarding === null) {
      hangarOpen = true;
    }
  }

  // Watch every online pilot's station slice; when one goes offline, prune it.
  // Re-subscribes when the roster changes. The signal fires synchronously with
  // the current value on subscribe, which for an online pilot is a no-op, so
  // this never prunes a pilot that is still live.
  $effect(() => {
    const unsubs = sessions.map((s) =>
      s.store.station.subscribe((slice) => {
        if (slice.online === null) removeSession(s.id);
        recomputeOnline();
      }),
    );
    recomputeOnline();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  // Retain the online roster (account + character + which is active, NO token)
  // across a refresh. Fires on roster / active-pilot changes, not on every
  // in-store tick. Skipped while restoring so a transient empty roster can't
  // clobber the one we are still bringing back — and `retained` was already read
  // into a const above, so even a stray write is harmless.
  $effect(() => {
    const roster = sessions;
    const current = activeId;
    if (restoring) return;
    const pilots = roster
      .map((s) => {
        const snapshot = s.store.get();
        return snapshot.station.online && snapshot.session.username
          ? { accountName: snapshot.session.username, characterID: snapshot.station.online.characterID }
          : null;
      })
      .filter((p): p is { accountName: string; characterID: number } => p !== null);
    const activeCharacterID =
      roster.find((s) => s.id === current)?.store.get().station.online?.characterID ?? null;
    savePersistedSessions({ pilots, activeCharacterID });
  });

  // One live push (SSE) connection per TAB, held by the active pilot. Roster
  // sessions are created with livePush OFF (see app/sessions.ts): an open
  // EventSource occupies one of the browser's ~6 per-origin connections for
  // its whole life, so letting every pilot keep one starved the pool and hung
  // the 7th pilot's login/select in the browser queue. Background pilots keep
  // refreshing themselves over ordinary reads (every bridge response carries
  // its notification drain); the switched-to pilot re-attaches here.
  // ⚠ TWO SEPARATE THINGS, DRIVEN FROM ONE CONDITION. Push is about which pilot
  // holds the tab's one EventSource; foreground is about which pilot wins a
  // request lane when they compete. A background pilot's bot keeps working —
  // that is the point of multibox — but the browser's ~6 connections per origin
  // do not multiply with the roster, so its calls yield to the pilot on screen.
  $effect(() => {
    for (const s of sessions) {
      const isActive = s.id === activeId;
      s.flow.setLivePush(isActive);
      s.flow.setForeground(isActive);
    }
  });

  // R107 — mirror the ACTIVE pilot's token into the per-tab global. A few panels
  // still call the API WITHOUT per-session options — the Bot Builder's
  // create/update/list/deleteBotScript and iconCache's admin routes — and those
  // fall back to this global. Multibox otherwise leaves it empty, so before this
  // they rode the leftover login COOKIE (the last pilot added) and saved/read a
  // DIFFERENT account's bot scripts than the one on screen. Pointing the global
  // at the active pilot makes those legacy calls act as the pilot you're looking
  // at. Per-session flows are unaffected — they carry their own token on
  // callOptions and never read the global.
  $effect(() => {
    const token = active?.flow.sessionToken() ?? null;
    if (token) setSessionToken(token);
    else clearSessionToken();
  });

  // Server connection status for the character bar.
  //
  // The ACTIVE pilot's push stream is the primary signal; the /api/health poll
  // is the fallback for when there is no stream (character select) or it is not
  // carrying. See app/serverStatus.ts for why: the poll runs at the lowest
  // priority in a four-lane transport, so under load the page starved its own
  // health ping and reported a healthy server as offline — which is why the
  // companion "disconnected" with two clients as readily as with twelve.
  // Subscribed explicitly rather than with `$store`: which pilot is active
  // changes, so the signal being read changes with it, and there is no signal at
  // all on the character-select screen. `subscribe` returns its unsubscriber,
  // which is exactly what $effect wants for cleanup.
  let liveStatus = $state<LiveStreamStatus>("idle");
  $effect(() => {
    const signal = active?.store.live;
    if (!signal) {
      liveStatus = "idle";
      return;
    }
    return signal.subscribe((value) => {
      liveStatus = value.status;
    });
  });

  // Last health answer: null until one arrives. Kept separate from the rendered
  // status so the stream can override it without destroying it.
  let healthReady = $state<boolean | null>(null);
  const serverStatus = $derived(resolveServerStatus({ live: liveStatus, healthReady }));

  $effect(() => {
    // Re-armed when the stream state changes, so the cadence follows it.
    const intervalMs = healthPollIntervalMs(liveStatus);
    let cancelled = false;
    const ping = async (): Promise<void> => {
      try {
        const { ready } = await getHealth({ priority: "poll" });
        if (!cancelled) healthReady = ready;
      } catch {
        if (!cancelled) healthReady = false;
      }
    };
    // ⚠ GUARDED. This one is mounted for the WHOLE session, so an unguarded
    // beat every ten seconds is the fastest way this client has of filling the
    // browser's connection pool with stalled requests when the server slows —
    // and it is the requests it steals sockets from that visibly fail. See
    // app/skipWhileBusy.ts.
    const beat = skipWhileBusy(ping);
    void beat();
    const handle = setInterval(() => void beat(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  });
</script>

{#if active}
  <ErrorBoundary name="Character bar">
    <CharacterBar {sessions} {activeId} {serverStatus} onSwitch={switchTo} onAdd={addCharacter} />
  </ErrorBoundary>
  <!-- Remount on switch: each Workspace binds one stable store/flow for its
       whole life, and the in-memory store makes the remount instant. -->
  {#key active.id}
    <!-- The outermost net. Every panel and every piece of chrome has its own
         boundary inside; this one only catches what escapes them all, so one
         pilot's cockpit can never take the character bar down with it. -->
    <ErrorBoundary name="Cockpit">
      <Workspace store={active.store} flow={active.flow} {sessions} />
    </ErrorBoundary>
  {/key}
{:else if restoring}
  <!-- Refresh restore in flight and no cockpit up yet: bringing pilots back. -->
  <h1>EveJS Web</h1>
  <p class="restoring-note">Restoring your pilots…</p>
{/if}

{#if hangarOpen}
  <!-- The Pilot Hangar. It is the landing screen when nothing is online, and it
       stays over a live cockpit after it launches a batch so its progress
       dialog is not torn down by the first pilot arriving. Its own boundary:
       the hangar can fail without taking the cockpit underneath with it. -->
  <ErrorBoundary name="Pilot hangar">
    <PilotHangar
      {onlineIDs}
      onLaunch={bringOnline}
      onGoToFirst={goToPilot}
      onClose={active ? () => (hangarOpen = false) : null}
    />
  </ErrorBoundary>
{/if}

{#if onboarding}
  {#if active}
    <!-- Add character: an overlay over the live workspace, which keeps running. -->
    <div class="onboarding-overlay">
      <div class="onboarding-frame">
        <div class="onboarding-frame-head">
          <span class="onboarding-frame-title">Add character</span>
          <button type="button" class="minor" onclick={cancelOnboarding}>Cancel</button>
        </div>
        <Onboarding store={onboarding.store} flow={onboarding.flow} {onlineIDs} onOnline={completeOnboarding} />
      </div>
    </div>
  {:else}
    <!-- No cockpit behind it (the hangar handed us a session that then went
         away): a full-screen login, nothing behind it. -->
    <h1>EveJS Web</h1>
    <Onboarding store={onboarding.store} flow={onboarding.flow} {onlineIDs} onOnline={completeOnboarding} />
  {/if}
{/if}
