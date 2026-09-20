// test/stamp_own_repo.test.js — the stamps log's OWN repository, OWN token,
// and its metering (free allowance -> prepaid credit).
//
// EVERY CLAIM HERE HAS A MUST-FAIL ARM. A green test that would stay green
// with the guard deleted proves nothing, so each block either sabotages the
// mechanism in-place and asserts the opposite outcome, or pins the exact
// condition (a write in the wrong repo, a debit that should not have
// happened) that a regression would flip.
//
// The mock store is repo-keyed: gh.has("a/b", path) and gh.has("c/d", path)
// are different questions. That is what makes "a stamp can NEVER land in the
// pins store" a real assertion rather than a hopeful one.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-pin-token";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_USAGE_BRANCH = "main";
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "500";
process.env.WITNESS_KEYS = "goodkey:acme-";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const stampStore = require("../lib/_stamp_store.js");
const stamp = require("../lib/_stamp.js");

const PINS_REPO = "test-owner/test-pins";
const STAMPS_REPO = "test-owner/test-stamps";
const USAGE_REPO = "test-owner/test-usage";
const KEY = "goodkey";
const KEY_HASH = balance.keyHash(KEY);

// A distinct, always-valid 64-hex fingerprint per label. Derived rather than
// spelled out because a label like "0k" repeated to 64 characters is not hex,
// and the handler would 400 it — which is a validation test, not the test the
// label was standing in for.
const sha = (label) => require("crypto").createHash("sha256").update(String(label)).digest("hex");
const pathOf = (s) => `stamps/${s.slice(0, 2)}/${s}.json`;
const today = () => `stamps/_meta/day-${new Date().toISOString().slice(0, 10)}.json`;
const balPath = () => `balance/${KEY_HASH}.json`;

let gh;
let restore;
let realSleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  stamp._resetLimiterForTests();
  realSleep = store._putRetry.sleep;
  store._putRetry.sleep = async () => {};
  process.env.STAMP_REPO = STAMPS_REPO;
  process.env.STAMP_BRANCH = "main";
  process.env.STAMP_TOKEN = "test-stamp-token";
  process.env.STAMP_FREE_PER_DAY = "3";
});

afterEach(() => {
  store._putRetry.sleep = realSleep;
  restore();
});

function seedBalance(credits) {
  gh.seed(USAGE_REPO, balPath(), {
    key_id: KEY_HASH.slice(0, 12),
    key_hash: KEY_HASH,
    balance: credits,
    seq: 1,
    applied_events: ["evt_seed"],
    updated_at: "2026-09-01T00:00:00.000Z",
  });
}

async function post(body, { ip = "203.0.113.7", key = null } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = makeRes();
  await stamp.handleStamp(makeReq({ method: "POST", body, headers }), res);
  return res;
}

// Burn the free allowance for one address without asserting on it.
async function burnFree(ip, n) {
  for (let i = 0; i < n; i += 1) {
    const r = await post({ sha256: sha(`${i}${ip.slice(-1)}`) }, { ip });
    assert.equal(r._status, 201, `free burn ${i} should have succeeded`);
  }
}

// ---------------------------------------------------------------------------
// 1. A SEPARATE STORE, AND NO PATH BACK TO THE PINS REPO
// ---------------------------------------------------------------------------

test("OWN REPO: a stamp and its budget counter land in the STAMPS repo and NOTHING lands in the pins repo", async () => {
  const s = sha("a");
  const res = await post({ sha256: s, size: 42 });
  assert.equal(res._status, 201);

  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), true, "the stamp belongs in the stamps repo");
  assert.equal(gh.has(STAMPS_REPO, today()), true, "the budget counter belongs in the stamps repo too");

  // MUST-FAIL ARM: if the stamp store ever fell back to the pins store, these
  // two would be true instead. Asserting the path specifically, and then the
  // whole repo, so a future write under any other name is caught as well.
  assert.equal(gh.has(PINS_REPO, pathOf(s)), false, "a stamp must NEVER land in the pins store");
  assert.equal(gh.has(PINS_REPO, today()), false);
  const pinsWrites = gh.putLog.filter((w) => w.repo === PINS_REPO);
  assert.deepEqual(pinsWrites, [], `the pins repo took ${pinsWrites.length} write(s) during a stamp`);

  // ...and every write that DID happen went to the stamps repo.
  assert.ok(gh.putLog.length >= 2);
  for (const w of gh.putLog) assert.equal(w.repo, STAMPS_REPO);
});

