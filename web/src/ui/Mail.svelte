<script lang="ts">
  // Mail page (goal R17, Slice A): the inbox, one message's text, and writing
  // to someone.
  //
  // A pure reader of the store's mail slice. Every call lives on the BFF and in
  // app/flow.ts; every identifier is translated to a name in bridge/mail.ts or
  // resolved through the shared name cache before it reaches this file. Nothing
  // here shows a characterID, a messageID or a corporationID (R7d) — a message
  // is identified by who sent it, what it is about and when it arrived.
  //
  // ⚠ THE BODY IS ALREADY PLAIN TEXT. mailMgr.GetBody answers a zlib-DEFLATED
  // buffer; the BFF inflates it (src/server.js, mailBodyText) so this file
  // never handles a compressed byte and no inflate code ships to the browser.
  //
  // ⚠ THE INBOX IS THE WHOLE MAILBOX. It arrives as a delta sync the BFF
  // cold-starts, so there is no paging to build and no "load more".
  import { onMount } from "svelte";
  import {
    MAIL_MAX_BODY,
    MAIL_MAX_TITLE,
    audienceOf,
    checkDraft,
    readFlags,
  } from "../bridge/mail.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CharacterMatch } from "../app/api.ts";
  import type { MailHeaderRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const mail = store.mail;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");
  let tab = $state<"inbox" | "compose">("inbox");

  // Compose state. `recipients` holds the chosen people; the id rides along
  // invisibly so SendMail's args[0] can be built, and only the name is shown.
  let recipients = $state<CharacterMatch[]>([]);
  let personQuery = $state("");
  let personMatches = $state<readonly CharacterMatch[]>([]);
  let searched = $state(false);
  let draftTitle = $state("");
  let draftBody = $state("");

  /** Always a NAME, never an id — and never an id-shaped fallback either. */
  function personName(characterID: number): string {
    return resolvedName($names.resolved, "character", characterID, "someone");
  }

  function ownerName(ownerID: number): string {
    return resolvedName($names.resolved, "corporation", ownerID, "their organisation");
  }

  /** A retail FILETIME as a plain date and time. Never rendered as a number. */
  function whenText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs) || unixMs <= 0) {
      return "—";
    }
    return new Date(unixMs).toLocaleString();
  }

  /** Who a message went to, in words. */
  function audienceText(header: MailHeaderRow): string {
    const audience = audienceOf(header);
    if (audience.kind === "characters") {
      const shown = audience.characterIDs.slice(0, 3).map(personName);
      const extra = audience.characterIDs.length - shown.length;
      return extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
    }
    if (audience.kind === "list") {
      return "a mailing list";
    }
    if (audience.kind === "corporation") {
      return `everyone at ${ownerName(audience.ownerID)}`;
    }
    // ⚠ A real shape: the server does not refuse mail addressed to nobody.
    return "nobody";
  }

  const flags = $derived(readFlags($mail.statuses));

  function isUnread(messageID: number): boolean {
    return flags.get(messageID) === false;
  }

  const openHeader = $derived(
    $mail.open === null
      ? null
      : ($mail.messages.find((row) => row.messageID === $mail.open?.messageID) ?? null),
  );

  const draftCheck = $derived(
    checkDraft({
      recipientIDs: recipients.map((person) => person.characterID),
      title: draftTitle,
      body: draftBody,
    }),
  );

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function searchPeople(): void {
    void run(async () => {
      personMatches = await flow.findCharacters(personQuery);
      searched = true;
    });
  }

  function addRecipient(person: CharacterMatch): void {
    if (!recipients.some((chosen) => chosen.characterID === person.characterID)) {
      recipients = [...recipients, person];
    }
    personQuery = "";
    personMatches = [];
    searched = false;
  }

  function removeRecipient(characterID: number): void {
    recipients = recipients.filter((person) => person.characterID !== characterID);
  }

  /** Opening a message marks it read — the player's own deliberate act. */
  function open(messageID: number): void {
    void run(() => flow.openMail(messageID, isUnread(messageID)));
  }

  function send(): void {
    void run(async () => {
      await flow.sendMail({
        toCharacterIDs: recipients.map((person) => person.characterID),
        title: draftTitle.trim(),
        body: draftBody,
      });
      const outcome = store.get().mail.lastOutcome;
      if (outcome && outcome.applied) {
        recipients = [];
        draftTitle = "";
        draftBody = "";
        tab = "inbox";
      }
    });
  }

  /** Reply: pre-address a new message to whoever wrote, with a Re: subject. */
  function reply(header: MailHeaderRow): void {
    recipients = [{ characterID: header.senderID, name: personName(header.senderID) }];
    draftTitle = header.title.startsWith("Re: ") ? header.title : `Re: ${header.title}`;
    draftBody = "";
    tab = "compose";
  }

  onMount(() => {
    void run(() => flow.loadMail());
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Mail</h2>
    <!-- ⚠ THE COUNT LEAVES THE TITLE RATHER THAN GOING WITH IT. A host that
         already says MAIL clips the title, and the unread badge was INSIDE it —
         so the one fact on this strip that changes would have been hidden by
         the rule that hides the word it sat next to. -->
    {#if $mail.unreadCount > 0}
      <p class="stat-line"><span class="badge accent">{$mail.unreadCount} unread</span></p>
    {/if}
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => void run(() => flow.loadMail())}>
        Check for new mail
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $mail.actionError}
    <p class="error">{$mail.actionError}</p>
  {/if}
  {#if $mail.inboxError}
    <p class="error">Your mail could not be loaded just now.</p>
  {/if}

  {#if $mail.lastOutcome}
    {#if $mail.lastOutcome.applied}
      <p class="note">
        Your message was sent to
        {$mail.lastOutcome.recipientCount === 1
          ? "one person"
          : `${$mail.lastOutcome.recipientCount} people`}.
      </p>
    {:else if $mail.lastOutcome.declinedSilently}
      <!-- ⚠ SendMail answers a bare null with no reason. Say exactly that. -->
      <p class="error">
        {$mail.lastOutcome.message ??
          "The server did not send that message, and did not say why."}
      </p>
    {/if}
  {/if}

  <nav class="tabs">
    <button type="button" class:active={tab === "inbox"} onclick={() => (tab = "inbox")}>
      Inbox
    </button>
    <button type="button" class:active={tab === "compose"} onclick={() => (tab = "compose")}>
      Write a message
    </button>
  </nav>

  {#if tab === "inbox"}
    {#if !$mail.loaded}
      <p class="note">Fetching your mail…</p>
    {:else if $mail.messages.length === 0}
      <p class="empty">You have no mail.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>From</th>
              <th>Subject</th>
              <th>To</th>
              <th>Arrived</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each $mail.messages as header (header.messageID)}
              <tr class:unread={isUnread(header.messageID)}>
                <td data-label="From">{personName(header.senderID)}</td>
                <td data-label="Subject">{header.title || "(no subject)"}</td>
                <td data-label="To">{audienceText(header)}</td>
                <td data-label="Arrived">{whenText(header.sentDate)}</td>
                <td data-label="Status">
                  {isUnread(header.messageID) ? "Unread" : "Read"}
                </td>
                <td data-label="">
                  <div class="row-actions">
                    <button type="button" disabled={busy} onclick={() => open(header.messageID)}>
                      Read it
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => reply(header)}
                    >
                      Reply
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if $mail.open !== null}
      <section class="bulk">
        <h2>{openHeader ? openHeader.title || "(no subject)" : "Message"}</h2>
        {#if openHeader}
          <p class="note">
            From {personName(openHeader.senderID)}, to {audienceText(openHeader)},
            {whenText(openHeader.sentDate)}.
          </p>
        {/if}
        {#if $mail.open.unreadable}
          <!-- The body arrived but would not inflate. Say so; show no garbage. -->
          <p class="error">This message arrived damaged and cannot be read.</p>
        {:else}
          <!-- Already plain text: the BFF inflated the zlib buffer. -->
          <p class="mail-body">{$mail.open.body}</p>
        {/if}
        {#if $mail.open.markedRead === null}
          <p class="note">
            This message could not be marked as read just now, so it may still
            show as unread.
          </p>
        {/if}
        <p class="controls">
          {#if openHeader}
            <button type="button" disabled={busy} onclick={() => reply(openHeader)}>
              Reply
            </button>
          {/if}
          <button type="button" class="minor" disabled={busy} onclick={() => flow.closeMail()}>
            Close
          </button>
        </p>
      </section>
    {/if}
  {:else}
    <section class="bulk">
      <h2>Write a message</h2>

      <p class="controls">
        <label>
          Who to write to
          <input
            type="search"
            bind:value={personQuery}
            placeholder="Search by name"
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                searchPeople();
              }
            }}
          />
        </label>
        <button type="button" disabled={busy || personQuery.trim().length < 2} onclick={searchPeople}>
          Find them
        </button>
      </p>

      {#if personMatches.length > 0}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Name</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each personMatches as person (person.characterID)}
                <tr>
                  <td data-label="Name">{person.name}</td>
                  <td data-label="">
                    <div class="row-actions">
                      <button type="button" disabled={busy} onclick={() => addRecipient(person)}>
                        Add
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if searched && personQuery.trim().length >= 2}
        <p class="empty">Nobody by that name.</p>
      {/if}

      {#if recipients.length > 0}
        <p class="note">
          Sending to:
          {#each recipients as person (person.characterID)}
            <button
              type="button"
              class="minor"
              disabled={busy}
              onclick={() => removeRecipient(person.characterID)}
            >
              {person.name} ✕
            </button>
          {/each}
        </p>
      {/if}

      <p class="controls">
        <label>
          Subject
          <input type="text" maxlength={MAIL_MAX_TITLE} bind:value={draftTitle} />
        </label>
      </p>
      <p class="controls">
        <label class="grow">
          Message
          <textarea rows="8" maxlength={MAIL_MAX_BODY} bind:value={draftBody}></textarea>
        </label>
      </p>

      {#if !draftCheck.ok && (recipients.length > 0 || draftTitle !== "" || draftBody !== "")}
        <p class="error">{draftCheck.message}</p>
      {/if}

      <p class="controls">
        <button type="button" disabled={busy || !draftCheck.ok} onclick={send}>
          Send it
        </button>
        <button
          type="button"
          class="minor"
          disabled={busy}
          onclick={() => {
            recipients = [];
            draftTitle = "";
            draftBody = "";
            tab = "inbox";
          }}
        >
          Never mind
        </button>
      </p>
    </section>
  {/if}
</section>

<style>
  /* Message text keeps the sender's own line breaks and never runs off the
   * side of a phone. */
  .mail-body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* An unread row reads as unread without relying on colour alone. */
  tr.unread td {
    font-weight: 600;
  }
  .badge {
    font-size: 12px;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 0;
    border: 1px solid var(--color-line-strong);
    vertical-align: middle;
  }
  label.grow {
    flex: 1 1 100%;
  }
  textarea {
    width: 100%;
    font: inherit;
    min-height: 8rem;
  }
</style>
