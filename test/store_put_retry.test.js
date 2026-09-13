// test/store_put_retry.test.js — lib/_store.js putFile's 409 retry (task 093).
//
// THE DEFECT, measured 2026-09-13 by tools/ceiling_probe.js against a scratch
// repo: ten concurrent writers on one branch issued 532 requests and took 465
// 409s. Every one of those writers was creating its OWN file, so nothing raced
// for a path — the branch ref moved under each PUT. putFile did not retry, so
// a pin that raced another pin simply failed. Production pins run on serverless
// instances that overlap, so this was live, not theoretical.
//
// What is proven here:
//   1. 409 twice then 201 — the write lands on attempt 3, and the third PUT
//      carries the FRESH sha, not the stale one the caller read.
//   2. 409 five times — the budget runs out and the caller gets a plain typed
//      error. Never a fabricated success, never a written file.
//   3. THE ONE THAT MATTERS — after a genuine race, the merged content holds
//      BOTH writers' rows. And with no rebuild hook, the racing writer's row
//      survives untouched rather than being clobbered by a blind re-PUT.
//
// Env vars are set before requiring _store.js (REPO/BRANCH are require-time
// consts), same discipline as test/pin.test.js.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const store = require("../lib/_store.js");

const REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;
let realSleep;
let slept;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  // Swap the backoff for a recorder. The DELAYS are still computed by the real
  // code path (so a broken schedule is still visible here); only the waiting is
  // skipped, which is the difference between a 20 ms test and a 20 s one.
  slept = [];
  realSleep = store._putRetry.sleep;
  store._putRetry.sleep = async (ms) => {
    slept.push(ms);
  };
});

afterEach(() => {
  store._putRetry.sleep = realSleep;
  restore();
});

// A stand-in concurrent writer. Intercepts PUTs to one path: for the first `n`
// of them it COMMITS ITS OWN CONTENT FIRST (so the stored sha genuinely moves,
// exactly as a racing writer does) and answers 409 with GitHub's branch-ref
// wording. `advance` returning null means "the ref moved but this file did not"
// — the branch-contention shape the probe actually measured.
//
// Records every sha the code under test put on the wire, and every sha the
// store held after each interception, so the test can bind attempt 3's sha to
// a value the FIXTURE authored rather than one the code reported about itself.
function raceOn(path, n, advance) {
  const inner = gh.handleFetch.bind(gh);
  const seen = { putShas: [], storeShas: [], fired: 0 };
  gh.handleFetch = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || "GET";
    const isTarget = u.pathname === `/repos/${REPO}/contents/${path}`;
    if (method === "PUT" && isTarget) {
      seen.putShas.push(JSON.parse(opts.body).sha || null);
      if (seen.fired < n) {
        seen.fired += 1;
        if (advance) {
          const next = advance(gh.read(REPO, path), seen.fired);
          if (next) gh.seed(REPO, path, next);
        }
        const rec = gh._repoMap(REPO).get(path);
        seen.storeShas.push(rec ? rec.sha : null);
        return {
          status: 409,
          ok: false,
          json: async () => ({}),
          text: async () =>
            '{"message":"main is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222"}',
        };
      }
    }
    return inner(url, opts);
  };
  return seen;
}

function shaOf(path) {
  const rec = gh._repoMap(REPO).get(path);
  return rec ? rec.sha : null;
}

// ---------------------------------------------------------------------
// 1. two 409s, then it lands — with the FRESH sha on the wire
// ---------------------------------------------------------------------

test("409 twice then 201: the write lands on attempt 3, and the third PUT carries the fresh sha", async () => {
  const path = "race/t1.json";
  gh.seed(REPO, path, { rows: ["A"] });
  const staleSha = shaOf(path);

  // Two racing writers land ahead of us, each moving the stored sha.
  const seen = raceOn(path, 2, (cur, n) => ({ rows: [...cur.rows, `racer${n}`] }));

  const res = await store.putFile(path, { rows: ["A", "mine"] }, "mine", staleSha, {
    rebuild: (fresh) => ({ rows: [...fresh.rows, "mine"] }),
  });

  assert.equal(res.attempts, 3, "the result must say it took three attempts, not report a clean single write");
  assert.equal(seen.putShas.length, 3, "exactly three PUTs went on the wire");
  assert.equal(seen.putShas[0], staleSha, "attempt 1 carried the sha the caller had read");
  assert.equal(
    seen.putShas[2],
    seen.storeShas[1],
    "attempt 3 carried the sha the store held after the SECOND racer committed — the fresh one"
  );
  assert.notEqual(seen.putShas[2], staleSha, "attempt 3 did not re-send the stale sha");
  assert.equal(slept.length, 2, "one jittered backoff between each pair of attempts");
  for (const ms of slept) assert.ok(ms >= 500, `backoff starts near a second, got ${ms}ms`);

  // And the landed content is built on what was actually there.
  assert.deepEqual(gh.read(REPO, path).rows, ["A", "racer1", "racer2", "mine"]);
});

test("branch-ref contention (the measured 409: nothing moved) is retried verbatim, same sha, no rebuild needed", async () => {
  const path = "race/t1b.json";
  gh.seed(REPO, path, { rows: ["A"] });
  const sha = shaOf(path);

  // advance:null — the ref moved, this file did not. 465 of the probe's 465.
  const seen = raceOn(path, 2, null);

  const res = await store.putFile(path, { rows: ["A", "mine"] }, "mine", sha);

  assert.equal(res.attempts, 3);
  assert.deepEqual(seen.putShas, [sha, sha, sha], "nothing moved, so the same sha is correct on every attempt");
  assert.deepEqual(gh.read(REPO, path).rows, ["A", "mine"]);
});

