// test/register.test.js — the registration grant (lib/_register.js via
// api/fulfill.js ?op=register|confirm|register-status|register-report), the
// "grant" plan in lib/_meter.js, the purchased flag in lib/_balance.js, and
// the durable hourly pin counter in api/pin.js. Mock store only; the mail
// sender is injected, and a fetch guard fails the test if anything tries to
// reach a network host that is not the mocked GitHub API.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.REGISTER_IP_SALT = "test-salt-not-a-secret";
process.env.WITNESS_ADMIN_KEY = "test-admin-key";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.WITNESS_KEYS;
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const keys = require("../lib/_keys.js");
const meter = require("../lib/_meter.js");
const register = require("../lib/_register.js");
const fulfill = require("../api/fulfill.js");
const pin = require("../api/pin.js");

const USAGE = process.env.GITHUB_USAGE_REPO;

let gh, sent, foreignCalls, restoreFetch;
const realPutSleep = store._putRetry.sleep;
const realRetrySleep = register._timing.retrySleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  sent = [];
  foreignCalls = [];
  const original = global.fetch;
  global.fetch = (url, opts) => {
    if (!String(url).startsWith("https://api.github.com/")) {
      foreignCalls.push(String(url));
      return Promise.resolve({ status: 599, ok: false, json: async () => ({}), text: async () => "blocked in tests" });
    }
    return gh.handleFetch(url, opts);
  };
  restoreFetch = () => { global.fetch = original; };
  register.setSender(async (msg) => { sent.push(msg); return { ok: true }; });
  store._putRetry.sleep = async () => {};
  register._timing.retrySleep = async () => {};
  pin._resetRateBuckets();
});

afterEach(() => {
  assert.deepEqual(foreignCalls, [], "a test reached a non-GitHub host (mail must go through the injected sender)");
  register.setSender(null);
  store._putRetry.sleep = realPutSleep;
  register._timing.retrySleep = realRetrySleep;
  restoreFetch();
});

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; // unique per call
}

async function call(req) {
  const res = makeRes();
  await fulfill(req, res);
  return res;
}

function registerReq(email, { ip = freshIp(), agent, xff } = {}) {
  const body = { email };
  if (agent !== undefined) body.agent = agent;
  return makeReq({
    method: "POST",
    headers: { "x-forwarded-for": xff || ip, accept: "application/json" },
    body,
    query: { op: "register" },
  });
}

function tokenFrom(msg) {
  const m = /[?&]t=([0-9a-f]{64})/.exec(msg.text);
  assert.ok(m, "the email carries a confirm link");
  return m[1];
}

// The claim: POST with the token in the body (review 3: the GET link never mints).
function confirmReq(t, json = true) {
  const accept = json ? "application/json" : "text/html";
  return makeReq({ method: "POST", headers: { accept, "x-forwarded-for": freshIp() }, query: { op: "confirm" }, body: { t } });
}
function confirmGetReq(t, json = false) {
  const accept = json ? "application/json" : "text/html";
  return makeReq({ method: "GET", headers: { accept, "x-forwarded-for": freshIp() }, query: { op: "confirm", t } });
}

function statusReq(email) {
  return makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "register-status", email } });
}

async function registerAndConfirm(email, opts) {
  const r = await call(registerReq(email, opts));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const c = await call(confirmReq(tokenFrom(sent[sent.length - 1])));
  assert.equal(c._status, 200, JSON.stringify(c._body));
  return c._body;
}

function pinReq(key, namespace, rows) {
  return makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: { namespace, rows, chain: rows.toString(16).padStart(8, "a") },
  });
}

// ---------------------------------------------------------------- happy path

test("HAPPY PATH: register -> pending + one email; confirm -> key with 500 credits; second confirm is idempotent", async () => {
  const r = await call(registerReq("Jane@Example.com", { agent: "claude-agent" }));
  assert.equal(r._status, 200);
  assert.equal(r._body.state, "pending");
  assert.equal(r._body.key, undefined, "register never returns a key");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "jane@example.com");
  assert.ok(!/wk_[0-9a-f]{48}/.test(sent[0].text), "the email carries the link, not a key");

  const emailHash = register.sha256("jane@example.com");
  const reg = gh.read(USAGE, register.regPath(emailHash));
  assert.equal(reg.state, "pending");
  assert.equal(reg.agent, "claude-agent");
  assert.match(reg.token_hash, /^[0-9a-f]{64}$/);
  assert.match(reg.ip_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(reg).includes("jane@"), "the registration stores no raw email");
  assert.ok(!/"10\.\d+\.\d+\.\d+"/.test(JSON.stringify(reg)), "the registration stores no raw IP");

  const s1 = await call(statusReq("jane@example.com"));
  assert.deepEqual(s1._body, { state: "pending_or_unknown" });
  const t8 = r._body.t8;
  assert.match(t8, /^[0-9a-f]{8}$/);

  const token = tokenFrom(sent[0]);
  const c1 = await call(confirmReq(token));
  assert.equal(c1._status, 200);
  assert.equal(c1._body.state, "confirmed");
  assert.match(c1._body.key, /^wk_[0-9a-f]{48}$/);
  assert.equal(c1._body.credit_balance, 500);
  assert.equal(c1._body.shown_once, true);

  const keyHash = keys.keyHash(c1._body.key);
  const issued = gh.read(USAGE, keys.issuedKeyPath(keyHash));
  assert.equal(issued.plan, "grant");
  assert.equal(issued.source, "register");
  const ful = gh.read(USAGE, keys.fulfillmentPath(register.fulfillId(emailHash)));
  const regAfter = gh.read(USAGE, register.regPath(emailHash));
  assert.equal(regAfter.state, "confirmed");
  assert.equal(regAfter.key_hash, keyHash);

  assert.equal(ful.key, c1._body.key, "the raw key stays readable for the 15-minute re-show window");
  assert.ok(regAfter.key_shown_at, "key_shown_at recorded");

  // Past the window: the next request nulls the raw key and answers already-claimed.
  const rp = register.regPath(emailHash);
  gh.seed(USAGE, rp, { ...regAfter, key_shown_at: new Date(Date.now() - register.KEY_RESHOW_MS - 1000).toISOString() });
  const c2 = await call(confirmReq(token));
  assert.equal(c2._status, 409);
  assert.equal(c2._body.reason, "already_claimed");
  assert.equal(c2._body.key, undefined, "past the window the key is not shown");
  assert.match(c2._body.error, /^already claimed on .+; the key was shown then; if you lost it, contact support@arcaeon\.io with the address you registered$/);
  assert.ok(!/register again/.test(c2._body.error), "never says register again");
  assert.equal(gh.read(USAGE, keys.fulfillmentPath(register.fulfillId(emailHash))).key, null, "the raw key is nulled");
  const writesBefore = gh.putLog.length;
  const c2b = await call(confirmReq(token));
  assert.equal(c2b._status, 409);
  assert.equal(gh.putLog.length, writesBefore, "after the null, a claim writes nothing");
  assert.equal((await balance.readBalance(keyHash)).balance, 500, "never granted twice");

  const s2 = await call(statusReq("jane@example.com"));
  assert.deepEqual(s2._body, { state: "pending_or_unknown" }, "without t8 a confirmed address is not revealed");
  const s3 = await call(makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "register-status", e: emailHash, t8 } }));
  assert.deepEqual(s3._body, { state: "confirmed" }, "with t8 the starter sees confirmed; never the key");
});

