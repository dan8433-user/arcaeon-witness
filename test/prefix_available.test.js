// test/prefix_available.test.js — GET /api/prefix-available?prefix=<p>, the
// live availability check behind the rev-2b prefix picker (board item
// I-daniel-01; Daniel 12288/12291 "shouldnt we let our users pick a prefix
// that isnt selected").
//
// Everything here drives the REAL route: api/fulfill.js's ?op=prefix-available
// dispatch into lib/_prefix_check.js, over the real lib/_keys.js
// listPrefixes() fan-out against the mock GitHub store. Nothing stubs
// listPrefixes — a test that stubs the availability source cannot catch the
// availability source being wrong.
//
// The three cases the build was asked for are named CONTRACT below: a taken
// prefix answers false, a free one answers true, an invalid one is a 400.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
delete process.env.WITNESS_KEYS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const prefixCheck = require("../lib/_prefix_check.js");
const keys = require("../lib/_keys.js");
const fulfill = require("../api/fulfill.js");

const USAGE = process.env.GITHUB_USAGE_REPO;

let gh, restoreFetch;
let ipCounter = 0;

// A distinct caller IP per call keeps the shared per-IP limiter in
// lib/_ratelimit.js (module state, survives between tests in this process)
// from turning an unrelated assertion into a 429 halfway down the file. The
// limiter gets its own test below, on its own IP.
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

// Seed an issued-key record the way api/fulfill.js writes one — the shape
// lib/_keys.js listPrefixes() reads namespace_prefix out of.
function seedIssuedKey(prefix, tag) {
  const hash = `${tag}`.padEnd(64, "0").slice(0, 64);
  gh.seed(USAGE, `keys/${hash}.json`, {
    key_hash: hash,
    namespace_prefix: prefix,
    plan: "free",
    source: "test",
  });
}

async function ask(prefix, { ip = null, method = "GET" } = {}) {
  const query = { op: "prefix-available" };
  if (prefix !== undefined) query.prefix = prefix;
  const req = makeReq({
    method,
    query,
    headers: { "x-forwarded-for": ip || freshIp(), accept: "application/json" },
  });
  const res = makeRes();
  await fulfill(req, res); // the real route: dispatch lives in api/fulfill.js
  return res;
}

beforeEach(() => {
  gh = new MockGitHubStore();
  restoreFetch = install(gh);
  prefixCheck._resetCache();
});

afterEach(() => {
  restoreFetch();
  prefixCheck._resetCache();
  delete process.env.WITNESS_KEYS;
});

// ---------------------------------------------------------------------
// CONTRACT: free -> true
// ---------------------------------------------------------------------

test("CONTRACT: a free prefix answers available:true with the namespace it will pin", async () => {
  seedIssuedKey("acme-", "a1");
  const res = await ask("gamma-");
  assert.equal(res._status, 200);
  assert.equal(res._body.available, true);
  assert.equal(res._body.prefix, "gamma-");
  assert.equal(res._body.example, "gamma-main");
  assert.deepEqual(res._body.suggestions, []);
});

test("an empty key store (nobody has bought yet) answers available:true, not an error", async () => {
  const res = await ask("firstbuyer-");
  assert.equal(res._status, 200);
  assert.equal(res._body.available, true);
});

// ---------------------------------------------------------------------
// CONTRACT: taken -> false
// ---------------------------------------------------------------------

test("CONTRACT: an exactly-taken prefix answers available:false with reason 'taken'", async () => {
  seedIssuedKey("acme-", "a1");
  const res = await ask("acme-");
  assert.equal(res._status, 200, "taken is a normal answer, not an HTTP error");
  assert.equal(res._body.available, false);
  assert.equal(res._body.reason, "taken");
});

test("overlap is refused in BOTH directions: a candidate CONTAINED BY an existing prefix is taken", async () => {
  seedIssuedKey("acme-labs-", "a2");
  const res = await ask("acme-");
  assert.equal(res._body.available, false,
    "'acme-' sits upstream of the existing 'acme-labs-' and would pin into it");
  assert.equal(res._body.reason, "taken");
});

test("overlap is refused in BOTH directions: a candidate CONTAINING an existing prefix is taken", async () => {
  seedIssuedKey("acme-", "a3");
  const res = await ask("acme-labs-");
  assert.equal(res._body.available, false);
});

test("prefixes bound in the WITNESS_KEYS env var count as taken too", async () => {
  process.env.WITNESS_KEYS = "envkey1:legacy-,envkey2:oldcorp-";
  const taken = await ask("legacy-");
  assert.equal(taken._body.available, false,
    "hand-provisioned env keys are authorization boundaries exactly like issued ones");
  const free = await ask("newcorp-");
  assert.equal(free._body.available, true);
});

