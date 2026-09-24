// lib/_brand_mark.js — the one copy of the locked Arcaeon C2 mark the witness
// pages carry. Underscore prefix = not routed (lib/ files don't count toward
// the 12-function api/ cap).
//
// Geometry is velouria projects/arcaeon_site/brand/arcaeon_mark_C2.svg
// exactly: gold #e0a73c outer chevron (stroke 9), inner chevron (stroke 6.5)
// #e8eef3 on dark grounds and navy #13233A on light grounds, miter joins,
// square caps. arcaeon.io does the same thing from brand_mark.py (header
// mark 30 px beside the wordmark, footer mark 20 px plus "arcaeon.io"); this
// file is its twin for the witness pages, so change one and change both.
//
// Grounds: the witness pages do not share a theme. The fulfill/balance shell
// is always dark; the reconcile page is dark with a light media flip; the
// status page is light with a dark media flip. So `ground` is one of:
//   "dark"       inner #e8eef3, always
//   "light"      inner #13233A, always
//   "dark-auto"  inner #e8eef3, flips to #13233A under prefers-color-scheme: light
//   "light-auto" inner #13233A, flips to #e8eef3 under prefers-color-scheme: dark
// The flip rides a <style> inside the SVG, scoped to .arc-mark .arc-in.
//
// The mark is aria-hidden: the wordmark (or "arcaeon.io") beside it carries
// the name. Pure presentation — no JSON, API field, verdict or vocabulary
// word is touched by anything here.

"use strict";

const GOLD = "#e0a73c";
const INNER_DARK = "#e8eef3";
const INNER_LIGHT = "#13233A";
const OUTER_D = "M16 82 L50 14 L84 82";
const INNER_D = "M34 82 L50 48 L66 82";

const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';

const GROUNDS = {
  "dark": { inner: INNER_DARK, flip: null },
  "light": { inner: INNER_LIGHT, flip: null },
  "dark-auto": { inner: INNER_DARK, flip: { scheme: "light", inner: INNER_LIGHT } },
  "light-auto": { inner: INNER_LIGHT, flip: { scheme: "dark", inner: INNER_DARK } },
};

// Inline SVG of the mark at px x px on the given ground.
function markSvg(px, ground, style) {
  const g = GROUNDS[ground || "dark"];
  if (!g) throw new Error(`_brand_mark: unknown ground ${ground}`);
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`_brand_mark: bad size ${px}`);
  const css = g.flip
    ? `<style>@media (prefers-color-scheme: ${g.flip.scheme}){.arc-mark .arc-in{stroke:${g.flip.inner}}}</style>`
    : "";
  const st = style ? ` style="${style}"` : "";
  return (
    `<svg class="arc-mark" width="${n}" height="${n}" viewBox="0 0 100 100" ` +
    `aria-hidden="true" focusable="false"${st}>${css}` +
    `<path d="${OUTER_D}" fill="none" stroke="${GOLD}" stroke-width="9" ` +
    `stroke-linejoin="miter" stroke-linecap="square"/>` +
    `<path class="arc-in" d="${INNER_D}" fill="none" stroke="${g.inner}" stroke-width="6.5" ` +
    `stroke-linejoin="miter" stroke-linecap="square"/></svg>`
  );
}

// Header: the 30 px mark, to sit beside the page's wordmark.
function headerMark(ground) {
  return markSvg(30, ground, "display:block;flex:none");
}

// Footer: the 20 px mark plus "arcaeon.io". `color` is the text colour of
// the label (a CSS value; defaults to inheriting the footer's colour).
function footerMark(ground, color) {
  const c = color ? `color:${color};` : "";
  return (
    `<span class="arc-foot" style="display:inline-flex;align-items:center;gap:8px;` +
    `vertical-align:middle;${c}letter-spacing:.04em">` +
    markSvg(20, ground, "display:block;flex:none") +
    `arcaeon.io</span>`
  );
}

module.exports = {
  GOLD, INNER_DARK, INNER_LIGHT, OUTER_D, INNER_D, FAVICON_LINK,
  markSvg, headerMark, footerMark,
};