test("OWN REPO: the response's record and history URLs name the stamps repo, not the pins repo", async () => {
  const s = sha("b");
  const res = await post({ sha256: s });
  assert.match(res._body.record_url, new RegExp(`github\\.com/${STAMPS_REPO}/blob/main/`));
  assert.match(res._body.history_url, new RegExp(`github\\.com/${STAMPS_REPO}/commits/main/`));
  // MUST-FAIL ARM: the old build built these from store.REPO.
  assert.equal(res._body.record_url.includes(PINS_REPO), false);
  assert.equal(res._body.history_url.includes(PINS_REPO), false);
});

test("FAIL CLOSED: with STAMP_REPO unset, POST is 503, GET is 503, and not one byte is written anywhere", async () => {
  delete process.env.STAMP_REPO;
  const s = sha("c");

  const res = await post({ sha256: s });
  assert.equal(res._status, 503);
  assert.equal(res._body.reason, "stamp_store_not_configured");
  assert.deepEqual(res._body.missing_config, ["STAMP_REPO"]);
  assert.match(res._body.error, /never written into the witness pins repository/);

  const look = makeRes();
  await stamp.handleStamp(makeReq({ method: "GET", query: { sha256: s } }), look);
  assert.equal(look._status, 503);

  // MUST-FAIL ARM: fail-closed means CLOSED. Not a pins-repo write, not a
  // stamps-repo write, not a budget increment, not even a read.
  assert.deepEqual(gh.putLog, [], "an unconfigured stamp endpoint must write nothing");
  assert.deepEqual(gh.getLog, [], "an unconfigured stamp endpoint must not even read");
  assert.equal(gh.has(PINS_REPO, pathOf(s)), false);
});

test("FAIL CLOSED: with STAMP_TOKEN unset the endpoint refuses rather than writing with the pin token", async () => {
  delete process.env.STAMP_TOKEN;
  const res = await post({ sha256: sha("d") });
  assert.equal(res._status, 503);
  assert.deepEqual(res._body.missing_config, ["STAMP_TOKEN"]);
  assert.deepEqual(gh.putLog, []);
});

test("FAIL CLOSED: STAMP_REPO pointed AT the pins repo is refused, not obeyed", async () => {
  // The misconfiguration that the whole separation exists to survive: someone
  // pastes the pins repo into STAMP_REPO.
  process.env.STAMP_REPO = PINS_REPO;
  const s = sha("e");
  const res = await post({ sha256: s });

  assert.equal(res._status, 503);
  assert.equal(res._body.reason, "stamp_repo_is_pins_repo");
  // MUST-FAIL ARM: without the equality guard this would be a 201 and the
  // stamp would be sitting in the witness record.
  assert.equal(gh.has(PINS_REPO, pathOf(s)), false, "one env typo must not merge the two records");
  assert.deepEqual(gh.putLog, []);
});

test("FAIL CLOSED: a malformed STAMP_REPO is refused rather than turned into a URL", async () => {
  process.env.STAMP_REPO = "not-a-repo";
  const res = await post({ sha256: sha("f") });
  assert.equal(res._status, 503);
  assert.equal(res._body.reason, "stamp_repo_malformed");
  assert.deepEqual(gh.putLog, []);
});

test("OWN TOKEN: the stamp request is authorized with STAMP_TOKEN, and the pin token is never sent to the stamps repo", async () => {
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = (url, opts) => {
    seen.push({ url: String(url), auth: opts && opts.headers && opts.headers.authorization });
    return origFetch(url, opts);
  };
  try {
    await post({ sha256: sha("1") });
  } finally {
    global.fetch = origFetch;
  }
  const stampCalls = seen.filter((c) => c.url.includes(STAMPS_REPO));
  assert.ok(stampCalls.length >= 2, "expected reads and a write against the stamps repo");
  for (const c of stampCalls) {
    assert.equal(c.auth, "Bearer test-stamp-token");
    // MUST-FAIL ARM: the pin token must not be what opens the stamps repo.
    assert.notEqual(c.auth, "Bearer test-pin-token");
  }
  assert.deepEqual(seen.filter((c) => c.url.includes(PINS_REPO)), []);
});

