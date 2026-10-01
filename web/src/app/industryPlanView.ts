// WHERE YOU WERE IN THE INDUSTRY MANAGER (R109 slice 3) — which saved plan was
// open, and which tree nodes you folded or unfolded by hand. Browser-local on
// purpose, as app/piPlanView.ts is for PI: the plan lives on the server; how
// you like to look at it is this browser's business.
//
// Folds are kept by IndustryNode.key — the type ids on the path from the target
// — which does not move when stock or choices do. Only HAND overrides are kept:
// a node nobody touched follows the default depth, so a new branch appearing
// under a plan opens the way every other one did.

export interface IndustryPlanView {
  /** The plan open when the window was last used, or null. */
  readonly openID: string | null;
  /** planID -> tree key -> unfolded (true) or folded (false) by hand. */
  readonly folds: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export const EMPTY_INDUSTRY_PLAN_VIEW: IndustryPlanView = Object.freeze({
  openID: null,
  folds: Object.freeze({}),
});

const STORAGE_KEY = "evejs-web-industry-plan-view:v1";
/** More folds than anyone makes by hand; a cap against a runaway store. */
const MAX_FOLDS_PER_PLAN = 300;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface IndustryPlanViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): IndustryPlanViewStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: IndustryPlanViewStorage | null }).localStorage;
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage — treat as unavailable.
  }
  return null;
}

let storage: IndustryPlanViewStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setIndustryPlanViewStorage(next: IndustryPlanViewStorage | null): void {
  storage = next;
}

function foldMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, open] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_FOLDS_PER_PLAN) break;
    if (key.length > 0 && typeof open === "boolean") {
      out[key] = open;
      count += 1;
    }
  }
  return out;
}

export function loadIndustryPlanView(): IndustryPlanView {
  if (!storage) return EMPTY_INDUSTRY_PLAN_VIEW;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_INDUSTRY_PLAN_VIEW;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_INDUSTRY_PLAN_VIEW;
    const o = parsed as Record<string, unknown>;
    const folds: Record<string, Record<string, boolean>> = {};
    if (o.folds && typeof o.folds === "object" && !Array.isArray(o.folds)) {
      for (const [planID, value] of Object.entries(o.folds as Record<string, unknown>)) {
        const map = foldMap(value);
        if (Object.keys(map).length > 0) folds[planID] = map;
      }
    }
    return { openID: typeof o.openID === "string" && o.openID.length > 0 ? o.openID : null, folds };
  } catch {
    return EMPTY_INDUSTRY_PLAN_VIEW;
  }
}

/** Best-effort: a full or blocked store is never fatal. */
export function saveIndustryPlanView(view: IndustryPlanView): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // A quota or a privacy mode. The window keeps working on the in-memory copy.
  }
}

export function withOpenIndustryPlan(view: IndustryPlanView, planID: string | null): IndustryPlanView {
  return view.openID === planID ? view : { ...view, openID: planID };
}

/** Record one plan's hand folds; an empty map forgets them. */
export function withFolds(view: IndustryPlanView, planID: string, folds: Readonly<Record<string, boolean>>): IndustryPlanView {
  const next = { ...view.folds };
  const map = foldMap(folds);
  if (Object.keys(map).length === 0) delete next[planID];
  else next[planID] = map;
  return { ...view, folds: next };
}

/** Drop whatever belongs to plans that no longer exist. Called with the server's list. */
export function pruneIndustryPlanView(view: IndustryPlanView, planIDs: readonly string[]): IndustryPlanView {
  const alive = new Set(planIDs);
  const folds: Record<string, Readonly<Record<string, boolean>>> = {};
  for (const [planID, map] of Object.entries(view.folds)) {
    if (alive.has(planID)) folds[planID] = map;
  }
  return { openID: view.openID !== null && alive.has(view.openID) ? view.openID : null, folds };
}
