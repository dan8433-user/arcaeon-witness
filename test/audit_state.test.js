// test/audit_state.test.js — deriving BLIND / SELF-CHECKED / CHECKED / STALE /
// BROKEN from check records (lib/_audit_state.js), and the exact strings the
// design page (B7) specifies.
//
// Design page B8 day 5, verbatim: "does it render BLIND with no records;
// SELF-CHECKED (not CHECKED) for an operator key; STALE at 30 days plus 1
// second; BROKEN over a later VERIFIED; and does a record with a missing
// field RAISE rather than default". Plus the decay and withdrawal rules of
// B6 and every choice written in DISAGREEMENTS_audit_state.md.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const cr = require("../lib/_check_record.js");
const as = require("../lib/_audit_state.js");
const { signed, isoAt } = require("./helpers/check_fixtures.js");

const NOW = Math.floor(Date.parse("2026-10-22T12:00:00Z") / 1000);
const DAY = 86400;
const ours = cr.generateKeyPair();
const stranger = cr.generateKeyPair();
const stranger2 = cr.generateKeyPair();
const OWN = new Set([ours.keyId]);

function rec(kp, result, agoSeconds, over = {}) {
  return signed(kp, { result, checked_at: isoAt(NOW - agoSeconds), checker: { name: kp === ours ? "operator" : "stranger" }, ...over });
}
const derive = (records, opts = {}) => as.deriveAuditState(records, { ownKeys: OWN, nowSeconds: NOW, ...opts });

// [name, records, opts, expected state]
const CASES = [
  ["no records -> BLIND", [], {}, "BLIND"],
  ["only our VERIFIED -> SELF-CHECKED, never CHECKED", [rec(ours, "VERIFIED", DAY)], {}, "SELF-CHECKED"],
  ["outside VERIFIED, 1 day old -> CHECKED", [rec(stranger, "VERIFIED", DAY)], {}, "CHECKED"],
  ["outside VERIFIED at 30 days minus 1 second -> CHECKED", [rec(stranger, "VERIFIED", 30 * DAY - 1)], {}, "CHECKED"],
  ["outside VERIFIED at exactly 30 days -> STALE (less-than, integer seconds)", [rec(stranger, "VERIFIED", 30 * DAY)], {}, "STALE"],
  ["outside VERIFIED at 30 days plus 1 second -> STALE", [rec(stranger, "VERIFIED", 30 * DAY + 1)], {}, "STALE"],
  ["BROKEN then a LATER VERIFIED -> still BROKEN", [rec(stranger, "BROKEN", 5 * DAY), rec(stranger2, "VERIFIED", DAY)], {}, "BROKEN"],
  ["BROKEN from our own key -> BROKEN (from anyone, including us)", [rec(ours, "BROKEN", DAY)], {}, "BROKEN"],
  ["BROKEN from a withdrawn tool -> no longer standing", [rec(stranger, "BROKEN", 5 * DAY, { tool: { version: "0.0.9" } }), rec(stranger2, "VERIFIED", DAY)], { withdrawnTools: new Set(["arcaeon-verifier-two@0.0.9"]) }, "CHECKED"],
  ["BROKEN from a withdrawn key, nothing else -> BLIND", [rec(stranger, "BROKEN", DAY)], { withdrawnKeys: new Set([stranger.keyId]) }, "BLIND"],
  ["outside VERIFIED from a withdrawn tool -> STALE immediately", [rec(stranger, "VERIFIED", DAY, { tool: { version: "0.0.9" } })], { withdrawnTools: new Set(["arcaeon-verifier-two@0.0.9"]) }, "STALE"],
  ["outside VERIFIED from a withdrawn key -> STALE immediately", [rec(stranger, "VERIFIED", DAY)], { withdrawnKeys: new Set([stranger.keyId]) }, "STALE"],
  ["only COULD_NOT_LOOK results -> BLIND (a failed look is not a look)", [rec(stranger, "COULD_NOT_LOOK", DAY), rec(ours, "COULD_NOT_LOOK", DAY)], {}, "BLIND"],
  ["outside key but OPERATOR_KEYS unknown -> SELF-CHECKED at most", [rec(stranger, "VERIFIED", DAY)], { ownKeysUnknown: true }, "SELF-CHECKED"],
  ["outside VERIFIED plus our VERIFIED -> CHECKED", [rec(ours, "VERIFIED", DAY), rec(stranger, "VERIFIED", 2 * DAY)], {}, "CHECKED"],
  ["outside STALE plus our fresh VERIFIED -> STALE (precedence over SELF-CHECKED)", [rec(ours, "VERIFIED", DAY), rec(stranger, "VERIFIED", 40 * DAY)], {}, "STALE"],
  ["a tampered record is ignored, not defaulted", [(() => { const r = rec(stranger, "VERIFIED", DAY); r.result = "VERIFIED "; return r; })()], {}, "BLIND"],
  ["a future-dated outside VERIFIED is ignored", [rec(stranger, "VERIFIED", -DAY)], {}, "BLIND"],
  ["a record missing a field is ignored, not defaulted", [(() => { const r = rec(stranger, "VERIFIED", DAY); delete r.tool; return r; })()], {}, "BLIND"],
  ["our VERIFIED from a withdrawn tool -> BLIND (withdrawn is not evidence)", [rec(ours, "VERIFIED", DAY, { tool: { version: "0.0.9" } })], { withdrawnTools: new Set(["arcaeon-verifier-two@0.0.9"]) }, "BLIND"],
];

