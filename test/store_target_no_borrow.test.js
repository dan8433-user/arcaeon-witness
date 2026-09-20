"use strict";
// A store target without its own token name must never borrow the pin token.
const test = require("node:test");
const assert = require("node:assert");
const store = require("../lib/_store.js");

test("NO BORROWED TOKEN: a non-pins target with no tokenEnv throws before any request", async () => {
  const saved = process.env.GITHUB_PIN_TOKEN;
  process.env.GITHUB_PIN_TOKEN = "pin-token-must-not-be-used";
  let fetched = false;
  const realFetch = global.fetch;
  global.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) , text: async () => "" }; };
  try {
    const half = store.forTarget({ repo: "someone/stamps", branch: "main" });
    await assert.rejects(() => half.getFile("x.json"), /no tokenEnv/);
    assert.equal(fetched, false, "no request may leave the process");
  } finally {
    global.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_PIN_TOKEN; else process.env.GITHUB_PIN_TOKEN = saved;
  }
});

test("PINS DEFAULT UNCHANGED: the pins target still names GITHUB_PIN_TOKEN", () => {
  assert.equal(store.PINS_TARGET.tokenEnv, "GITHUB_PIN_TOKEN");
});

// ---------------------------------------------------------------------
// MERGE SEAM (release candidate, 2026-09-20). getTreeMeta arrived on the
// `sealer-safety` branch, which forked BEFORE lib/_store.js's target
// refactor landed on `stamp-own-repo`. Git merged both cleanly because
// they touch different lines, and the result was the one primitive in
// this file that takes no target: it read the module-level REPO/BRANCH
// and called ghHeaders() with no argument.
//
// It happened to be correct — the pins repo is what the reconciler wants
// — but it was correct BY DEFAULT rather than by construction, and it was
// missing from forTarget()'s bound set. A future caller that bound a
// different target and called getTreeMeta would have read the pins repo
// with the pin token and had no way to notice. That is the same shape as
// the borrowed-token bug the rest of this file exists to prevent, so it
// is closed here rather than left as a comment.
// ---------------------------------------------------------------------

test("TARGET-AWARE: getTreeMeta reads the target it is given, not always the pins repo", async () => {
  const savedPin = process.env.GITHUB_PIN_TOKEN;
  const savedStamp = process.env.STAMP_TOKEN;
  process.env.GITHUB_PIN_TOKEN = "pin-token-must-not-be-used-here";
  process.env.STAMP_TOKEN = "stamp-token";
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen.push({ url: String(url), authorization: ((opts && opts.headers) || {}).authorization });
    return { ok: true, status: 200, json: async () => ({ tree: [], truncated: false }), text: async () => "" };
  };
  try {
    const bound = store.forTarget({ repo: "someone/stamps", branch: "trunk", tokenEnv: "STAMP_TOKEN", ua: "x" });
    assert.equal(typeof bound.getTreeMeta, "function",
      "forTarget() must bind getTreeMeta like every other primitive, or a bound store silently reads the pins repo");
    await bound.getTreeMeta();
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.includes("someone/stamps"), `getTreeMeta read ${seen[0].url}`);
    assert.ok(seen[0].url.includes("/git/trees/trunk"), "getTreeMeta ignored the target's branch");
    assert.equal(seen[0].authorization, "Bearer stamp-token",
      "getTreeMeta used the wrong token for the target it was given");

    // MUST-FAIL ARM: the pins DEFAULT is unchanged, so the assertions above
    // are measuring the target argument and not a global rewrite. Called
    // with no argument it still reads the pins repo with the pin token —
    // which is what tools/reconcile_batches.js depends on.
    await store.getTreeMeta();
    assert.equal(seen.length, 2);
    assert.ok(seen[1].url.includes(store.REPO), `the default target moved off the pins repo: ${seen[1].url}`);
    assert.equal(seen[1].authorization, "Bearer pin-token-must-not-be-used-here");
    assert.notEqual(seen[0].url, seen[1].url,
      "both calls read the same repo, so this test cannot tell a target-aware getTreeMeta from a hardcoded one");

    // And a half-built target refuses here too, exactly as getFile does.
    const half = store.forTarget({ repo: "someone/stamps", branch: "main" });
    await assert.rejects(() => half.getTreeMeta(), /no tokenEnv/);
    assert.equal(seen.length, 2, "a refused target must not put a tree request on the wire");
  } finally {
    global.fetch = realFetch;
    if (savedPin === undefined) delete process.env.GITHUB_PIN_TOKEN; else process.env.GITHUB_PIN_TOKEN = savedPin;
    if (savedStamp === undefined) delete process.env.STAMP_TOKEN; else process.env.STAMP_TOKEN = savedStamp;
  }
});