test("THE LINK DOES NOT MINT: GET shows one 'Show my key' form; nothing is written; the POST shows the key in plain markup", async () => {
  await call(registerReq("html@example.com"));
  const t = tokenFrom(sent[0]);
  const writesBefore = gh.putLog.length;
  for (let i = 0; i < 3; i++) {
    const g = await call(confirmGetReq(t));
    assert.equal(g._status, 200);
    assert.match(g._headers["content-type"], /text\/html/);
    assert.match(g._body, /<form method="post" action="[^"]*op=confirm">/);
    assert.match(g._body, /<input type="hidden" name="t" value="[0-9a-f]{64}">/);
    assert.match(g._body, /<button type="submit">Show my key<\/button>/);
    assert.ok(!/wk_[0-9a-f]{48}/.test(g._body), "no key on the GET page");
  }
  const gj = await call(confirmGetReq(t, true));
  assert.equal(gj._body.state, "pending");
  assert.equal(gh.putLog.length, writesBefore, "a scanner's GETs mint, grant and mark nothing");
  assert.equal(gh.has(USAGE, keys.fulfillmentPath(register.fulfillId(register.sha256("html@example.com")))), false);

  const c = await call(confirmReq(t, false));
  assert.equal(c._status, 200);
  assert.match(c._body, /<code id="key">wk_[0-9a-f]{48}<\/code>/);
  const again = await call(confirmGetReq(t));
  assert.equal(again._status, 409);
  assert.ok(!/wk_[0-9a-f]{48}/.test(again._body));
});

test("DOUBLE SUBMIT: a second POST inside 15 minutes re-shows the same key with no write and no second grant; GET never shows it", async () => {
  await call(registerReq("double@example.com"));
  const t = tokenFrom(sent[0]);
  const c1 = await call(confirmReq(t));
  assert.equal(c1._status, 200);
  const writesBefore = gh.putLog.length;
  const c2 = await call(confirmReq(t));
  assert.equal(c2._status, 200, JSON.stringify(c2._body));
  assert.equal(c2._body.key, c1._body.key, "the same key");
  assert.equal(c2._body.reshown, true);
  assert.equal(c2._body.credit_balance, 500);
  const html = await call(confirmReq(t, false));
  assert.equal(html._status, 200);
  assert.ok(html._body.includes(c1._body.key), "the HTML re-show carries the same key");
  const g = await call(confirmGetReq(t));
  assert.equal(g._status, 409, "a GET inside the window does not show the key");
  assert.ok(!g._body.includes(c1._body.key));
  assert.equal(gh.putLog.length, writesBefore, "re-shows and the GET wrote nothing");
  assert.equal((await balance.readBalance(keys.keyHash(c1._body.key))).balance, 500, "granted once");
});

test("CONFIRM RATE LIMIT: the in-memory per-IP pre-filter covers confirm (GET and POST)", async () => {
  const ip = "198.51.100.150";
  let last;
  for (let i = 0; i <= 30; i++) {
    last = makeRes();
    await fulfill(makeReq({ method: "GET", headers: { "x-forwarded-for": ip }, query: { op: "confirm", t: "b".repeat(64) } }), last);
  }
  assert.equal(last._status, 429);
  assert.equal(last._body.reason, "rate_limited");
});

test("CLAIM WINDOW: the 11th key claimed from one IPv4 address in 30 days is 429 and mints nothing", async () => {
  const claimIp = "198.51.100.160";
  const L = register.IP_WINDOW_LIMIT;
  assert.equal(L, 10);
  const tokens = [];
  for (let i = 1; i <= L + 1; i++) {
    await call(registerReq(`claimer${i}@example.com`));
    tokens.push(tokenFrom(sent[sent.length - 1]));
  }
  const claim = (t) => makeReq({ method: "POST", headers: { accept: "application/json", "x-forwarded-for": claimIp }, query: { op: "confirm" }, body: { t } });
  for (let i = 0; i < L; i++) assert.equal((await call(claim(tokens[i])))._status, 200, `claim ${i + 1}`);
  const over = await call(claim(tokens[L]));
  assert.equal(over._status, 429);
  assert.equal(over._body.reason, "ip_claim_window");
  assert.equal(gh.has(USAGE, keys.fulfillmentPath(register.fulfillId(register.sha256(`claimer${L + 1}@example.com`)))), false);
});