for (const [name, records, opts, expected] of CASES) {
  test(`STATE: ${name}`, () => {
    assert.equal(derive(records, opts).state, expected);
  });
}

test("BREAK ARM: every state case goes RED against a derive that always says CHECKED", () => {
  const liar = () => ({ state: "CHECKED" });
  const survivors = CASES.filter(([, , , expected]) => liar().state === expected && expected !== "CHECKED");
  assert.deepEqual(survivors, []);
  const caught = CASES.filter(([, , , expected]) => expected !== "CHECKED").length;
  assert.ok(caught >= 12, `only ${caught} cases would catch a liar that paints everything green`);
});

test("counts carry their denominator; COULD_NOT_LOOK and unverifiable are counted, never folded", () => {
  const bad = rec(stranger, "VERIFIED", DAY); bad.detail += "!";
  const d = derive([rec(stranger, "COULD_NOT_LOOK", DAY), rec(ours, "COULD_NOT_LOOK", DAY), bad, rec(ours, "VERIFIED", 2 * DAY)]);
  assert.equal(d.state, "SELF-CHECKED");
  assert.equal(d.counts.records, 4);
  assert.equal(d.counts.could_not_look, 2);
  assert.equal(d.counts.unverifiable, 1);
  assert.deepEqual(d.unverifiable_reasons, ["bad_signature:sig"]);
  assert.equal(d.counts.verified_own, 1);
  assert.equal(d.counts.verified_outside, 0);
});

test("CHECKED names the distinct fresh outside keys, not the stale ones", () => {
  const d = derive([rec(stranger, "VERIFIED", DAY), rec(stranger, "VERIFIED", 2 * DAY), rec(stranger2, "VERIFIED", 40 * DAY)]);
  assert.equal(d.state, "CHECKED");
  assert.deepEqual(d.outside_keys.map((k) => k.key), [stranger.keyId]);
  assert.equal(d.days_since_outside_verified, 1);
});

test("recordsForNamespace filters by target.ref", () => {
  const a = rec(stranger, "VERIFIED", DAY);
  const b = rec(stranger, "VERIFIED", DAY, { target: { ref: "pins/other/00000001.json" } });
  assert.deepEqual(as.recordsForNamespace([a, b], "acme-prod"), [a]);
  assert.deepEqual(as.recordsForNamespace([a, b], "other"), [b]);
});

// ---------------------------------------------------------------------------
// rendering strings, exactly as B7 lists them
// ---------------------------------------------------------------------------
test("STRINGS: BLIND", () => {
  const d = derive([]);
  assert.equal(as.badgeString(d), "BLIND");
  assert.equal(as.lineUnder(d, { rerun: "py verify.py X" }),
    "No one has checked this record. It was registered, and registering is a claim, not a check. Check it yourself: py verify.py X");
});

test("STRINGS: SELF-CHECKED", () => {
  const d = derive([rec(ours, "VERIFIED", DAY)]);
  assert.equal(as.badgeString(d), "SELF-CHECKED");
  assert.equal(as.lineUnder(d), `Only the operator's own checker has looked, most recently ${isoAt(NOW - DAY)}. That is not an outside check.`);
});

test("STRINGS: CHECKED says UNALTERED and never true", () => {
  const d = derive([rec(stranger, "VERIFIED", 3 * DAY + 100)]);
  assert.equal(as.badgeString(d), "UNALTERED, checked 3 days ago");
  const line = as.lineUnder(d);
  assert.equal(line, `Found unaltered on ${isoAt(NOW - 3 * DAY - 100)} by 1 key not declared as ours: stranger. This says the record was not rewritten. It does not say the record is true.`);
  assert.ok(!/\bverified\b/i.test(as.badgeString(d)), "the badge must not say verified");
});

test("STRINGS: STALE", () => {
  const d = derive([rec(stranger, "VERIFIED", 45 * DAY)]);
  assert.equal(as.badgeString(d), "STALE");
  assert.equal(as.lineUnder(d), `Last found unaltered by an outside key on ${isoAt(NOW - 45 * DAY)}, 45 days ago. Nothing since. Treat it as unchecked.`);
});

test("STRINGS: BROKEN carries the re-run command and keeps both records", () => {
  const d = derive([rec(stranger, "BROKEN", 2 * DAY, { rerun: "py verify.py Y" }), rec(stranger, "VERIFIED", DAY)]);
  assert.equal(as.badgeString(d), "BROKEN");
  assert.equal(as.lineUnder(d), `A check on ${isoAt(NOW - 2 * DAY)} found this record does not match. Re-run it: py verify.py Y. Both records are kept.`);
  assert.equal(d.counts.verified_outside, 1, "the later VERIFIED stays on the record");
});

test("STRINGS: the aggregate names BLIND first and never prints failures alone", () => {
  const ds = [derive([]), derive([]), derive([rec(ours, "VERIFIED", DAY)]), derive([rec(stranger, "VERIFIED", DAY)]), derive([rec(stranger, "VERIFIED", 40 * DAY)]), derive([rec(ours, "BROKEN", DAY)])];
  assert.equal(as.aggregateLine(ds), "6 records: 2 blind, 1 self-checked, 1 checked, 1 stale, 1 broken.");
  assert.equal(as.checkedOfLine(ds, { noun: "namespaces" }), "1 of 6 namespaces checked by a key not declared as ours.");
  assert.equal(as.aggregateLine([]), "0 records: 0 blind, 0 self-checked, 0 checked, 0 stale, 0 broken.");
});