test("STORE MODULE: status() reports configuration without throwing, and getFile/putFile throw typed when unconfigured", async () => {
  assert.equal(stampStore.status().configured, true);
  assert.equal(stampStore.status().repo, STAMPS_REPO);

  delete process.env.STAMP_REPO;
  const st = stampStore.status();
  assert.equal(st.configured, false);
  assert.equal(st.repo, null, "an unconfigured store must not report a repo to fall back to");

  await assert.rejects(() => stampStore.getFile("stamps/aa/x.json"), (e) => e.not_configured === true);
  await assert.rejects(() => stampStore.putFile("stamps/aa/x.json", {}, "m"), (e) => e.not_configured === true);
  // MUST-FAIL ARM: a throw, not a silent redirect.
  assert.deepEqual(gh.putLog, []);
});

// ---------------------------------------------------------------------------
// 2. METERING: THREE FREE, THEN PAID
// ---------------------------------------------------------------------------

test("FREE TIER: the first three stamps from an address are free and report the remaining allowance", async () => {
  const remaining = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await post({ sha256: sha(`${i}a`) });
    assert.equal(r._status, 201);
    assert.equal(r._body.billing.paid, false);
    assert.equal(r._body.billing.credits_charged, 0);
    remaining.push(r._body.billing.free_remaining_today);
  }
  assert.deepEqual(remaining, [2, 1, 0]);
  // MUST-FAIL ARM: free means the balance store was never touched.
  assert.equal(gh.has(USAGE_REPO, balPath()), false);
});

test("FREE TIER: the fourth stamp with no key is 401, names the price, and writes nothing", async () => {
  await burnFree("198.51.100.9", 3);
  const s = sha("9x");
  const res = await post({ sha256: s }, { ip: "198.51.100.9" });

  assert.equal(res._status, 401);
  assert.equal(res._body.reason, "key_required");
  assert.equal(res._body.free_per_day, 3);
  assert.equal(res._body.price_credits_per_stamp, stamp.STAMP_PRICE_CREDITS);
  // MUST-FAIL ARM: a refused stamp is not a stamp.
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), false);
});

test("FREE TIER: the allowance is per address — a second address still gets its own three", async () => {
  await burnFree("198.51.100.1", 3);
  const res = await post({ sha256: sha("7b") }, { ip: "198.51.100.2" });
  assert.equal(res._status, 201);
  assert.equal(res._body.billing.paid, false);
  // MUST-FAIL ARM: and the first address is still spent.
  const denied = await post({ sha256: sha("7c") }, { ip: "198.51.100.1" });
  assert.equal(denied._status, 401);
});

test("PAID: past the free allowance a valid key debits the SAME prepaid balance, at the one configured price", async () => {
  seedBalance(10);
  await burnFree("198.51.100.3", 3);

  const s = sha("2c");
  const res = await post({ sha256: s }, { ip: "198.51.100.3", key: KEY });

  assert.equal(res._status, 201);
  assert.equal(res._body.billing.paid, true);
  assert.equal(res._body.billing.credits_charged, stamp.STAMP_PRICE_CREDITS);
  assert.equal(res._body.billing.credit_balance, 10 - stamp.STAMP_PRICE_CREDITS);

  // The balance that moved is the pins' own balance file in the usage repo —
  // one pool, which is the point.
  const stored = gh.read(USAGE_REPO, balPath());
  assert.equal(stored.balance, 10 - stamp.STAMP_PRICE_CREDITS);
  assert.equal(stored.key_hash, KEY_HASH);
  // MUST-FAIL ARM: the pack-idempotency set must survive a stamp debit, or a
  // Stripe retry re-grants a pack (the 2026-08-16 bug, in a new lane).
  assert.deepEqual(stored.applied_events, ["evt_seed"]);
  // ...and the stamp is in the stamps repo while the money is in the usage repo.
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), true);
  assert.equal(gh.has(PINS_REPO, pathOf(s)), false);
});

test("PAID: four stamps at 0.25 credits each cost exactly one credit, with no float drift", async () => {
  seedBalance(1);
  process.env.STAMP_FREE_PER_DAY = "0";
  for (let i = 0; i < 4; i += 1) {
    const r = await post({ sha256: sha(`${i}d`) }, { key: KEY });
    assert.equal(r._status, 201, `stamp ${i}`);
  }
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 0, "0.25 x 4 must be exactly 1, not 0.9999999999999998");

  // MUST-FAIL ARM: the balance is now genuinely empty, so the fifth is 402.
  const fifth = await post({ sha256: sha("4e") }, { key: KEY });
  assert.equal(fifth._status, 402);
  assert.equal(fifth._body.reason, "insufficient_credit");
});

