// test/brand_mark.test.js — every HTML page the witness serves carries the
// locked Arcaeon C2 mark exactly twice (header 30 px beside the wordmark,
// footer 20 px plus "arcaeon.io") and the /favicon.svg head link exactly once.
//
// Pages covered: the /status page (api/status.js), the shared navy shell
// (lib/_page.js pageShell) as rendered by the balance form and a fulfill
// error page, and, in the tree that has it, the /reconcile page
// (lib/_reconcile_page.js). The same file lives in both witness trees; the
// reconcile case skips itself where that page does not exist.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.WITNESS_KEYS = "brand-env-key:acme-";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_AUDIT_STATE;

const fs = require("node:fs");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const brand = require("../lib/_brand_mark.js");
const page = require("../lib/_page.js");

const ROOT = path.join(__dirname, "..");
const OUTER = 'd="M16 82 L50 14 L84 82"';
const INNER = 'd="M34 82 L50 48 L66 82"';
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

function assertBranded(html, label) {
  assert.equal(count(html, OUTER), 2, `${label}: outer mark path must appear exactly twice (header + footer)`);
  assert.equal(count(html, INNER), 2, `${label}: inner mark path must appear exactly twice`);
  assert.equal(count(html, 'rel="icon"'), 1, `${label}: favicon link must appear exactly once`);
  assert.equal(count(html, brand.FAVICON_LINK), 1, `${label}: the favicon link is the /favicon.svg one`);
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(head.includes(brand.FAVICON_LINK), `${label}: favicon link sits in <head>`);
  assert.equal(count(html, 'class="arc-mark" width="30" height="30"'), 1, `${label}: one 30 px header mark`);
  assert.equal(count(html, 'class="arc-mark" width="20" height="20"'), 1, `${label}: one 20 px footer mark`);
  assert.ok(html.includes('class="arc-foot"') && html.includes("arcaeon.io</span>"), `${label}: footer mark carries "arcaeon.io"`);
  assert.ok(html.indexOf('width="30"') < html.indexOf('width="20"'), `${label}: header mark comes before the footer mark`);
}

let gh, restore;
beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});
afterEach(() => { restore(); });

test("MARK: the helper draws the locked C2 geometry on each ground", () => {
  const dark = brand.markSvg(30, "dark");
  assert.ok(dark.includes(`${OUTER} fill="none" stroke="#e0a73c" stroke-width="9" stroke-linejoin="miter" stroke-linecap="square"`));
  assert.ok(dark.includes(`${INNER} fill="none" stroke="#e8eef3" stroke-width="6.5" stroke-linejoin="miter" stroke-linecap="square"`));
  assert.ok(brand.markSvg(20, "light").includes('stroke="#13233A" stroke-width="6.5"'));
  assert.ok(brand.markSvg(30, "dark-auto").includes("prefers-color-scheme: light){.arc-mark .arc-in{stroke:#13233A}"));
  assert.ok(brand.markSvg(30, "light-auto").includes("prefers-color-scheme: dark){.arc-mark .arc-in{stroke:#e8eef3}"));
  assert.throws(() => brand.markSvg(30, "teal"));
  assert.throws(() => brand.markSvg(0, "dark"));
});

test("FAVICON: favicon.svg is served from the deployment root: the mark on navy, rounded 20 percent corners", () => {
  const svg = fs.readFileSync(path.join(ROOT, "favicon.svg"), "utf8");
  assert.ok(svg.includes('<rect width="100" height="100" rx="20" ry="20" fill="#13233A"/>'));
  assert.equal(count(svg, OUTER), 1);
  assert.equal(count(svg, INNER), 1);
  assert.ok(svg.includes('stroke="#e0a73c"') && svg.includes('stroke="#e8eef3"'));
  assert.ok(!fs.existsSync(path.join(ROOT, "public")),
    "no public/ directory: on Vercel's no-framework preset it would become the output directory and stop serving the root files (/PRACTICES.md, /favicon.svg)");
});

test("PAGE /status: mark twice, favicon once", async () => {
  gh.seed(process.env.GITHUB_PIN_REPO, "pins/acme-prod/latest.json", {
    namespace: "acme-prod", rows: 3, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
    cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString(),
  });
  const res = makeRes();
  await require("../api/status.js")(makeReq({ method: "GET", query: {} }), res);
  assert.equal(res._status, 200);
  assertBranded(String(res._body), "/status");
});

test("PAGE pageShell: the shared navy shell carries the mark twice and keeps the wordmark", () => {
  const html = page.pageShell("t", "<h1>t</h1>");
  assertBranded(html, "pageShell");
  assert.ok(html.includes(">Arcaeon</div>"), "the text wordmark is still there beside the mark");
});

test("PAGE /balance (browser form): mark twice, favicon once", async () => {
  const res = makeRes();
  await require("../api/balance.js")(makeReq({ method: "GET", headers: { accept: BROWSER_ACCEPT } }), res);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  assertBranded(String(res._body), "/balance");
});

test("PAGE /api/fulfill (human error page): mark twice, favicon once", async () => {
  const res = makeRes();
  await require("../api/fulfill.js")(makeReq({ method: "GET", headers: { accept: BROWSER_ACCEPT }, query: { session_id: "nope" } }), res);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  assertBranded(String(res._body), "/api/fulfill error");
});

const RECONCILE = path.join(ROOT, "lib", "_reconcile_page.js");
test("PAGE /reconcile: mark twice, favicon once", { skip: !fs.existsSync(RECONCILE) && "no reconcile page in this tree" }, () => {
  const html = require(RECONCILE).HTML;
  assertBranded(html, "/reconcile");
  assert.ok(!html.includes("<!--arc:"), "every placeholder slot was filled");
});