test("GRANT GATE: the registration's granted flag stops a second grant even when applied_events no longer holds the id", async () => {
  await call(registerReq("gate@example.com"));
  const t = tokenFrom(sent[0]);
  const h = register.sha256("gate@example.com");
  // Crash shape: the grant landed and the flag was written, the mark did not.
  const origPut = gh.handleFetch.bind(gh);
  let regPuts = 0;
  gh.handleFetch = async (url, opts) => {
    if (opts && opts.method === "PUT" && String(url).endsWith(`registrations/${h}.json`)) {
      regPuts += 1;
      if (regPuts === 2) return { status: 500, ok: false, json: async () => ({}), text: async () => "mock: mark fails" };
    }
    return origPut(url, opts);
  };
  const first = await call(confirmReq(t));
  assert.equal(first._status, 503, "the mark failed after the grant and the flag");
  gh.handleFetch = origPut;
  assert.equal(gh.read(USAGE, register.regPath(h)).granted, true);
  const keyHash = gh.read(USAGE, keys.fulfillmentPath(register.fulfillId(h))).key_hash;
  // applied_events aged out: only the flag stands between this and a second +500.
  const bp = balance.balancePath(keyHash);
  gh.seed(USAGE, bp, { ...gh.read(USAGE, bp), applied_events: [] });
  const second = await call(confirmReq(t));
  assert.equal(second._status, 200);
  assert.equal((await balance.readBalance(keyHash)).balance, 500, "granted once, by the flag");
  assert.equal(second._body.credit_balance, 500);
});

test("CLAIM RESUMES AFTER A CRASH: minted but not marked -> the next POST shows that key once, grants once", async () => {
  await call(registerReq("crash@example.com"));
  const t = tokenFrom(sent[0]);
  const h = register.sha256("crash@example.com");
  gh.forceFailure(USAGE, register.regPath(h), 1, 500); // the mark fails once, after the mint and grant
  const first = await call(confirmReq(t));
  assert.equal(first._status, 503);
  const minted = gh.read(USAGE, keys.fulfillmentPath(register.fulfillId(h)));
  assert.match(minted.key, /^wk_/);
  const second = await call(confirmReq(t));
  assert.equal(second._status, 200);
  assert.equal(second._body.key, minted.key, "the same key, not a second one");
  assert.equal((await balance.readBalance(keys.keyHash(minted.key))).balance, 500);
});

test("CONFIRM: malformed, unknown and superseded tokens are one bare 404 costing at most one read; expired is 410", async () => {
  const mal = await call(confirmReq("nothex"));
  assert.equal(mal._status, 404);
  assert.deepEqual(mal._body, { error: "not found" });
  const readsBefore = gh.getLog.length;
  const unk = await call(confirmReq("a".repeat(64)));
  assert.equal(unk._status, 404);
  assert.deepEqual(unk._body, { error: "not found" });
  assert.equal(gh.getLog.length - readsBefore, 1, "an unknown token costs one GET");
  assert.equal(gh.putLog.filter((w) => w.path.startsWith("registrations/")).length, 0);

  const ip = freshIp();
  await call(registerReq("rot@example.com", { ip }));
  const oldT = tokenFrom(sent[0]);
  await call(registerReq("rot@example.com", { ip }));
  assert.equal(sent.length, 2, "a pending email gets a fresh link");
  const readsBefore2 = gh.getLog.length;
  const old = await call(confirmReq(oldT));
  assert.equal(old._status, 404);
  assert.deepEqual(old._body, { error: "not found" }, "a replaced link says nothing about why");
  assert.equal(gh.getLog.length - readsBefore2, 1, "a replaced token stops at its voided index: one GET");

  await call(registerReq("late@example.com"));
  const t = tokenFrom(sent[2]);
  const p = register.regPath(register.sha256("late@example.com"));
  const rec = gh.read(USAGE, p);
  rec.token_created_at = new Date(Date.now() - register.TOKEN_TTL_MS - 1000).toISOString();
  gh.seed(USAGE, p, rec);
  const exp = await call(confirmReq(t));
  assert.equal(exp._status, 410);
  assert.equal(exp._body.reason, "expired_token");
});

test("AGENT LABEL: stored on the record only, never in the mail; outside [A-Za-z0-9 ._-]{0,32} is 400", async () => {
  const r = await call(registerReq("agentlabel@example.com", { agent: "my-agent_1.0" }));
  assert.equal(r._status, 200);
  assert.equal(gh.read(USAGE, register.regPath(register.sha256("agentlabel@example.com"))).agent, "my-agent_1.0");
  assert.ok(!sent[0].text.includes("my-agent_1.0") && !sent[0].html.includes("my-agent_1.0"), "agent label is not in the email");
  for (const bad of ["<a href=x>", "x".repeat(33), "urgent: verify now!", 7]) {
    const b = await call(registerReq("agentbad@example.com", { agent: bad }));
    assert.equal(b._status, 400, String(bad));
    assert.equal(b._body.reason, "bad_agent");
  }
});

test("NO RAW ADDRESS OUT: status_url carries the email hash; no log line carries the address", async () => {
  const logs = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const r = await call(registerReq("privacy.person@example.com"));
    assert.equal(r._status, 200);
    const h = register.sha256("privacy.person@example.com");
    assert.ok(r._body.status_url.includes(`e=${h}`));
    assert.ok(!JSON.stringify(r._body).includes("privacy.person"), "no raw address in the response");
    const s = await call(makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "register-status", e: h } }));
    assert.equal(s._status, 200);
    register.setSender(async () => { throw new Error("upstream said privacy.person@example.com bounced"); });
    await call(registerReq("privacy.person@example.com"));
    await call(confirmReq(tokenFrom(sent[0])));
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assert.ok(logs.length > 0, "the failure path did log");
  for (const line of logs) assert.ok(!line.includes("privacy.person"), `log line carries the address: ${line}`);
});

// ---------------------------------------------------------- one grant, ever