test("PAID: an invalid key past the free allowance is 401, and a key-store outage is 502 (not 401)", async () => {
  await burnFree("198.51.100.4", 3);

  const bad = await post({ sha256: sha("3f") }, { ip: "198.51.100.4", key: "not-a-key" });
  assert.equal(bad._status, 401);
  assert.equal(bad._body.reason, "key_required");

  // MUST-FAIL ARM: "we could not check" must never be reported as "your key is
  // invalid" to someone who is paying.
  const origFetch = global.fetch;
  global.fetch = (url, opts) =>
    String(url).includes("/keys/")
      ? Promise.resolve({ status: 500, ok: false, json: async () => ({}), text: async () => "boom" })
      : origFetch(url, opts);
  try {
    const outage = await post({ sha256: sha("3g") }, { ip: "198.51.100.4", key: "unknown-key" });
    assert.equal(outage._status, 502);
    assert.equal(outage._body.reason, "key_store_error");
  } finally {
    global.fetch = origFetch;
  }
});

test("PAID: an insufficient balance is 402 with an honest body, and nothing is stamped", async () => {
  seedBalance(0.1); // less than one stamp
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("5h");
  const res = await post({ sha256: s }, { key: KEY });

  assert.equal(res._status, 402);
  assert.equal(res._body.reason, "insufficient_credit");
  assert.equal(res._body.credit_balance, 0.1);
  assert.equal(res._body.price_credits_per_stamp, stamp.STAMP_PRICE_CREDITS);
  assert.equal(res._body.ever_purchased, true, "a spent-out buyer is not the same as a stranger");
  assert.ok(res._body.packs && res._body.packs.mini, "say how to top up");

  // MUST-FAIL ARM: refused before the write, so no stamp and no budget spend.
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), false);
  assert.equal(gh.has(STAMPS_REPO, today()), false);
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 0.1, "a refused stamp must not move the balance");
});

test("STAMP_FREE_PER_DAY=0 makes EVERY stamp paid, from the very first one", async () => {
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("6i");

  const anon = await post({ sha256: s });
  assert.equal(anon._status, 401);
  assert.match(anon._body.error, /every stamp on this deployment requires a witness key/);
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), false);

  // MUST-FAIL ARM: with a key and a balance the same first stamp goes through
  // and is CHARGED — proving the 401 above was the flag, not a broken handler.
  seedBalance(2);
  const paid = await post({ sha256: s }, { key: KEY });
  assert.equal(paid._status, 201);
  assert.equal(paid._body.billing.paid, true);
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 2 - stamp.STAMP_PRICE_CREDITS);
});

test("FIRST WRITE WINS NEVER DEBITS: re-stamping a fingerprint returns the original and costs nothing", async () => {
  seedBalance(5);
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("8j");

  const first = await post({ sha256: s, size: 10 }, { key: KEY });
  assert.equal(first._status, 201);
  const afterFirst = gh.read(USAGE_REPO, balPath()).balance;
  assert.equal(afterFirst, 5 - stamp.STAMP_PRICE_CREDITS);
  const writesBefore = gh.putLog.length;

  for (let i = 0; i < 3; i += 1) {
    const again = await post({ sha256: s, size: 999 }, { key: KEY });
    assert.equal(again._status, 200);
    assert.equal(again._body.existing, true);
    assert.equal(again._body.stamp.stamped_at, first._body.stamp.stamped_at);
  }

  // MUST-FAIL ARM: three repeats, zero writes of any kind and zero movement in
  // the balance. A re-stamp that charged would show up in either number.
  assert.equal(gh.putLog.length, writesBefore, "a repeat stamp must write nothing — not the record, not the budget, not the ledger");
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, afterFirst, "a repeat stamp must never debit");
  assert.equal(first._body.billing.paid, true, "...and the FIRST one really was charged, so the comparison means something");
});

test("A FAILED WRITE NEVER CHARGES: the record write fails, the balance is untouched", async () => {
  seedBalance(4);
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("0k");
  // A genuine (non-conflict) store failure on the stamp record itself.
  gh.forceFailure(STAMPS_REPO, pathOf(s), 10, 500);

  const res = await post({ sha256: s }, { key: KEY });
  assert.equal(res._status, 503);
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), false);

  // MUST-FAIL ARM: the debit is ordered AFTER the confirmed write, so this
  // number moving would mean the ordering had been reversed.
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 4, "a stamp that was never recorded must not be charged");
  const ledgerWrites = gh.putLog.filter((w) => w.repo === USAGE_REPO);
  assert.deepEqual(ledgerWrites, [], "no ledger entry for a charge that never happened");
});

