// test/verify_vocabulary.test.js — the vocabulary pass (2026-09-23).
//
// One set of words on every Arcaeon surface: VERIFIED, BROKEN, COULD NOT LOOK.
// On /api/verify the JSON fields do not move (clients read `witnessed`,
// `reason` and the status code, and those are pinned in verify.test.js); only
// the human text beside them leads with the word. These tests pin both halves:
// the word is there, and the field it describes is exactly what it was.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const verifyHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

function seedHead(ns, rows, chain) {
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows, chain, seq: 1, pinned_at: new Date().toISOString(),
  });
}

async function ask(query) {
  const res = makeRes();
  await verifyHandler(makeReq({ query }), res);
  return res;
}

test("VOCABULARY: witnessed:true reads VERIFIED, and the field is still true", async () => {
  seedHead("voc-hit", 42, "cafebabe");
  const res = await ask({ ns: "voc-hit", rows: "42", chain: "cafebabe" });
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, true);
  assert.match(res._body.note, /^VERIFIED: /);
});

test("VOCABULARY: witnessed:false reads BROKEN, and the field is still false", async () => {
  seedHead("voc-miss", 42, "cafebabe");
  const res = await ask({ ns: "voc-miss", rows: "42", chain: "deadbeef" });
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, false);
  assert.equal(res._body.reason, "rows_match_chain_mismatch");
  assert.match(res._body.note, /^BROKEN: /);
});

test("VOCABULARY: witnessed:null reads COULD NOT LOOK (never 'undetermined'), and the field is still null", async () => {
  const none = await ask({ ns: "voc-never", rows: "5", chain: "aaaaaaaa" });
  assert.equal(none._body.witnessed, null);
  assert.match(none._body.note, /^COULD NOT LOOK: /);

  seedHead("voc-ahead", 10, "cafebabe");
  const ahead = await ask({ ns: "voc-ahead", rows: "999", chain: "cafebabe" });
  assert.equal(ahead._body.witnessed, null);
  assert.equal(ahead._body.reason, "exceeds_current_head");
  assert.match(ahead._body.note, /^COULD NOT LOOK: /);
});

test("VOCABULARY: a stored head that cannot be read as its record (503 with a reason) reads COULD NOT LOOK", async () => {
  gh.seed(PIN_REPO, "pins/voc-wrong/latest.json", {
    namespace: "someone-else", rows: 3, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
  });
  const res = await ask({ ns: "voc-wrong", rows: "3", chain: "cafebabe" });
  assert.equal(res._status, 503);
  assert.equal(res._body.ok, false);
  assert.equal(typeof res._body.reason, "string");
  assert.ok(res._body.reason.length > 0);
  // the note is what a person reads; the error stays the plain statement
  assert.match(res._body.note, /^COULD NOT LOOK: /);
  assert.doesNotMatch(res._body.error, /^COULD NOT LOOK/);
});

test("VOCABULARY: a 400 is a question the caller got wrong, not an answer, and carries no verdict word", async () => {
  const res = await ask({ ns: "voc-bad", rows: "zero", chain: "cafebabe" });
  assert.equal(res._status, 400);
  assert.doesNotMatch(res._body.error, /^(VERIFIED|BROKEN|COULD NOT LOOK)/);
});

test("VOCABULARY: the word is added once, never stacked", async () => {
  seedHead("voc-once", 7, "cafebabe");
  const res = await ask({ ns: "voc-once", rows: "7", chain: "cafebabe" });
  assert.equal((res._body.note.match(/VERIFIED: /g) || []).length, 1);
});
