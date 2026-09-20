"use strict";
// The functions that WRITE through putFile's 409 retry must be allowed to run
// longer than that retry's worst case, or a busy moment turns into a platform
// timeout mid-write (release candidate review, 2026-09-20: worst case measured
// from PUT_RETRY is 21,000 ms for a content-advance pin; the platform default is 10 s).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WORST_CASE_MS = 21000;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));

for (const fn of ["api/pin.js", "api/verify.js"]) {
  test(`MAX DURATION: ${fn} may run longer than the retry loop's worst case`, () => {
    const max = cfg.functions && cfg.functions[fn] && cfg.functions[fn].maxDuration;
    assert.ok(Number.isFinite(max), `${fn} has no maxDuration; the platform default would cut a retrying write short`);
    assert.ok(max * 1000 > WORST_CASE_MS, `${fn} maxDuration ${max}s does not exceed the ${WORST_CASE_MS} ms worst case`);
    assert.ok(max <= 60, "above 60 s is refused on this plan");
  });
}
