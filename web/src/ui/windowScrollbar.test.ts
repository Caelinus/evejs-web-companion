// A FLOATING WINDOW SCROLLS IN THE APP'S OWN COLOURS, not the platform's.
//
// ⚠ WHAT WENT WRONG. Only two surfaces styled their scrollbars — the dock
// panel's two faces (`.stn-content`, `.spc-content`) — so every desktop window
// whose panel overflowed drew the operating system's bar instead: a light track
// with stepper buttons, down the middle of a near-black frame. It was reported
// on Fleet companions because a roster plus a setup form is the tallest thing
// the desktop holds, but nothing about it was that window's fault; the frame
// every window shares had no scrollbar styling at all.
//
// This reads the real stylesheet off disk, the way squareCorners.test.ts does,
// because the failure is a missing declaration and no render test can see one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
/** Comments describe the rules in prose; only real declarations are inspected. */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the first rule whose selector list matches. */
function ruleFor(selector: string): string | null {
  const at = CSS_NO_COMMENTS.indexOf(selector);
  if (at < 0) return null;
  const open = CSS_NO_COMMENTS.indexOf("{", at);
  const close = CSS_NO_COMMENTS.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return CSS_NO_COMMENTS.slice(open + 1, close);
}

test("the window body asks for a thin scrollbar in the app's palette", () => {
  const rule = ruleFor(".win-body,");
  assert.ok(rule, "the window body's scrollbar rule is gone");
  assert.match(rule, /scrollbar-width:\s*thin/);
  assert.match(rule, /scrollbar-color:\s*var\(--color-/, "the colours must be tokens, not literals");
});

test("and paints the WebKit bar too, track, thumb and corner", () => {
  // `scrollbar-color` alone leaves Chrome's own bar in place on the platforms
  // that still prefer the pseudo-elements, which is where this was reported.
  for (const part of ["scrollbar-track", "scrollbar-thumb", "scrollbar-corner"]) {
    assert.match(
      CSS_NO_COMMENTS,
      new RegExp(`\\.win-body::-webkit-${part}`),
      `nothing paints the ${part}`,
    );
  }
});

test("a table scrolling INSIDE a window is styled with it", () => {
  // A wide table scrolls in its own box; that box is as much part of the window
  // as its edge is, and a native bar inside a themed one is the same fault.
  assert.match(CSS_NO_COMMENTS, /\.win-body \.table-wrap::-webkit-scrollbar-thumb/);
});

test("the sweep would actually catch a missing rule", () => {
  // Keeps every assertion above from passing vacuously: a selector that has
  // never existed must come back empty.
  assert.equal(ruleFor(".win-body-that-does-not-exist,"), null);
});
