// test/audit_reader_newest.test.js — the audit reader reads each checker
// key's NEWEST records, not every record oldest first (D20).
//
// The finding (release notes 2026-09-23c, "the reader's read budget runs out
// on day 13"): with a flat cap of 100 reads, oldest path first, eight
// namespaces and one daily self-check each filled the budget in twelve days;
// on day 13 the eighth namespace read COULD NOT LOOK, and one more each day
// after. The fix reads, per namespace and per checker key, the newest
// NEWEST_PER_KEY records by the timestamp in the file name. Older records of
// the same key are superseded by design and do NOT make a namespace partial.
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
const auditStatus = require("../lib/_audit_status.js");
const statusHandler = require("../api/status.js");

const REPO = process.env.GITHUB_PIN_REPO;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const K = auditStatus.NEWEST_PER_KEY;
const ours = cr.generateKeyPair();
const stranger = cr.generateKeyPair();
const NAMESPACES = Array.from({ length: 8 }, (_, i) => `ns-${String(i + 1).padStart(2, "0")}`);
let gh, restore;

function pin(ns) {
  return { namespace: ns, rows: 10, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
           cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString() };
}
function check(kp, ns, result, agoSeconds) {
  return signed(kp, {
    result, checked_at: isoAt(NOW - agoSeconds),
    target: { ref: `pins/${ns}/00000001.json` },
    checker: { name: kp === ours ? "operator" : "stranger" },
  });
}
function seedCheck(rec) {
  gh.seed(REPO, cr.checkRecordPath(rec), rec);
  return cr.checkRecordPath(rec);
}
// 30 days of one daily record per namespace from `kp`, newest 1 hour ago.
function seedDaily(kp, namespaces, days = 30, result = "VERIFIED") {
  for (const ns of namespaces) {
    for (let d = 0; d < days; d++) seedCheck(check(kp, ns, result, 3600 + d * DAY));
  }
}

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  for (const ns of NAMESPACES) gh.seed(REPO, `pins/${ns}/latest.json`, pin(ns));
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId, name: "operator daily self-check" }] });
  delete process.env.WITNESS_AUDIT_STATE;
});
afterEach(() => { restore(); delete process.env.WITNESS_AUDIT_STATE; });

test("DAY 30: 8 namespaces x 30 days of records all derive, SELF-CHECKED or CHECKED as their newest records say; none COULD NOT LOOK", async () => {
  seedDaily(ours, NAMESPACES);
  seedDaily(stranger, NAMESPACES.slice(4));
  const audit = await auditStatus.gatherAuditStates(NAMESPACES, { nowSeconds: NOW });
  for (const ns of NAMESPACES.slice(0, 4)) {
    const d = audit.byNs[ns];
    assert.equal(d.partial, false, `${ns} partial on day 30`);
    assert.equal(d.state, "SELF-CHECKED", ns);
    assert.equal(d.records_listed, 30, ns);
    assert.equal(d.records_older_not_read, 30 - K, ns);
    assert.equal(d.last_own_verified_at, isoAt(NOW - 3600), `${ns}: the newest record is the one read`);
  }
  for (const ns of NAMESPACES.slice(4)) {
    const d = audit.byNs[ns];
    assert.equal(d.partial, false, `${ns} partial on day 30`);
    assert.equal(d.state, "CHECKED", ns);
    assert.equal(d.days_since_outside_verified, 0, ns);
    assert.equal(d.records_listed, 60, ns);
    assert.equal(d.records_older_not_read, 2 * (30 - K), ns);
  }
  assert.equal(audit.readsUsed, 4 * K + 4 * 2 * K, "reads = newest K per key per namespace, nothing else");
  assert.ok(audit.readsUsed <= auditStatus.recordReadCap(NAMESPACES.length));
  const counted = Object.values(audit.byNs);
  const summary = auditStatus.renderAuditSummary(audit, { noun: "namespaces" });
  assert.ok(summary.includes("4 of 8 namespaces checked by a key not declared as ours."), summary);
  assert.ok(summary.includes("8 namespaces: 0 blind, 4 self-checked, 4 checked, 0 stale, 0 broken."));
  assert.ok(!summary.includes("not fully read"));
  assert.equal(counted.filter((d) => d.partial).length, 0);
  const cell = auditStatus.renderAuditCell(audit.byNs["ns-01"]);
  assert.ok(cell.includes(`${30 - K} older records not read: each checker key&#39;s newest ${K} were, and a key&#39;s newer check supersedes its older ones`));
  assert.ok(!cell.includes("COULD NOT LOOK"));
});