test("A LOST CREATE RACE NEVER CHARGES: the winner's record is returned and the balance does not move", async () => {
  seedBalance(4);
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("1l");
  const winner = { kind: "file-stamp", v: 1, sha256: s, size: 5, stamped_at: "2026-01-01T00:00:00.000Z" };

  const origFetch = global.fetch;
  let reads = 0;
  global.fetch = (url, opts) => {
    const isStampGet = (!opts || !opts.method || opts.method === "GET") && String(url).includes(pathOf(s));
    if (isStampGet) {
      reads += 1;
      if (reads === 1) {
        return origFetch(url, opts).then((r) => {
          gh.seed(STAMPS_REPO, pathOf(s), winner); // the winner lands after our read
          return r;
        });
      }
    }
    return origFetch(url, opts);
  };
  try {
    const res = await post({ sha256: s, size: 777 }, { key: KEY });
    assert.equal(res._status, 200);
    assert.equal(res._body.existing, true);
    assert.equal(res._body.stamp.stamped_at, winner.stamped_at);
  } finally {
    global.fetch = origFetch;
  }

  assert.deepEqual(gh.read(STAMPS_REPO, pathOf(s)), winner, "the winner's record is untouched");
  // MUST-FAIL ARM: we recorded nothing, so we charge nothing.
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 4);
});

test("THE GLOBAL DAILY CAP STILL FAILS CLOSED on a paid stamp, and refuses BEFORE the charge", async () => {
  seedBalance(4);
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("2m");
  gh.forceFailure(STAMPS_REPO, today(), 10, 500); // the counter cannot be written

  const res = await post({ sha256: s }, { key: KEY });
  assert.equal(res._status, 503);
  assert.equal(gh.has(STAMPS_REPO, pathOf(s)), false);
  // MUST-FAIL ARM: money is the thing that must not move when a fence fires.
  assert.equal(gh.read(USAGE_REPO, balPath()).balance, 4);
});

// ---------------------------------------------------------------------------
// 3. THE PRIVACY GUARANTEE, RE-PROVED AGAINST THE NEW STORE
// ---------------------------------------------------------------------------

test("PRIVACY: the paid path stores a fingerprint and a size and nothing else, in the stamps repo", async () => {
  seedBalance(4);
  process.env.STAMP_FREE_PER_DAY = "0";
  const s = sha("3n");
  await post({ sha256: s, size: 1234 }, { key: KEY });

  const rec = gh.read(STAMPS_REPO, pathOf(s));
  assert.deepEqual(Object.keys(rec).sort(), ["kind", "sha256", "size", "stamped_at", "v"]);

  // MUST-FAIL ARM: paying does not buy a filename field, and the key that paid
  // must not be identifiable anywhere in the PUBLIC record.
  const publicText = JSON.stringify(gh.read(STAMPS_REPO, pathOf(s))) + JSON.stringify(gh.read(STAMPS_REPO, today()));
  assert.equal(publicText.includes(KEY), false, "the raw key must never appear in the public record");
  assert.equal(publicText.includes(KEY_HASH), false, "the billing hash must never appear in the public record");
  assert.equal(publicText.includes(KEY_HASH.slice(0, 12)), false);
});

test("PRIVACY: an extra field is still refused on the paid path, not silently dropped", async () => {
  seedBalance(4);
  process.env.STAMP_FREE_PER_DAY = "0";
  const res = await post({ sha256: sha("4o"), name: "divorce-settlement-v3.pdf" }, { key: KEY });
  assert.equal(res._status, 400);
  assert.match(res._body.error, /unexpected field/);
  // MUST-FAIL ARM: refused before any store touch at all.
  assert.deepEqual(gh.putLog, []);
});

// ---------------------------------------------------------------------------
// 4. THE GENESIS TOOL (DRY RUN ONLY — it is never run for real from a test)
// ---------------------------------------------------------------------------

const genesis = require("../tools/stamp_genesis.js");

const FIRST_SHA = "0123456789abcdef0123456789abcdef01234567";

