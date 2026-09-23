#!/usr/bin/env node
// tools/publish_self_checks.js — publish the daily self-check records
// (tools/self_check_daily.js --write) into the public pins repo's checks/
// directory, the only place the status page's audit column reads them from.
// Until this runs, every namespace reads BLIND no matter how often we look.
//
//   node tools/publish_self_checks.js --dir OUT --operator-keys OPERATOR_KEYS.json
//        (--dry-run | --publish) [--date YYYY-MM-DD] [--days N] [--show-bytes]
//        [--env-file PATH] [--now ISO] [--break-battery]
//
// THE READER IS THE CONTRACT. lib/_audit_status.js lists the repo tree,
// takes the blobs matching checks/(pin|observation)/<ns>/<file>.json, one
// record per file, filed under the namespace its target.ref names, and reads
// each key's newest 3 plus every file whose name says broken. The file name
// is lib/_check_record.js checkRecordPath(record):
// <checked_at>-<keyid8>-<result>.json (D22). This tool publishes exactly
// those paths, with exactly the bytes self_check_daily.js wrote.
//
// Fences, each checked for EVERY record of the run before anything is sent:
//   0. Its `rerun` is portable: no drive letter, home-directory path or
//      backslash (reason rerun_not_portable; lib/_check_record.js).
//   1. The record verifies (verifyCheckRecord: shape, Ed25519 signature over
//      every field, not future-dated). A bad signature refuses the run.
//   2. Its local path under --dir equals checkRecordPath(record): the name
//      and the content agree, so a record cannot be filed under another
//      namespace, another time, or another result. A name whose result part
//      disagrees with the signed `result` is refused first, with its own
//      reason, path_result_mismatch (the reader refuses the same).
//   3. Its checker key is in the local OPERATOR_KEYS declaration AND (live
//      only) in the PUBLISHED checks/OPERATOR_KEYS.json. A self-check signed
//      by a key the published declaration does not list would read on the
//      page as an OUTSIDE check: our own look painted green (design B5).
//   Any refusal = nothing is published, exit 2.
//   The fences are the BATTERY (check_* functions, CHECKS). Every run prints
//   `battery: N defined, M called, K orphaned [names]` (lib/_battery_inventory.js:
//   defined = parsed from this file's source, called = recorded by the runner).
//   K > 0 is REFUSED, exit 2. --break-battery adds one never-called check to
//   the source the inventory reads, to show the red.
//
// Create-only and idempotent. Live mode GETs every target path first:
// absent -> created; present with the same git blob sha -> already
// published, skipped (a second run with the same records makes no commit);
// present with different bytes -> refused (records are never overwritten).
// All GETs happen before the first PUT, so a conflict never half-publishes.
// A run that dies between PUTs resumes on the next run.
//
// --dry-run reads nothing but local files: no token, no network. It prints
// every path and the exact bytes (length + sha256, and the bytes themselves
// with --show-bytes) it would write.
//
// Auth and commit pattern: the same as velouria's genesis-checkpoint
// publisher (bridge/arcaeon/logtree_checkpoint.py via ots_anchor.py):
// GITHUB_TOKEN read from the velouria .env file, never from argv and never
// printed; Authorization: Bearer; Accept: application/vnd.github+json;
// one contents-API PUT per file to main of dan8433-user/arcaeon-witness-pins.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cr = require("../lib/_check_record.js");
const battery = require("../lib/_battery_inventory.js");

