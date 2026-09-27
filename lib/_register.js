// _register.js — the REGISTRATION GRANT: verified email in, one witness key
// with 500 credits out, once per email, ever. Underscore prefix = not routed;
// api/fulfill.js dispatches here on ?op=register | confirm | register-status |
// register-report (api/ is at Vercel Hobby's 12-function cap).
//
// The decision this implements: memory/PRICING_DECISION_2026-09-17.md, the
// 2026-09-27 8:47 AM entry. Every new key comes with 500 credits, one time, at
// verified registration. An agent may START the signup with its human's email;
// the key is minted only when the human clicks the link. The 100/month free
// tier is retired for these keys (plan "grant", cap 0 in lib/_meter.js).
//
// FLOW
//   POST ?op=register {email, agent?}
//     validate + normalise the email, refuse disposable domains, spend one slot
//     of the caller's per-IP window, write registrations/<emailHash>.json
//     (create-only; state "pending", token HASH only), write the token index,
//     send the magic link. A confirmed email answers 200 {state:"confirmed"}
//     and sends nothing. A pending email gets a FRESH token (the old link stops
//     working) and costs another IP slot, so the endpoint cannot be used to
//     mail-bomb one address from one IP.
//   GET ?op=confirm&t=<token>  -> a "Show my key" form; writes nothing.
//   POST ?op=confirm {t}
//     verify the token against the stored hash, mint the key (create-only
//     fulfillments/reg-<emailHash>.json is the one-key-per-email gate, same
//     idiom as the Stripe path's fulfillments/<session_id>.json), write the
//     issued-key + pool records, grant 500 credits once, mark the registration
//     confirmed and show the key. A second POST inside 15 minutes re-shows the
//     same key (double-submit safety); after that the raw key is nulled and
//     the answer is already-claimed. See "op: confirm" below.
//   GET ?op=register-status&email=...  -> {state} only, never the key.
//   GET ?op=register-report  (Bearer WITNESS_ADMIN_KEY) -> 14-day reader.
//
// WHERE THE KEY GOES: the confirm page only. The email carries the link, not
// the key: the key does not exist until the click, and a key in an inbox is a
// key in every mail archive and forward.
//
// FILES (all in the PRIVATE usage repo; never the public pin repo)
//   registrations/<sha256(normalised email)>.json   the registration
//   registrations/_tok/<sha256(token)>.json         token -> email hash index
//   registrations/_ip/<ip_hash>/<YYYY-MM>.json      per-IP registration events
//   fulfillments/reg-<emailHash>.json               raw key, create-only
// The raw email is stored nowhere in registrations/ (hash + domain only); the
// raw IP is stored nowhere at all (salted hash, REGISTER_IP_SALT).

"use strict";

const crypto = require("crypto");
const keys = require("./_keys.js");
const balance = require("./_balance.js");
const ratelimit = require("./_ratelimit.js");
const { DISPOSABLE_DOMAINS } = require("./_disposable_domains.js");
const { SUPPORT_EMAIL, esc, wantsJson, pageShell, copyBox } = require("./_page.js");

const API = "https://api.github.com";
const GRANT_CREDITS = 500;
const IP_WINDOW_LIMIT = 3; // registrations per ip_hash ...
const IP_WINDOW_DAYS = 30; // ... per rolling 30 days
const TOKEN_TTL_MS = 48 * 3600 * 1000; // a pending link expires; registering again sends a new one
const REPORT_DAYS = 14;
const OPS = new Set(["register", "confirm", "register-status", "register-report"]);

function usageRepo() {
  return process.env.GITHUB_USAGE_REPO || keys.USAGE_REPO;
}
function usageBranch() {
  return process.env.GITHUB_USAGE_BRANCH || keys.USAGE_BRANCH;
}
function baseUrl() {
  return process.env.WITNESS_BASE_URL || "https://arcaeon-witness.vercel.app";
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

// ---- store (same get/put pair as every stateful module here; the house
// pattern is one copy per module so its log tag and redaction stay legible) ----
function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-register",
    "x-github-api-version": "2022-11-28",
  };
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

