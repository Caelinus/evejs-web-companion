// The desktop window model (the "always-open desktop" refactor): which panels
// are open as floating windows, where each sits, its stacking order, and whether
// it has been put away. Pure data + reducers so the rules are
// unit-testable without a DOM — DesktopWindow.svelte owns only the pointer math
// and bounds clamping that genuinely needs the element.
//
// ONE window per TabID (single instance): opening an already-open panel focuses
// it rather than duplicating. `station` and `overview` are deliberately NOT
// windows — they are the fixed top-right dock panel — so they never enter this
// model (App drops them; loadLayout filters them out).

import { TABS, type TabID } from "./tabs.ts";

export interface WinState {
  readonly id: TabID;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  /**
   * Put away — not drawn at all, and reachable only from the window strip.
   *
   * ⚠ THERE USED TO BE A SECOND HIDE BESIDE THIS ONE, and it is gone at the
   * operator's call. `collapsed` shaded a window down to its title bar; the
   * redesign added this one, and for a while both shipped because they are
   * genuinely different acts — shading keeps a window you are still watching
   * where you put it, putting away gets it out of the way entirely.
   *
   * Two ways to get a window out of the way is still one too many, and the
   * shade is the weaker of the two: it goes on occupying the desktop, goes on
   * overlapping whatever is under it, and leaves a stub the player has to find
   * again. A chip in the strip is a better handle than a floating stub. So `—`,
   * the glyph a player already reads as "minimize", is this.
   *
   * ⚠ AND A PUT-AWAY WINDOW MUST ALWAYS HAVE A WAY BACK. It is hidden, not
   * closed, so the strip lists it and the launcher rail still counts it as
   * open. A hide with no visible handle is a window the player has lost.
   */
  readonly minimized: boolean;
}

export const MIN_W = 260;
export const MIN_H = 120;
export const DEFAULT_W = 520;
export const DEFAULT_H = 440;
const CASCADE_STEP = 28;
const CASCADE_ORIGIN = 16;

// Panels that are fixed chrome (the top-right dock), never floating windows.
//
// ⚠ EMPTY, AND THAT IS THE POINT NOW. Both halves of the dock frame are their
// own components with no TabID at all — `StationPanel` docked, `SpaceOverview`
// in space — so neither can be opened as a window by construction rather than
// by being listed here.
//
// `overview` used to be listed: it WAS the in-space dock panel. It became a
// window for one phase, while the old cockpit was taken apart section by
// section — and then that file was deleted and the tab with it. Every section
// it held has its own home now, so there is nothing left for this set to name.
const CHROME_TABS = new Set<TabID>([]);

/** True when this tab opens as a floating window (i.e. is not fixed chrome). */
export function isWindowTab(id: TabID): boolean {
  return !CHROME_TABS.has(id);
}

/** The highest z among open windows (0 when none). */
export function topZ(wins: readonly WinState[]): number {
  return wins.reduce((max, w) => (w.z > max ? w.z : max), 0);
}

/**
 * The id of the front-most window, or null when nothing is on screen.
 *
 * ⚠ A MINIMIZED WINDOW IS NEVER THE FRONT ONE. It is not drawn, so calling it
 * focused would light its entry in the launcher rail and put the focus ring on
 * something the player cannot see.
 */
export function focusedId(wins: readonly WinState[]): TabID | null {
  let front: WinState | null = null;
  for (const w of wins) {
    if (w.minimized) continue;
    if (front === null || w.z > front.z) front = w;
  }
  return front ? front.id : null;
}

/** A cascade offset for the Nth new window so fresh windows don't stack exactly. */
function cascadeAt(n: number): number {
  return CASCADE_ORIGIN + (n % 8) * CASCADE_STEP;
}

/**
 * Open a panel as a window, or focus it if already open. New windows land at a
 * cascade position with the default size and on top. Focusing raises z and
 * un-collapses (opening from the launcher should always reveal the panel).
 * Chrome tabs (station/overview) are never opened as windows.
 */
export function openWindow(
  wins: readonly WinState[],
  id: TabID,
  size?: { readonly w?: number; readonly h?: number },
): WinState[] {
  if (!isWindowTab(id)) return wins.slice();
  const z = topZ(wins) + 1;
  const existing = wins.find((w) => w.id === id);
  if (existing) {
    // Opening from the launcher must always REVEAL the panel — so it un-shades
    // and un-hides, not just raises. Picking a rail entry and watching nothing
    // happen because the window was minimized is the whole bug this prevents.
    return wins.map((w) => (w.id === id ? { ...w, z, minimized: false } : w));
  }
  const next: WinState = {
    id,
    x: cascadeAt(wins.length),
    y: cascadeAt(wins.length),
    w: size?.w ?? DEFAULT_W,
    h: size?.h ?? DEFAULT_H,
    z,
    minimized: false,
  };
  return [...wins, next];
}

/** Raise a window to the top of the stack. No-op if already on top or absent. */
export function focusWindow(wins: readonly WinState[], id: TabID): WinState[] {
  const w = wins.find((x) => x.id === id);
  if (!w || w.z === topZ(wins)) return wins.slice();
  const z = topZ(wins) + 1;
  return wins.map((x) => (x.id === id ? { ...x, z } : x));
}

export function closeWindow(wins: readonly WinState[], id: TabID): WinState[] {
  return wins.filter((w) => w.id !== id);
}

