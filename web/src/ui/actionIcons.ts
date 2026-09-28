// ROW-ACTION GLYPHS — the transport and record verbs, as SVG path data.
//
// WHY ICONS. Run, pause, stop, edit, export and delete are the six verbs with
// genuinely settled international shapes: a player recognises ▶ and ⏸ before
// they have read anything, and a table of rows repeating six words in every
// row is mostly text that says the same thing again. This is the same trade the
// Neocom rail made (see `neocomIcons.ts`), and these are drawn to the same rule
// so the two sets look like one app.
//
// ⚠ AN ICON IS NEVER THE ONLY LABEL, exactly as in the Neocom. Every button
// carries the verb as its ACCESSIBLE NAME and its tooltip, and
// `.icon-btn-label` shows the word inline wherever the row has room for it —
// which is where it matters most, because a tooltip does not exist on a touch
// screen. An icon is an accelerator for someone who already knows the app; it
// must never be the only way to find out what a button does, and it must never
// be the only way to tell a destructive button from a harmless one.
//
// Every path is authored in a 24x24 box and STROKED by the component (round
// caps and joins, no fills), like the Neocom's, so a one-point "path" such as
// `M7 18h.01` renders as a dot.

/** The row actions that have a settled shape. Anything else stays a word. */
export type RowAction =
  | "run-here"
  | "run-on-server"
  | "pause"
  | "resume"
  | "stop"
  | "edit"
  | "export"
  | "delete";

/** One glyph: the primitives to stroke, in a 24x24 box. */
export type ActionGlyph = readonly string[];

/**
 * The glyph for every row action.
 *
 * ⚠ `Record<RowAction, …>`, so a new action is a TYPE ERROR here rather than a
 * button that renders an empty box — the same guarantee `NEOCOM_GLYPHS` gives
 * tabs, and for the same reason: a missing glyph is invisible in review.
 */
export const ACTION_GLYPHS: Readonly<Record<RowAction, ActionGlyph>> = {
  // The play triangle, the one shape nobody has to be taught.
  "run-here": ["M8 5l11 7-11 7z"],
  // Play, over the server rack the Neocom already uses for server-side bots —
  // so the two "start it" buttons are never two identical triangles side by
  // side, which is the failure an icon-only pair invites.
  "run-on-server": ["M9 3l7 4.5-7 4.5z", "M4 14h16v5H4z", "M7 16.5h.01"],
  pause: ["M9 5v14", "M15 5v14"],
  // Resume is play again. Safe to share: pause and resume are the two states of
  // ONE control and are never on screen at the same time.
  resume: ["M8 5l11 7-11 7z"],
  stop: ["M6 6h12v12H6z"],
  // A pencil over its stroke.
  edit: ["M4 20l4-1L18 9l-3-3L5 15z", "M13 7l4 4"],
  // Out of the app and onto your disk: an arrow leaving, over a floor.
  export: ["M12 4v9", "M8 10l4 4 4-4", "M5 19h14"],
  // A bin with a lid and two ribs.
  delete: ["M5 7h14", "M9 7V5h6v2", "M7 7l1 12h8l1-12", "M10 10.5v5", "M14 10.5v5"],
};

/**
 * The word for each action — the accessible name, the tooltip, and the inline
 * label wherever there is room for one. `Record<RowAction, string>` for the
 * same reason as the glyphs: an action with a shape but no word is a button
 * nobody using a screen reader can identify.
 *
 * Plain player language (R9a): "Run here" and "Run on server" name WHERE the
 * bot flies, which is the whole difference between them.
 */
export const ACTION_LABEL: Readonly<Record<RowAction, string>> = {
  "run-here": "Run here",
  "run-on-server": "Run on server",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  edit: "Edit",
  export: "Export",
  delete: "Delete",
};
