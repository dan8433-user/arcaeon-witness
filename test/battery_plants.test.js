// test/battery_plants.test.js — the third battery guard. Defined and called
// (lib/_battery_inventory.js) cannot see a fence that ran and saw nothing;
// lib/_battery_plants.js feeds every per-record fence of
// tools/publish_self_checks.js one planted record it alone must refuse, and
// the whole battery one planted good record it must pass. BREAK ARMS: a
// blinded fence (same name, still called, refuses nothing) leaves the battery
// line green and turns the plants line red, naming the fence and the plant;
// a fence that refuses everything is caught by the good plant.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const plantsLib = require("../lib/_battery_plants.js");
const cr = require("../lib/_check_record.js");
const { unsignedRecord } = require("./helpers/check_fixtures.js");
const pub = require("../tools/publish_self_checks.js");

const ours = cr.generateKeyPair();
const DAY = "2026-09-23";
const NOW = `${DAY}T14:00:00Z`;
const NOW_S = Math.floor(Date.parse(NOW) / 1000);
const FENCES = pub.CHECKS.map((f) => f.name);

function selfCheck(ns) {
  return cr.signCheckRecord(unsignedRecord({
    target: { type: "pin", ref: `pins/${ns}/00000004.json` },
    inputs: [{ url: `https://raw.githubusercontent.com/o/r/main/pins/${ns}/00000004.json`, sha256: "ab".repeat(32) }],
    checked_at: `${DAY}T13:40:45Z`,
    checker: { name: "arcaeon operator daily self-check", binding_url: "https://github.com/o/r/blob/main/checks/OPERATOR_KEYS.json" },
  }), ours.privateKey);
}
function outDir(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plants-"));
  for (const rec of records) {
    const dest = path.join(dir, cr.checkRecordPath(rec));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(rec, null, 1) + "\n");
  }
  const keys = path.join(dir, "OPERATOR_KEYS.json");
  fs.writeFileSync(keys, JSON.stringify({ keys: [{ key: ours.keyId }] }));
  return { dir, keys };
}
function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return out.sort();
}
function io() {
  const o = { out: "", err: "" };
  return { o, w: { out: (s) => { o.out += s; }, err: (s) => { o.err += s; } } };
}
const args = (d) => ["--dir", d.dir, "--operator-keys", d.keys, "--date", DAY, "--now", NOW, "--dry-run"];
const GREEN_BATTERY = `battery: ${FENCES.length} defined, ${FENCES.length} called, 0 orphaned []\n`;
const GREEN_PLANTS = `plants: ${FENCES.length + 1} planted, ${FENCES.length + 1} caught, 0 missed []\n`;

// A fence that refuses every record, with the reason its own plant expects:
// it still catches its bad plant, and only the good plant can see it is broken.
function refusesEverything(name, reason) {
  const fn = () => ({ reason });
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

// ---------------------------------------------------------------- the plants
test("one planted bad record per fence, each for a fence in the battery, and every fence has one", () => {
  const p = plantsLib.buildPlants({ nowSeconds: NOW_S });
  assert.deepEqual(p.bad.map((b) => b.fence).sort(), [...FENCES].sort());
  assert.equal(new Set(p.bad.map((b) => b.name)).size, p.bad.length, "plant names are distinct");
  for (const b of p.bad) assert.ok(b.rel.includes(plantsLib.PLANT_NS), b.rel);
  assert.ok(p.good.rel.startsWith(`checks/pin/${plantsLib.PLANT_NS}/`));
  // the plant key is nobody's: not the operator's
  assert.ok(!p.ownKeys.has(ours.keyId));
});

test("clean battery: all plants caught, the good plant passes every fence", () => {
  const r = plantsLib.runPlants({ checks: pub.CHECKS, nowSeconds: NOW_S });
  assert.equal(r.ok, true, JSON.stringify(r.missed));
  assert.equal(r.planted, FENCES.length + 1);
  assert.equal(r.caught, FENCES.length + 1);
  assert.equal(`${r.line}\n`, GREEN_PLANTS);
});

test("ISOLATION: blinding any one fence misses exactly that fence's plant, even where a later fence would refuse the same record", () => {
  for (const name of FENCES) {
    const r = plantsLib.runPlants({ checks: plantsLib.blindFence(pub.CHECKS, name), nowSeconds: NOW_S });
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.missed.map((m) => m.fence), [name], name);
    assert.equal(r.caught, FENCES.length, name);
    assert.equal(r.line, `plants: ${FENCES.length + 1} planted, ${FENCES.length} caught, 1 missed [${name}]`);
  }
});

test("a fence that refuses with the wrong reason has not caught its plant", () => {
  const checks = pub.CHECKS.map((f) => (f.name === "check_record_verifies" ? refusesEverything(f.name, "unsigned") : f));
  const r = plantsLib.runPlants({ checks, nowSeconds: NOW_S });
  const m = r.missed.find((x) => x.plant === "bad_signature");
  assert.ok(m, JSON.stringify(r.missed));
  assert.match(m.what, /refused with unsigned, not bad_signature/);
});

test("COVERAGE: a fence with no plant, and a plant whose fence is gone, are both missed", () => {
  const extra = () => null;
  Object.defineProperty(extra, "name", { value: "check_added_without_a_plant" });
  const r1 = plantsLib.runPlants({ checks: [...pub.CHECKS, extra], nowSeconds: NOW_S });
  assert.equal(r1.ok, false);
  assert.match(r1.line, /1 missed \[check_added_without_a_plant \(no plant\)\]$/);
  const r2 = plantsLib.runPlants({ checks: pub.CHECKS.filter((f) => f.name !== "check_key_declared"), nowSeconds: NOW_S });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.missed.map((m) => [m.fence, m.plant]), [["check_key_declared", "unknown_key_id"]]);
});

