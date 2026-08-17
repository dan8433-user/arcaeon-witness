// test/cors.test.js — api/_cors.js: GET-only CORS helper for public read
// endpoints (verify.js, status.js, health.js). Never imported by a write
// endpoint — see _cors.js's own module comment for why that's on purpose.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { applyGetCors } = require("../lib/_cors.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");

test("CONTRACT: a GET request gets Access-Control-Allow-Origin:* and is NOT short-circuited", () => {
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  const handled = applyGetCors(req, res);
  assert.equal(handled, false, "GET must fall through to the real handler logic");
  assert.equal(res._headers["access-control-allow-origin"], "*");
  assert.equal(res._sent, false, "the CORS helper must not itself send a response for GET");
});

test("CONTRACT: a HEAD request also gets the ACAO header and is NOT short-circuited", () => {
  const req = makeReq({ method: "HEAD" });
  const res = makeRes();
  const handled = applyGetCors(req, res);
  assert.equal(handled, false);
  assert.equal(res._headers["access-control-allow-origin"], "*");
});

test("CONTRACT: an OPTIONS preflight gets 204 with the full header set and IS short-circuited", () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  const handled = applyGetCors(req, res);
  assert.equal(handled, true, "the caller must return immediately on a handled OPTIONS");
  assert.equal(res._status, 204);
  assert.equal(res._headers["access-control-allow-origin"], "*");
  assert.equal(res._headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
  assert.ok(res._headers["access-control-max-age"], "max-age should be set so repeat preflights are cached");
});

test("REGRESSION: a POST request still gets the ACAO header set (harmless) but is never short-circuited by this helper — method rejection is the caller's own job, not CORS's", () => {
  const req = makeReq({ method: "POST" });
  const res = makeRes();
  const handled = applyGetCors(req, res);
  assert.equal(handled, false, "only OPTIONS is special-cased; POST falls through to the caller's own method guard");
});
