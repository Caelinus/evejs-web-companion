// The row-action glyph set, checked the way the Neocom's is: a shape and a
// word for every action, and no shape that renders as an empty box.
//
// The point of the `Record<RowAction, …>` tables is that a MISSING entry is a
// compile error. What a compiler cannot see is an entry that exists and is
// useless — an empty path list, a blank label — so that is what this covers.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { ACTION_GLYPHS, ACTION_LABEL } = await import("./actionIcons.ts");
const { render } = await import("svelte/server");
const ActionButton = (await import("./ActionButton.svelte")).default;

const ACTIONS = Object.keys(ACTION_GLYPHS) as (keyof typeof ACTION_GLYPHS)[];

test("there are actions to check, so the sweep below is not vacuous", () => {
  assert.ok(ACTIONS.length >= 6, `expected the six settled verbs, found ${ACTIONS.length}`);
});

test("every action has a glyph that will actually draw something", () => {
  for (const action of ACTIONS) {
    const glyph = ACTION_GLYPHS[action];
    assert.ok(glyph.length > 0, `${action} has no path data — it would render an empty box`);
    for (const d of glyph) {
      assert.match(d, /^M/, `${action} has a path that does not start with a move: ${d}`);
    }
  }
});

test("every action has a plain-language word, and no word is a raw token (R9a)", () => {
  for (const action of ACTIONS) {
    const label = ACTION_LABEL[action];
    assert.ok(label.trim().length > 0, `${action} has no word`);
    assert.ok(!/[_]/.test(label), `underscore in label: ${label}`);
    assert.ok(!/^[a-z]+(-[a-z]+)+$/.test(label), `looks like a raw token: ${label}`);
  }
});

test("the two ways to start a bot do not share a shape", () => {
  // An icon-only pair of identical triangles is the failure this set exists to
  // avoid: "here" and "on the server" are the whole difference between them.
  assert.notDeepEqual(ACTION_GLYPHS["run-here"], ACTION_GLYPHS["run-on-server"]);
});

test("a button carries its word three ways, so the icon is never the only label", () => {
  for (const action of ACTIONS) {
    const html = render(ActionButton as never, { props: { action, onclick: () => {} } } as never).body;
    const word = ACTION_LABEL[action];
    assert.match(html, new RegExp(`aria-label="${word}"`), `${action} has no accessible name`);
    assert.match(html, new RegExp(`title="${word}"`), `${action} has no tooltip`);
    assert.match(
      html,
      new RegExp(`<span class="icon-btn-label">${word}</span>`),
      `${action} has no inline label — a tooltip does not exist on a touch screen`,
    );
    assert.match(html, /<svg[^>]*aria-hidden="true"/, `${action}'s glyph is not hidden from screen readers`);
  }
});

test("a state label overrides the word without changing the shape", () => {
  // "Deleting…" is still the delete button; the action has not changed.
  const html = render(ActionButton as never, {
    props: { action: "delete", label: "Deleting…", onclick: () => {} },
  } as never).body;
  assert.match(html, /aria-label="Deleting…"/);
  assert.match(html, /Deleting…<\/span>/);
  for (const d of ACTION_GLYPHS["delete"]) {
    assert.ok(html.includes(d), "the glyph changed when only the word should have");
  }
});

test("the button renders no image, so R27 still holds", () => {
  // Inline SVG, never an <img>: TypeIcon.svelte is the only component in the
  // app allowed to render a picture, and `typeIcon.test.ts` enforces it.
  const html = render(ActionButton as never, { props: { action: "edit", onclick: () => {} } } as never).body;
  assert.doesNotMatch(html, /<img/);
});