// ---------------------------------------------------------------- the publisher
test("clean run: battery line, then plants line, all caught, no REFUSED, dry run green", async () => {
  const d = outDir([selfCheck("acme-prod"), selfCheck("beta-ns")]);
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w), 0, o.err);
  const ib = o.err.indexOf(GREEN_BATTERY);
  const ip = o.err.indexOf(GREEN_PLANTS);
  assert.ok(ib >= 0 && ip > ib, o.err);
  assert.equal(ip, ib + GREEN_BATTERY.length, "plants line directly follows the battery line");
  assert.doesNotMatch(o.err, /REFUSED/);
  assert.match(o.out, /WOULD PUT/);
});

test("BREAK ARM (--break-plants): the blinded fence still runs, the battery line stays green, the plant is missed and the run is REFUSED", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const { o, w } = io();
  assert.equal(await pub.main([...args(d), "--break-plants"], w), 2);
  const n = FENCES.length;
  const plantsRed = `plants: ${n + 1} planted, ${n} caught, 1 missed [check_record_verifies]\n`;
  const ib = o.err.indexOf(GREEN_BATTERY);
  const ip = o.err.indexOf(plantsRed);
  const ir = o.err.indexOf("REFUSED: plants: check_record_verifies: plant bad_signature passed (expected refusal bad_signature);");
  assert.ok(ib >= 0 && ip > ib && ir > ip, o.err);
  assert.match(o.err, /Nothing published\.\n$/);
  assert.equal(o.out, "", "nothing is listed to publish");
});

test("BREAK ARM (--break-plants FENCE): names the fence it was given", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const { o, w } = io();
  assert.equal(await pub.main([...args(d), "--break-plants", "check_key_declared"], w), 2);
  assert.match(o.err, /1 missed \[check_key_declared\]\n/);
  assert.match(o.err, /^REFUSED: plants: check_key_declared: plant unknown_key_id passed \(expected refusal key_not_declared\);/m);
  await assert.rejects(pub.main([...args(d), "--break-plants", "check_nope"], io().w), /no fence named check_nope/);
});

test("BREAK ARM (good plant): a fence broken to refuse everything catches its own plant, and the good plant reports it", async () => {
  const checks = pub.CHECKS.map((f) => (f.name === "check_path_result" ? refusesEverything(f.name, "path_result_mismatch") : f));
  const d = outDir([selfCheck("acme-prod")]);
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w, { checks }), 2);
  const n = FENCES.length;
  assert.ok(o.err.includes(`plants: ${n + 1} planted, ${n} caught, 1 missed [check_path_result]\n`), o.err);
  assert.match(o.err, /^REFUSED: plants: check_path_result: plant good refused \(path_result_mismatch\); the good plant must pass every fence;/m);
  assert.equal(o.out, "");
});

test("the plants line prints on a day with no records, and the plants are still caught", async () => {
  const d = outDir([]);
  const { o, w } = io();
  assert.equal(await pub.main(args(d), w), 2);
  assert.ok(o.err.includes(GREEN_PLANTS), o.err);
});

test("ORDER: battery, plants, then the REFUSED lines (plants first, then battery) when both arms are on", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const { o, w } = io();
  assert.equal(await pub.main([...args(d), "--break-plants", "--break-battery"], w), 2);
  const lines = o.err.trimEnd().split("\n");
  assert.match(lines[0], /^battery: /);
  assert.match(lines[1], /^plants: /);
  assert.match(lines[2], /^REFUSED: plants: /);
  assert.match(lines[3], /^REFUSED: battery: /);
  assert.equal(lines.length, 4, o.err);
});

test("PLANTS NEVER PUBLISHED: not in the dry-run list or bytes, not in the plan, nothing written to --dir", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const before = listTree(d.dir);
  const { o, w } = io();
  assert.equal(await pub.main([...args(d), "--show-bytes"], w), 0, o.err);
  for (const s of [plantsLib.PLANT_NS, "plant.invalid", "battery plant"]) {
    assert.ok(!o.out.includes(s), `dry-run output carries ${s}`);
  }
  assert.equal((o.out.match(/^WOULD PUT /gm) || []).length, 1, "only the one real record is listed");
  assert.deepEqual(listTree(d.dir), before, "the run wrote nothing into --dir");
  const plan = pub.planPublish({ dir: d.dir, dates: [DAY], ownKeys: new Set([ours.keyId]), nowSeconds: NOW_S });
  assert.ok(plan.files.every((f) => !f.rel.includes(plantsLib.PLANT_NS)));
  // the module has no file access at all
  assert.doesNotMatch(fs.readFileSync(require.resolve("../lib/_battery_plants.js"), "utf-8"), /require\("node:fs"\)|require\("fs"\)/);
});

test("VOCABULARY: the red word stays REFUSED; the plants add no verdict word", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const { o, w } = io();
  await pub.main([...args(d), "--break-plants"], w);
  for (const line of o.err.trimEnd().split("\n")) {
    assert.match(line, /^(battery: |plants: |REFUSED: )/, line);
  }
  assert.doesNotMatch(o.err, /\b(MISSED|FAILED|UNDETERMINED|NOT FULLY READ):/);
});