const REPO = "dan8433-user/arcaeon-witness-pins";
const BRANCH = "main";
const API = `https://api.github.com/repos/${REPO}`;
const DEFAULT_ENV_FILE = "C:/Users/USER/velouria/.env";
const OPERATOR_KEYS_REL = "checks/OPERATOR_KEYS.json";
const TOOL_NAME = "arcaeon-publish-self-checks";
const RECORD_DIRS = ["pin", "observation"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
// What the contents API reports as `sha` for a file: the git blob id.
function gitBlobSha(buf) {
  return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
}

function declaredKeys(doc) {
  if (!doc || !Array.isArray(doc.keys)) throw new Error("OPERATOR_KEYS document has no keys array");
  return new Set(doc.keys.filter((k) => k && typeof k.key === "string").map((k) => k.key));
}

// The dates a run covers: `date` and the N-1 days before it, newest first.
function datesFor(date, days) {
  if (!DATE.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  const n = Number.isInteger(days) && days > 0 ? days : 1;
  const base = Date.parse(`${date}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

// Every file under <dir>/checks/(pin|observation)/<ns>/ whose name starts
// with one of the dates. Returns [{rel, bytes}] sorted by rel. A stray file
// of the right day is collected (and then refused by validation), so a
// damaged record cannot hide by being unparseable.
function collectRecords(dir, dates) {
  const out = [];
  for (const type of RECORD_DIRS) {
    const typeDir = path.join(dir, "checks", type);
    if (!fs.existsSync(typeDir)) continue;
    for (const ns of fs.readdirSync(typeDir).sort()) {
      const nsDir = path.join(typeDir, ns);
      if (!fs.statSync(nsDir).isDirectory()) continue;
      for (const f of fs.readdirSync(nsDir).sort()) {
        if (!dates.some((d) => f.startsWith(`${d}T`))) continue;
        out.push({ rel: `checks/${type}/${ns}/${f}`, bytes: fs.readFileSync(path.join(nsDir, f)) });
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// ---------------------------------------------------------------------------
// THE BATTERY. One file against the design's record shape and the fences
// above, as named check functions run in CHECKS order. Each takes the
// per-file context {rel, bytes, ownKeys, nowSeconds, record} and returns
// null (pass) or {reason, field?} (refused); the first refusal stops the
// file. check_json fills ctx.record for the checks after it.
//
// Every run, lib/_battery_inventory.js compares the check_* functions
// DEFINED in this file's own source against the ones the runner CALLED, and
// prints `battery: N defined, M called, K orphaned [names]`. A check defined
// here and never called (not in CHECKS, or skipped by the loop) is an
// orphan, and an orphan refuses the run: a fence that did not run cannot
// pass a record.
// ---------------------------------------------------------------------------
function check_byte_order_mark(ctx) {
  const b = ctx.bytes;
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? { reason: "byte_order_mark" } : null;
}

function check_json(ctx) {
  try {
    ctx.record = JSON.parse(ctx.bytes.toString("utf-8"));
  } catch {
    return { reason: "not_json" };
  }
  return null;
}

// Fence 0: a record whose `rerun` names a local path (drive letter, home
// directory, backslash) is refused before anything else, so a user folder
// name never reaches the public repo. verifyCheckRecord refuses it too
// (validateShape); this check keeps the publisher's fence if that ever moves.
function check_rerun_portable(ctx) {
  const record = ctx.record;
  if (record && typeof record === "object" && typeof record.rerun === "string" && !cr.rerunIsPortable(record.rerun)) {
    return { reason: "rerun_not_portable", field: "rerun" };
  }
  return null;
}

// Fence 1: shape, Ed25519 signature over every field, not future-dated.
function check_record_verifies(ctx) {
  const v = cr.verifyCheckRecord(ctx.record, { nowSeconds: ctx.nowSeconds });
  return v.ok ? null : { reason: v.reason, field: v.field };
}

// Fence 2a (D22): the result in the file name is the reader's index of
// BROKENs; a name that says one result over a body that says another is
// refused by the reader, so it is refused here before it can be published.
function check_path_result(ctx) {
  if (!cr.pathResultMismatch(ctx.rel, ctx.record)) return null;
  return { reason: "path_result_mismatch", field: `name says ${cr.parseRecordFileName(ctx.rel).result}, record says ${ctx.record.result}` };
}

// Fence 2: the local path is the path the record's own content names.
function check_record_path(ctx) {
  let want;
  try {
    want = cr.checkRecordPath(ctx.record);
  } catch {
    return { reason: "no_namespace", field: "target.ref" };
  }
  return want === ctx.rel ? null : { reason: "path_mismatch", field: `expected ${want}` };
}

// Fence 3 (local half): the checker key is in the local declaration.
function check_key_declared(ctx) {
  return ctx.ownKeys.has(ctx.record.checker.key) ? null : { reason: "key_not_declared", field: "checker.key" };
}

const CHECKS = Object.freeze([
  check_byte_order_mark,
  check_json,
  check_rerun_portable,
  check_record_verifies,
  check_path_result,
  check_record_path,
  check_key_declared,
]);

// This file's own source: the battery's definitions, read fresh every run.
function batterySource() {
  return fs.readFileSync(__filename, "utf-8");
}

// The runner. Returns {ok:true, rel, bytes, record} or {ok:false, rel,
// reason, field?}. `called` (a Set) receives the name of every check it
// invokes, recorded before the call.
function validateRecordFile({ rel, bytes }, { ownKeys, nowSeconds, called = new Set(), checks = CHECKS }) {
  const ctx = { rel, bytes, ownKeys, nowSeconds, record: undefined };
  for (const fn of checks) {
    const r = battery.callRecorded(called, fn, ctx);
    if (r) return { ok: false, rel, reason: r.reason, field: r.field };
  }
  return { ok: true, rel, bytes, record: ctx.record };
}

// Local only. Returns {files, refused, called}.
function planPublish({ dir, dates, ownKeys, nowSeconds, checks = CHECKS }) {
  const files = [];
  const refused = [];
  const called = new Set();
  for (const f of collectRecords(dir, dates)) {
    const r = validateRecordFile(f, { ownKeys, nowSeconds, called, checks });
    if (r.ok) files.push(r);
    else refused.push(r);
  }
  return { files, refused, called };
}

// The break arm's extra check: a real function, defined in the source the
// inventory reads (appended, never written to disk) and never called.
const BREAK_ARM_SOURCE = "\nfunction check_break_arm_never_called(ctx) {\n  return null;\n}\n";

function readToken(envFile) {
  for (const line of fs.readFileSync(envFile, "utf-8").split(/\r?\n/)) {
    if (line.startsWith("GITHUB_TOKEN=")) return line.split("=").slice(1).join("=").trim();
  }
  throw new Error(`GITHUB_TOKEN not found in ${envFile}`);
}

// The contents-API call, same headers as ots_anchor._gh (plus the
// User-Agent GitHub requires, which urllib sends by itself and fetch does
// not). Returns {status, body}; never throws on an HTTP error status.
async function gh(method, url, tok, body) {
  const headers = {
    Authorization: `Bearer ${tok}`,
    Accept: "application/vnd.github+json",
    "User-Agent": TOOL_NAME,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}

function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

class Refused extends Error {
  constructor(outcome, detail) {
    super(detail);
    this.outcome = outcome;
  }
}

// Live publish of an already-validated plan. `ghImpl(method, url, tok, body)`
// and `token()` are injected so the tests run against a stub. Returns
// {created:[{rel, commit}], already:[rel]}.
async function publishPlan(files, { ghImpl = gh, token, api = API, branch = BRANCH } = {}) {
  const tok = token();
  // Fence 3, against the PUBLISHED declaration.
  const kd = await ghImpl("GET", `${api}/contents/${OPERATOR_KEYS_REL}?ref=${branch}`, tok);
  if (kd.status === 404) {
    throw new Refused("refused", `${OPERATOR_KEYS_REL} is not published on ${branch}; a self-check must not land before the declaration that marks its key as ours`);
  }
  if (kd.status !== 200) throw new Refused("could-not-look", `GET ${OPERATOR_KEYS_REL} -> ${kd.status}`);
  let published;
  try {
    published = declaredKeys(JSON.parse(Buffer.from(kd.body.content || "", "base64").toString("utf-8")));
  } catch (err) {
    throw new Refused("refused", `published ${OPERATOR_KEYS_REL} is unreadable (${err.message})`);
  }
  for (const f of files) {
    if (!published.has(f.record.checker.key)) {
      throw new Refused("refused", `${f.rel}: key ${f.record.checker.key} is not in the published ${OPERATOR_KEYS_REL}; it would read as an outside check`);
    }
  }

  // Every path looked at before the first PUT.
  const toCreate = [];
  const already = [];
  for (const f of files) {
    const r = await ghImpl("GET", `${api}/contents/${encodePath(f.rel)}?ref=${branch}`, tok);
    if (r.status === 404) { toCreate.push(f); continue; }
    if (r.status !== 200) throw new Refused("could-not-look", `GET ${f.rel} -> ${r.status}`);
    if (r.body && r.body.sha === gitBlobSha(f.bytes)) { already.push(f.rel); continue; }
    throw new Refused("refused", `${f.rel} already exists in the pins repo with different bytes; check records are create-only`);
  }

  const created = [];
  for (const f of toCreate) {
    const body = {
      message: `checks: ${f.record.result} ${f.rel.split("/")[2]} (self-check ${f.record.checked_at}, key ${cr.keyIdShort(f.record.checker.key)})`,
      branch,
      content: f.bytes.toString("base64"),
    };
    const r = await ghImpl("PUT", `${api}/contents/${encodePath(f.rel)}`, tok, body);
    if (r.status !== 200 && r.status !== 201) {
      const err = new Refused("error", `PUT ${f.rel} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      err.created = created;
      throw err;
    }
    created.push({ rel: f.rel, commit: r.body && r.body.commit && r.body.commit.sha });
  }
  return { created, already };
}

function parseArgs(argv) {
  const a = { envFile: DEFAULT_ENV_FILE, days: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${k} needs a value`); return argv[i]; };
    if (k === "--dir") a.dir = next();
    else if (k === "--operator-keys") a.operatorKeys = next();
    else if (k === "--date") a.date = next();
    else if (k === "--days") a.days = Number(next());
    else if (k === "--env-file") a.envFile = next();
    else if (k === "--now") a.now = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--publish") a.publish = true;
    else if (k === "--show-bytes") a.showBytes = true;
    else if (k === "--break-battery") a.breakBattery = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// Returns an exit code. `io` = {out, err} writers; `deps` = {ghImpl, token}
// for tests. 0 = published or nothing new; 2 = refused / error / no records.
async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, deps = {}) {
  const a = parseArgs(argv);
  if (a.help) {
    io.out(fs.readFileSync(__filename, "utf-8").split("\n").filter((l) => l.startsWith("//")).slice(0, 54).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (!a.dir) throw new Error("--dir is required (the self-check --out directory)");
  if (!a.operatorKeys) throw new Error("--operator-keys is required: every record's key must be shown to be declared as ours");
  if (!!a.dryRun === !!a.publish) throw new Error("exactly one of --dry-run or --publish is required");
  if (!Number.isInteger(a.days) || a.days < 1 || a.days > 31) throw new Error("--days must be an integer 1..31");

  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now is not a time: ${a.now}`);
  const nowSeconds = Math.floor(nowMs / 1000);
  const date = a.date || new Date(nowMs).toISOString().slice(0, 10);
  const dates = datesFor(date, a.days);
  const ownKeys = declaredKeys(JSON.parse(fs.readFileSync(a.operatorKeys, "utf-8")));

  const { files, refused, called } = planPublish({ dir: a.dir, dates, ownKeys, nowSeconds });
  const span = dates.length === 1 ? dates[0] : `${dates[dates.length - 1]}..${dates[0]}`;
  for (const r of refused) io.err(`REFUSED  ${r.rel}  ${r.reason}${r.field ? ` (${r.field})` : ""}\n`);
  // The battery line, every run, before any verdict on the day.
  const source = (deps.batterySource || batterySource)() + (a.breakBattery ? BREAK_ARM_SOURCE : "");
  const inv = battery.inventory({ source, called });
  io.err(`${inv.line}\n`);
  if (refused.length) {
    io.err(`${refused.length} record(s) for ${span} failed validation; nothing published.\n`);
    return 2;
  }
  if (!files.length) {
    io.err(`no self-check records for ${span} under ${a.dir}; nothing to publish.\n`);
    return 2;
  }
  if (!inv.ok) {
    const why = inv.defined.length
      ? `${inv.orphaned.length} check function(s) defined in ${path.basename(__filename)} and never called by this run: ${inv.orphaned.join(", ")}`
      : `no check functions found in ${path.basename(__filename)}`;
    io.err(`REFUSED: battery: ${why}; a fence that did not run cannot pass a record. Nothing published.\n`);
    return 2;
  }

  if (a.dryRun) {
    let total = 0;
    for (const f of files) {
      total += f.bytes.length;
      io.out(`WOULD PUT  ${BRANCH}:${f.rel}  ${f.bytes.length} bytes  sha256 ${sha256hex(f.bytes)}  blob ${gitBlobSha(f.bytes)}  ${f.record.result}\n`);
      if (a.showBytes) io.out(f.bytes.toString("utf-8") + (f.bytes[f.bytes.length - 1] === 0x0a ? "" : "\n"));
    }
    io.err(`dry run: ${files.length} record(s) for ${span}, ${total} bytes, would go to ${REPO} (create-only; paths already there with the same bytes are skipped). No token read, no network.\n`);
    return 0;
  }

  const token = deps.token || (() => readToken(a.envFile));
  try {
    const res = await publishPlan(files, { ghImpl: deps.ghImpl || gh, token });
    for (const rel of res.already) io.out(`ALREADY    ${rel}\n`);
    for (const c of res.created) io.out(`CREATED    ${c.rel}  commit ${c.commit}\n`);
    io.err(`${res.created.length} created, ${res.already.length} already published, for ${span} in ${REPO}.\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    for (const c of err.created || []) io.out(`CREATED    ${c.rel}  commit ${c.commit}\n`);
    // Display words use spaces (COULD NOT LOOK, as every other tool prints it);
    // err.outcome keeps its hyphenated internal value.
    io.err(`${err.outcome.toUpperCase().replace(/-/g, " ")}: ${err.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = {
  REPO, BRANCH, API, OPERATOR_KEYS_REL, CHECKS, BREAK_ARM_SOURCE, batterySource,
  sha256hex, gitBlobSha, declaredKeys, datesFor, collectRecords, validateRecordFile,
  planPublish, publishPlan, readToken, parseArgs, main, Refused,
};
