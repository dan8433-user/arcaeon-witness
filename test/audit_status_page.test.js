// test/audit_status_page.test.js — the /status page's audit-state column
// behind WITNESS_AUDIT_STATE (lib/_audit_status.js + api/status.js).
//
// Flag off: the page renders exactly what it rendered before (no audit
// vocabulary anywhere). Flag on: every namespace row leads with its audit
// state, the header carries the BLIND-first aggregate, and green "current"
// no longer stands alone. Fixes the design page's finding at api/status.js:29.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const cr = require("../lib/_check_record.js");
const { signed, isoAt } = require("./helpers/check_fixtures.js");
const statusHandler = require("../api/status.js");
const auditStatus = require("../lib/_audit_status.js");

const REPO = process.env.GITHUB_PIN_REPO;
const ours = cr.generateKeyPair();
const stranger = cr.generateKeyPair();
const NOW = Math.floor(Date.now() / 1000);
let gh, restore;

function pin(ns, rows) {
  return { namespace: ns, rows, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
           cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString() };
}
function check(kp, ns, result, agoSeconds, over = {}) {
  return signed(kp, {
    result, checked_at: isoAt(NOW - agoSeconds),
    target: { ref: `pins/${ns}/00000001.json` },
    checker: { name: kp === ours ? "operator" : "stranger" },
    ...over,
  });
}
function seedCheck(rec) {
  gh.seed(REPO, cr.checkRecordPath(rec), rec);
}

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  gh.seed(REPO, "pins/velouria-demo/latest.json", pin("velouria-demo", 12));
  gh.seed(REPO, "pins/acme-prod/latest.json", pin("acme-prod", 40));
  delete process.env.WITNESS_AUDIT_STATE;
});
afterEach(() => { restore(); delete process.env.WITNESS_AUDIT_STATE; });

async function render() {
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: {} }), res);
  return String(res._body);
}
function rowOf(html, ns) {
  const i = html.indexOf(`<code>${ns}</code>`);
  assert.ok(i >= 0, `no row for ${ns}`);
  return html.slice(i, html.indexOf("</tr>", i));
}

test("FLAG OFF (default): no audit vocabulary; a namespace still gets the old green current badge", async () => {
  const html = await render();
  for (const word of ["BLIND", "SELF-CHECKED", "audit state", "not declared as ours", "badge-grey-outline"]) {
    assert.ok(!html.includes(word), `flag off, page contains: ${word}`);
  }
  assert.ok(rowOf(html, "acme-prod").includes(`<span class="badge badge-green">current</span>`));
});

// Added in the 2026-09-23 release tree: the vocabulary test above could not
// see a whitespace-only line. The summary panel's placeholder once sat on its
// own template line, so with the flag OFF the page gained "  \n" (3 bytes)
// between the legend and the table: not byte-identical to production. The
// conditional now carries its own leading newline; this pins the adjacency.
test("FLAG OFF (default): the legend paragraph is followed directly by the table panel, no leftover blank line", async () => {
  const html = await render();
  assert.ok(html.includes(`close that gap.</p>\n  <div class="panel scroll">`),
    "flag off, the audit summary placeholder left bytes between the legend and the table");
});

test("FLAG ON, no check records anywhere: every row is BLIND, and green current is demoted to a cadence line", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  const html = await render();
  for (const ns of ["acme-prod", "velouria-demo"]) {
    const row = rowOf(html, ns);
    assert.ok(row.includes(`<span class="badge badge-grey" title="audit state, derived from published check records">BLIND</span>`), `${ns} is not BLIND`);
    assert.ok(row.includes("No one has checked this record. It was registered, and registering is a claim, not a check. Check it yourself: py verify.py"), `${ns} lacks the BLIND line`);
    assert.ok(row.includes(`cadence: <span class="badge badge-green">current</span>`), `${ns} cadence badge must follow, not lead`);
    assert.ok(row.indexOf("BLIND") < row.indexOf("badge-green"), `${ns}: the audit state must come before the green badge`);
  }
  assert.ok(html.includes("<strong>0 of 2 namespaces checked by a key not declared as ours.</strong> 2 namespaces: 2 blind, 0 self-checked, 0 checked, 0 stale, 0 broken."));
  assert.ok(html.includes("checks/OPERATOR_KEYS.json is not published"));
  assert.ok(html.includes("<th>audit state / cadence</th>"));
});

test("FLAG ON: our own key's VERIFIED renders SELF-CHECKED, never green", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId, name: "operator daily self-check" }] });
  seedCheck(check(ours, "acme-prod", "VERIFIED", 3600));
  const html = await render();
  const row = rowOf(html, "acme-prod");
  assert.ok(row.includes(`badge-grey-outline" title="audit state, derived from published check records">SELF-CHECKED</span>`));
  assert.ok(row.includes("That is not an outside check."));
  assert.ok(!row.includes("UNALTERED"));
  assert.ok(html.includes("2 namespaces: 1 blind, 1 self-checked, 0 checked, 0 stale, 0 broken."));
});