// ---------------------------------------------------------------------
// 2. the budget runs out — a plain error, never a fabricated success
// ---------------------------------------------------------------------

test("409 five times: the retry budget runs out and throws a plain typed error, with nothing written", async () => {
  const path = "race/t2.json";
  gh.seed(REPO, path, { rows: ["A"] });
  const sha = shaOf(path);
  const before = gh.read(REPO, path);

  const seen = raceOn(path, 5, null);

  await assert.rejects(
    () => store.putFile(path, { rows: ["A", "mine"] }, "mine", sha),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.conflict, true, "still tagged conflict, so every pre-existing caller behaves as before");
      assert.equal(err.attempts, 4, "gave up after the bounded four attempts");
      assert.equal(
        err.message,
        `github PUT ${path} -> 409`,
        "the thrown message is plain — no upstream body, which handlers interpolate into a 502"
      );
      assert.ok(!/expected 2222/.test(err.message), "GitHub's response body never reaches the caller");
      return true;
    }
  );

  assert.equal(seen.putShas.length, 4, "four attempts, not five, not unbounded");
  assert.deepEqual(gh.read(REPO, path), before, "a give-up writes nothing — no fabricated success");
});

// ---------------------------------------------------------------------
// 3. THE ONE THAT MATTERS: both writers' rows survive the race
// ---------------------------------------------------------------------

test("after a race, the merged content contains BOTH writers' rows", async () => {
  const path = "race/rows.json";
  gh.seed(REPO, path, { rows: ["A"] });
  const shaB = shaOf(path); // writer B's read

  // Writer C commits {rows:[A,C]} the instant before B's PUT, so B's sha is stale.
  raceOn(path, 1, () => ({ rows: ["A", "C"] }));

  // B wants to append its own row. Its rebuild is handed the FRESH json.
  const res = await store.putFile(path, { rows: ["A", "B"] }, "writer B", shaB, {
    rebuild: (fresh) => ({ rows: [...fresh.rows, "B"] }),
  });

  assert.equal(res.attempts, 2);
  const final = gh.read(REPO, path);
  assert.deepEqual(final.rows, ["A", "C", "B"], "C's row survived AND B's row landed");
  assert.ok(final.rows.includes("C"), "writer C's row was not overwritten");
  assert.ok(final.rows.includes("B"), "writer B's row was not lost");
});

test("with no rebuild hook, a moved path is refused rather than clobbered — the racer's row survives", async () => {
  const path = "race/noclobber.json";
  gh.seed(REPO, path, { rows: ["A"] });
  const shaB = shaOf(path);

  raceOn(path, 1, () => ({ rows: ["A", "D"] }));

  await assert.rejects(
    () => store.putFile(path, { rows: ["A", "B"] }, "writer B", shaB),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.conflict, true);
      assert.equal(err.stale, true, "tagged stale: the path moved, so the write was refused, not retried blind");
      assert.equal(err.attempts, 1, "no point spending the budget — a moved path is not contention");
      return true;
    }
  );

  assert.deepEqual(gh.read(REPO, path).rows, ["A", "D"], "writer D's row is intact; B never overwrote it");
});

// ---------------------------------------------------------------------
// the abandon path: a rebuild that returns null is an honest no-write
// ---------------------------------------------------------------------

test("a rebuild that returns null abandons the write and says so, rather than reporting a commit", async () => {
  const path = "race/abandon.json";
  gh.seed(REPO, path, { seq: 5 });
  const sha = shaOf(path);

  raceOn(path, 1, () => ({ seq: 7 }));

  const res = await store.putFile(path, { seq: 6 }, "mine", sha, {
    rebuild: (fresh) => (fresh.seq >= 6 ? null : { seq: 6 }),
  });

  assert.equal(res.abandoned, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.commit, undefined, "an abandoned write reports no commit");
  assert.deepEqual(res.fresh, { seq: 7 });
  assert.deepEqual(gh.read(REPO, path), { seq: 7 }, "the newer pointer was left alone");
});

// ---------------------------------------------------------------------
// the non-409 paths are untouched
// ---------------------------------------------------------------------

test("a 422 create-race is NOT retried — it keeps its existing one-shot conflict contract", async () => {
  const path = "race/create.json";
  gh.seed(REPO, path, { rows: ["A"] }); // exists, so a sha-less PUT is the create-race

  await assert.rejects(
    () => store.putFile(path, { rows: ["B"] }, "create"),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.conflict, true);
      assert.equal(err.attempts, 1, "422 is a semantic create-race, not ref contention — retrying it is wrong");
      return true;
    }
  );
  assert.equal(slept.length, 0, "no backoff was spent on a non-409");
});

test("a 500 store failure is NOT retried and is NOT tagged conflict", async () => {
  const path = "race/fail.json";
  gh.forceFailure(REPO, path, 3, 500);

  await assert.rejects(
    () => store.putFile(path, { rows: ["A"] }, "msg"),
    (err) => {
      assert.equal(err.status, 500);
      assert.equal(err.conflict, false);
      assert.equal(err.attempts, 1);
      return true;
    }
  );
});

test("a clean first-attempt write still reports attempts:1", async () => {
  const path = "race/clean.json";
  const res = await store.putFile(path, { rows: ["A"] }, "msg");
  assert.equal(res.attempts, 1);
  assert.ok(res.commit && res.commit.sha, "the real GitHub response shape is preserved alongside `attempts`");
});