test("DAY 13 and every day to 60: the finding's exact shape no longer breaks (one own record per namespace per day)", async () => {
  seedDaily(ours, NAMESPACES, 60);
  const audit = await auditStatus.gatherAuditStates(NAMESPACES, { nowSeconds: NOW });
  for (const ns of NAMESPACES) {
    assert.equal(audit.byNs[ns].partial, false, ns);
    assert.equal(audit.byNs[ns].state, "SELF-CHECKED", ns);
  }
  assert.equal(audit.readsUsed, NAMESPACES.length * K);
});

test("NEWEST FIRST: the newest file wins when older files carry a different result", async () => {
  // Older records say VERIFIED; the newest says BROKEN. An oldest-first
  // reader capped at K would read three VERIFIEDs and miss the BROKEN.
  for (let d = 1; d <= 10; d++) seedCheck(check(ours, "ns-01", "VERIFIED", d * DAY));
  const newest = seedCheck(check(ours, "ns-01", "BROKEN", 3600));
  // Older records say COULD_NOT_LOOK; the newest say VERIFIED.
  for (let d = 5; d <= 12; d++) seedCheck(check(ours, "ns-02", "COULD_NOT_LOOK", d * DAY));
  for (let d = 0; d < K; d++) seedCheck(check(ours, "ns-02", "VERIFIED", 3600 + d * DAY));
  const audit = await auditStatus.gatherAuditStates(["ns-01", "ns-02"], { nowSeconds: NOW });
  assert.equal(audit.byNs["ns-01"].state, "BROKEN");
  assert.equal(audit.byNs["ns-01"].broken_evidence.checked_at, isoAt(NOW - 3600));
  assert.equal(audit.byNs["ns-02"].state, "SELF-CHECKED");
  assert.equal(audit.byNs["ns-02"].counts.could_not_look, 0, "the older COULD_NOT_LOOKs were not the ones read");
  const reads = gh.getLog.filter((p) => String(p).startsWith("checks/pin/ns-01/"));
  assert.equal(reads.length, K);
  assert.equal(reads[0], newest, "the newest file is read first");
});

test("NEWEST FIRST (pure): selectRecordPaths orders by the file-name timestamp, per key, reads every older broken-named file, and always reads an unparseable name", () => {
  const p = (ts, key, r = "verified") => `checks/pin/x/${ts}-${key}-${r}.json`;
  const paths = [
    p("2026-09-01T03-30-00Z", "aaaaaaaa", "broken"), p("2026-09-23T03-30-00Z", "aaaaaaaa"), p("2026-09-10T03-30-00Z", "aaaaaaaa"),
    p("2026-09-22T03-30-00Z", "aaaaaaaa"), p("2026-09-21T23-59-59Z", "aaaaaaaa", "could_not_look"),
    p("2026-09-05T03-30-00Z", "aaaaaaaa", "broken"),
    p("2026-08-01T00-00-00Z", "bbbbbbbb"),
    "checks/pin/x/misfiled-cccccccc.json",
    // The pre-D22 name (no result part) does not parse, so it is always read.
    "checks/pin/x/2026-07-01T00-00-00Z-dddddddd.json",
  ];
  const sel = auditStatus.selectRecordPaths(paths, 3);
  assert.deepEqual(sel.read, [
    "checks/pin/x/2026-07-01T00-00-00Z-dddddddd.json",
    "checks/pin/x/misfiled-cccccccc.json",
    p("2026-09-23T03-30-00Z", "aaaaaaaa"), p("2026-09-22T03-30-00Z", "aaaaaaaa"), p("2026-09-21T23-59-59Z", "aaaaaaaa", "could_not_look"),
    p("2026-09-05T03-30-00Z", "aaaaaaaa", "broken"), p("2026-09-01T03-30-00Z", "aaaaaaaa", "broken"),
    p("2026-08-01T00-00-00Z", "bbbbbbbb"),
  ]);
  assert.equal(sel.olderNotRead, 1, "only the older VERIFIED of key a is left unread");
  assert.equal(sel.brokenExtra, 2);
  assert.deepEqual(sel.brokenOverflowKeys, []);
  // Bound: with a per-key extra bound of 1, key a overflows.
  const tight = auditStatus.selectRecordPaths(paths, 3, 1);
  assert.equal(tight.brokenExtra, 1);
  assert.deepEqual(tight.brokenOverflowKeys, ["aaaaaaaa"]);
  assert.ok(tight.read.includes(p("2026-09-05T03-30-00Z", "aaaaaaaa", "broken")), "the newest broken-named extras are the ones read");
});

