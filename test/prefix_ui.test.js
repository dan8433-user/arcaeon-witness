// test/prefix_ui.test.js — the rev-2b picker's browser half: the debounce,
// and the correctness of the prefix substituted into the commands a buyer
// copies (board item I-daniel-01).
//
// TWO THINGS THIS FILE EXISTS TO CATCH:
//
//   1. DEBOUNCE DRIFT. The availability check fires from a keystroke handler.
//      Without a debounce, one typed prefix is a dozen requests, each of them
//      a GitHub read fan-out on the server — and the per-IP limiter would eat
//      the buyer mid-purchase. The delay and the clearTimeout that resets it
//      are parsed out of the shipped script source here, not assumed.
//
//   2. SUBSTITUTION DRIFT. The curl command exists twice — rendered
//      server-side on the success page (lib/_prefix_ui.js pinCurlCommand) and
//      rebuilt in the browser for the live preview (BUILD_PIN_CURL_JS). If
//      they diverge, the preview shows a buyer one command and the receipt
//      page hands them another. This file EVALUATES the browser copy out of
//      the shipped script and diffs its output against the server copy.
//
// Page-level assertions drive the real api/fulfill.js handler over the same
// mock-Stripe + mock-GitHub seam test/fulfill.test.js uses.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_BASE_URL = "https://witness.test"; // read at require time by api/fulfill.js
process.env.WITNESS_STRIPE_SECRET_KEY = "sk_test_prefix_ui_mock_only"; // test-only literal
process.env.WITNESS_STRIPE_LIVEMODE = "false";
process.env.WITNESS_STRIPE_PRICE_MAP = JSON.stringify({ price_starter_test: "starter" });
delete process.env.WITNESS_KEYS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const prefixUi = require("../lib/_prefix_ui.js");
const prefixCheck = require("../lib/_prefix_check.js");
const fulfill = require("../api/fulfill.js");

const BASE = process.env.WITNESS_BASE_URL;
const SCRIPT = prefixUi.pickerScript(BASE);

// =====================================================================
// 1. THE SCRIPT — parsed, not assumed
// =====================================================================

test("the shipped picker script is syntactically valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(SCRIPT));
});

test("DEBOUNCE: the check is delayed by a named constant in a sane range, not fired per keystroke", () => {
  const m = SCRIPT.match(/var\s+DEBOUNCE_MS\s*=\s*(\d+)\s*;/);
  assert.ok(m, "the script must define a DEBOUNCE_MS constant");
  const ms = Number(m[1]);
  assert.ok(ms >= 100 && ms <= 1500,
    `DEBOUNCE_MS is ${ms}ms — under 100ms is not a debounce, over 1500ms feels broken`);
});

