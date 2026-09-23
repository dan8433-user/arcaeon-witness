// test/audit_superseded.test.js — a namespace superseded as a test namespace
// (superseded/<ns>.json, lib/_test_ns.js) on the audit-state surfaces.
//
// The helm's call (2026-09-23) on the design's B10-addendum item 5: supersede
// `velouria-selftest` as a test namespace, visibly. It stays in the record and
// on the page, its derived state is NOT rewritten (no sixth state word; a
// BROKEN is permanent), it gains a grey tag, and it leaves the headline and
// the aggregate with one sentence saying which row and why. A supersede file
// that cannot be read as one leaves the row COUNTED: the failure direction
// must never take a red out of the totals.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const { signed, isoAt } = require("./helpers/check_fixtures.js");
const cr = require("../lib/_check_record.js");
const tns = require("../lib/_test_ns.js");
const statusHandler = require("../api/status.js");

const REPO = process.env.GITHUB_PIN_REPO;
const NOW = Math.floor(Date.now() / 1000);
const ours = cr.generateKeyPair();
const SELFTEST = "velouria-selftest";
let gh, restore;

function pin(ns, rows) {
  return { namespace: ns, rows, chain: "cafebabe", seq: 4, pinned_at: new Date().toISOString(),
           cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString() };
}
function check(ns, result, agoSeconds) {
  return signed(ours, {
    result, checked_at: isoAt(NOW - agoSeconds),
    target: { ref: `pins/${ns}/00000001.json` },
    checker: { name: "operator" },
  });
}
function supersedeRecord(over = {}) {
  return {
    ...tns.buildSupersedeRecord({
      namespace: SELFTEST, lastSeq: 4, now: "2026-09-23T12:00:00Z",
      reason: "the operator's own self-test namespace, not a customer's log",
    }),
    ...over,
  };
}

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  gh.seed(REPO, `pins/${SELFTEST}/latest.json`, pin(SELFTEST, 4));
  gh.seed(REPO, "pins/acme-prod/latest.json", pin("acme-prod", 40));
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  for (const [ns, r] of [[SELFTEST, "BROKEN"], ["acme-prod", "VERIFIED"]]) {
    const rec = check(ns, r, 3600);
    gh.seed(REPO, cr.checkRecordPath(rec), rec);
  }
  process.env.WITNESS_AUDIT_STATE = "1";
});
afterEach(() => { restore(); delete process.env.WITNESS_AUDIT_STATE; });

async function renderHtml() {
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: {} }), res);
  return String(res._body);
}
async function renderJson() {
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: { format: "json" } }), res);
  assert.equal(res._status, 200);
  return res._body;
}
function rowOf(html, ns) {
  const i = html.lastIndexOf(`<code>${ns}</code>`); // the summary sentence names it first
  assert.ok(i >= 0, `no row for ${ns}`);
  return html.slice(i, html.indexOf("</tr>", i));
}

test("SUPERSEDED: the row keeps its derived BROKEN and gains a grey tag; the totals leave it out and one sentence says why", async () => {
  gh.seed(REPO, tns.supersedePath(SELFTEST), supersedeRecord());
  const html = await renderHtml();
  const row = rowOf(html, SELFTEST);
  assert.ok(row.includes(">BROKEN</span>"), "the derived state is not rewritten");
  assert.ok(row.includes(">superseded test namespace</div>"));
  assert.ok(!/>TEST</.test(html), "no sixth state word");
  assert.ok(html.includes("1 of 1 namespaces checked") === false);
  assert.ok(html.includes("1 namespaces: 0 blind, 1 self-checked, 0 checked, 0 stale, 0 broken."), "the aggregate counts acme-prod only");
  const sentence = html.match(/<p class="muted"><code>velouria-selftest<\/code> is left out of the counts above[^\n]*<\/p>/);
  assert.ok(sentence, "one sentence names the row");
  assert.ok(sentence[0].includes("superseded as a test namespace on 2026-09-23"));
  assert.ok(sentence[0].includes("superseded/velouria-selftest.json"));
  assert.ok(sentence[0].includes("its audit state, BROKEN, stays on its row"));
  assert.equal((sentence[0].match(/\. /g) || []).length, 0, "one sentence");
  assert.ok(!rowOf(html, "acme-prod").includes("superseded test namespace"));
});

