// test/store_file_reader_guards.test.js — queue task 171: every GitHub
// contents-API file reader goes through lib/_contents.js decodeContents, which
// refuses a 200 whose `encoding` is not "base64" or whose decoded byte length
// disagrees with `size`.
//
// Two planted fixtures, both shapes the real API can answer with:
//   OVERSIZED  size says 2,000,000 bytes, the content decodes to 8
//   NON_BASE64 the real >1 MB answer: encoding "none", content ""
//
// Each must throw StoreFileUnreadableError (code store_file_unreadable) from
// every reader, and every endpoint over those readers must answer the way it
// answers any other store failure: a 502 whose body names the class word, and
// never a stack trace. A real-shape file (encoding + size correct) still reads.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const { StoreFileUnreadableError, decodeContents, CODE } = require("../lib/_contents.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const keys = require("../lib/_keys.js");
const meter = require("../lib/_meter.js");
const pending = require("../lib/_pending.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;
const USAGE_REPO = process.env.GITHUB_USAGE_REPO;
const KEY = "testkeyA";

const FIXTURES = {
  OVERSIZED: {
    type: "file", encoding: "base64", size: 2_000_000,
    content: Buffer.from('{"a":1}\n').toString("base64"), sha: "a1",
  },
  NON_BASE64: { type: "file", encoding: "none", size: 1_500_000, content: "", sha: "b2" },
};

let gh, restore;
beforeEach(() => { gh = new MockGitHubStore(); restore = install(gh); });
afterEach(() => restore());

function isTyped(err) {
  return err instanceof StoreFileUnreadableError && err.code === CODE && err.name === "StoreFileUnreadableError";
}

// ------------------------------------------------------------- the decoder

test("DECODER: a real-shape body decodes; each malformed shape throws the typed error with its reason", () => {
  const text = '{"ok":true}\n';
  const good = { encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  assert.equal(decodeContents(good, "t"), text);
  // GitHub wraps base64 at 60 columns; the newlines are not bytes.
  const wrapped = { ...good, content: good.content.replace(/(.{4})/g, "$1\n") };
  assert.equal(decodeContents(wrapped, "t"), text);

  const cases = [
    [FIXTURES.OVERSIZED, /size_mismatch/],
    [FIXTURES.NON_BASE64, /encoding_not_base64/],
    [{ ...good, encoding: undefined }, /encoding_not_base64/],
    [{ ...good, size: undefined }, /size_not_an_integer/],
    [{ ...good, size: "12" }, /size_not_an_integer/],
    [{ ...good, content: null }, /content_not_a_string/],
    [[], /not_a_file_object/],
    [null, /not_a_file_object/],
  ];
  for (const [body, re] of cases) {
    assert.throws(() => decodeContents(body, "t"), (e) => isTyped(e) && re.test(e.message), JSON.stringify(body));
  }
});

// ------------------------------------------------------------- every reader

const READERS = [
  ["store.getFile", PIN_REPO, "pins/demo-x/latest.json", (p) => store.getFile(p)],
  ["store.getRawFile", PIN_REPO, "anchors/demo-x.txt", (p) => store.getRawFile(p)],
  ["balance.getFile", USAGE_REPO, `balance/${balance.keyHash(KEY)}.json`, (p) => balance.getFile(p)],
  ["keys.getFile", USAGE_REPO, "keys/abc.json", (p) => keys.getFile(p)],
  ["meter (usage file)", USAGE_REPO, `usage/${meter.keyHash(KEY)}/${meter.utcMonth()}.json`, () => meter.peek(KEY)],
  ["pending.readUsageDoc", USAGE_REPO, "batches/pending.json", (p) => pending.readUsageDoc(p)],
];

for (const [fx, body] of Object.entries(FIXTURES)) {
  for (const [name, repo, path, read] of READERS) {
    test(`READER / ${fx}: ${name} throws StoreFileUnreadableError`, async () => {
      gh.plantRawGet(repo, path, body);
      await assert.rejects(() => read(path), (e) => isTyped(e));
      assert.ok(gh.getLog.includes(path), `${name} never read ${path}`);
    });
  }
}

test("READER / GOOD: a real-shape file still reads through every reader", async () => {
  gh.seed(PIN_REPO, "pins/demo-x/latest.json", { hello: 1 });
  assert.deepEqual((await store.getFile("pins/demo-x/latest.json")).json, { hello: 1 });
  gh.seed(USAGE_REPO, "keys/abc.json", { k: 2 });
  assert.deepEqual((await keys.getFile("keys/abc.json")).json, { k: 2 });
  gh.seed(USAGE_REPO, "x/doc.json", { d: 3 });
  assert.deepEqual((await pending.readUsageDoc("x/doc.json")).json, { d: 3 });
  gh.seed(USAGE_REPO, "b/doc.json", { b: 4 });
  assert.deepEqual((await balance.getFile("b/doc.json")).json, { b: 4 });
});

// ------------------------------------------------------------- the callers

const ENDPOINTS = [
  ["GET /api/latest", "../api/latest.js", PIN_REPO, "pins/demo-x/latest.json", { query: { ns: "demo-x" } }],
  ["GET /api/verify", "../api/verify.js", PIN_REPO, "pins/demo-x/latest.json", { query: { ns: "demo-x", rows: "5", chain: "aaaaaaaa" } }],
  ["POST /api/pin (head)", "../api/pin.js", PIN_REPO, "pins/demo-x/latest.json",
    { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: { namespace: "demo-x", rows: 5, chain: "cafebabe" } }],
  ["POST /api/pin (usage)", "../api/pin.js", USAGE_REPO, `usage/${meter.keyHash(KEY)}/${meter.utcMonth()}.json`,
    { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: { namespace: "demo-x", rows: 5, chain: "cafebabe" } }],
  ["GET /api/balance", "../api/balance.js", USAGE_REPO, `balance/${balance.keyHash(KEY)}.json`,
    { headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } }],
];

for (const [fx, body] of Object.entries(FIXTURES)) {
  for (const [name, mod, repo, path, reqOpts] of ENDPOINTS) {
    test(`CALLER / ${fx}: ${name} answers 502 with the class word, no stack, nothing written`, async () => {
      gh.plantRawGet(repo, path, body);
      const res = makeRes();
      await require(mod)(makeReq(reqOpts), res);
      const text = JSON.stringify(res._body);
      assert.equal(res._status, 502, `${name} answered ${res._status}: ${text}`);
      assert.match(res._body.error, /StoreFileUnreadableError/);
      assert.match(res._body.error, /store_file_unreadable/);
      assert.doesNotMatch(text, /\n\s+at |at .+\.js:\d+/, "a stack trace reached the response body");
      if (repo === USAGE_REPO) {
        assert.ok(!res._body.error.includes(path), "a private-repo path reached the response body");
      }
      assert.equal(gh.putLog.length, 0, `wrote ${gh.putLog.map((p) => p.path).join(", ")} after an unreadable read`);
    });
  }
}
