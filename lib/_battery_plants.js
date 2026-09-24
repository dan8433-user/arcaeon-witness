// _battery_plants.js — the third battery guard: records planted where a
// fence must refuse them, so a fence that runs and sees nothing is caught.
//
// WHY (2026-09-23). lib/_battery_inventory.js answers two questions every
// run: is each check DEFINED, and was it CALLED. Neither can catch a check
// that ran and saw nothing: a fence whose refusal was removed is still
// defined and still called, and on a clean day every record passes it
// anyway (the class a correspondent measured as "0 of 17 probes noticed a
// guard removed"). The only way to see that a fence still bites is to feed
// it something it must bite on. So every run of tools/publish_self_checks.js
// also feeds each per-record fence one PLANTED BAD record that this fence,
// and this fence alone, must refuse with its own reason, and feeds the
// whole battery one PLANTED GOOD record that every fence must pass:
//
//   plants: P planted, Q caught, R missed [fence names]
//
// R > 0 refuses the run (exit 2) before any token read or network call.
//
// ISOLATION. Each bad plant is judged by its own fence called directly, not
// by the chain. In the chain a later fence often refuses the same record
// for another reason (verifyCheckRecord also refuses a non-portable rerun),
// and that later refusal would hide the removal of the earlier fence: the
// exact blind spot this guard is for. The good plant goes through the whole
// chain, in order, the way a real record does.
//
// COVERAGE. A fence in the battery with no plant is reported missed (named
// "<fence> (no plant)"), and a plant whose fence is no longer in the
// battery is reported missed too, so adding a fence without adding its plant
// turns the run red.
//
// THE PLANTS NEVER LEAVE THIS PROCESS. They are built in memory, per run,
// from this source: signed with two throwaway Ed25519 keys generated on each
// call and dropped when the run ends (no key is stored anywhere, and neither
// key is in any OPERATOR_KEYS declaration). This module requires no fs and
// writes nothing: plants never enter the publish set, the dry-run file list,
// the checks/ store, the --dir the daily task writes into, or any file the
// daily task publishes. Their namespace (PLANT_NS) and URLs (.invalid, a
// reserved name that cannot resolve) mark them if one were ever seen
// outside; tests assert none is.

"use strict";

const cr = require("./_check_record.js");

const PLANT_NS = "battery-plant-never-published";
const ZERO64 = "0".repeat(64);

function isoAt(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function recordBytes(rec) {
  return Buffer.from(JSON.stringify(rec, null, 1) + "\n", "utf-8");
}

// The planted good record's unsigned body: every field the schema requires,
// valid, a minute before `nowSeconds`.
function goodUnsigned(nowSeconds) {
  return {
    kind: "check",
    v: 1,
    target: { type: "pin", ref: `pins/${PLANT_NS}/00000001.json`, digest: `sha256:${ZERO64}` },
    claim_checked: "battery-plant",
    inputs: [{ url: `https://plant.invalid/pins/${PLANT_NS}/00000001.json`, sha256: ZERO64 }],
    result: "VERIFIED",
    detail: "planted good record; never published",
    checked_at: isoAt(nowSeconds - 60),
    checker: { name: "battery plant (never published)", binding_url: "https://plant.invalid/keys" },
    tool: { name: "arcaeon-battery-plant", version: "1", impl: "reference", source_sha256: ZERO64 },
    trust_dependencies: [],
    rerun: "node plant.js",
  };
}

// Build this run's plants. Returns {ownKeys, good, bad}: `ownKeys` is the
// declaration the plant run uses (the plant key only, never the operator's);
// `good` = {name, rel, bytes}; `bad` = [{name, fence, expect, rel, bytes}],
// one per fence, `expect` the refusal reason that fence must give.
function buildPlants({ nowSeconds }) {
  if (!Number.isInteger(nowSeconds)) throw new TypeError("battery_plants: nowSeconds must be an integer");
  const plantKey = cr.generateKeyPair();
  const strangerKey = cr.generateKeyPair();
  const good = cr.signCheckRecord(goodUnsigned(nowSeconds), plantKey.privateKey);
  const goodRel = cr.checkRecordPath(good);
  const goodBytes = recordBytes(good);

  const stranger = cr.signCheckRecord(goodUnsigned(nowSeconds), strangerKey.privateKey);
  const fileName = goodRel.split("/").pop();

  const bad = [
    { name: "byte_order_mark_prefix", fence: "check_byte_order_mark", expect: "byte_order_mark",
      rel: goodRel, bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), goodBytes]) },
    { name: "malformed_json_body", fence: "check_json", expect: "not_json",
      rel: goodRel, bytes: goodBytes.subarray(0, goodBytes.length - 3) },
    { name: "rerun_names_a_drive", fence: "check_rerun_portable", expect: "rerun_not_portable",
      rel: goodRel, bytes: recordBytes({ ...good, rerun: "py C:/plant/verify.py" }) },
    { name: "bad_signature", fence: "check_record_verifies", expect: "bad_signature",
      rel: goodRel, bytes: recordBytes({ ...good, detail: "planted good record; edited after signing" }) },
    { name: "name_says_broken_body_says_verified", fence: "check_path_result", expect: "path_result_mismatch",
      rel: goodRel.replace(/-verified\.json$/, "-broken.json"), bytes: goodBytes },
    { name: "filed_under_another_namespace", fence: "check_record_path", expect: "path_mismatch",
      rel: `checks/pin/${PLANT_NS}-elsewhere/${fileName}`, bytes: goodBytes },
    { name: "unknown_key_id", fence: "check_key_declared", expect: "key_not_declared",
      rel: cr.checkRecordPath(stranger), bytes: recordBytes(stranger) },
  ];
  return {
    ownKeys: new Set([plantKey.keyId]),
    good: { name: "good", rel: goodRel, bytes: goodBytes },
    bad,
  };
}