test("the colliding prefix is NEVER echoed — it belongs to another customer", async () => {
  seedIssuedKey("someone-elses-company-", "a4");
  const res = await ask("someone-");
  assert.equal(res._body.available, false);
  assert.ok(
    !JSON.stringify(res._body).includes("someone-elses-company-"),
    "the response must not name whose prefix was hit"
  );
});

// ---------------------------------------------------------------------
// CONTRACT: invalid -> 400
// ---------------------------------------------------------------------

test("CONTRACT: a missing prefix is a 400", async () => {
  const res = await ask(undefined);
  assert.equal(res._status, 400);
  assert.equal(res._body.available, false);
  assert.equal(res._body.reason, "empty");
});

for (const [label, bad] of [
  ["no trailing dash", "acme"],
  ["uppercase-only content that survives normalization badly", "-acme-"],
  ["illegal characters", "acme_corp-"],
  ["a space", "acme corp-"],
  ["a path traversal attempt", "../etc-"],
  ["over the 48-char ceiling", `${"a".repeat(48)}-`],
]) {
  test(`CONTRACT: an invalid prefix (${label}) is a 400, never a silent yes`, async () => {
    const res = await ask(bad);
    assert.equal(res._status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res._body.available, false);
    assert.equal(res._body.reason, "format");
    assert.ok(res._body.detail, "a 400 must say what is wrong with it");
  });
}

test("CONTRACT: the reserved wk- stem is a 400 with reason 'reserved', not merely 'taken'", async () => {
  const res = await ask("wk-mine-");
  assert.equal(res._status, 400);
  assert.equal(res._body.reason, "reserved",
    "wk- is reserved for auto-minted prefixes; a customer sitting on that stem would sit upstream of every future random mint");
});

// ---------------------------------------------------------------------
// The operator's brand stems (2026-09-20, second-model review) — a customer
// picking "velouria-x" or "arcaeon-x" would both squat the operator's brand
// AND get mislabelled "our own log" on the public status page. This
// endpoint must agree with the claim path (api/fulfill.js) on every one of
// these, since both go through keys.validatePrefix().
// ---------------------------------------------------------------------

for (const bad of ["velouria-mine-", "arcaeon-x-", "velouria-", "arcaeon-"]) {
  test(`CONTRACT: the reserved brand stem '${bad}' is a 400 with reason 'reserved'`, async () => {
    const res = await ask(bad);
    assert.equal(res._status, 400);
    assert.equal(res._body.available, false);
    assert.equal(res._body.reason, "reserved");
    assert.match(res._body.detail, /operator/);
  });
}

test("CASE: an upper-cased brand stem is normalized (H3) before the reserved check, same as any other prefix", async () => {
  const res = await ask("  ARCAEON-Mine-  ");
  assert.equal(res._body.prefix, "arcaeon-mine-");
  assert.equal(res._status, 400);
  assert.equal(res._body.reason, "reserved");
});

for (const ok of ["acme-velouria-mirror-", "myarcaeon-x-"]) {
  test(`a brand stem merely APPEARING inside a longer, differently-rooted prefix stays available: '${ok}'`, async () => {
    const res = await ask(ok);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, true, JSON.stringify(res._body));
  });
}

// ---------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------

test("a taken prefix returns three alternatives, and every one of them really is free", async () => {
  seedIssuedKey("acme-", "b1");
  const res = await ask("acme-");
  const alts = res._body.suggestions;
  assert.equal(alts.length, 3, "three alternatives, per the picker design");

  for (const alt of alts) {
    assert.equal(keys.validatePrefix(alt).ok, true, `${alt} must be format-valid`);
    // Re-ask the endpoint itself: a suggestion the endpoint would then call
    // taken is worse than no suggestion at all.
    const back = await ask(alt);
    assert.equal(back._status, 200);
    assert.equal(back._body.available, true, `suggested ${alt} must actually be available`);
  }
});

test("alternatives DIVERGE from the taken stem instead of extending it (an extension would collide right back)", async () => {
  seedIssuedKey("acme-", "b2");
  const res = await ask("acme-");
  for (const alt of res._body.suggestions) {
    assert.ok(
      !alt.startsWith("acme-"),
      `${alt} extends the taken prefix — two-way overlap would reject it on submit`
    );
  }
});

test("alternatives never overlap EACH OTHER", async () => {
  seedIssuedKey("acme-", "b3");
  const alts = (await ask("acme-"))._body.suggestions;
  for (let i = 0; i < alts.length; i++) {
    const others = alts.filter((_, j) => j !== i);
    assert.equal(keys.prefixConflicts(alts[i], others), false,
      `${alts[i]} overlaps another suggestion in the same list`);
  }
});

test("alternatives stay under the 48-char ceiling even from a maximum-length stem", async () => {
  const long = `${"a".repeat(46)}b-`; // 48 chars, the ceiling exactly
  assert.equal(keys.validatePrefix(long).ok, true);
  seedIssuedKey(long, "b4");
  const res = await ask(long);
  assert.equal(res._body.available, false);
  for (const alt of res._body.suggestions) {
    assert.ok(alt.length <= prefixCheck.MAX_PREFIX_LEN, `${alt} is ${alt.length} chars`);
    assert.equal(keys.validatePrefix(alt).ok, true);
  }
});