test("FLAG ON: an outside key's fresh VERIFIED renders CHECKED, with OPERATOR_KEYS.json published", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  seedCheck(check(stranger, "acme-prod", "VERIFIED", 2 * 86400 + 5));
  const html = await render();
  const row = rowOf(html, "acme-prod");
  assert.ok(row.includes(`badge-green" title="audit state, derived from published check records">UNALTERED, checked 2 days ago</span>`));
  assert.ok(row.includes("by 1 key not declared as ours: stranger. This says the record was not rewritten. It does not say the record is true."));
  assert.ok(html.includes("<strong>1 of 2 namespaces checked by a key not declared as ours.</strong>"));
});

test("FLAG ON: without OPERATOR_KEYS.json an outside key can only reach SELF-CHECKED (never upgrade without evidence)", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  seedCheck(check(stranger, "acme-prod", "VERIFIED", 3600));
  const html = await render();
  const row = rowOf(html, "acme-prod");
  assert.ok(row.includes(">SELF-CHECKED</span>"));
  assert.ok(!row.includes("UNALTERED") && !row.includes("badge-green\" title=\"audit"), "no green audit badge without a published key declaration");
  assert.ok(html.includes("0 of 2 namespaces checked by a key not declared as ours."));
});

test("FLAG ON: BROKEN from anyone is red and stays over a later VERIFIED; withdrawn tool releases it", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  seedCheck(check(ours, "velouria-demo", "BROKEN", 5 * 86400, { tool: { version: "0.0.9" }, rerun: "py verify.py Z" }));
  seedCheck(check(stranger, "velouria-demo", "VERIFIED", 86400));
  let html = await render();
  let row = rowOf(html, "velouria-demo");
  assert.ok(row.includes(`badge-red" title="audit state, derived from published check records">BROKEN</span>`));
  assert.ok(row.includes("found this record does not match. Re-run it: py verify.py Z. Both records are kept."));
  assert.ok(html.includes("2 namespaces: 1 blind, 0 self-checked, 0 checked, 0 stale, 1 broken."));

  gh.seed(REPO, "checks/WITHDRAWN_TOOLS.json", { tools: ["arcaeon-verifier-two@0.0.9"], keys: [] });
  html = await render();
  row = rowOf(html, "velouria-demo");
  assert.ok(row.includes(">UNALTERED, checked 1 days ago</span>"));
  assert.ok(row.includes("1 BROKEN from a withdrawn tool or key, kept on the record"));
});

test("FLAG ON: a tampered record, a misfiled record, and a COULD_NOT_LOOK are counted, never folded in", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const tampered = check(stranger, "acme-prod", "VERIFIED", 3600); tampered.detail += "!";
  seedCheck(tampered);
  const misfiled = check(stranger, "velouria-demo", "VERIFIED", 3600);
  gh.seed(REPO, "checks/pin/acme-prod/misfiled-aaaaaaaa.json", misfiled);
  seedCheck(check(stranger, "acme-prod", "COULD_NOT_LOOK", 7200));
  const html = await render();
  const row = rowOf(html, "acme-prod");
  assert.ok(row.includes(">BLIND</span>"), "tampered/misfiled/CNL must leave the row BLIND");
  assert.ok(row.includes("1 attempted check could not complete"));
  assert.ok(row.includes("1 record ignored: bad signature, shape, or clock"));
  assert.ok(row.includes("1 record filed here but targeting another namespace, ignored"));
  assert.ok(rowOf(html, "velouria-demo").includes(">BLIND</span>"), "a misfiled record is not evidence for its target either");
});

test("gatherAuditStates: the read budget marks a namespace NOT FULLY READ rather than deriving over half the evidence", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  for (let i = 0; i < auditStatus.MAX_RECORD_READS + 1; i++) {
    seedCheck(check(stranger, "acme-prod", "VERIFIED", 3600 + i));
  }
  seedCheck(check(stranger, "velouria-demo", "VERIFIED", 3600));
  const audit = await auditStatus.gatherAuditStates(["acme-prod", "velouria-demo"], { nowSeconds: NOW });
  assert.equal(audit.byNs["acme-prod"].partial, true);
  assert.equal(audit.byNs["velouria-demo"].partial, true, "the budget is per render, so a later namespace with records to read is partial too");
  const empty = await auditStatus.gatherAuditStates(["no-such-ns"], { nowSeconds: NOW });
  assert.equal(empty.byNs["no-such-ns"].partial, false, "a namespace with nothing listed needs no reads and is simply BLIND");
  assert.equal(empty.byNs["no-such-ns"].state, "BLIND");
  const cell = auditStatus.renderAuditCell(audit.byNs["acme-prod"]);
  assert.ok(cell.includes("NOT FULLY READ"));
  assert.ok(!cell.includes("UNALTERED"));
  const summary = auditStatus.renderAuditSummary(audit, { noun: "namespaces" });
  assert.ok(summary.includes("0 of 0 namespaces checked by a key not declared as ours."));
  assert.ok(summary.includes("2 not fully read."));
});

test("auditStateEnabled reads only 1/true/on", () => {
  for (const v of ["1", "true", "TRUE", "on"]) assert.equal(auditStatus.auditStateEnabled({ WITNESS_AUDIT_STATE: v }), true, v);
  for (const v of ["", "0", "false", "off", "yes", undefined]) assert.equal(auditStatus.auditStateEnabled({ WITNESS_AUDIT_STATE: v }), false, String(v));
});
