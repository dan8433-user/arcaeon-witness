// test/helpers/http_mocks.js — minimal req/res fakes for the Vercel-shaped
// `async (req, res) => {}` handlers in api/*.js. Not a test file (no test()
// calls).

"use strict";

const { Readable } = require("stream");

function lowerHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
  return out;
}

// Handlers that use Vercel's default (parsed) body: pin.js. `body` is a
// plain JS object, already "parsed" — matches req.body under Vercel's
// default bodyParser.
function makeReq({ method = "GET", headers = {}, body = null, query = {} } = {}) {
  return { method, headers: lowerHeaders(headers), body, query };
}

// stripe-webhook.js disables bodyParser and reads the raw body itself via
// req.on('data'|'end'|'error'). Give it a real Readable so that contract
// holds byte-for-byte (this is exactly the surface a raw-body signature
// check depends on — see stripe-webhook.js's own comment on why).
function makeRawReq({ method = "POST", headers = {}, rawBody = Buffer.alloc(0) } = {}) {
  const stream = new Readable({
    read() {
      this.push(rawBody);
      this.push(null);
    },
  });
  stream.method = method;
  stream.headers = lowerHeaders(headers);
  return stream;
}

// res.status(code).json(body) — captures what was sent so a test can assert
// on it without a real HTTP round trip.
function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: undefined,
    _sent: false,
    _ended: false,
    setHeader(k, v) {
      res._headers[String(k).toLowerCase()] = v;
      return res;
    },
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      res._sent = true;
      return res;
    },
    // Real http.ServerResponse#end(): sends a bodyless response. Used by
    // read endpoints answering an OPTIONS preflight (res.status(204).end()) —
    // added alongside _cors.js so that path is exercisable under this
    // harness the same as .json() is.
    send(body) {
      res._body = body;
      res._sent = true;
      return res;
    },
    end() {
      res._sent = true;
      res._ended = true;
      return res;
    },
  };
  return res;
}

module.exports = { makeReq, makeRawReq, makeRes };