test("D1 GUARD: our own daily volume cannot bury an outside checker's older BROKEN (slots are per key)", async () => {
  seedCheck(check(stranger, "ns-03", "BROKEN", 20 * DAY));
  seedDaily(ours, ["ns-03"], 30);
  const audit = await auditStatus.gatherAuditStates(["ns-03"], { nowSeconds: NOW });
  assert.equal(audit.byNs["ns-03"].partial, false);
  assert.equal(audit.byNs["ns-03"].state, "BROKEN");
  assert.equal(audit.byNs["ns-03"].broken_evidence.key, stranger.keyId);
});

test("D20 RESIDUAL CLOSED (D1 literal, D22): a key's own BROKEN survives K later records from the same key", async () => {
  // Was the D20 residual: the BROKEN fell out of the newest-K read set and
  // the row read SELF-CHECKED. The helm's ruling: D1 holds literally. The
  // result is in the file name, so the reader reads every broken-named file
  // besides the newest K, and a verified BROKEN keeps the namespace BROKEN.
  const b = seedCheck(check(ours, "ns-04", "BROKEN", 10 * DAY));
  assert.match(b, /-broken\.json$/);
  seedDaily(ours, ["ns-04"], K);
  seedDaily(ours, ["ns-05"], 30);
  seedCheck(check(ours, "ns-05", "BROKEN", 40 * DAY));
  const audit = await auditStatus.gatherAuditStates(["ns-04", "ns-05"], { nowSeconds: NOW });
  assert.equal(audit.byNs["ns-04"].partial, false);
  assert.equal(audit.byNs["ns-04"].state, "BROKEN");
  assert.equal(audit.byNs["ns-04"].broken_evidence.checked_at, isoAt(NOW - 10 * DAY));
  assert.equal(audit.byNs["ns-04"].records_older_not_read, 0);
  assert.equal(audit.byNs["ns-04"].records_broken_older_read, 1);
  assert.equal(audit.byNs["ns-05"].state, "BROKEN", "30 later same-key VERIFIEDs do not clear it either");
  assert.equal(audit.byNs["ns-05"].records_older_not_read, 30 - K);
  assert.ok(gh.getLog.includes(b), "the broken-named file was read");
  assert.equal(audit.readsUsed, 2 * (K + 1), "newest K per key plus the one broken-named file, per namespace");
  const cell = auditStatus.renderAuditCell(audit.byNs["ns-04"]);
  assert.ok(cell.includes("1 older BROKEN record read as well"), cell);
});

test("D22 BOUND: more than MAX_BROKEN_EXTRA_PER_KEY older broken-named files from one key -> COULD NOT LOOK with a note, never a state over some of them", async () => {
  const MAX = auditStatus.MAX_BROKEN_EXTRA_PER_KEY;
  assert.equal(MAX, 20);
  for (let d = 0; d < MAX + 1; d++) seedCheck(check(ours, "ns-06", "BROKEN", 10 * DAY + d * 3600));
  seedDaily(ours, ["ns-06"], K);
  for (let d = 0; d < MAX; d++) seedCheck(check(ours, "ns-07", "BROKEN", 10 * DAY + d * 3600));
  seedDaily(ours, ["ns-07"], K);
  const audit = await auditStatus.gatherAuditStates(["ns-06", "ns-07"], { nowSeconds: NOW });
  assert.equal(audit.byNs["ns-06"].partial, true, "past the bound");
  assert.deepEqual(audit.byNs["ns-06"].broken_overflow_keys, [cr.keyIdShort(ours.keyId)]);
  assert.ok(audit.notes.some((n) => n.startsWith("ns-06:") && n.includes(`more than ${MAX} older BROKEN records`)), audit.notes.join("\n"));
  assert.ok(auditStatus.renderAuditCell(audit.byNs["ns-06"]).includes("COULD NOT LOOK"));
  assert.equal(audit.byNs["ns-07"].partial, false, "at the bound exactly: all read, derived");
  assert.equal(audit.byNs["ns-07"].state, "BROKEN");
  assert.equal(audit.byNs["ns-07"].records_broken_older_read, MAX);
  // The global cap grew by exactly the extras chosen (20 + 20), so neither
  // namespace was cut by it.
  assert.equal(audit.readsUsed, 2 * K + 2 * MAX);
});