// Call one fence. A throw is recorded as {threw}: the real runner would
// crash (exit 2), but a fence that throws has not refused with its reason.
function callFence(fn, ctx) {
  try {
    return { r: fn(ctx) };
  } catch (err) {
    return { threw: err && err.message ? err.message : String(err) };
  }
}

function parsedOrUndefined(bytes) {
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
}

// Run the plants against `checks` (the battery, in order). Returns
// {planted, caught, missed:[{fence, plant, what}], ok, line}.
function runPlants({ checks, nowSeconds, plants = buildPlants({ nowSeconds }) }) {
  const byName = new Map(checks.map((fn) => [fn.name, fn]));
  const missed = [];
  let caught = 0;

  for (const p of plants.bad) {
    const fn = byName.get(p.fence);
    if (!fn) {
      missed.push({ fence: p.fence, plant: p.name, what: "has no such fence in the battery" });
      continue;
    }
    const ctx = { rel: p.rel, bytes: p.bytes, ownKeys: plants.ownKeys, nowSeconds, record: parsedOrUndefined(p.bytes) };
    const res = callFence(fn, ctx);
    if (res.r && res.r.reason === p.expect) { caught += 1; continue; }
    const what = res.threw !== undefined
      ? `threw (${res.threw}), expected refusal ${p.expect}`
      : res.r
        ? `refused with ${res.r.reason}, not ${p.expect}`
        : `passed (expected refusal ${p.expect})`;
    missed.push({ fence: p.fence, plant: p.name, what });
  }

  // The good plant: the whole chain, in order, like a real record.
  const ctx = { rel: plants.good.rel, bytes: plants.good.bytes, ownKeys: plants.ownKeys, nowSeconds, record: undefined };
  let goodPassed = true;
  for (const fn of checks) {
    const res = callFence(fn, ctx);
    if (res.threw !== undefined || res.r) {
      goodPassed = false;
      missed.push({
        fence: fn.name,
        plant: plants.good.name,
        what: res.threw !== undefined ? `threw (${res.threw}); the good plant must pass every fence` : `refused (${res.r.reason}); the good plant must pass every fence`,
      });
      break;
    }
  }
  if (goodPassed) caught += 1;

  // Coverage: every fence has a plant.
  const planted = new Set(plants.bad.map((p) => p.fence));
  for (const fn of checks) {
    if (!planted.has(fn.name)) missed.push({ fence: fn.name, plant: null, what: "no plant" });
  }

  const total = plants.bad.length + 1;
  return {
    planted: total,
    caught,
    missed,
    ok: missed.length === 0,
    line: plantsLine(total, caught, missed),
  };
}

function plantsLine(planted, caught, missed) {
  const names = missed.map((m) => (m.what === "no plant" ? `${m.fence} (no plant)` : m.fence));
  return `plants: ${planted} planted, ${caught} caught, ${missed.length} missed [${names.join(", ")}]`;
}

// One human sentence per miss, for the REFUSED line.
function describeMissed(missed) {
  return missed.map((m) => (m.plant ? `${m.fence}: plant ${m.plant} ${m.what}` : `${m.fence}: no plant`)).join("; ");
}

// A copy of `checks` with fence `name` replaced by a pass-through of the
// same name: defined, called, and blind. The break arm for this guard.
function blindFence(checks, name) {
  if (!checks.some((fn) => fn.name === name)) throw new Error(`no fence named ${name} in the battery`);
  return checks.map((fn) => {
    if (fn.name !== name) return fn;
    const blind = (ctx) => (name === "check_json" ? (ctx.record = parsedOrUndefined(ctx.bytes), null) : null);
    Object.defineProperty(blind, "name", { value: name });
    return blind;
  });
}

module.exports = { PLANT_NS, buildPlants, runPlants, plantsLine, describeMissed, blindFence };
