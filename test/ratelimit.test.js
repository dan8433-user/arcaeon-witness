// test/ratelimit.test.js — api/_ratelimit.js: naive per-IP fixed-window
// limiter backing /api/verify's rate limit (Stage-0, per-instance).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const ratelimit = require("../api/_ratelimit.js");

// Every test below uses its OWN fake IP so tests never interfere with each
// other's bucket state (the module holds one process-wide Map on purpose —
// that's the real behavior under test, not something to work around).
let ipCounter = 0;
function freshReq(overrides) {
  ipCounter += 1;
  return Object.assign(
    {
      method: "GET",
      headers: { "x-forwarded-for": `203.0.113.${ipCounter}` },
      socket: { remoteAddress: "unused" },
    },
    overrides
  );
}

test("CONTRACT: allows exactly LIMIT calls from one IP, then blocks the next", () => {
  const req = freshReq();
  for (let i = 0; i < ratelimit.LIMIT; i++) {
    const r = ratelimit.check(req);
    assert.equal(r.limited, false, `call ${i + 1} of ${ratelimit.LIMIT} should be allowed`);
  }
  const blocked = ratelimit.check(req);
  assert.equal(blocked.limited, true, "the call past LIMIT must be blocked");
  assert.ok(
    Number.isInteger(blocked.retryAfterSeconds) && blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= ratelimit.WINDOW_MS / 1000,
    "retryAfterSeconds must be a positive integer no larger than the window"
  );
});

test("CONTRACT: two different IPs get two independent buckets", () => {
  const reqA = freshReq();
  const reqB = freshReq();
  for (let i = 0; i < ratelimit.LIMIT; i++) ratelimit.check(reqA);
  const blockedA = ratelimit.check(reqA);
  const okB = ratelimit.check(reqB);
  assert.equal(blockedA.limited, true, "IP A is over its own limit");
  assert.equal(okB.limited, false, "IP B's budget must be untouched by IP A's usage");
});

test("CONTRACT: x-forwarded-for with multiple hops uses the leftmost (original client)", () => {
  const req = { headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1, 10.0.0.2" } };
  assert.equal(ratelimit.callerIp(req), "198.51.100.7");
});

test("CONTRACT: falls back to socket.remoteAddress when x-forwarded-for is absent", () => {
  const req = { headers: {}, socket: { remoteAddress: "192.0.2.55" } };
  assert.equal(ratelimit.callerIp(req), "192.0.2.55");
});

test("CONTRACT: with neither header nor socket address, every such caller collapses onto ONE shared bucket (fails toward blocking, never toward unlimited)", () => {
  const reqX = { headers: {} };
  const reqY = { headers: {} };
  assert.equal(ratelimit.callerIp(reqX), "unknown");
  assert.equal(ratelimit.callerIp(reqY), "unknown");
});

test("REGRESSION: a caller exactly at LIMIT is still allowed (off-by-one — the 429 must trigger on the (LIMIT+1)th call, not the LIMIT-th)", () => {
  const req = freshReq();
  let last;
  for (let i = 0; i < ratelimit.LIMIT; i++) last = ratelimit.check(req);
  assert.equal(last.limited, false, "the LIMIT-th call itself must still be allowed");
});