export function moveWindow(wins: readonly WinState[], id: TabID, x: number, y: number): WinState[] {
  return wins.map((w) => (w.id === id ? { ...w, x: Math.round(x), y: Math.round(y) } : w));
}

export function resizeWindow(wins: readonly WinState[], id: TabID, w: number, h: number): WinState[] {
  const cw = Math.max(MIN_W, Math.round(w));
  const ch = Math.max(MIN_H, Math.round(h));
  return wins.map((win) => (win.id === id ? { ...win, w: cw, h: ch } : win));
}


/**
 * Put a window away, or bring it back. Coming back also raises it: a window
 * restored under three others would look like nothing happened.
 */
export function toggleMinimize(wins: readonly WinState[], id: TabID): WinState[] {
  const z = topZ(wins) + 1;
  return wins.map((w) =>
    w.id === id ? { ...w, minimized: !w.minimized, z: w.minimized ? z : w.z } : w,
  );
}

// ── persistence: per-character desktop layout in localStorage ──────────────

export const DEFAULT_DOCK_WIDTH = 340;
const MIN_DOCK_WIDTH = 240;

// The floating "Locked targets" panel's default spot (top-left of the work area).
export const DEFAULT_TARGETS_POS = { x: 20, y: 12 };

export interface DesktopLayout {
  readonly wins: readonly WinState[];
  readonly dockCollapsed: boolean;
  readonly dockWidth: number;
  readonly targetsX: number;
  readonly targetsY: number;
  /**
   * The player asked the docked Station panel to take the whole work area.
   *
   * ⚠ A PREFERENCE, NOT A STATE. It is remembered even while the pilot is in
   * space, where it means nothing — Workspace DERIVES the real flag as
   * `isDocked && this`, so undocking can never leave somebody in space with the
   * desktop and the HUD hidden. Storing the preference is what makes the panel
   * come back expanded on the next dock.
   */
  readonly stationExpanded: boolean;
}

const STORAGE_VERSION = 1;
const KNOWN_TABS = new Set<string>(TABS.map((t) => t.id));

const storageKey = (characterID: number): string =>
  `evejs-web-desktop:v${STORAGE_VERSION}:${characterID}`;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isWinState(v: unknown): v is WinState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    KNOWN_TABS.has(o.id) &&
    isWindowTab(o.id as TabID) &&
    isFiniteNumber(o.x) &&
    isFiniteNumber(o.y) &&
    isFiniteNumber(o.w) &&
    isFiniteNumber(o.h) &&
    isFiniteNumber(o.z)
    // ⚠ `minimized` is deliberately NOT required. Every layout saved before it
    // existed lacks the field, and demanding it would throw away every window
    // those players had open. It is read as `=== true` below instead.
    //
    // ⚠ NOR IS `collapsed`, AND IT USED TO BE. Layouts written while the shade
    // existed still carry it; requiring it would now reject every one of those,
    // and rejecting a layout throws away the windows a player had open. An
    // unknown field is simply ignored — which is what makes dropping a field
    // safe in a way that adding one is not.
  );
}

/** Read a saved layout for a character; null when none/unusable/unavailable. */
export function loadLayout(characterID: number): DesktopLayout | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(characterID));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    // ONE window per TabID is this model's core invariant, and the reducers all
    // keep it — but storage is not a reducer. A layout saved by any build that
    // ever let a tab in twice comes back with a duplicate id and Desktop's
    // keyed `{#each ... (win.id)}` throws on every render from then on, for
    // good, because the bad layout is written back on the next change. First
    // one wins; the rest are dropped on the way in.
    const seen = new Set<TabID>();
    const wins = (Array.isArray(o.wins) ? o.wins.filter(isWinState) : [])
      .filter((w) => {
        if (seen.has(w.id)) return false;
        seen.add(w.id);
        return true;
      })
      // ⚠ REBUILT FIELD BY FIELD, NOT SPREAD. A stale key that rides in on a
      // `{ ...w }` is a key that gets written straight back out on the next
      // save and lives forever — `collapsed` is exactly that, left behind by
      // every layout saved while the window shade existed. Naming the fields is
      // what makes REMOVING one actually remove it.
      //
      // `minimized` is absent in every layout written before the window strip,
      // and `=== true` is what makes that read as "on screen" rather than
      // throwing a returning player's whole desktop into the strip.
      .map((w) => ({
        id: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        minimized: (w as { minimized?: unknown }).minimized === true,
      }));
    const dockWidth =
      typeof o.dockWidth === "number" && o.dockWidth >= MIN_DOCK_WIDTH ? o.dockWidth : DEFAULT_DOCK_WIDTH;
    const targetsX = isFiniteNumber(o.targetsX) ? o.targetsX : DEFAULT_TARGETS_POS.x;
    const targetsY = isFiniteNumber(o.targetsY) ? o.targetsY : DEFAULT_TARGETS_POS.y;
    return {
      wins,
      dockCollapsed: o.dockCollapsed === true,
      dockWidth,
      targetsX,
      targetsY,
      // Absent in every layout saved before the expand toggle existed, and
      // `=== true` is what makes that read as "not expanded" rather than throw.
      stationExpanded: o.stationExpanded === true,
    };
  } catch {
    return null;
  }
}

/** Persist a character's desktop layout. Best-effort (storage may be blocked). */
export function saveLayout(characterID: number, layout: DesktopLayout): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(characterID), JSON.stringify(layout));
  } catch {
    // storage full or blocked — layout persistence is best-effort, never fatal.
  }
}