test("REPEAT EMAIL: a confirmed email answers 200 confirmed, sends nothing, grants nothing", async () => {
  const first = await registerAndConfirm("once@example.com");
  const before = sent.length;
  const fresh = await call(registerReq("somebody-new@example.com"));
  const sentAfterFresh = sent.length;
  const again = await call(registerReq("once@example.com"));
  assert.equal(again._status, fresh._status, "same status as a fresh registration");
  assert.deepEqual(Object.keys(again._body).sort(), Object.keys(fresh._body).sort(), "same fields as a fresh registration");
  assert.equal(again._body.state, "pending");
  assert.equal(again._body.key, undefined);
  assert.equal(sent.length, sentAfterFresh, "no mail for the confirmed address");
  assert.equal(sent.length, before + 1, "only the fresh address was mailed");
  assert.equal((await balance.readBalance(keys.keyHash(first.key))).balance, 500);
});

test("NO ORACLE: register-status answers the same for unknown and pending; a wrong t8 proves nothing; no slot spent for a confirmed address", async () => {
  const unknown = await call(statusReq("never-seen@example.com"));
  await call(registerReq("waiting@example.com"));
  const pending = await call(statusReq("waiting@example.com"));
  assert.deepEqual(unknown._body, pending._body);
  assert.deepEqual(pending._body, { state: "pending_or_unknown" });

  const ip = "198.51.100.61";
  await registerAndConfirm("already@example.com", { ip: "198.51.100.62" });
  const month = new Date().toISOString().slice(0, 7);
  const r = await call(registerReq("already@example.com", { ip }));
  assert.equal(r._status, 200);
  assert.equal(gh.has(USAGE, register.ipPath(register.ipHash(ip), month)), false, "no slot spent");
  const h = register.sha256("already@example.com");
  const wrong = await call(makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "register-status", e: h, t8: r._body.t8 } }));
  assert.deepEqual(wrong._body, { state: "pending_or_unknown" }, "the decoy t8 from a confirmed-address register proves nothing");
});

// ---------------------------------------------------------- email hygiene

test("DISPOSABLE DOMAIN: 400, subdomains too, nothing written, nothing sent", async () => {
  for (const email of ["x@mailinator.com", "x@mx.mailinator.com", "y@yopmail.com"]) {
    const r = await call(registerReq(email));
    assert.equal(r._status, 400, email);
    assert.equal(r._body.reason, "disposable_email");
  }
  assert.equal(gh.putLog.length, 0);
  assert.equal(sent.length, 0);
});

test("BAD EMAIL: 400 bad_email", async () => {
  for (const email of ["", "no-at-sign", "a@b", "a..b@example.com", "+tag@example.com", 42]) {
    const r = await call(registerReq(email));
    assert.equal(r._status, 400, String(email));
    assert.equal(r._body.reason, "bad_email");
  }
});

test("PLUS-ALIAS COLLAPSE: a+1@x and a@x are one identity; gmail dots and googlemail fold too", async () => {
  assert.equal(register.normaliseEmail("A+1@X.com").normalised, "a@x.com");
  assert.equal(register.normaliseEmail("a@x.com").normalised, "a@x.com");
  assert.equal(register.normaliseEmail("J.Doe+news@googlemail.com").normalised, "jdoe@gmail.com");
  assert.equal(register.normaliseEmail("jdoe@gmail.com").normalised, "jdoe@gmail.com");
  assert.equal(register.normaliseEmail("j.doe@example.com").normalised, "j.doe@example.com", "dots only fold at gmail");

  await registerAndConfirm("a+1@x.com");
  const sentBefore = sent.length;
  const r = await call(registerReq("a@x.com"));
  assert.equal(r._status, 200);
  const r2 = await call(registerReq("a+farm2@x.com"));
  assert.equal(r2._status, 200);
  assert.equal(sent.length, sentBefore, "the collapsed aliases are the confirmed identity: no mail, no grant");
});

// ---------------------------------------------------------- per-IP window

test("IP WINDOW: the 11th registration from one IPv4 address in 30 days is 429; another IP is not", async () => {
  const ip = "198.51.100.7";
  const L = register.IP_WINDOW_LIMIT;
  for (let i = 1; i <= L; i++) {
    const r = await call(registerReq(`ipuser${i}@example.com`, { ip }));
    assert.equal(r._status, 200, `registration ${i}`);
  }
  const over = await call(registerReq("ipuserX@example.com", { ip }));
  assert.equal(over._status, 429);
  assert.equal(over._body.reason, "ip_registration_window");
  assert.equal(over._body.limit, 10);
  assert.equal(sent.length, L, "the refused one sent nothing");

  const other = await call(registerReq("ipuserX@example.com", { ip: "198.51.100.8" }));
  assert.equal(other._status, 200);

  const iph = register.ipHash(ip);
  const month = new Date().toISOString().slice(0, 7);
  const file = gh.read(USAGE, register.ipPath(iph, month));
  assert.equal(file.events.length, L);
  assert.ok(!JSON.stringify(file).includes(ip), "no raw IP at rest");
});

test("IP WINDOW: a spoofed LEFTMOST x-forwarded-for hop does not buy a new window (rightmost is used)", async () => {
  const real = "192.0.2.50";
  for (let i = 1; i <= register.IP_WINDOW_LIMIT; i++) {
    const r = await call(registerReq(`spoof${i}@example.com`, { xff: `10.0.0.${i}, ${real}` }));
    assert.equal(r._status, 200);
  }
  const r = await call(registerReq("spoofX@example.com", { xff: `10.9.9.9, ${real}` }));
  assert.equal(r._status, 429);
  assert.equal(register.clientIp({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }), "2.2.2.2");
});

test("IP WINDOW: last month's events inside 30 days still count (rolling, not calendar)", async () => {
  const ip = "192.0.2.77";
  const iph = register.ipHash(ip);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
  const recent = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
  const old = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  gh.seed(USAGE, register.ipPath(iph, prev), { ip_hash: iph, month: prev, events: Array(register.IP_WINDOW_LIMIT - 1).fill(recent).concat([old, old]) });
  assert.equal((await call(registerReq("roll1@example.com", { ip })))._status, 200);
  assert.equal((await call(registerReq("roll2@example.com", { ip })))._status, 429);
});

