// test/no_delete_record.test.js — the public record only grows.
//
// Verifier-two D1/D2 (2026-09-22): 65 published records were deleted from the
// pin repo on 2026-08-14 as "test cleanup". This suite holds two lines:
//   1. No code in lib/, api/ or tools/ can issue a DELETE against the pin repo.
//      The only DELETE calls allowed are named below with the repo they hit.
//   2. The replacement, tools/supersede_namespace.js, adds a record and never
//      removes or overwrites one.
// Each line has a break arm that proves the check can fail.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const tns = require("../lib/_test_ns.js");
const { supersede } = require("../tools/supersede_namespace.js");

const ROOT = path.join(__dirname, "..");

// file -> why a DELETE there is not a deletion from the public record.
const ALLOWED_DELETE = {
  "lib/_balance.js": "private usage/balance store (GITHUB_USAGE_REPO), not the pin repo; no callers",
  "tools/ceiling_probe.js": "deletes only the throwaway probe repository it created itself",
};

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsFiles(rel));
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// A deletion path: an HTTP DELETE, a `git rm`, or a contents-API delete helper.
const DELETE_RE = /method\s*:\s*["'`]DELETE["'`]|\bgit\s+rm\b|\bdeleteFile\s*\(/;

function violations(files, read) {
  return files.filter((f) => DELETE_RE.test(read(f)) && !(f in ALLOWED_DELETE));
}

test("no DELETE path against the public record in lib/, api/, tools/", () => {
  const files = ["lib", "api", "tools"].flatMap(jsFiles);
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  assert.deepEqual(violations(files, read), []);
  // The allowed DELETE in _balance.js must target the usage repo, not REPO.
  const bal = read("lib/_balance.js");
  const m = bal.match(/fetch\(`\$\{API\}\/repos\/\$\{(\w+)\}[^`]*`,\s*\{\s*method:\s*"DELETE"/);
  assert.ok(m, "could not find the DELETE call in _balance.js; re-audit the allowlist");
  assert.equal(m[1], "USAGE_REPO");
  // The pin store itself exports nothing that deletes.
  const store = require("../lib/_store.js");
  assert.deepEqual(Object.keys(store).filter((k) => /del|remove|rm/i.test(k)), []);
});

test("break arm: a DELETE added to the pin store is caught", () => {
  const fake = { "lib/_store.js": 'await fetch(url, { method: "DELETE", body })' };
  assert.deepEqual(violations(["lib/_store.js"], (f) => fake[f]), ["lib/_store.js"]);
  const fake2 = { "tools/cleanup.js": 'execSync("git rm pins/veltest-x/latest.json")' };
  assert.deepEqual(violations(["tools/cleanup.js"], (f) => fake2[f]), ["tools/cleanup.js"]);
});

test("reserved and legacy test prefixes", () => {
  assert.equal(tns.RESERVED_TEST_PREFIX, "veltest-");
  assert.ok(tns.isTestNamespace("veltest-sm-35120afaf8"));
  assert.ok(tns.isTestNamespace("velouria-tmp-renew-0814"));
  assert.ok(tns.isTestNamespace("test-freeplan-smoke"));
  assert.ok(!tns.isTestNamespace("velouria-selftest"));
  assert.ok(!tns.isTestNamespace("acme-prod"));
});

function fakeStore(files) {
  const writes = [];
  return {
    writes,
    getFile: async (p) => (p in files ? { json: files[p], sha: "s" } : null),
    putFile: async (p, obj, msg, sha) => { writes.push({ p, obj, msg, sha }); return { commit: { sha: "c1" } }; },
  };
}

const NOW = "2026-09-22T20:00:00.000Z";

test("supersede publishes a NEW create-only record and leaves the pins alone", async () => {
  const st = fakeStore({ "pins/veltest-a-1/latest.json": { seq: 3 } });
  const out = await supersede({ namespace: "veltest-a-1", reason: "audit fixture done", now: NOW, write: true }, st);
  assert.equal(out.ok, true);
  assert.equal(st.writes.length, 1);
  const w = st.writes[0];
  assert.equal(w.p, "superseded/veltest-a-1.json");
  assert.equal(w.sha, null, "must be create-only");
  assert.equal(w.obj.kind, "superseded");
  assert.equal(w.obj.last_seq, 3);
  assert.equal(w.obj.superseded_at, NOW);
  assert.ok(!w.p.startsWith("pins/") && !w.p.startsWith("observations/"));
});

test("dry run is the default: nothing written", async () => {
  const st = fakeStore({});
  const out = await supersede({ namespace: "veltest-b", reason: "smoke test done", now: NOW }, st);
  assert.equal(out.dryRun, true);
  assert.equal(st.writes.length, 0);
});

test("an existing supersede record is never overwritten", async () => {
  const st = fakeStore({ "superseded/veltest-c.json": { kind: "superseded" } });
  const out = await supersede({ namespace: "veltest-c", reason: "second attempt here", now: NOW, write: true }, st);
  assert.equal(out.refused, "already-superseded");
  assert.equal(st.writes.length, 0);
});

test("a namespace with no test prefix is refused unless asked deliberately", async () => {
  const st = fakeStore({ "pins/velouria-selftest/latest.json": { seq: 4 } });
  const r1 = await supersede({ namespace: "velouria-selftest", reason: "self test finished", now: NOW, write: true }, st);
  assert.equal(r1.refused, "not-a-test-namespace");
  assert.equal(st.writes.length, 0);
  const r2 = await supersede({ namespace: "velouria-selftest", reason: "self test finished", now: NOW, write: true, anyNamespace: true }, st);
  assert.equal(r2.ok, true);
  assert.equal(st.writes[0].obj.test_namespace, false);
});

test("missing reason or zoneless time raises, never defaults", () => {
  assert.throws(() => tns.buildSupersedeRecord({ namespace: "veltest-x", reason: "", lastSeq: 0, now: NOW }));
  assert.throws(() => tns.buildSupersedeRecord({ namespace: "veltest-x", reason: "long enough", lastSeq: 0, now: "2026-09-22T20:00:00" }));
});