test("GENESIS: the record it would write names the stamps repo's first commit and is written into the PINS repo", () => {
  const res = genesis.plan(
    { sha: FIRST_SHA, date: "2026-09-21T17:04:05Z", repo: STAMPS_REPO },
    { GITHUB_PIN_REPO: PINS_REPO, GITHUB_PIN_BRANCH: "main", STAMP_BRANCH: "main" }
  );
  assert.equal(res.ok, true);
  assert.equal(res.plan.target_repo, PINS_REPO, "the OLD log is what dates the new one");
  assert.equal(res.plan.path, `genesis/stamp-log/${FIRST_SHA}.json`);
  assert.ok(!res.plan.path.startsWith("observations/"), "a birth record must never be counted as a conflict observation on the status page");
  assert.equal(res.plan.create_only, true);
  assert.equal(res.plan.record.first_commit_sha, FIRST_SHA);
  assert.equal(res.plan.record.repo, STAMPS_REPO);
  assert.equal(res.plan.record.first_commit_date, "2026-09-21T17:04:05.000Z");

  // MUST-FAIL ARM: the dry-run text must be the artifact, not a summary of it.
  const printed = genesis.renderDryRun(res.plan);
  assert.match(printed, /DRY RUN — nothing was written/);
  for (const line of res.plan.body.split("\n")) {
    if (line.trim()) assert.ok(printed.includes(line.trim()), `dry run omitted: ${line.trim()}`);
  }
});

test("GENESIS: the claim is scoped — 'would show', and no impossibility or strength-of-witness language", () => {
  const rec = genesis.buildGenesisRecord({
    repo: STAMPS_REPO, branch: "main", sha: FIRST_SHA,
    date: "2026-09-21T17:04:05.000Z", observedAt: "2026-09-21T18:00:00.000Z", pinsRepo: PINS_REPO,
  });
  assert.match(rec.scope.shows, /would show/);
  assert.match(rec.scope.shows, /no later than/);
  assert.match(rec.scope.does_not_show, /That no other/);

  // MUST-FAIL ARM: the public-claim gate, as an assertion. Any of these words
  // reappearing in the record is a test failure, not a review note.
  const text = JSON.stringify(rec).toLowerCase();
  for (const banned of [
    "impossible", "cannot be altered", "can't be altered", "tamper-proof", "tamperproof",
    "independent", "independently", "multi-witness", "multiple witnesses", "widely used",
    "trusted by", "guarantee",
  ]) {
    assert.equal(text.includes(banned), false, `the genesis record must not say "${banned}"`);
  }
});

test("GENESIS: it refuses to write the birth record into the log being born", () => {
  const res = genesis.plan(
    { sha: FIRST_SHA, date: "2026-09-21T17:04:05Z", repo: PINS_REPO },
    { GITHUB_PIN_REPO: PINS_REPO }
  );
  // MUST-FAIL ARM: a log cannot witness its own birth, and this is the arm
  // that proves the check exists rather than being assumed.
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.match(res.error, /same repository/);
});

test("GENESIS: bad arguments are refused before anything is built", () => {
  const cases = [
    [{ sha: "short", date: "2026-09-21T17:04:05Z", repo: STAMPS_REPO }, /40 hex/],
    [{ sha: FIRST_SHA, date: "", repo: STAMPS_REPO }, /--date is required/],
    [{ sha: FIRST_SHA, date: "not-a-date", repo: STAMPS_REPO }, /ISO 8601/],
    [{ sha: FIRST_SHA, date: "2026-09-21T17:04:05Z", repo: "" }, /no stamps repo/],
    [{ sha: FIRST_SHA, date: "2026-09-21T17:04:05Z", repo: "bad repo name" }, /owner\/name/],
  ];
  for (const [args, re] of cases) {
    const res = genesis.plan(args, { GITHUB_PIN_REPO: PINS_REPO });
    assert.equal(res.ok, false, JSON.stringify(args));
    assert.match(res.error, re);
  }
  // MUST-FAIL ARM: the good case really does pass the same gate.
  assert.equal(
    genesis.plan({ sha: FIRST_SHA, date: "2026-09-21T17:04:05Z", repo: STAMPS_REPO }, { GITHUB_PIN_REPO: PINS_REPO }).ok,
    true
  );
});

test("GENESIS: both argument spellings parse, and an unknown flag is refused", () => {
  const spaced = genesis.parseArgs(genesis.normalizeArgv(["--sha", FIRST_SHA, "--date", "2026-09-21T17:04:05Z"]));
  assert.equal(spaced.sha, FIRST_SHA);
  assert.equal(spaced.commit, false, "dry run is the DEFAULT");
  const equals = genesis.parseArgs(genesis.normalizeArgv([`--sha=${FIRST_SHA}`, "--commit"]));
  assert.equal(equals.sha, FIRST_SHA);
  assert.equal(equals.commit, true);
  // MUST-FAIL ARM: a typo'd flag must not be silently ignored on a tool that
  // writes to the public record.
  assert.match(genesis.parseArgs(["--comit"]).error, /unknown argument/);
});