test("SLOT RACE: a concurrent register taking the last slot between our read and our CAS write is 429 and no mail is sent", async () => {
  const ip = "192.0.2.88";
  const iph = register.ipHash(ip);
  const month = new Date().toISOString().slice(0, 7);
  const p = register.ipPath(iph, month);
  const now = new Date().toISOString();
  const L = register.IP_WINDOW_LIMIT;
  gh.seed(USAGE, p, { ip_hash: iph, month, events: Array(L - 1).fill(now) });
  const orig = gh.handleFetch.bind(gh);
  let raced = false;
  gh.handleFetch = async (url, opts) => {
    if (!raced && opts && opts.method === "PUT" && String(url).includes(p)) {
      raced = true; // a concurrent register lands first: the file (and its sha) moves
      gh.seed(USAGE, p, { ...gh.read(USAGE, p), events: Array(L).fill(now) });
    }
    return orig(url, opts);
  };
  const r = await call(registerReq("race@example.com", { ip }));
  gh.handleFetch = orig;
  assert.equal(raced, true);
  assert.equal(r._status, 429, JSON.stringify(r._body));
  assert.equal(r._body.reason, "ip_registration_window");
  assert.equal(sent.length, 0, "the slot is reserved before the mail, so the loser mails nothing");
  assert.equal(gh.read(USAGE, p).events.length, L);
  assert.equal(gh.has(USAGE, register.regPath(register.sha256("race@example.com"))), false, "no record written");
});

test("CAS EXHAUSTION: 8 conflicts on the window answer 503 store_busy, no mail sent, no slot spent, no record", async () => {
  assert.equal(register.WINDOW_CAS_ATTEMPTS, 8);
  const ip = "192.0.2.89";
  const month = new Date().toISOString().slice(0, 7);
  const p = register.ipPath(register.ipHash(ip), month);
  gh.forceConflict(USAGE, p, 8);
  const r = await call(registerReq("busy@example.com", { ip }));
  assert.equal(r._status, 503, JSON.stringify(r._body));
  assert.equal(r._body.reason, "store_busy");
  assert.equal(sent.length, 0);
  assert.equal(gh.has(USAGE, p), false, "no slot spent");
  assert.equal(gh.has(USAGE, register.regPath(register.sha256("busy@example.com"))), false);
  // IPv6: the /64 is spent, then the /48 exhausts -> the /64 is refunded.
  const ip6 = "2001:db8:cc:1::1";
  const [b64, b48] = register.networkBuckets(ip6);
  gh.forceConflict(USAGE, register.ipPath(b48.hash, month), 8);
  const r6 = await call(registerReq("busy6@example.com", { ip: ip6 }));
  assert.equal(r6._status, 503);
  assert.equal(sent.length, 0);
  assert.deepEqual(gh.read(USAGE, register.ipPath(b64.hash, month)).events, [], "the /64 slot was given back");
});

// ---------------------------------------------------------- networks + domains (review 1)

test("NETWORKS: IPv6 hashes the /64 (and the /48); IPv4-mapped IPv6 is the IPv4 address", () => {
  assert.deepEqual(register.expandIPv6("2001:db8::1"), ["2001", "0db8", "0000", "0000", "0000", "0000", "0000", "0001"]);
  assert.deepEqual(register.expandIPv6("::ffff:192.0.2.1").slice(5), ["ffff", "c000", "0201"]);
  assert.equal(register.expandIPv6("not-an-ip"), null);
  const a = register.networkBuckets("2001:db8:1:2:aaaa::1");
  const b = register.networkBuckets("2001:db8:1:2:ffff:ffff:ffff:ffff");
  const c = register.networkBuckets("2001:db8:1:3::1");
  assert.equal(a[0].scope, "v6/64");
  assert.equal(a[0].hash, b[0].hash, "same /64, same bucket");
  assert.notEqual(a[0].hash, c[0].hash, "different /64");
  assert.equal(a[1].scope, "v6/48");
  assert.equal(a[1].hash, c[1].hash, "same /48 bucket across /64s");
  assert.equal(a[0].limit, 10);
  assert.equal(a[1].limit, 30);
  assert.equal(register.networkBuckets("192.0.2.1")[0].limit, 10);
  assert.equal(register.networkBuckets("::ffff:192.0.2.9")[0].hash, register.networkBuckets("192.0.2.9")[0].hash);
});

test("NETWORKS: an 11th registration from ANY address in one IPv6 /64 is 429", async () => {
  for (let i = 1; i <= register.V6_64_LIMIT; i++) {
    const r = await call(registerReq(`v6user${i}@example.com`, { ip: `2001:db8:aa:1::${i}` }));
    assert.equal(r._status, 200, `registration ${i}`);
  }
  const r = await call(registerReq("v6userX@example.com", { ip: "2001:db8:aa:1:dead:beef:0:4" }));
  assert.equal(r._status, 429);
  assert.equal(r._body.scope, "v6/64");
});

test("NETWORKS: a /48 caps at 30 per 30 days even when each /64 is under its own 10", async () => {
  let n = 0;
  for (let net = 1; net <= 4; net++) {
    for (let i = 1; i <= 8; i++) {
      n += 1;
      const r = await call(registerReq(`v48user${n}@example.com`, { ip: `2001:db8:bb:${net}::${i}` }));
      if (n <= 30) assert.equal(r._status, 200, `registration ${n}`);
      else {
        assert.equal(r._status, 429, `registration ${n}`);
        assert.equal(r._body.scope, "v6/48");
      }
    }
  }
});

