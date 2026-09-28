// The Bot Manager library's PURE VIEW LAYER — filtering, authorship and
// "last saved" wording, with no component, no fetch and no clock of its own.
//
// WHY IT IS ITS OWN MODULE. The panel loads the library into local state from
// `listBotScripts`, and the SSR test harness never runs `onMount`, so anything
// computed inside the component is only reachable by faking a load. Rather than
// open a test-only seam on the panel's props, the parts worth testing live
// here, as this codebase does elsewhere (tabs.ts, desktop.ts, macroCatalogView.ts):
// a pure core unit-tested without a DOM, and a thin component that renders it.
//
// `now` is always passed in, never read from Date.now() in here — a function
// that reads the clock cannot be pinned by a test without freezing time.

import type { BotScriptSummary } from "../app/api.ts";

/** What a row shows for "saved by" — R7d: the NAME, never the account id. */
export function savedByLabel(script: BotScriptSummary): string {
  const name = script.authorName;
  if (name === null || name.trim().length === 0) {
    // Bots saved before the library went platform-wide carry no author. An
    // em-dash says "not recorded"; a blank cell would read as a rendering bug.
    return "—";
  }
  return name;
}

/**
 * The rows matching `query`, searched over the bot's name AND its author, so
 * "who saved the mining ones" is one search rather than two. An empty or
 * whitespace-only query matches everything.
 */
export function filterLibrary(
  scripts: readonly BotScriptSummary[],
  query: string,
): readonly BotScriptSummary[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return scripts;
  }
  return scripts.filter((script) => {
    const author = (script.authorName ?? "").toLowerCase();
    return script.name.toLowerCase().includes(q) || author.includes(q);
  });
}

/**
 * How long ago a bot was last saved, in words. Relative because "4 minutes ago"
 * is what a player wants; a clock time would need a timezone this readout does
 * not have. An unparseable timestamp says so rather than rendering "NaN ago".
 */
export function lastSavedPhrase(updatedAt: string, nowMs: number): string {
  const atMs = Date.parse(updatedAt);
  if (Number.isNaN(atMs)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Which of the three honest states the list is in. Kept here so the rule is
 * testable and stated once: a FAILED READ IS NEVER "no bots saved" — collapsing
 * those two is how a player concludes their library was wiped when the server
 * merely blinked.
 */
export type LibraryView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "no-matches" }
  | { readonly kind: "rows"; readonly rows: readonly BotScriptSummary[] };

export function libraryView(
  loaded: boolean,
  error: string | null,
  scripts: readonly BotScriptSummary[],
  query: string,
): LibraryView {
  if (error !== null) {
    return { kind: "error", message: error };
  }
  if (!loaded) {
    return { kind: "loading" };
  }
  if (scripts.length === 0) {
    return { kind: "empty" };
  }
  const rows = filterLibrary(scripts, query);
  if (rows.length === 0) {
    return { kind: "no-matches" };
  }
  return { kind: "rows", rows };
}