// ---------------------------------------------------------------------
// Normalization — must match api/fulfill.js's mint-path normalization, or
// this endpoint answers about a different string than the one minted.
// ---------------------------------------------------------------------

test("input is trimmed and lowercased exactly like the mint path (H3), so the answer is about the string that gets minted", async () => {
  seedIssuedKey("acme-", "c1");
  const res = await ask("  ACME-  ");
  assert.equal(res._body.prefix, "acme-");
  assert.equal(res._body.available, false, "the normalized form is taken, so the raw form is too");
});

// ---------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------

test("a store read failure answers 503 available:null — 'unknown', never 'free'", async () => {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("/contents/keys")) {
      return { status: 500, ok: false, json: async () => ({}), text: async () => "boom" };
    }
    return original(url, opts);
  };
  try {
    const res = await ask("anything-");
    assert.equal(res._status, 503);
    assert.equal(res._body.available, null,
      "an unreadable store must not be reported as availability");
    assert.equal(res._body.reason, "store_unavailable");
  } finally {
    global.fetch = original;
  }
});

test("only GET/HEAD are accepted; a POST is 405 (this route reads, it never writes)", async () => {
  const res = await ask("acme-", { method: "POST" });
  assert.equal(res._status, 405);
  assert.equal(res._headers.allow, "GET, HEAD");
});

test("the shared per-IP limiter answers 429 with an honest body — and says the check is advisory", async () => {
  const ip = "198.51.100.7";
  let last = null;
  for (let i = 0; i < 31; i++) last = await ask("burst-", { ip });
  assert.equal(last._status, 429);
  assert.equal(last._body.available, null, "a rate-limited call is 'unknown', not 'taken'");
  assert.ok(Number(last._headers["retry-after"]) > 0);
  assert.match(String(last._body.detail), /validated at mint time/,
    "a buyer who trips the limiter must be told the submit path still works");
});

// ---------------------------------------------------------------------
// The read fan-out is cached briefly, because a debounced picker asks often
// ---------------------------------------------------------------------

test("repeat checks inside the TTL reuse one prefix listing instead of re-reading every issued key", async () => {
  seedIssuedKey("acme-", "d1");
  seedIssuedKey("beta-", "d2");
  await ask("one-");
  const afterFirst = gh.getLog.length;
  assert.ok(afterFirst >= 3, "first call lists the keys dir and reads each record");
  await ask("two-");
  await ask("three-");
  assert.equal(gh.getLog.length, afterFirst,
    "a debounced picker must not fan out a GitHub read set per keystroke");
});

// ---------------------------------------------------------------------
// Routing + the boundary: this route mints nothing
// ---------------------------------------------------------------------

test("BOUNDARY: an availability check writes NOTHING — no key, no fulfillment, no pool", async () => {
  seedIssuedKey("acme-", "e1");
  await ask("acme-");
  await ask("brandnew-");
  assert.deepEqual(gh.putLog, [],
    "the picker checks availability; minting stays behind fulfill.js's Stripe verification");
});

test("the dispatch is reached WITHOUT a session_id — the check needs no purchase and no auth", async () => {
  const req = makeReq({
    method: "GET",
    query: { op: "prefix-available", prefix: "nosession-" },
    headers: { "x-forwarded-for": freshIp() },
  });
  const res = makeRes();
  await fulfill(req, res);
  assert.equal(res._status, 200, "a missing session_id must not reach the fulfillment gate here");
  assert.equal(res._body.available, true);
});

test("REGRESSION: without ?op, api/fulfill still behaves as the fulfillment endpoint", async () => {
  const req = makeReq({ method: "GET", query: {}, headers: { accept: "application/json" } });
  const res = makeRes();
  await fulfill(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.reason, "bad_session_id",
    "the co-hosted route must not shadow the endpoint it rides on");
});

test("vercel.json actually rewrites the public /api/prefix-available path onto this dispatch", async () => {
  // Without this rewrite the endpoint exists in code and 404s in production —
  // and api/ is at Vercel Hobby's 12-function cap, so it cannot simply become
  // its own file. The rewrite IS the route.
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf-8")
  );
  const rule = (cfg.rewrites || []).find((r) => r.source === "/api/prefix-available");
  assert.ok(rule, "vercel.json must carry a /api/prefix-available rewrite");
  assert.equal(rule.destination, "/api/fulfill?op=prefix-available");

  const apiFiles = fs
    .readdirSync(path.join(__dirname, "..", "api"))
    .filter((f) => f.endsWith(".js"));
  assert.ok(apiFiles.length <= 12,
    `api/ holds ${apiFiles.length} serverless functions; Vercel Hobby hard-caps it at 12`);
});