test("DOMAIN WINDOW: a non-major domain gets 20 grants per 30 days; the 21st confirm and the next register are 429", async () => {
  const L = register.DOMAIN_WINDOW_LIMIT;
  assert.equal(L, 20);
  const tokens = [];
  for (let i = 1; i <= L + 1; i++) {
    const r = await call(registerReq(`staff${i}@smallco.example`));
    assert.equal(r._status, 200, `register ${i} (pending registrations spend no domain slot)`);
    tokens.push(tokenFrom(sent[sent.length - 1]));
  }
  for (let i = 0; i < L; i++) assert.equal((await call(confirmReq(tokens[i])))._status, 200, `grant ${i + 1}`);
  const over = await call(confirmReq(tokens[L]));
  assert.equal(over._status, 429);
  assert.equal(over._body.reason, "domain_registration_window");
  const more = await call(registerReq("staffX@smallco.example"));
  assert.equal(more._status, 429);
  assert.equal(more._body.reason, "domain_registration_window");
  assert.equal(sent.length, L + 1, "no link mailed once the domain is full");
});

test("ALLOWLIST: WITNESS_REGISTER_ALLOW domains and exact IPs skip the windows; CIDR entries are ignored", async () => {
  process.env.WITNESS_REGISTER_ALLOW = " partner.example , 203.0.113.9, 2001:DB8:dd:1::5, 198.51.100.0/24";
  try {
    assert.equal(register.isAllowed("staff.partner.example", "1.2.3.4"), true, "registrable domain match");
    assert.equal(register.isAllowed("other.example", "203.0.113.9"), true, "exact IP match");
    assert.equal(register.isAllowed("other.example", "2001:db8:dd:1:0:0:0:5"), true, "IPv6 compared expanded");
    assert.equal(register.isAllowed("other.example", "198.51.100.7"), false, "CIDR is not supported");
    assert.equal(register.isAllowed("other.example", "203.0.113.10"), false);
    const month = new Date().toISOString().slice(0, 7);
    const ip = "203.0.113.9";
    for (let i = 1; i <= register.IP_WINDOW_LIMIT + 2; i++) {
      const r = await call(registerReq(`p${i}@other.example`, { ip }));
      assert.equal(r._status, 200, `allowlisted IP registration ${i}`);
    }
    assert.equal(gh.has(USAGE, register.ipPath(register.ipHash(ip), month)), false, "no window spent for an allowlisted IP");
    const tokens = [];
    for (let i = 1; i <= register.DOMAIN_WINDOW_LIMIT + 1; i++) {
      await call(registerReq(`s${i}@partner.example`));
      tokens.push(tokenFrom(sent[sent.length - 1]));
    }
    for (const t of tokens) assert.equal((await call(confirmReq(t)))._status, 200);
    assert.equal(gh.has(USAGE, register.domainPath("partner.example", month)), false, "no domain window spent");
  } finally {
    delete process.env.WITNESS_REGISTER_ALLOW;
  }
});

test("DOMAIN WINDOW: the major-provider exemption is an exact list, no prefix or regional matching", async () => {
  for (const d of ["gmail.com", "googlemail.com", "outlook.com", "hey.com", "mail.com", "t-online.de", "zoho.com"]) {
    assert.equal(register.isMajorProvider(d), true, d);
  }
  for (const d of ["yahoo.co.jp", "hotmail.co.uk", "outlook.fr", "live.de", "gmail.com.evil.example", "evilgmail.com", "x.gmail.com", "smallco.example"]) {
    assert.equal(register.isMajorProvider(d), false, d);
  }
  assert.equal(register.MAJOR_PROVIDERS.size, 40);
  for (let i = 1; i <= 6; i++) await registerAndConfirm(`person${i}@gmail.com`);
});

test("DOMAIN WINDOW: keyed on the registrable domain; subdomains share one window", async () => {
  assert.equal(register.registrableDomain("acme.example"), "acme.example");
  assert.equal(register.registrableDomain("a.b.acme.example"), "acme.example");
  assert.equal(register.registrableDomain("shop.acme.co.uk"), "acme.co.uk");
  assert.equal(register.registrableDomain("mail.acme.com.au"), "acme.com.au");
  assert.equal(register.registrableDomain("x.uni.ac.jp"), "uni.ac.jp");
  assert.equal(register.registrableDomain("a.b.c.d.example"), "d.example");
  const tokens = [];
  const n = register.DOMAIN_WINDOW_LIMIT + 1;
  for (let i = 1; i <= n; i++) {
    const r = await call(registerReq(`u${i}@sub${i}.farm.example`));
    assert.equal(r._status, 200, `register ${i}`);
    tokens.push(tokenFrom(sent[sent.length - 1]));
  }
  for (let i = 0; i < n - 1; i++) assert.equal((await call(confirmReq(tokens[i])))._status, 200, `grant ${i + 1}`);
  const last = await call(confirmReq(tokens[n - 1]));
  assert.equal(last._status, 429, "a fresh subdomain is not a fresh window");
  assert.equal(last._body.reason, "domain_registration_window");
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(gh.read(USAGE, register.domainPath("farm.example", month)).events.length, n - 1);
});

test("NOT CONFIGURED: no sender and no RESEND_* env -> 501 before any write", async () => {
  register.setSender(null);
  const r = await call(registerReq("cfg@example.com"));
  assert.equal(r._status, 501);
  assert.equal(r._body.reason, "not_configured");
  assert.equal(gh.putLog.length, 0);
});

test("MAIL FAILURE: the slot is reserved before the send and refunded on failure; 502 mail_failed; a retry sends a fresh link", async () => {
  const ip = freshIp();
  const month = new Date().toISOString().slice(0, 7);
  const p = register.ipPath(register.ipHash(ip), month);
  register.setSender(async () => {
    assert.equal(gh.read(USAGE, p).events.length, 1, "the slot is held while the mail is in flight");
    throw new Error("boom");
  });
  for (let i = 0; i < 5; i++) {
    const r = await call(registerReq("mf@example.com", { ip }));
    assert.equal(r._status, 502);
    assert.equal(r._body.reason, "mail_failed");
    assert.equal(r._body.link_sent, false);
    assert.equal(r._body.slot_refunded, true);
  }
  assert.deepEqual(gh.read(USAGE, p).events, [], "five failed sends consumed nothing");
  register.setSender(async (msg) => { sent.push(msg); return { ok: true }; });
  const r2 = await call(registerReq("mf@example.com", { ip }));
  assert.equal(r2._status, 200);
  assert.equal((await call(confirmReq(tokenFrom(sent[0]))))._status, 200);
});