test("D22 NAME IS A CLAIM: a file whose name-result disagrees with its signed body is refused (path_result_mismatch) and its namespace is COULD NOT LOOK", async () => {
  // Name says verified, body says BROKEN.
  const lieGreen = check(ours, "ns-01", "BROKEN", 3600);
  const pathGreen = cr.checkRecordPath(lieGreen).replace(/-broken\.json$/, "-verified.json");
  gh.seed(REPO, pathGreen, lieGreen);
  // Name says broken, body says VERIFIED (an older one, read only because of its name).
  seedDaily(ours, ["ns-02"], K);
  const lieRed = check(ours, "ns-02", "VERIFIED", 20 * DAY);
  const pathRed = cr.checkRecordPath(lieRed).replace(/-verified\.json$/, "-broken.json");
  gh.seed(REPO, pathRed, lieRed);
  // Control: an honest namespace next to them still derives.
  seedDaily(ours, ["ns-03"], K);
  const audit = await auditStatus.gatherAuditStates(["ns-01", "ns-02", "ns-03"], { nowSeconds: NOW });
  for (const [ns, p] of [["ns-01", pathGreen], ["ns-02", pathRed]]) {
    assert.equal(audit.byNs[ns].partial, true, ns);
    assert.equal(audit.byNs[ns].path_result_mismatch, 1, ns);
    assert.ok(audit.notes.some((n) => n.includes(p) && n.includes("path_result_mismatch")), ns);
  }
  assert.equal(audit.byNs["ns-03"].partial, false);
  assert.equal(audit.byNs["ns-03"].state, "SELF-CHECKED");
  const j = auditStatus.auditNamespaceJson(audit.byNs["ns-01"]);
  assert.equal(j.state, auditStatus.NOT_FULLY_READ);
  assert.equal(j.path_result_mismatch, 1);
});

test("D22 NAME IS A CLAIM (outside source): the same refusal applies to a record fetched from a listed source", async () => {
  const lie = check(stranger, "ns-01", "VERIFIED", 3600);
  const p = cr.checkRecordPath(lie).replace(/-verified\.json$/, "-broken.json");
  const base = "https://checks.example.org";
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
  const fetchImpl = async (url) => {
    if (url === `${base}/checks/INDEX.json`) return ok(JSON.stringify({ paths: [p] }));
    if (url === `${base}/${p}`) return ok(JSON.stringify(lie));
    return { ok: false, status: 404 };
  };
  const audit = await auditStatus.gatherAuditStates(["ns-01"], {
    nowSeconds: NOW, env: { WITNESS_CHECK_SOURCES: base }, fetchImpl,
  });
  assert.equal(audit.byNs["ns-01"].partial, true);
  assert.equal(audit.byNs["ns-01"].source_records, 0, "the record was not folded in");
  assert.equal(audit.byNs["ns-01"].path_result_mismatch, 1);
});

test("SAFETY CAP: scales with namespaces x K; past it the remaining namespaces are COULD NOT LOOK, never derived", async () => {
  assert.equal(auditStatus.recordReadCap(8), 8 * (K * auditStatus.KEY_SLOTS_PER_NAMESPACE + 1));
  seedDaily(ours, NAMESPACES, 5);
  const audit = await auditStatus.gatherAuditStates(NAMESPACES, { nowSeconds: NOW, maxRecordReads: 2 * K });
  assert.equal(audit.byNs["ns-01"].partial, false);
  assert.equal(audit.byNs["ns-02"].partial, false);
  for (const ns of NAMESPACES.slice(2)) assert.equal(audit.byNs[ns].partial, true, ns);
});

// Same pattern as the supersede test's FLAG OFF case: render, add the
// records, render again, compare with only the clock-derived text masked.
test("FLAG OFF: 8 namespaces x 30 days of check records change nothing on the page or in the JSON, and checks/ is not read", async () => {
  async function render(query) {
    const res = makeRes();
    await statusHandler(makeReq({ method: "GET", query }), res);
    return query.format ? JSON.stringify(res._body) : String(res._body);
  }
  const strip = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "T").replace(/\d+[dhm]( \d+[hm])?|<1m/g, "D");
  const beforeHtml = await render({});
  const beforeJson = await render({ format: "json" });
  seedDaily(ours, NAMESPACES);
  seedDaily(stranger, NAMESPACES.slice(4));
  gh.getLog.length = 0;
  const afterHtml = await render({});
  const afterJson = await render({ format: "json" });
  assert.equal(strip(afterHtml), strip(beforeHtml));
  assert.equal(strip(afterJson), strip(beforeJson));
  assert.ok(!gh.getLog.some((p) => String(p).startsWith("checks/")), "flag off must not read checks/");
  assert.ok(!afterHtml.includes("older record"));
});