test("DEBOUNCE: the input handler clears the pending timer before setting a new one", () => {
  // Without the clearTimeout, every keystroke schedules its own fetch and the
  // "debounce" only delays the storm rather than collapsing it.
  assert.match(SCRIPT, /addEventListener\("input"/, "the check is driven by input events");
  assert.match(SCRIPT, /clearTimeout\(\s*timer\s*\)/, "a pending check must be cancelled");
  assert.match(SCRIPT, /timer\s*=\s*setTimeout\(\s*check\s*,\s*DEBOUNCE_MS\s*\)/,
    "the new check must be scheduled with the named debounce constant");
  const order = SCRIPT.indexOf("clearTimeout(timer)") < SCRIPT.indexOf("timer = setTimeout(check, DEBOUNCE_MS)");
  assert.ok(order, "clearTimeout must come before the re-arm, or the old timer survives");
});

test("DEBOUNCE: out-of-order responses are dropped, so a slow answer can't repaint a stale verdict", () => {
  assert.match(SCRIPT, /var\s+timer\s*=\s*null\s*,\s*seq\s*=\s*0/, "a request sequence counter");
  assert.match(SCRIPT, /var\s+mine\s*=\s*\+\+seq/, "each request takes a ticket");
  const guards = SCRIPT.match(/if\s*\(\s*mine\s*!==\s*seq\s*\)\s*return/g) || [];
  assert.ok(guards.length >= 2,
    "both the success and the failure handler must drop a superseded response");
});

test("the script asks the public availability route, url-encoding the prefix", () => {
  assert.match(SCRIPT, /fetch\("\/api\/prefix-available\?prefix=" \+ encodeURIComponent\(p\)/);
});

test("all three states are rendered distinctly, and 'could not check' is never painted as free", () => {
  for (const state of ["free", "taken", "unknown", "checking"]) {
    assert.ok(SCRIPT.includes(`paint("${state}"`), `missing the ${state} state`);
  }
  // The failure branches must reach for "unknown", never "free".
  const catchBlock = SCRIPT.slice(SCRIPT.indexOf(".catch(function()"));
  assert.match(catchBlock, /paint\("unknown"/);
  assert.ok(!catchBlock.includes('paint("free"'),
    "a failed check must not report availability");
});

test("BOUNDARY: the picker script never mints — no writes, no POST, no key issuance", () => {
  assert.ok(!/method\s*:\s*["']POST["']/i.test(SCRIPT), "the script issues no POST");
  // Exactly one network call, and it is the read-only availability route.
  // (/api/pin DOES appear in the script — inside the preview STRING that
  // buildPinCurl assembles. That is text on a page, not a request; this
  // assertion is about what the script CALLS.)
  const fetched = (SCRIPT.match(/fetch\(\s*"([^"]*)"/g) || []).map((s) =>
    s.replace(/^fetch\(\s*"/, "").replace(/"$/, "")
  );
  assert.deepEqual(fetched, ["/api/prefix-available?prefix="],
    "the script talks to the read-only availability route and nothing else");
  assert.ok(!/wk_/.test(SCRIPT), "no key material anywhere in the client");
});

test("the server-injected base URL cannot break out of the inline <script>", () => {
  const hostile = prefixUi.jsString('https://x.test"</script><script>alert(1)</script>');
  assert.ok(!hostile.includes("</script>"), "'<' must be escaped to \\u003c");
  assert.match(hostile, /\\u003c/);
  assert.doesNotThrow(() => new Function(`var B = ${hostile};`));
});

// =====================================================================
// 2. SUBSTITUTION — the browser copy evaluated and diffed against the server
// =====================================================================

test("the shipped script embeds EXACTLY the exported buildPinCurl source (so what is tested is what ships)", () => {
  assert.ok(SCRIPT.includes(prefixUi.BUILD_PIN_CURL_JS),
    "pickerScript must interpolate BUILD_PIN_CURL_JS verbatim");
});

test("SUBSTITUTION: the browser's buildPinCurl and the server's pinCurlCommand produce identical commands", () => {
  const browserBuild = new Function(`return (${prefixUi.BUILD_PIN_CURL_JS});`)();
  const prefixes = [
    "acme-",
    "a-",
    "jane-doe-",
    "wk-3f2a1b0c9d8e-",
    "x9-",
    `${"a".repeat(46)}b-`, // the 48-char ceiling
  ];
  for (const p of prefixes) {
    assert.equal(
      browserBuild(BASE, p),
      prefixUi.pinCurlCommand(BASE, p),
      `preview and receipt disagree for prefix ${p}`
    );
  }
});

test("SUBSTITUTION: the prefix lands in the namespace field, and the key stays a placeholder", () => {
  const cmd = prefixUi.pinCurlCommand(BASE, "acme-");
  assert.ok(cmd.includes(`${BASE}/api/pin`), "posts to this deployment's pin endpoint");
  assert.ok(cmd.includes('"namespace":"acme-main"'),
    "the namespace is the buyer's prefix plus a concrete example suffix");
  assert.ok(cmd.includes("Bearer <YOUR KEY>"),
    "the key stays a placeholder on purpose — a copied command must not carry it into shell history");
  assert.equal(cmd.split("\n").length, 4, "four lines, each continued with a trailing backslash");
  for (const line of cmd.split("\n").slice(0, 3)) {
    assert.ok(line.endsWith(" \\"), `line continuation missing: ${JSON.stringify(line)}`);
  }
});

test("SUBSTITUTION: the command is valid JSON in the -d payload once the prefix is in", () => {
  for (const p of ["acme-", "jane-doe-", "x9-"]) {
    const cmd = prefixUi.pinCurlCommand(BASE, p);
    const payload = cmd.slice(cmd.indexOf("-d '") + 4, cmd.lastIndexOf("'"));
    const parsed = JSON.parse(payload);
    assert.equal(parsed.namespace, `${p}main`);
    assert.equal(parsed.rows, 1);
  }
});

test("the pip line is the exact published package, unparameterized", () => {
  assert.equal(prefixUi.PIP_COMMAND, "pip install arcaeon-ledger");
});

// =====================================================================
// 3. THE RENDERED PAGES — real handler, mock Stripe + mock store
// =====================================================================

function fakeResponse(status, bodyObj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  };
}

let gh, sessions, restoreFetch;

beforeEach(() => {
  gh = new MockGitHubStore();
  sessions = new Map();
  const original = global.fetch;
  global.fetch = (url, opts) => {
    const s = String(url);
    if (s.startsWith("https://api.stripe.com/")) {
      const id = decodeURIComponent(new URL(s).pathname.split("/").pop());
      const sess = sessions.get(id);
      return Promise.resolve(
        sess ? fakeResponse(200, sess) : fakeResponse(404, { error: { message: "no such session" } })
      );
    }
    return gh.handleFetch(url, opts);
  };
  restoreFetch = () => { global.fetch = original; };
  prefixCheck._resetCache();
});

afterEach(() => {
  restoreFetch();
  prefixCheck._resetCache();
});

let n = 0;
function paidSession() {
  n += 1;
  const id = `cs_test_${String(n).padStart(4, "0")}${"b".repeat(20)}`;
  sessions.set(id, {
    id,
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    amount_total: 1500,
    currency: "usd",
    client_reference_id: null,
    customer_details: { email: "jane.doe@acme.com" },
    metadata: {},
    line_items: { data: [{ price: { id: "price_starter_test" } }] },
  });
  return id;
}

async function page({ method = "GET", query = {}, body = null }) {
  const req = makeReq({ method, query, body, headers: { accept: "text/html" } });
  const res = makeRes();
  await fulfill(req, res);
  return res;
}

// The clipboard copies a DOM node's textContent, i.e. the decoded text — so
// to assert what a buyer actually pastes, decode the rendered escapes back.
function decode(html) {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function block(html, id) {
  const start = html.indexOf(`<pre id="${id}">`);
  assert.ok(start >= 0, `no copy block with id ${id}`);
  const from = start + `<pre id="${id}">`.length;
  return decode(html.slice(from, html.indexOf("</pre>", from)));
}

function box(html, id) {
  const start = html.indexOf(`<code id="${id}">`);
  assert.ok(start >= 0, `no copy box with id ${id}`);
  const from = start + `<code id="${id}">`.length;
  return decode(html.slice(from, html.indexOf("</code>", from)));
}

test("PICKER PAGE: renders the live-check hooks, the script, and a command preview — and mints nothing", async () => {
  const sid = paidSession();
  const res = await page({ query: { session_id: sid } });
  assert.equal(res._status, 200);
  const html = String(res._body);

  for (const id of ["prefix", "prefix-status", "prefix-alts", "ns-preview", "curl-preview"]) {
    assert.ok(html.includes(`id="${id}"`), `picker is missing #${id}`);
  }
  assert.ok(html.includes("DEBOUNCE_MS"), "the picker page must carry the debounced check script");
  assert.ok(html.includes('data-copy-target="pip"'), "copy button for the install command");
  assert.ok(html.includes('data-copy-target="curl-preview"'), "copy button for the pin command");

  // The prefix is suggested from the buyer's email local part (jane.doe@ ->
  // jane-doe-), and the preview must already be built around it.
  assert.ok(html.includes('value="jane-doe-"'), "prefill from the Stripe customer email");
  assert.equal(block(html, "curl-preview"), prefixUi.pinCurlCommand(BASE, "jane-doe-"));
  assert.equal(box(html, "pip"), prefixUi.PIP_COMMAND);

  assert.deepEqual(gh.putLog, [], "BOUNDARY: rendering the picker mints nothing");
  assert.ok(!html.includes("wk_"), "no key is on the picker page");
});

test("SUCCESS PAGE: the key, the install line, and the pin command are all copy boxes with the chosen prefix substituted", async () => {
  const sid = paidSession();
  const res = await page({
    method: "POST",
    query: {},
    body: { session_id: sid, prefix: "contoso-" },
  });
  assert.equal(res._status, 200);
  const html = String(res._body);

  const key = box(html, "key");
  assert.match(key, /^wk_[0-9a-f]{48}$/, "the minted key renders in its own copy box");
  assert.equal(box(html, "pip"), prefixUi.PIP_COMMAND);

  const curl = block(html, "curl");
  assert.equal(curl, prefixUi.pinCurlCommand(BASE, "contoso-"),
    "the receipt page's command must be the same string the preview showed");
  assert.ok(curl.includes('"namespace":"contoso-main"'), "the chosen prefix is substituted");
  assert.ok(!curl.includes(key), "the live key is never baked into the copyable command");

  for (const id of ["key", "pip", "curl"]) {
    assert.ok(html.includes(`data-copy-target="${id}"`), `no copy button for ${id}`);
  }
});

test("SUCCESS PAGE: a random auto-minted prefix is substituted just as faithfully", async () => {
  const sid = paidSession();
  const res = await page({ method: "POST", query: {}, body: { session_id: sid, prefix: "zeta-" } });
  const html = String(res._body);
  assert.equal(block(html, "curl"), prefixUi.pinCurlCommand(BASE, "zeta-"));
});
