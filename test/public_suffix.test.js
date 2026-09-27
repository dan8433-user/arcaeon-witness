// test/public_suffix.test.js — lib/_public_suffix.js (generated from the
// Public Suffix List by tools/gen_public_suffix.js) and its use as the
// registration domain window's key (third review item 2). Every expected
// value below was checked against the list file the table was built from:
// "co.uk", "uk", "pw", "com", "ac.jp", "com.au", "*.ck" and "!www.ck" are
// rules in its ICANN section; "co.pw" is NOT a rule anywhere in it.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const psl = require("../lib/_public_suffix.js");
const gen = require("../tools/gen_public_suffix.js");
const register = require("../lib/_register.js");

test("PSL: registrable domain = public suffix + one label (list-derived cases)", () => {
  const cases = [
    ["example.co.uk", "example.co.uk"], // co.uk is a rule
    ["example.uk", "example.uk"], // uk (single label, the default rule covers it)
    ["x1.co.pw", "co.pw"], // pw is a rule, co.pw is not: co.pw is registrable
    ["x2.co.pw", "co.pw"], // ... so x1 and x2 share one key
    ["a.b.example.com", "example.com"],
    ["bar.foo.ck", "bar.foo.ck"], // *.ck: foo.ck is itself a public suffix
    ["www.ck", "www.ck"], // !www.ck: the exception makes www.ck registrable
    ["shop.acme.co.uk", "acme.co.uk"],
    ["mail.acme.com.au", "acme.com.au"],
    ["x.uni.ac.jp", "uni.ac.jp"],
    ["a.b.c.d.example", "d.example"], // unlisted TLD: the default rule "*"
  ];
  for (const [host, want] of cases) {
    assert.equal(psl.registrableDomain(host), want, host);
    assert.equal(register.registrableDomain(host), want, `register uses the table: ${host}`);
  }
  assert.equal(psl.publicSuffix("foo.ck"), "foo.ck", "wildcard rule");
  assert.equal(psl.publicSuffix("www.ck"), "ck", "exception rule drops its leftmost label");
  assert.equal(psl.publicSuffix("x1.co.pw"), "pw");
  assert.equal(psl.registrableDomain("co.uk"), "co.uk", "a bare public suffix is returned whole");
  assert.equal(psl.registrableDomain("Example.CO.UK."), "example.co.uk", "case and a trailing dot are normalised");
});

test("PSL table: sorted, ICANN multi-label + wildcard + exception rules, source stamped", () => {
  assert.deepEqual(psl.RULES, [...psl.RULES].sort(), "the array is sorted");
  const set = new Set(psl.RULES);
  for (const r of ["co.uk", "com.au", "ac.jp", "*.ck", "!www.ck"]) assert.ok(set.has(r), r);
  for (const r of ["co.pw", "uk", "com", "pw"]) assert.ok(!set.has(r), `not in the table: ${r}`);
  assert.ok(psl.RULES.every((r) => r.startsWith("!") || r.includes("*") || r.split(".").length >= 2));
  assert.ok(psl.RULES.every((r) => /^[!*a-z0-9.-]+$/.test(r)), "ASCII (punycode) only");
  assert.match(psl.PSL_VERSION, /^\d{4}-\d{2}-\d{2}_/);
  assert.match(psl.PSL_COMMIT, /^[0-9a-f]{40}$/);
});

test("PSL generator: ICANN section only; single-label rules dropped; wildcard, exception and IDN rules kept", () => {
  const text = [
    "// VERSION: 2099-01-01_00-00-00_UTC",
    "// COMMIT: " + "a".repeat(40),
    "// ===BEGIN ICANN DOMAINS===",
    "uk",
    "co.uk",
    "// comment",
    "*.ck",
    "!www.ck",
    "公司.cn",
    "// ===END ICANN DOMAINS===",
    "// ===BEGIN PRIVATE DOMAINS===",
    "blogspot.com",
    "// ===END PRIVATE DOMAINS===",
  ].join("\n");
  const out = gen.parse(text);
  assert.equal(out.version, "2099-01-01_00-00-00_UTC");
  assert.deepEqual(out.rules, ["!www.ck", "*.ck", "co.uk", "xn--55qx5d.cn"]);
  const mod = { exports: {} };
  new Function("module", "exports", gen.render(out, "x.dat"))(mod, mod.exports);
  assert.equal(mod.exports.registrableDomain("a.b.co.uk"), "b.co.uk");
  assert.equal(mod.exports.registrableDomain("a.blogspot.com"), "blogspot.com", "private rules are not applied");
  assert.equal(mod.exports.registrableDomain("x.www.ck"), "www.ck");
});
