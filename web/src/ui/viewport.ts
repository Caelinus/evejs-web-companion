// The one place the mobile breakpoint is written down.
//
// Two components need the same answer for different reasons: Workspace swaps
// its whole desktop for the single-panel MobileWorkspace below it, and App
// decides whether to mount the global window layer at all (there are no
// floating windows on a phone, so there is nothing for that layer to hold).
// Two `matchMedia("(max-width: 720px)")` calls would be two chances to drift,
// and a drift here shows up as a global window floating over a UI that has no
// windows — so the query and the subscription live here once.

/** Below this the UI is the single-panel mobile workspace, not a desktop. */
export const MOBILE_QUERY = "(max-width: 720px)";

/**
 * Subscribe to the mobile breakpoint. Calls `onChange` immediately with the
 * current answer, then on every crossing; returns the unsubscribe.
 *
 * ⚠ IT LISTENS TO `resize` AS WELL AS THE QUERY. That is deliberate and
 * pre-existing (this is Workspace's own effect, lifted): some embedded
 * webviews fire `resize` without re-evaluating a media query listener, and a
 * workspace stuck in the wrong mode is unusable rather than merely wrong.
 *
 * Returns a no-op unsubscribe where there is no `window` at all (SSR renders),
 * having reported `false` — a server render has no viewport, and guessing
 * "phone" there would send every first paint down the mobile path.
 */
export function watchIsMobile(onChange: (isMobile: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    onChange(false);
    return () => {};
  }
  const mq = window.matchMedia(MOBILE_QUERY);
  const update = (): void => onChange(mq.matches);
  update();
  mq.addEventListener("change", update);
  window.addEventListener("resize", update);
  return () => {
    mq.removeEventListener("change", update);
    window.removeEventListener("resize", update);
  };
}
