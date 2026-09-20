// test/status_posture.test.js — the status page reports the SERVICE.
//
// 2026-09-19 (owner's call): the page carried "Independence disclosure: k=1.
// Every namespace below traces to one operator root... We measured, the answer
// is one" — forum candour that had drifted onto a product surface and read as
// an announcement that nobody else uses the service. A status page says what
// the service is doing. It keeps the limit a relying party NEEDS (one operator,
// everything checkable without trusting us) and drops the editorial.
//
// The other half matters just as much: deleting the paragraph alone would leave
// a bare namespace count that reads as a customer count. So the operator's own
// namespaces are tagged "reference", and these tests pin BOTH halves.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const statusHandler = require("../api/status.js");
const { isReferenceNamespace } = require("../lib/_status_data.js");

const REPO = process.env.GITHUB_PIN_REPO;
let gh, restore;

function pin(ns, rows) {
  return { namespace: ns, rows, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
           cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString() };
}

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  gh.seed(REPO, "pins/velouria-demo/latest.json", pin("velouria-demo", 12));
  gh.seed(REPO, "pins/acme-prod/latest.json", pin("acme-prod", 40));
});
afterEach(() => restore());

async function render(query) {
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: query || {} }), res);
  return res;
}
function htmlOf(res) {
  const b = res._body !== undefined ? res._body : res._text;
  return typeof b === "string" ? b : JSON.stringify(b);
}

test("POSTURE: the HTML page does not editorialise about who uses the service", async () => {
  const html = htmlOf(await render());
  for (const gone of ["k=1", "one operator root", "We measured", "Independence disclosure", "independent roots"]) {
    assert.ok(!html.includes(gone), `status page still contains: ${gone}`);
  }
});

test("LIMIT KEPT: the page still tells a relying party nothing here has to be taken on trust", async () => {
  const html = htmlOf(await render());
  assert.match(html, /third-party-timestamped/);
  assert.match(html, /taken on trust/);
});

test("NO IMPLIED ADOPTION: the operator's own namespace is tagged reference, a customer's is not", async () => {
  const html = htmlOf(await render());
  const demoRow = html.slice(html.indexOf("velouria-demo"), html.indexOf("velouria-demo") + 2500);
  const acmeRow = html.slice(html.indexOf("acme-prod"), html.indexOf("acme-prod") + 2500).split("velouria-demo")[0];
  assert.match(demoRow, />our own log</, "the operator's own namespace must carry the plain our-own-log tag");
  assert.ok(!/>our own log</.test(acmeRow.split("</tr>")[0]), "a customer's namespace must NOT be tagged as ours");
});

test("JSON: states the service property, not the usage; and carries the per-namespace flag", async () => {
  const res = await render({ format: "json" });
  const j = typeof res._body === "string" ? JSON.parse(res._body) : res._body;
  const text = JSON.stringify(j);
  assert.ok(!text.includes("all namespaces trace"), "status.json still carries the usage confession");
  assert.equal(j.independence.witness_operators, 1);
  assert.equal(j.independence.verifiable_without_trusting_us, true);
  const byNs = Object.fromEntries(j.namespaces.map((n) => [n.namespace || n.ns, n]));
  assert.equal(byNs["velouria-demo"].reference, true);
  assert.equal(byNs["acme-prod"].reference, false);
});

test("PREFIX RULE: reference is decided by prefix, and a lookalike in the middle of a name does not count", () => {
  assert.equal(isReferenceNamespace("velouria-canon"), true);
  assert.equal(isReferenceNamespace("test-freeplan"), false); // generic stem: no longer ours by prefix
  assert.equal(isReferenceNamespace("acme-velouria-mirror"), false);
  assert.equal(isReferenceNamespace("acme-prod"), false);
});

test("GENERIC STEMS ARE NOT OURS: a customer who picks demo- or test- is never tagged as the operator (2026-09-20 review)", () => {
  assert.equal(isReferenceNamespace("demo-project-alpha"), false);
  assert.equal(isReferenceNamespace("test-acme"), false);
  assert.equal(isReferenceNamespace("test-freeplan-smoke"), true);
  assert.equal(isReferenceNamespace("velouria-canon"), true);
});

test("JSON KEEPS THE ROOT COUNT: independence.roots stays machine-readable next to the new fields", async () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "_status_json.js"), "utf8");
  assert.match(src, /roots:\s*1/);
  assert.match(src, /witness_operators:\s*1/);
});