async function getFile(path) {
  const r = await fetch(`${API}/repos/${usageRepo()}/contents/${path}?ref=${usageBranch()}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.error(`[register] GET ${path} -> ${r.status}`);
    throw new Error(`registration store read failed (${r.status})`);
  }
  const body = await r.json();
  if (Array.isArray(body)) return null; // a directory, not a record
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

async function putFile(path, obj, message, sha) {
  const payload = {
    message,
    branch: usageBranch(),
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${usageRepo()}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) {
    const err = new Error("registration store write conflict (concurrent writer)");
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    console.error(`[register] PUT ${path} -> ${r.status}: ${detail.slice(0, 300)}`);
    const err = new Error(`registration store write failed (${r.status})`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

// Directory listing -> [{name, type}]. 404 = empty. The contents API caps a
// listing at 1000 entries; the report says so rather than read a truncated
// list as the whole truth.
async function listDir(path) {
  const r = await fetch(`${API}/repos/${usageRepo()}/contents/${path}?ref=${usageBranch()}`, { headers: ghHeaders() });
  if (r.status === 404) return [];
  if (!r.ok) {
    console.error(`[register] LIST ${path} -> ${r.status}`);
    throw new Error(`registration store list failed (${r.status})`);
  }
  const body = await r.json();
  if (!Array.isArray(body)) throw new Error("registration store list: not a directory listing");
  return body.map((e) => ({ name: e.name, type: e.type }));
}

// ---- email ----
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// normaliseEmail(raw) -> {ok:true, normalised, domain, address} | {ok:false, reason, detail}
// One identity per real inbox: lowercased; plus-suffix removed for every
// domain (a+1@x and a@x are one identity); dots removed and googlemail.com
// folded to gmail.com for Gmail, where dots are ignored by the provider.
// `address` is what the mail is sent to (as typed, trimmed and lowercased).
function normaliseEmail(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "bad_email", detail: "email is required" };
  const address = raw.trim().toLowerCase();
  if (address.length > 254 || !EMAIL_RE.test(address)) {
    return { ok: false, reason: "bad_email", detail: "that does not look like an email address" };
  }
  const at = address.lastIndexOf("@");
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return { ok: false, reason: "bad_email", detail: "that does not look like an email address" };
  }
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  if (!local) return { ok: false, reason: "bad_email", detail: "that does not look like an email address" };
  return { ok: true, normalised: `${local}@${domain}`, domain, address };
}

// The domain or any parent domain of it is on the list.
function isDisposable(domain) {
  const parts = String(domain).split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

// The agent label is stored on the registration record ONLY, never put in
// the email (review 7: a caller-chosen string in a mail we send to a stranger
// is a phishing line with our name on it). Restricted to a plain charset; any
// other character is a 400, not a silent rewrite.
const AGENT_RE = /^[A-Za-z0-9 ._-]{0,32}$/;
function cleanAgent(a) {
  if (a === undefined || a === null || a === "") return { ok: true, value: null };
  if (typeof a !== "string" || !AGENT_RE.test(a)) return { ok: false };
  const v = a.trim();
  return { ok: true, value: v || null };
}

// ---- caller IP ----
// The RIGHTMOST x-forwarded-for hop, not the leftmost. The leftmost entry is
// whatever the client wrote into the header before it reached the first proxy
// that appends; the rightmost is the one appended by the proxy nearest to us.
// On Vercel the platform overwrites x-forwarded-for with the client IP it saw
// and does not forward a client-supplied value (Vercel docs, "Request
// headers" -> x-forwarded-for: "we currently overwrite the X-Forwarded-For
// header and do not forward external IPs ... to prevent IP spoofing"), so
// there the header holds one entry and rightmost == the connection's client.
// Anywhere a chain does arrive, rightmost is the only hop we can trust.
// Falls back to the socket address, then to one shared "unknown" bucket
// (fails toward MORE blocking).
// One helper for every per-IP decision in this service: lib/_ratelimit.js.
function clientIp(req) {
  return ratelimit.callerIp(req);
}

// ---- networks, not addresses (review 1) ----
// One person owns a network, not an address: an IPv6 customer is typically
// handed a whole /64 (2^64 addresses) and often a /48, so hashing the full
// IPv6 address gave a farmer a fresh window per address. So:
//   IPv4 (and IPv4-mapped IPv6)  -> the whole address, 3 per 30 days
//   IPv6                         -> the /64, 3 per 30 days, AND the /48, 10 per 30 days
// Each bucket is hashed with REGISTER_IP_SALT; the raw address is never stored.
const V6_48_LIMIT = 10;

function expandIPv6(a) {
  let s = String(a).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  let tail = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    tail = [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    s = s.slice(0, -v4[1].length);
    if (!s.endsWith("::") && s.endsWith(":")) s = s.slice(0, -1);
  }
  const dbl = s.indexOf("::");
  const left = (dbl === -1 ? s : s.slice(0, dbl)).split(":").filter(Boolean);
  const right = dbl === -1 ? [] : s.slice(dbl + 2).split(":").filter(Boolean);
  let groups;
  if (dbl === -1) {
    groups = left.concat(tail);
  } else {
    const fill = 8 - tail.length - left.length - right.length;
    if (fill < 1) return null;
    groups = left.concat(Array(fill).fill("0"), right, tail);
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

function networkBuckets(ip) {
  const salted = (k) => sha256(`${process.env.REGISTER_IP_SALT}\n${k}`);
  const raw = String(ip || "unknown");
  if (raw.includes(":")) {
    const g = expandIPv6(raw);
    if (g) {
      const mapped = g.slice(0, 5).every((x) => x === "0000") && g[5] === "ffff";
      if (mapped) {
        const n = parseInt(g[6], 16);
        const m = parseInt(g[7], 16);
        const v4 = `${n >> 8}.${n & 255}.${m >> 8}.${m & 255}`;
        return [{ scope: "v4", hash: salted(`v4:${v4}`), limit: IP_WINDOW_LIMIT }];
      }
      return [
        { scope: "v6/64", hash: salted(`v6/64:${g.slice(0, 4).join(":")}`), limit: IP_WINDOW_LIMIT },
        { scope: "v6/48", hash: salted(`v6/48:${g.slice(0, 3).join(":")}`), limit: V6_48_LIMIT },
      ];
    }
  }
  return [{ scope: "v4", hash: salted(`v4:${raw}`), limit: IP_WINDOW_LIMIT }];
}

// The registration record's ip_hash (and the report's) is the narrowest bucket.
function ipHash(ip) {
  return networkBuckets(ip)[0].hash;
}

// ---- per-email-DOMAIN grant window (review 1) ----
// Outside the big mailbox providers, a domain is one owner: someone with a
// catch-all on their own domain has unlimited verified addresses. So a domain
// that is NOT a major provider gets at most 5 GRANTS per rolling 30 days,
// counted when a key is minted (confirm), not at register, so that strangers
// registering fake addresses at someone's domain cannot spend its slots.
// Register only reads it, to avoid mailing a link that could not be honoured.
const DOMAIN_WINDOW_LIMIT = 5;
const MAJOR_PROVIDERS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "rocketmail.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me",
  "protonmail.ch", "aol.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "t-online.de", "mail.ru",
  "yandex.ru", "yandex.com", "qq.com", "163.com", "126.com", "sina.com", "naver.com", "hanmail.net",
  "daum.net", "orange.fr", "free.fr", "laposte.net", "libero.it", "virgilio.it", "rediffmail.com",
  "comcast.net", "att.net", "verizon.net", "sbcglobal.net", "bellsouth.net", "cox.net", "zoho.com",
  "fastmail.com", "tutanota.com", "tuta.io", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "uol.com.br",
  "bol.com.br", "terra.com.br", "shaw.ca", "rogers.com", "sympatico.ca", "bigpond.com", "optusnet.com.au",
  "btinternet.com", "sky.com", "virginmedia.com",
]);
// Regional variants of the biggest brands: hotmail.co.uk, yahoo.co.jp, outlook.fr, live.de ...
const MAJOR_BRAND_RE = /^(hotmail|outlook|live|yahoo|ymail|gmx|yandex|aol|icloud)\.[a-z.]{2,12}$/;
function isMajorProvider(domain) {
  return MAJOR_PROVIDERS.has(domain) || MAJOR_BRAND_RE.test(domain);
}

// ---- paths ----
const regPath = (emailHash) => `registrations/${emailHash}.json`;
const tokPath = (tokenHash) => `registrations/_tok/${tokenHash}.json`;
const ipPath = (iph, month) => `registrations/_ip/${iph}/${month}.json`;
const claimIpPath = (iph, month) => `registrations/_ipc/${iph}/${month}.json`;
const domainPath = (domain, month) => `registrations/_domain/${domain}/${month}.json`;
const fulfillId = (emailHash) => `reg-${emailHash}`;

function utcMonth(d) {
  return d.toISOString().slice(0, 7);
}
function prevMonth(d) {
  return utcMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)));
}

// ---- durable rolling windows (per network, per domain) ----
// Events are appended to the CURRENT month's file; the count reads this month
// and last month and keeps events inside the last 30 days. The count and the
// append are one CAS against the current month's file, so two racers cannot
// both take the last slot: the loser re-reads, recounts, and is refused.
// dryRun: count only, write nothing (the pre-send check, review 6).
async function reserveWindow(pathFor, limit, now, dryRun, label) {
  const since = now.getTime() - IP_WINDOW_DAYS * 86400 * 1000;
  const inWindow = (evs) =>
    (Array.isArray(evs) ? evs : []).filter((t) => Date.parse(t) > since).length;
  const prev = await getFile(pathFor(prevMonth(now)));
  const prevCount = prev ? inWindow(prev.json.events) : 0;
  const month = utcMonth(now);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getFile(pathFor(month));
    const events = cur && Array.isArray(cur.json.events) ? cur.json.events : [];
    const count = prevCount + inWindow(events);
    if (count >= limit) return { ok: false, count, limit };
    if (dryRun) return { ok: true, count, limit };
    try {
      await putFile(
        pathFor(month),
        { month, events: events.concat([now.toISOString()]) },
        `register window ${label} ${month} n=${events.length + 1}`,
        cur ? cur.sha : undefined
      );
      return { ok: true, count: count + 1, limit };
    } catch (err) {
      if (err.conflict && attempt < 3) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("registration store: exhausted CAS retries on a window");
}

// Every network bucket of this caller, checked (dryRun) or spent. Returns the
// first bucket that is full, or null. Spending stops at the first full bucket;
// a bucket already spent stays spent (fails toward blocking).
async function reserveNetwork(buckets, pathOf, now, dryRun) {
  for (const b of buckets) {
    const r = await reserveWindow((m) => pathOf(b.hash, m), b.limit, now, dryRun, `${b.scope} ${b.hash.slice(0, 12)}`);
    if (!r.ok) return b;
  }
  return null;
}

// The per-domain window, as a response when full (or null).
async function domainWindowDeny(domain, now, dryRun) {
  if (!domain || isMajorProvider(domain)) return null;
  const d = await reserveWindow((m) => domainPath(domain, m), DOMAIN_WINDOW_LIMIT, now, dryRun, `domain ${domain}`);
  if (d.ok) return null;
  return {
    error: `this email domain has had ${DOMAIN_WINDOW_LIMIT} keys in ${IP_WINDOW_DAYS} days, the most one domain gets`,
    reason: "domain_registration_window",
    limit: DOMAIN_WINDOW_LIMIT,
    window_days: IP_WINDOW_DAYS,
  };
}

// ---- mail (injectable; tests never send) ----
let injectedSender = null;
function setSender(fn) {
  injectedSender = typeof fn === "function" ? fn : null;
}

async function resendSender(msg) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: process.env.RESEND_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!r.ok) {
    // Status only: Resend's error body can echo the recipient address (review 10).
    console.error(`[register] resend -> ${r.status}`);
    throw new Error(`mail send failed (${r.status})`);
  }
  const body = await r.json().catch(() => ({}));
  return { ok: true, id: body && body.id ? body.id : null };
}

function getSender() {
  if (injectedSender) return injectedSender;
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) return resendSender;
  return null;
}

function confirmUrl(token) {
  return `${baseUrl()}/api/fulfill?op=confirm&t=${token}`;
}

function magicLinkMessage(address, token) {
  const link = confirmUrl(token);
  const who = "Someone asked";
  const subject = "Confirm your Arcaeon witness key";
  const text =
    `${who} for an Arcaeon witness key for this address.\n\n` +
    `Open this link and press "Show my key". The key is created then, shown once on that page, and comes with ${GRANT_CREDITS} credits (one credit = one pin):\n\n` +
    `${link}\n\n` +
    `The link works for 48 hours. Asking again sends a new link and the old one stops working.\n` +
    `If you did not ask for this, ignore it: nothing is created until the link is opened.\n\n` +
    `Questions: ${SUPPORT_EMAIL}\n`;
  const html =
    `<p>${esc(who)} for an Arcaeon witness key for this address.</p>` +
    `<p>Open this link and press "Show my key". The key is created then, shown once on that page, and comes with <b>${GRANT_CREDITS} credits</b> (one credit = one pin):</p>` +
    `<p><a href="${esc(link)}">${esc(link)}</a></p>` +
    `<p>The link works for 48 hours. Asking again sends a new link and the old one stops working.</p>` +
    `<p>If you did not ask for this, ignore it: nothing is created until the link is opened.</p>` +
    `<p>Questions: ${esc(SUPPORT_EMAIL)}</p>`;
  return { to: address, subject, text, html };
}

// ---- responses ----
function send(req, res, status, jsonBody, title, htmlInner) {
  res.setHeader("cache-control", "no-store");
  if (wantsJson(req) || !htmlInner) return res.status(status).json(jsonBody);
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(status).send(pageShell(title, htmlInner));
}
function fail(req, res, status, body, title) {
  return send(req, res, status, body, title, `<h1>${esc(title)}</h1><p>${esc(body.error)}</p>`);
}

function inputOf(req) {
  const q = req.query || {};
  const body = typeof req.body === "object" && req.body ? req.body : {};
  return { q, body };
}

// ---- op: register ----
async function handleRegister(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only", reason: "method" });
  }
  const pre = ratelimit.check(req);
  if (pre.limited) {
    res.setHeader("retry-after", String(pre.retryAfterSeconds));
    return res.status(429).json({ error: "too many requests from this address; slow down", reason: "rate_limited" });
  }
  if (!process.env.REGISTER_IP_SALT) {
    return res.status(501).json({
      error: "registration is not configured yet",
      reason: "not_configured",
      human_step: "set REGISTER_IP_SALT (a long random string) in the Vercel project env",
    });
  }
  const sender = getSender();
  if (!sender) {
    return res.status(501).json({
      error: "registration email is not configured yet",
      reason: "not_configured",
      human_step: "set RESEND_API_KEY and RESEND_FROM in the Vercel project env",
    });
  }

  const { body } = inputOf(req);
  const e = normaliseEmail(body.email);
  if (!e.ok) return res.status(400).json({ error: e.detail, reason: e.reason });
  if (isDisposable(e.domain)) {
    return res.status(400).json({
      error: "that email domain is a throwaway inbox; register with an address you keep",
      reason: "disposable_email",
    });
  }
  const agent = cleanAgent(body.agent);
  if (!agent.ok) {
    return res.status(400).json({ error: "agent must be at most 32 characters of letters, digits, space, dot, underscore or dash", reason: "bad_agent" });
  }

  const emailHash = sha256(e.normalised);
  // Email HASH only in anything we hand back or log (review 10): a status URL
  // lands in agent logs, proxies and transcripts, and must not carry the address.
  const statusUrl = `${baseUrl()}/api/fulfill?op=register-status&e=${emailHash}`;

  try {
    const now = new Date();
    const buckets = networkBuckets(clientIp(req));
    const iph = buckets[0].hash;
    const overWindow = (b) => res.status(429).json({
      error: `too many registrations from this network: at most ${b.limit} in ${IP_WINDOW_DAYS} days`,
      reason: "ip_registration_window",
      scope: b.scope,
      limit: b.limit,
      window_days: IP_WINDOW_DAYS,
    });
    // Check now (read only), SPEND only after the mail is out (review 6): a
    // send failure must not eat one of the network's slots.
    const full = await reserveNetwork(buckets, ipPath, now, true);
    if (full) return overWindow(full);
    // Domain window: read only here; it is spent when a key is minted.
    const domFull = await domainWindowDeny(e.domain, now, true);
    if (domFull) return res.status(429).json(domFull);

    // NO ORACLE (review 4): an address that already has its key gets exactly
    // the answer a fresh registration gets (same status, same fields, a t8
    // that proves nothing), and no mail is sent and no slot is spent. The
    // read-only window checks above run first for both, so a caller on a full
    // network cannot tell the two apart by the 429 either.
    const pendingAnswer = (t8) => res.status(200).json({
      ok: true,
      state: "pending",
      sent: true,
      email_domain: e.domain,
      t8,
      status_url: `${statusUrl}&t8=${t8}`,
      note:
        "if this address can receive a key, a confirmation link was sent to it. The key is created when the human opens it " +
        `and presses the button, is shown once, and comes with ${GRANT_CREDITS} credits. Poll status_url (it carries t8, ` +
        "the proof this caller started the registration); it never returns the key.",
    });
    let cur = await getFile(regPath(emailHash));
    if (cur && cur.json.state === "confirmed") return pendingAnswer(crypto.randomBytes(4).toString("hex"));

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(token);
    const nowIso = now.toISOString();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!cur) {
        const rec = {
          email_hash: emailHash,
          email_domain: e.domain,
          agent: agent.value,
          state: "pending",
          token_hash: tokenHash,
          token_created_at: nowIso,
          created_at: nowIso,
          ip_hash: iph,
          sends: 1,
        };
        try {
          await putFile(regPath(emailHash), rec, `register ${emailHash.slice(0, 12)} pending`);
          break;
        } catch (err) {
          if (!err.conflict) throw err;
          cur = await getFile(regPath(emailHash)); // a concurrent register won the create
          if (!cur) throw err;
        }
      }
      if (cur.json.state === "confirmed") return pendingAnswer(crypto.randomBytes(4).toString("hex"));
      // Pending: rotate the token (the older link stops working).
      const replaced = cur.json.token_hash;
      const next = { ...cur.json, token_hash: tokenHash, token_created_at: nowIso, sends: (Number(cur.json.sends) || 1) + 1 };
      if (agent.value) next.agent = agent.value;
      try {
        await putFile(regPath(emailHash), next, `register ${emailHash.slice(0, 12)} resend`, cur.sha);
        await voidTokenIndex(replaced).catch((err) =>
          console.error(`[register] replaced token index not voided for ${emailHash.slice(0, 12)}: ${err.message}`));
        break;
      } catch (err) {
        if (!err.conflict || attempt === 2) throw err;
        cur = await getFile(regPath(emailHash));
      }
    }

    await putFile(tokPath(tokenHash), { email_hash: emailHash, created_at: nowIso }, `register token ${tokenHash.slice(0, 12)}`);

    try {
      await sender(magicLinkMessage(e.address, token));
    } catch (err) {
      // No err.message: a sender's error text can quote the recipient (review 10).
      console.error(`[register] mail send failed for ${emailHash.slice(0, 12)} (${(err && err.name) || "Error"})`);
      return res.status(502).json({
        error: "the confirmation email could not be sent; nothing was used up; try again in a few minutes",
        reason: "mail_failed",
        retry_safe: true,
      });
    }

    // The mail is out: spend the slot. A concurrent register from the same
    // network can have taken the last slot between the check and here; then
    // this link is voided (its token no longer matches) and the answer is 429.
    const spentFull = await reserveNetwork(buckets, ipPath, now, false);
    if (spentFull) {
      await voidToken(emailHash, tokenHash).catch((err) =>
        console.error(`[register] could not void a link over the window for ${emailHash.slice(0, 12)}: ${err.message}`));
      return overWindow(spentFull);
    }

    return pendingAnswer(tokenHash.slice(0, 8));
  } catch (err) {
    console.error(`[register] store error: ${err.message}`);
    return res.status(503).json({ error: "registration store unavailable; nothing was sent; retry shortly", reason: "store_error", retry_safe: true });
  }
}

// Void a just-sent link: only if the record still carries THIS token.
async function voidToken(emailHash, tokenHash) {
  const cur = await getFile(regPath(emailHash));
  if (!cur || cur.json.token_hash !== tokenHash || cur.json.state === "confirmed") return;
  await putFile(regPath(emailHash), { ...cur.json, token_hash: "void" }, `register ${emailHash.slice(0, 12)} void`, cur.sha);
  await voidTokenIndex(tokenHash);
}

// ---- op: confirm ----
// THE LINK DOES NOT MINT (review 3). Mail scanners and link previewers GET
// every URL in a message; they do not POST. So:
//   GET  ?op=confirm&t=<token>  -> a page with ONE button, "Show my key"
//                                  (a form POSTing the token back). Nothing
//                                  is minted, granted or marked.
//   POST ?op=confirm, body {t}  -> mints, grants, marks the registration
//                                  confirmed with key_shown_at, shows the raw
//                                  key.
// DOUBLE-SUBMIT SAFETY (decision 2, 2026-09-27): the raw key stays readable in
// fulfillments/reg-<emailHash>.json for KEY_RESHOW_MS (15 minutes) after
// key_shown_at. A second POST with the same valid token inside that window
// (a double click, a reload of the POST, a dropped response) re-shows the SAME
// key page: no second grant and no write at all. After the window, the next
// confirm request nulls the raw key and answers the already-claimed page;
// every request after that answers already-claimed with no write.
// A confirmed registration never mints, grants or writes a pool, ledger or
// balance on any revisit; the only write a revisit can make is that null.
const CLAIMED_CONTACT = SUPPORT_EMAIL;
const KEY_RESHOW_MS = 15 * 60 * 1000;

function claimedBody(reg) {
  const at = reg.json.key_shown_at || reg.json.confirmed_at || "an earlier visit";
  return {
    ok: false,
    state: "confirmed",
    reason: "already_claimed",
    claimed_at: reg.json.key_shown_at || reg.json.confirmed_at || null,
    error:
      `already claimed on ${at}; the key was shown then; if you lost it, contact ${CLAIMED_CONTACT} with the address you registered`,
  };
}

function withinReshow(reg, nowMs) {
  const shown = Date.parse(reg.json.key_shown_at || "");
  if (!Number.isFinite(shown)) return false;
  const age = nowMs - shown;
  return age >= 0 && age < KEY_RESHOW_MS;
}

function claimFormHtml(t) {
  return (
    `<h1>Your Arcaeon witness key is ready</h1>` +
    `<p>Press the button to create your key. It is shown <b>once</b>, on the next page, with ${GRANT_CREDITS} credits on it (one credit = one pin). Have somewhere to save it.</p>` +
    `<form method="post" action="${esc(baseUrl())}/api/fulfill?op=confirm">` +
    `<input type="hidden" name="t" value="${esc(t)}">` +
    `<button type="submit">Show my key</button>` +
    `</form>` +
    `<p class="muted">If you did not ask for this, close this page: nothing is created until the button is pressed.</p>`
  );
}

function keyOnceHtml(rec, balanceAfter) {
  const ns = rec.namespace_prefix;
  return (
    `<h1>Your witness key</h1>` +
    copyBox("key", rec.key) +
    `<p><b>${esc(String(balanceAfter))} credits</b> are on it (one credit = one pin). It pins any namespace starting with <code>${esc(ns)}</code>, for example <code>${esc(ns)}main</code>.</p>` +
    `<p class="warn">Save it now. For 15 minutes, pressing the button again shows this same key; after that it is removed from our store and cannot be shown again.</p>` +
    `<p class="muted">Balance: <a href="${esc(baseUrl())}/api/balance">${esc(baseUrl())}/api/balance</a>. Questions: ${esc(CLAIMED_CONTACT)}.</p>`
  );
}

// Set the registration's granted flag (CAS; a no-op if already set).
async function setGranted(emailHash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getFile(regPath(emailHash));
    if (!cur) throw new Error("registration vanished during grant");
    if (cur.json.granted === true) return;
    const next = { ...cur.json, granted: true, granted_at: new Date().toISOString() };
    try {
      await putFile(regPath(emailHash), next, `register ${emailHash.slice(0, 12)} granted`, cur.sha);
      return;
    } catch (err) {
      if (!err.conflict || attempt === 2) throw err;
    }
  }
}

// Mark confirmed + key_shown_at. Returns true if THIS call made the
// transition, false if the registration was already confirmed (a concurrent
// POST won; that one shows the key, this one answers already-claimed).
async function markClaimed(emailHash, keyHash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getFile(regPath(emailHash));
    if (!cur) throw new Error("registration vanished during confirm");
    if (cur.json.state === "confirmed") return false;
    const nowIso = new Date().toISOString();
    const next = { ...cur.json, state: "confirmed", key_hash: keyHash, confirmed_at: nowIso, key_shown_at: nowIso };
    try {
      await putFile(regPath(emailHash), next, `register ${emailHash.slice(0, 12)} confirmed`, cur.sha);
      return true;
    } catch (err) {
      if (!err.conflict || attempt === 2) throw err;
    }
  }
  return false;
}

// Resolve a token to its registration. Returns {reg, emailHash} or a
// {status, body, title} refusal.
// A token that does not match answers 404 with NO detail (review 2): not
// malformed-vs-unknown-vs-replaced, which would tell a prober what exists.
// Cost: a malformed token costs nothing, an unknown or replaced one ONE store
// read (a replaced token's index is voided at rotation, so it stops at the
// index read like an unknown one). The registration compare below stays as the
// second guard for an index the void write missed.
const NOT_FOUND = { status: 404, body: { error: "not found" }, title: "Not found" };
async function resolveToken(t) {
  if (!/^[0-9a-f]{64}$/.test(t)) return { refuse: NOT_FOUND };
  const tokenHash = sha256(t);
  const idx = await getFile(tokPath(tokenHash));
  const emailHash = idx && idx.json.void !== true && typeof idx.json.email_hash === "string" ? idx.json.email_hash : null;
  if (!emailHash) return { refuse: NOT_FOUND };
  const reg = await getFile(regPath(emailHash));
  if (!reg) return { refuse: NOT_FOUND };
  const stored = Buffer.from(String(reg.json.token_hash || ""), "utf8");
  const given = Buffer.from(tokenHash, "utf8");
  if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) return { refuse: NOT_FOUND };
  return { reg, emailHash };
}

// Void a replaced token's index so it costs one read, not two (best effort:
// the registration compare still refuses it if this write is missed).
async function voidTokenIndex(tokenHash) {
  if (!/^[0-9a-f]{64}$/.test(String(tokenHash))) return;
  const cur = await getFile(tokPath(tokenHash));
  if (!cur || cur.json.void === true) return;
  await putFile(tokPath(tokenHash), { void: true, voided_at: new Date().toISOString() }, `register token ${String(tokenHash).slice(0, 12)} void`, cur.sha);
}

function expired(reg) {
  const age = Date.now() - Date.parse(reg.json.token_created_at || reg.json.created_at || 0);
  return !(age >= 0 && age <= TOKEN_TTL_MS);
}

async function handleConfirm(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "GET or POST only", reason: "method" });
  }
  // Same in-memory per-IP pre-filter as register and status (review 2).
  const pre = ratelimit.check(req);
  if (pre.limited) {
    res.setHeader("retry-after", String(pre.retryAfterSeconds));
    return res.status(429).json({ error: "too many requests from this address; slow down", reason: "rate_limited" });
  }
  const { q, body } = inputOf(req);
  // GET reads the token from the link; POST only from the body.
  const t = String((req.method === "POST" ? body.t : q.t) || "");
  try {
    const r = await resolveToken(t);
    if (r.refuse) return fail(req, res, r.refuse.status, r.refuse.body, r.refuse.title);
    const { reg, emailHash } = r;

    // Confirmed: re-show inside the window (POST only), else already-claimed.
    if (reg.json.state === "confirmed") return answerConfirmed(req, res, reg, emailHash);
    if (expired(reg)) {
      return fail(req, res, 410, { error: "this confirmation link has expired; register again to get a new one", reason: "expired_token" }, "This link has expired");
    }

    if (req.method === "GET") {
      return send(req, res, 200, {
        ok: true,
        state: "pending",
        action: "POST /api/fulfill?op=confirm with body {t} to create the key; it is shown once",
      }, "Show my Arcaeon key", claimFormHtml(t));
    }

    // ---- POST: the claim ----
    const fid = fulfillId(emailHash);
    let rec;
    const existing = await keys.readFulfillment(fid);
    if (existing) {
      rec = existing.json; // a crash after the mint and before the mark: resume, do not re-mint
    } else {
      // Durable windows at the claim, spent only when a key is actually
      // minted (review 1 + 2): the claiming network (same /64-/48 buckets as
      // register, separate counter) and the email domain. Both are checked
      // before either is spent.
      const now = new Date();
      const buckets = networkBuckets(clientIp(req));
      const claimFull = await reserveNetwork(buckets, claimIpPath, now, true);
      if (claimFull) {
        return fail(req, res, 429, {
          error: `too many keys claimed from this network: at most ${claimFull.limit} in ${IP_WINDOW_DAYS} days`,
          reason: "ip_claim_window",
          scope: claimFull.scope,
        }, "Too many keys from this network");
      }
      const domCheck = await domainWindowDeny(reg.json.email_domain, now, true);
      if (domCheck) return fail(req, res, 429, domCheck, "Too many keys for this domain");
      const claimSpent = await reserveNetwork(buckets, claimIpPath, now, false);
      if (claimSpent) {
        return fail(req, res, 429, { error: "too many keys claimed from this network", reason: "ip_claim_window", scope: claimSpent.scope }, "Too many keys from this network");
      }
      const domFull = await domainWindowDeny(reg.json.email_domain, now, false);
      if (domFull) return fail(req, res, 429, domFull, "Too many keys for this domain");
      const key = keys.mintKey();
      const created = await keys.createFulfillment(fid, {
        session_id: fid,
        mode: "registration",
        key,
        key_hash: keys.keyHash(key),
        namespace_prefix: keys.mintNamespacePrefix(),
        prefix_source: "random",
        pack: "registration",
        credits: GRANT_CREDITS,
        pool_id: keys.mintPoolId(),
        org: null,
        email_hash: emailHash,
        email_domain: reg.json.email_domain || null,
        created_at: new Date().toISOString(),
      });
      rec = created.record;
    }
    if (typeof rec.key !== "string" || typeof rec.key_hash !== "string" || !rec.namespace_prefix) {
      return fail(req, res, 503, { error: `the stored key record for this registration cannot be read; contact ${CLAIMED_CONTACT}`, reason: "record_unreadable", retry_safe: false }, "This key needs support");
    }

    await keys.writeIssuedKey({
      key_hash: rec.key_hash,
      key_id: rec.key_hash.slice(0, 12),
      namespace_prefix: rec.namespace_prefix,
      plan: "grant", // no monthly free pins: every pin debits a credit (lib/_meter.js PLAN_CAPS.grant = 0)
      org: rec.org || null,
      pool_id: rec.pool_id,
      source: "register",
      registration: emailHash,
      created_at: rec.created_at,
    });
    await keys.writePool({
      pool_id: rec.pool_id,
      org: rec.org || null,
      credit_account: rec.key_hash,
      member_key_hashes: [rec.key_hash],
      kind: "solo",
      created_at: rec.created_at,
    });
    // TWO gates on the grant, not one (review 9). The registration record's
    // `granted` flag is the first: once set, grantCredits is never called
    // again for this email, whatever the balance file says. applied_events
    // (idempotent on "reg-"+emailHash) is the second, covering only the crash
    // window between the grant and the flag write. applied_events alone is
    // not enough: it keeps the last 500 events, so an old grant id can age out.
    let creditBalance;
    const fresh = await getFile(regPath(emailHash));
    if (fresh && fresh.json.granted === true) {
      creditBalance = (await balance.readBalance(rec.key_hash)).balance;
    } else {
      const grant = await balance.grantCredits(rec.key_hash, GRANT_CREDITS, "registration", fid, "register");
      if (grant.ledger_write_failed) {
        console.error(`[register] ledger write failed for a successful grant: key=${rec.key_hash.slice(0, 12)} detail=${grant.ledger_write_failed}`);
      }
      creditBalance = grant.balance_after;
      await setGranted(emailHash);
    }

    // The ONE showing: only the call that makes the transition shows the key.
    // The transition. A concurrent POST that lost it is a double submit:
    // answered like any confirmed revisit (the same key inside the window).
    const won = await markClaimed(emailHash, rec.key_hash);
    if (!won) {
      const now = await getFile(regPath(emailHash));
      return answerConfirmed(req, res, now || reg, emailHash);
    }
    return keyPage(req, res, rec, creditBalance, false);
  } catch (err) {
    console.error(`[register] confirm store error: ${err.message}`);
    return fail(req, res, 503, { error: "the key store is unavailable right now; try again in a minute (it is safe to retry)", reason: "store_error", retry_safe: true }, "Try again in a minute");
  }
}

function keyPage(req, res, rec, creditBalance, reshown) {
  return send(req, res, 200, {
    ok: true,
    state: "confirmed",
    key: rec.key,
    shown_once: !reshown,
    ...(reshown ? { reshown: true } : {}),
    reshow_window_minutes: KEY_RESHOW_MS / 60000,
    namespace: rec.namespace_prefix,
    namespace_example: `${rec.namespace_prefix}main`,
    plan: "grant",
    credits_granted: GRANT_CREDITS,
    credit_balance: creditBalance,
    support: CLAIMED_CONTACT,
  }, "Your Arcaeon witness key", keyOnceHtml(rec, creditBalance));
}

// A confirmed registration. POST inside the re-show window with the raw key
// still stored: the same key page, reads only. Past the window with the raw
// key still stored: null it (the one write), then already-claimed. Otherwise
// already-claimed, no write. GET never shows the key (scanners GET).
async function answerConfirmed(req, res, reg, emailHash) {
  const fid = fulfillId(emailHash);
  const ful = await keys.readFulfillment(fid);
  const rec = ful && ful.json;
  const hasKey = !!(rec && typeof rec.key === "string" && rec.key && typeof rec.key_hash === "string" && rec.namespace_prefix);
  if (hasKey && withinReshow(reg, Date.now())) {
    if (req.method === "POST") {
      const b = await balance.readBalance(rec.key_hash);
      return keyPage(req, res, rec, b.balance, true);
    }
  } else if (hasKey) {
    try {
      await keys.updateFulfillment(fid, (f) => ({ ...f, key: null, key_removed_at: new Date().toISOString() }));
    } catch (err) {
      console.error(`[register] raw key not removed after the re-show window, key=${String(rec.key_hash).slice(0, 12)}: ${err.message}`);
    }
  }
  return fail(req, res, 409, claimedBody(reg), "Already claimed");
}

// ---- op: register-status ----
async function handleStatus(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only", reason: "method" });
  }
  const pre = ratelimit.check(req);
  if (pre.limited) {
    res.setHeader("retry-after", String(pre.retryAfterSeconds));
    return res.status(429).json({ error: "too many requests from this address; slow down", reason: "rate_limited" });
  }
  const { q } = inputOf(req);
  // ?e=<email hash> (what status_url carries) or ?email=<address>.
  let emailHash;
  if (typeof q.e === "string" && /^[0-9a-f]{64}$/.test(q.e)) {
    emailHash = q.e;
  } else {
    const e = normaliseEmail(q.email);
    if (!e.ok) return res.status(400).json({ error: e.detail, reason: e.reason });
    emailHash = sha256(e.normalised);
  }
  res.setHeader("cache-control", "no-store");
  try {
    // NO ORACLE (review 4): unknown and pending answer the same. "confirmed"
    // only for a caller holding t8 (the first 8 hex of the token hash, handed
    // to whoever started this registration).
    const t8 = typeof q.t8 === "string" && /^[0-9a-f]{8}$/.test(q.t8) ? q.t8 : null;
    const cur = await getFile(regPath(emailHash));
    const proven = !!(t8 && cur && typeof cur.json.token_hash === "string" && cur.json.token_hash.slice(0, 8) === t8);
    const state = proven && cur.json.state === "confirmed" ? "confirmed" : "pending_or_unknown";
    return res.status(200).json({ state });
  } catch (err) {
    return res.status(503).json({ error: "registration store unavailable; retry shortly", reason: "store_error" });
  }
}

// ---- op: register-report (the reader) ----
function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function topN(map, n, total, keyName) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k, c]) => ({ [keyName]: k, count: c, share: total ? Math.round((c / total) * 1000) / 1000 : 0 }));
}

async function handleReport(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only", reason: "method" });
  }
  const adminKey = process.env.WITNESS_ADMIN_KEY;
  if (!adminKey) return res.status(500).json({ error: "WITNESS_ADMIN_KEY not configured", reason: "not_configured" });
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided || !timingSafeStringEqual(provided, adminKey)) {
    return res.status(401).json({ error: "invalid or missing admin bearer key" });
  }
  res.setHeader("cache-control", "no-store");
  try {
    const entries = await listDir("registrations");
    const files = entries.filter((x) => x.type !== "dir" && /^[0-9a-f]{64}\.json$/.test(x.name));
    const recs = await Promise.all(files.map((f) => getFile(`registrations/${f.name}`)));
    const now = Date.now();
    const days = [];
    for (let i = REPORT_DAYS - 1; i >= 0; i--) {
      days.push(new Date(now - i * 86400 * 1000).toISOString().slice(0, 10));
    }
    const first = days[0];
    const perDay = new Map(days.map((d) => [d, { date: d, registrations: 0, confirmed: 0, ip_hashes: new Set(), domains: new Set() }]));
    const byIp = new Map();
    const byDomain = new Map();
    let total = 0;
    let unreadable = 0;
    for (const r of recs) {
      if (!r || !r.json || typeof r.json.created_at !== "string") {
        unreadable += 1;
        continue;
      }
      const day = r.json.created_at.slice(0, 10);
      if (day < first || !perDay.has(day)) continue;
      const row = perDay.get(day);
      total += 1;
      row.registrations += 1;
      if (r.json.state === "confirmed") row.confirmed += 1;
      const ip = String(r.json.ip_hash || "unknown").slice(0, 16);
      const dom = String(r.json.email_domain || "unknown");
      row.ip_hashes.add(ip);
      row.domains.add(dom);
      byIp.set(ip, (byIp.get(ip) || 0) + 1);
      byDomain.set(dom, (byDomain.get(dom) || 0) + 1);
    }
    return res.status(200).json({
      ok: true,
      window_days: REPORT_DAYS,
      total,
      per_day: days.map((d) => {
        const row = perDay.get(d);
        return { date: d, registrations: row.registrations, confirmed: row.confirmed, distinct_ip_hashes: row.ip_hashes.size, distinct_domains: row.domains.size };
      }),
      top_ip_hashes: topN(byIp, 10, total, "ip_hash"),
      top_email_domains: topN(byDomain, 10, total, "email_domain"),
      records_listed: files.length,
      records_unreadable: unreadable,
      // The contents API lists at most 1000 entries per directory. At that
      // size this report can no longer see every registration, and says so.
      listing_may_be_truncated: entries.length >= 1000,
      note: "ip_hash is a salted sha256 prefix, never an IP. Flip rule (pricing decision 2026-09-27): one ip_hash or domain over 5% share means card gate first.",
    });
  } catch (err) {
    return res.status(503).json({ error: "registration store unavailable; retry shortly", reason: "store_error" });
  }
}

async function handle(req, res, op) {
  if (op === "register") return handleRegister(req, res);
  if (op === "confirm") return handleConfirm(req, res);
  if (op === "register-status") return handleStatus(req, res);
  if (op === "register-report") return handleReport(req, res);
  return res.status(400).json({ error: "unknown op" });
}

module.exports = {
  OPS,
  GRANT_CREDITS,
  IP_WINDOW_LIMIT,
  IP_WINDOW_DAYS,
  TOKEN_TTL_MS,
  KEY_RESHOW_MS,
  handle,
  normaliseEmail,
  isDisposable,
  clientIp,
  ipHash,
  networkBuckets,
  expandIPv6,
  isMajorProvider,
  DOMAIN_WINDOW_LIMIT,
  V6_48_LIMIT,
  claimIpPath,
  domainPath,
  setSender,
  regPath,
  tokPath,
  ipPath,
  fulfillId,
  sha256,
};
