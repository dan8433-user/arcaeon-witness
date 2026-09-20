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