test("MAIL FAILURE, REFUND FAILS: the slot stays spent (safe direction) and the answer says no link was sent", async () => {
  const ip = freshIp();
  const month = new Date().toISOString().slice(0, 7);
  const p = register.ipPath(register.ipHash(ip), month);
  register.setSender(async () => {
    gh.forceFailure(USAGE, p, 20, 500); // the refund write cannot land
    throw new Error("boom");
  });
  const r = await call(registerReq("mf2@example.com", { ip }));
  assert.equal(r._status, 502);
  assert.equal(r._body.reason, "mail_failed");
  assert.equal(r._body.link_sent, false);
  assert.equal(r._body.slot_refunded, false);
  assert.match(r._body.error, /no link was sent/);
  assert.equal(gh.read(USAGE, p).events.length, 1, "the slot stays spent");
});

// ---------------------------------------------------------- grant plan pins

test("GRANT PLAN: a registered key's pin debits a credit; no monthly free counter is touched", async () => {
  const c = await registerAndConfirm("pinner@example.com");
  const ns = `${c.namespace}main`;
  const res = makeRes();
  await pin(pinReq(c.key, ns, 1), res);
  assert.equal(res._status, 201, JSON.stringify(res._body));
  assert.equal(res._headers["x-meter-source"], "credit");
  assert.equal(res._headers["x-meter-cap"], "0");
  const h = keys.keyHash(c.key);
  assert.equal((await balance.readBalance(h)).balance, 499);
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(gh.has(USAGE, `usage/${h}/${month}.json`), false, "no monthly free pin was used");
  assert.equal(meter.PLAN_CAPS.grant, 0);
  assert.equal(meter.PLAN_CAPS.free, 100, "existing free plan untouched");
});

test("GRANT PLAN: an empty grant balance is 402 top-up, and the key still reads as never-purchased", async () => {
  const c = await registerAndConfirm("empty@example.com");
  const h = keys.keyHash(c.key);
  const bp = balance.balancePath(h);
  gh.seed(USAGE, bp, { ...gh.read(USAGE, bp), balance: 0 });
  const res = makeRes();
  await pin(pinReq(c.key, `${c.namespace}main`, 1), res);
  assert.equal(res._status, 402);
  assert.equal(res._body.reason, "credit_exhausted");
  assert.equal(res._body.error, "no credits left on the key: buy a pack");
  assert.equal((await balance.readBalance(h)).ever_purchased, false);
});

