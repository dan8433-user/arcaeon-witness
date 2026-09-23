// test/battery_inventory.test.js — the battery that can tell you it was not
// there. lib/_battery_inventory.js compares check_* functions DEFINED in a
// source file (parsed) against the ones a runner CALLED (recorded); the
// publisher (tools/publish_self_checks.js) prints the line every run and
// refuses on any orphan. BREAK ARMS: one extra check defined and never
// called turns the run red and names it (through the parser, through the
// CLI flag, and through a runner that skips a registered check).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const inv = require("../lib/_battery_inventory.js");
const cr = require("../lib/_check_record.js");
const { unsignedRecord } = require("./helpers/check_fixtures.js");
const pub = require("../tools/publish_self_checks.js");

const ours = cr.generateKeyPair();
const DAY = "2026-09-23";
const NOW = `${DAY}T14:00:00Z`;

function selfCheck(ns) {
  return cr.signCheckRecord(unsignedRecord({
    target: { type: "pin", ref: `pins/${ns}/00000004.json` },
    inputs: [{ url: `https://raw.githubusercontent.com/o/r/main/pins/${ns}/00000004.json`, sha256: "ab".repeat(32) }],
    checked_at: `${DAY}T13:40:45Z`,
    checker: { name: "arcaeon operator daily self-check", binding_url: "https://github.com/o/r/blob/main/checks/OPERATOR_KEYS.json" },
  }), ours.privateKey);
}
function outDir(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "battery-"));
  for (const rec of records) {
    const dest = path.join(dir, cr.checkRecordPath(rec));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(rec, null, 1) + "\n");
  }
  const keys = path.join(dir, "OPERATOR_KEYS.json");
  fs.writeFileSync(keys, JSON.stringify({ keys: [{ key: ours.keyId }] }));
  return { dir, keys };
}
function io() {
  const o = { out: "", err: "" };
  return { o, w: { out: (s) => { o.out += s; }, err: (s) => { o.err += s; } } };
}
const args = (d) => ["--dir", d.dir, "--operator-keys", d.keys, "--date", DAY, "--now", NOW, "--dry-run"];

// ---------------------------------------------------------------- the parser
test("definedChecks finds function, async function and bound-arrow checks, and ignores comments and strings", () => {
  const src = [
    "function check_a(ctx) { return null; }",
    "  async function check_b(ctx) {}",
    "const check_c = (ctx) => null;",
    "let check_d = async function (ctx) {};",
    "// function check_commented(ctx) {}",
    " * function check_in_block_comment(ctx) {}",
    "const s = \"function check_in_string(ctx) {}\";",
    "function helper(ctx) { return check_a(ctx); }",
    "const check_value = 3;",
  ].join("\n");
  assert.deepEqual(inv.definedChecks(src), ["check_a", "check_b", "check_c", "check_d"]);
});

test("inventory: every defined check called is green, zero orphans", () => {
  const r = inv.inventory({ source: "function check_a(){}\nfunction check_b(){}\n", called: new Set(["check_a", "check_b"]) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.line, "battery: 2 defined, 2 called, 0 orphaned []");
});

test("inventory: a defined check nobody called is an orphan, red, and named", () => {
  const r = inv.inventory({ source: "function check_a(){}\nfunction check_b(){}\nfunction check_c(){}\n", called: ["check_a"] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ["check_b", "check_c"]);
  assert.equal(r.line, "battery: 3 defined, 1 called, 2 orphaned [check_b, check_c]");
});

test("inventory: a battery with no checks at all is not green", () => {
  const r = inv.inventory({ source: "function helper(){}\n", called: [] });
  assert.equal(r.ok, false);
  assert.equal(r.line, "battery: 0 defined, 0 called, 0 orphaned []");
});

test("callRecorded records the name before the call, so a check that throws was still called", () => {
  const called = new Set();
  function check_throws() { throw new Error("boom"); }
  assert.throws(() => inv.callRecorded(called, check_throws), /boom/);
  assert.ok(called.has("check_throws"));
});

// ---------------------------------------------------------------- the publisher's own battery
test("the publisher's source defines exactly the checks in its CHECKS registry", () => {
  const defined = inv.definedChecks(pub.batterySource());
  assert.deepEqual(defined, pub.CHECKS.map((f) => f.name).sort());
  assert.ok(defined.length >= 7, `battery has ${defined.length} checks`);
});

test("clean run: the battery line prints, 0 orphaned, and the dry run stays green", async () => {
  const d = outDir([selfCheck("acme-prod"), selfCheck("beta-ns")]);
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w), 0, o.err);
  const n = pub.CHECKS.length;
  assert.ok(o.err.includes(`battery: ${n} defined, ${n} called, 0 orphaned []\n`), o.err);
  assert.match(o.out, /WOULD PUT/);
  assert.doesNotMatch(o.err, /REFUSED/);
});

test("the line prints even on a day with no records, and says nothing ran", async () => {
  const d = outDir([]);
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w), 2);
  assert.match(o.err, new RegExp(`battery: ${pub.CHECKS.length} defined, 0 called, ${pub.CHECKS.length} orphaned \\[check_`));
});

// ---------------------------------------------------------------- BREAK ARMS
test("BREAK ARM (--break-battery): one extra check defined and never called turns the run REFUSED and names it", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const n = pub.CHECKS.length;
  const { o, w } = io();
  assert.equal(await pub.main([...args(d), "--break-battery"], w), 2);
  assert.ok(o.err.includes(`battery: ${n + 1} defined, ${n} called, 1 orphaned [check_break_arm_never_called]\n`), o.err);
  assert.match(o.err, /^REFUSED: battery: 1 check function\(s\) defined in publish_self_checks\.js and never called by this run: check_break_arm_never_called; .*Nothing published\./m);
  assert.equal(o.out, "", "nothing is listed to publish");
});

test("BREAK ARM (source): a check function added to the battery's source but not to CHECKS is caught by the parser, not the registry", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const extra = "\nasync function check_added_and_forgotten(ctx) {\n  return null;\n}\n";
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w, { batterySource: () => pub.batterySource() + extra }), 2);
  assert.match(o.err, /1 orphaned \[check_added_and_forgotten\]/);
  assert.match(o.err, /^REFUSED: battery:/m);
});

test("BREAK ARM (runner): a registered check the loop skips is an orphan", () => {
  const d = outDir([selfCheck("acme-prod")]);
  const skipped = pub.CHECKS.filter((f) => f.name !== "check_key_declared");
  const plan = pub.planPublish({ dir: d.dir, dates: [DAY], ownKeys: new Set([ours.keyId]), nowSeconds: Math.floor(Date.parse(NOW) / 1000), checks: skipped });
  assert.equal(plan.files.length, 1, "the record passes the checks that did run");
  const r = inv.inventory({ source: pub.batterySource(), called: plan.called });
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ["check_key_declared"]);
});