test("SUPERSEDED JSON: the namespace keeps state BROKEN and carries superseded; the summary counts leave it out and list it", async () => {
  gh.seed(REPO, tns.supersedePath(SELFTEST), supersedeRecord());
  const body = await renderJson();
  const st = body.namespaces.find((n) => n.namespace === SELFTEST).audit;
  assert.equal(st.state, "BROKEN");
  assert.deepEqual(st.superseded, {
    record_path: "superseded/velouria-selftest.json", superseded_at: "2026-09-23T12:00:00Z",
    reason: "the operator's own self-test namespace, not a customer's log", last_seq: 4, counted: false,
  });
  assert.equal(body.namespaces.find((n) => n.namespace === "acme-prod").audit.superseded, undefined);
  assert.equal(body.audit.counts.broken, 0);
  assert.equal(body.audit.counts.self_checked, 1);
  assert.equal(body.audit.counts.superseded_test, 1);
  assert.deepEqual(body.audit.superseded_test_namespaces, [
    { namespace: SELFTEST, state: "BROKEN", record_path: "superseded/velouria-selftest.json", superseded_at: "2026-09-23T12:00:00Z" },
  ]);
});

test("NOT SUPERSEDED (control): without the record the BROKEN is counted, red, and no tag appears", async () => {
  const html = await renderHtml();
  assert.ok(html.includes("2 namespaces: 0 blind, 1 self-checked, 0 checked, 0 stale, 1 broken."));
  assert.ok(!html.includes("superseded test namespace"));
  const body = await renderJson();
  assert.equal(body.audit.counts.broken, 1);
  assert.equal(body.audit.counts.superseded_test, 0);
});

for (const [label, content] of [
  ["another namespace's record", supersedeRecord({ namespace: "acme-prod" })],
  ["wrong kind", supersedeRecord({ kind: "retired" })],
  ["wrong version", supersedeRecord({ v: 2 })],
  ["no reason", supersedeRecord({ reason: "" })],
  ["bad date", supersedeRecord({ superseded_at: "yesterday" })],
  ["a bare array", []],
]) {
  test(`FAIL DIRECTION: a supersede file that is not a readable supersede record (${label}) leaves the row COUNTED, and says so`, async () => {
    gh.seed(REPO, tns.supersedePath(SELFTEST), content);
    const html = await renderHtml();
    assert.ok(html.includes("2 namespaces: 0 blind, 1 self-checked, 0 checked, 0 stale, 1 broken."), label);
    assert.ok(!html.includes("superseded test namespace"), label);
    assert.ok(html.includes("is not a readable supersede record for velouria-selftest; velouria-selftest is counted as usual."), label);
    const body = await renderJson();
    assert.equal(body.audit.counts.broken, 1, label);
    assert.equal(body.namespaces.find((n) => n.namespace === SELFTEST).audit.superseded, undefined, label);
  });
}

test("FAIL DIRECTION: a supersede file that is not JSON leaves the row counted", async () => {
  gh._repoMap(REPO).set(tns.supersedePath(SELFTEST), { content: "not json {", sha: gh._newSha() });
  const body = await renderJson();
  assert.equal(body.audit.counts.broken, 1);
  assert.equal(body.audit.counts.superseded_test, 0);
});

test("FLAG OFF: a published supersede record changes nothing on the page or in the JSON", async () => {
  delete process.env.WITNESS_AUDIT_STATE;
  const before = await renderHtml();
  const beforeJson = JSON.stringify(await renderJson());
  gh.seed(REPO, tns.supersedePath(SELFTEST), supersedeRecord());
  const after = await renderHtml();
  const afterJson = JSON.stringify(await renderJson());
  const strip = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "T").replace(/\d+[dhm]( \d+[hm])?|<1m/g, "D");
  assert.equal(strip(after), strip(before));
  assert.equal(strip(afterJson), strip(beforeJson));
  assert.ok(!after.includes("superseded"));
});
