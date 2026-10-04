<script lang="ts">
  import type { AcquisitionReview, AcquisitionOutcome, FundingPolicy } from "../training/types.ts";
  import { formatIsk } from "./isk.ts";
  let { review, outcome, busy, mode, stage, officers, message, trainingWallet = null, targetName = (id: string) => id, onReview, onAcquire, onChange }:
    { review: AcquisitionReview | null; outcome: AcquisitionOutcome | null; busy: boolean; mode: string; stage: string | null;
      officers: readonly { key: string; label: string }[]; message: string; trainingWallet?: { corporationID: number; accountKey: number } | null; targetName?: (id: string) => string;
      onReview: (policy: FundingPolicy, officer: string, division: number) => void;
      onAcquire: () => void; onChange: () => void } = $props();
  let policy = $state<FundingPolicy>("CHARACTER_WALLET_ONLY");
  let officer = $state("SELF");
</script>
<section class="acquisition" aria-label="Skill acquisition">
  <h3>Direct skill acquisition · {mode} → {stage ?? "Unknown"}</h3>
  <p>Direct purchase is unavailable on stock EveJS web gateway. Inject skillbooks in the game client, then refresh Training and review the queue.</p>
  <label>Funding policy <select bind:value={policy} disabled={busy} onchange={onChange}>
    <option value="CHARACTER_WALLET_ONLY">Character wallet only</option>
    <option value="CHARACTER_PLUS_CORPORATION_SHORTFALL">Character wallet + corporation shortfall</option>
  </select></label>
  {#if policy === "CHARACTER_PLUS_CORPORATION_SHORTFALL"}
    <label>Funding authority <select bind:value={officer} disabled={busy} onchange={onChange}>
      <option value="SELF">Trainee self-funding · Account Take required</option>
      {#each officers as row}<option value={row.key}>{row.label}</option>{/each}
    </select></label>
    <p>Training wallet: {trainingWallet ? `Corporation ${trainingWallet.corporationID} · Division ${trainingWallet.accountKey - 999} (${trainingWallet.accountKey})` : "UNCONFIGURED — save a training wallet in settings first."}</p>
    <p>Review verifies Account Take permission and corporation. Fallback requires an explicitly selected non-CEO officer; no CEO is acquired.</p>
  {/if}
  <button type="button" disabled title="Stock web gateway purchase authority is unavailable">Review missing skill acquisition</button>
  {#if message}<p role="status">{message}</p>{/if}
  {#if review}
    <h4>Reviewed {review.mode} → {targetName(review.stage)}</h4>
    <ul>{#each review.skills as skill}<li>{skill.name} · {formatIsk(skill.price)}</li>{/each}</ul>
    <dl>
      <dt>Total purchase</dt><dd>{formatIsk(review.total)}</dd>
      <dt>Character wallet</dt><dd>{formatIsk(review.personalBalance)}</dd>
      <dt>Shortfall</dt><dd>{formatIsk(review.shortfall)}</dd>
      {#if review.funding}
        <dt>Funding source</dt><dd>Authority {review.funding.characterID} · Corporation {review.funding.corporationID} · Division {review.funding.division - 999}</dd>
        <dt>Division balance</dt><dd>{formatIsk(review.funding.balance)}</dd>
      {/if}
    </dl>
    <p>Actions: {#if review.funding}transfer exactly {formatIsk(review.shortfall)}, then {/if}buy the listed skills, verify skills, release temporary sessions.</p>
    <p>Purchase and funding are separate server operations. If purchase fails after funding, remaining ISK stays with the trainee. No automatic retry or rollback.</p>
    {#each review.blockers as blocker}<p class="error">{blocker}</p>{/each}
    {#each review.cleanup.filter((row) => !row.released) as row}<p class="error">{row.code}: pilot {row.characterID}</p>{/each}
    <button type="button" disabled title="Stock web gateway purchase authority is unavailable">Acquire missing skills · {review.mode} → {targetName(review.stage)}</button>
  {/if}
  {#if outcome}
    <h4>Last acquisition · {outcome.mode} → {targetName(outcome.stage)}</h4>
    <p>{outcome.status} · Verified: {outcome.verified ? "yes" : "no"} · {new Date(outcome.at).toLocaleString()}</p>
    <p>{outcome.message} {outcome.errorCode ?? ""}</p>
    <p>Skills confirmed: {outcome.purchased?.length ?? "unknown"} · Corporation funded: {formatIsk(outcome.funded ?? null)} · Remaining wallet: {formatIsk(outcome.wallet ?? null)}</p>
    {#each outcome.cleanup as row}<p>Pilot {row.characterID}: {row.released ? "Factory session released" : "FACTORY_SESSION_RELEASE_FAILED — refresh ownership before retrying"}</p>{/each}
    {#if outcome.readyForQueueReview}<p>READY FOR QUEUE REVIEW. Review and apply the training plan separately.</p>{/if}
  {/if}
</section>
<style>
  .acquisition { margin-top: 1.2rem; padding: 1rem; border: 1px solid #455569; border-radius: 6px; }
  p { max-width: 85ch; } label { display: flex; gap: .6rem; margin: .7rem 0; flex-wrap: wrap; }
  select { background: #16202e; color: #e4edf7; padding: .4rem; } dt { opacity: .7; } dd { margin: .2rem 0 .6rem; }
  .error { color: #ffa3a3; }
</style>