test("OVER-CAP WORDING: pin and distill say 'monthly allowance' only for a capped plan, else 'buy a pack'", async () => {
  const distill = require("../api/distill.js");
  const capped = "capped-key", uncapped = "zero-key", buyer = "buyer-key";
  process.env.WITNESS_PLANS = JSON.stringify({
    [keys.keyHash(capped)]: { plan: "free", monthly_cap: 1 },
    [keys.keyHash(uncapped)]: { plan: "free", monthly_cap: 0 },
    [keys.keyHash(buyer)]: { plan: "free", monthly_cap: 1 },
  });
  try {
    const month = new Date().toISOString().slice(0, 7);
    for (const k of [capped, buyer]) gh.seed(USAGE, `usage/${keys.keyHash(k)}/${month}.json`, { used: 1, month });
    const a = await distill.meterAndCharge(capped);
    assert.equal(a.deny.status, 429);
    assert.match(a.deny.body.note, /this key's monthly allowance/);
    const b = await distill.meterAndCharge(uncapped);
    assert.equal(b.deny.body.note, "no credits left on the key: buy a pack");

    // a capped key that bought and spent everything: pin's 402 names the allowance
    const bh = keys.keyHash(buyer);
    gh.seed(USAGE, balance.balancePath(bh), { key_hash: bh, balance: 0, seq: 2, purchased: true, applied_events: [] });
    gh.seed(USAGE, keys.issuedKeyPath(bh), { key_hash: bh, namespace_prefix: "buyerco-", plan: "free" });
    const res = makeRes();
    await pin(pinReq(buyer, "buyerco-main", 1), res);
    assert.equal(res._status, 402);
    assert.match(res._body.error, /this key's monthly allowance and its credits are used up/);
  } finally {
    delete process.env.WITNESS_PLANS;
  }
});

test("FREE PLAN UNCHANGED: a Stripe-style issued key with plan free still gets the monthly free pin", async () => {
  const key = keys.mintKey();
  const h = keys.keyHash(key);
  gh.seed(USAGE, keys.issuedKeyPath(h), { key_hash: h, namespace_prefix: "freeco-", plan: "free", source: "stripe-fulfill" });
  const res = makeRes();
  await pin(pinReq(key, "freeco-main", 1), res);
  assert.equal(res._status, 201);
  assert.equal(res._headers["x-meter-cap"], "100");
  assert.equal(res._headers["x-meter-source"], undefined, "charged to the free tier, not credit");
});

// ---------------------------------------------------------- ever_purchased

test("EVER_PURCHASED: false after the registration grant (and after a refund), true after a Stripe pack", async () => {
  const h = "b".repeat(64);
  await balance.grantCredits(h, 500, "registration", "reg-x", "register");
  let b = await balance.readBalance(h);
  assert.equal(b.balance, 500);
  assert.equal(b.ever_purchased, false);

  await balance.grantCredits(h, 1, "refund", "refund-1", "pin-write-failure-refund");
  assert.equal((await balance.readBalance(h)).ever_purchased, false, "a refund is not a purchase");

  const d = await balance.debitCredits("unused", 1, "x"); // another key, no balance file
  assert.equal(d.ok, false);
  assert.equal(d.ever_purchased, false);

  await balance.creditPack(h, "mini", "cs_test_pack123", "stripe-webhook");
  b = await balance.readBalance(h);
  assert.equal(b.balance, 1501);
  assert.equal(b.ever_purchased, true);
});

test("EVER_PURCHASED: a legacy balance file with no purchased field still reads as purchased", async () => {
  const h = "c".repeat(64);
  gh.seed(USAGE, balance.balancePath(h), { key_hash: h, balance: 3, seq: 1, applied_events: ["evt_old"] });
  assert.equal((await balance.readBalance(h)).ever_purchased, true);
});

// ---------------------------------------------------------- durable hour cap

test("DURABLE HOUR CAP: 60 pins pass; after a simulated cold start the 61st is still 429", async () => {
  const c = await registerAndConfirm("hourly@example.com");
  const ns = `${c.namespace}main`;
  for (let i = 1; i <= 60; i++) {
    const res = makeRes();
    await pin(pinReq(c.key, ns, i), res);
    assert.equal(res._status, 201, `pin ${i}: ${JSON.stringify(res._body)}`);
  }
  pin._resetRateBuckets(); // cold start: the in-memory Map is empty
  const res = makeRes();
  await pin(pinReq(c.key, ns, 61), res);
  assert.equal(res._status, 429);
  assert.equal(res._body.reason, "hourly_rate_limit");
  assert.equal(res._body.limit, 60);
  assert.equal((await balance.readBalance(keys.keyHash(c.key))).balance, 440, "the refused pin charged nothing");
  const hour = gh.read(USAGE, meter.hourPath(keys.keyHash(c.key), meter.utcHour()));
  assert.equal(hour.used, 60, "the refused 61st was decided on a read: no counter write");
});

test("DURABLE HOUR CAP: a store error on the counter fails closed with 503 and charges nothing", async () => {
  const c = await registerAndConfirm("closed@example.com");
  const h = keys.keyHash(c.key);
  gh.forceFailure(USAGE, meter.hourPath(h, meter.utcHour()), 5, 500);
  const res = makeRes();
  await pin(pinReq(c.key, `${c.namespace}main`, 1), res);
  assert.equal(res._status, 503);
  assert.equal(res._body.reason, "rate_limit_store_error");
  assert.equal((await balance.readBalance(h)).balance, 500);
});

test("DURABLE HOUR CAP: a free-plan key's pin makes no hour-counter write (in-memory check only)", async () => {
  const key = keys.mintKey();
  const h = keys.keyHash(key);
  gh.seed(USAGE, keys.issuedKeyPath(h), { key_hash: h, namespace_prefix: "hourfree-", plan: "free", source: "stripe-fulfill" });
  const res = makeRes();
  await pin(pinReq(key, "hourfree-main", 1), res);
  assert.equal(res._status, 201);
  assert.equal(gh.putLog.filter((w) => /\/hour-/.test(w.path)).length, 0, "no hour counter written for a free-plan key");
  gh.forceFailure(USAGE, meter.hourPath(h, meter.utcHour()), 5, 500);
  const res2 = makeRes();
  await pin(pinReq(key, "hourfree-main", 2), res2);
  assert.equal(res2._status, 201, "a free-plan key's pin does not depend on the hour-counter store");
});

test("DURABLE HOUR CAP: a Stripe-minted plan-grant key debits credits but writes no hour counter and never 503s on it", async () => {
  const key = keys.mintKey();
  const h = keys.keyHash(key);
  gh.seed(USAGE, keys.issuedKeyPath(h), { key_hash: h, namespace_prefix: "stripeg-", plan: "grant", source: "stripe-fulfill" });
  gh.seed(USAGE, balance.balancePath(h), { key_hash: h, balance: 10, seq: 1, purchased: true, applied_events: [] });
  const res = makeRes();
  await pin(pinReq(key, "stripeg-main", 1), res);
  assert.equal(res._status, 201, JSON.stringify(res._body));
  assert.equal(res._headers["x-meter-source"], "credit", "plan grant: no monthly free pin");
  assert.equal(res._headers["x-meter-cap"], "0");
  assert.equal((await balance.readBalance(h)).balance, 9);
  assert.equal(gh.putLog.filter((w) => /\/hour-/.test(w.path)).length, 0, "no hour counter written for a Stripe key");
  gh.forceFailure(USAGE, meter.hourPath(h, meter.utcHour()), 5, 500);
  const res2 = makeRes();
  await pin(pinReq(key, "stripeg-main", 2), res2);
  assert.equal(res2._status, 201, "a Stripe key's pin does not depend on the hour-counter store");
});

// ---------------------------------------------------------- the reader

test("REPORT: admin-only; 14 days per day, top 10 by ip_hash and by domain", async () => {
  const noAuth = await call(makeReq({ method: "GET", query: { op: "register-report" } }));
  assert.equal(noAuth._status, 401);

  const ip = "198.51.100.200";
  await call(registerReq("r1@alpha.com", { ip }));
  await call(registerReq("r2@alpha.com", { ip }));
  await registerAndConfirm("r3@beta.com");

  const r = await call(makeReq({ method: "GET", headers: { authorization: "Bearer test-admin-key" }, query: { op: "register-report" } }));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const b = r._body;
  assert.equal(b.window_days, 14);
  assert.equal(b.per_day.length, 14);
  assert.equal(b.total, 3);
  const today = b.per_day[13];
  assert.equal(today.date, new Date().toISOString().slice(0, 10));
  assert.equal(today.registrations, 3);
  assert.equal(today.confirmed, 1);
  assert.equal(today.distinct_ip_hashes, 2);
  assert.equal(today.distinct_domains, 2);
  assert.ok(b.top_ip_hashes.length <= 10 && b.top_email_domains.length <= 10);
  assert.deepEqual(b.top_email_domains[0], { email_domain: "alpha.com", count: 2, share: 0.667 });
  assert.equal(b.top_ip_hashes[0].count, 2);
  assert.match(b.top_ip_hashes[0].ip_hash, /^[0-9a-f]{16}$/);
  assert.equal(b.listing_may_be_truncated, false);
  assert.ok(!JSON.stringify(b).includes(ip));
});
