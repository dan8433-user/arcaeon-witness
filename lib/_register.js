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
//   GET ?op=confirm&t=<token>
//     verify the token against the stored hash, mint the key (create-only
//     fulfillments/reg-<emailHash>.json is the one-key-per-email gate, same
//     idiom as the Stripe path's fulfillments/<session_id>.json), write the
//     issued-key + pool records, grant 500 credits idempotent on
//     "reg-"+emailHash, mark the registration confirmed. Every revisit re-shows
//     the SAME key and grants nothing (the link is a bearer of the key, exactly
//     like the Stripe receipt URL; see lib/_keys.js fulfillments/ paragraph).
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

function cleanAgent(a) {
  if (a === undefined || a === null || a === "") return { ok: true, value: null };
  if (typeof a !== "string") return { ok: false };
  // eslint-disable-next-line no-control-regex
  const v = a.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
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

function ipHash(ip) {
  return sha256(`${process.env.REGISTER_IP_SALT}\n${ip}`);
}

// ---- paths ----
const regPath = (emailHash) => `registrations/${emailHash}.json`;
const tokPath = (tokenHash) => `registrations/_tok/${tokenHash}.json`;
const ipPath = (iph, month) => `registrations/_ip/${iph}/${month}.json`;
const fulfillId = (emailHash) => `reg-${emailHash}`;

function utcMonth(d) {
  return d.toISOString().slice(0, 7);
}
function prevMonth(d) {
  return utcMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)));
}

// ---- per-IP registration window (durable, rolling 30 days) ----
// Events are appended to the CURRENT month's file; the count reads this month
// and last month and keeps events inside the last 30 days. The count and the
// append are one CAS against the current month's file, so two racers cannot
// both take the third slot: the loser re-reads, recounts, and is refused.
async function reserveIpSlot(iph, now) {
  const since = now.getTime() - IP_WINDOW_DAYS * 86400 * 1000;
  const inWindow = (evs) =>
    (Array.isArray(evs) ? evs : []).filter((t) => Date.parse(t) > since).length;
  const prev = await getFile(ipPath(iph, prevMonth(now)));
  const prevCount = prev ? inWindow(prev.json.events) : 0;
  const month = utcMonth(now);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getFile(ipPath(iph, month));
    const events = cur && Array.isArray(cur.json.events) ? cur.json.events : [];
    const count = prevCount + inWindow(events);
    if (count >= IP_WINDOW_LIMIT) return { ok: false, count, limit: IP_WINDOW_LIMIT };
    try {
      await putFile(
        ipPath(iph, month),
        { ip_hash: iph, month, events: events.concat([now.toISOString()]) },
        `register ip-window ${iph.slice(0, 12)} ${month} n=${events.length + 1}`,
        cur ? cur.sha : undefined
      );
      return { ok: true, count: count + 1, limit: IP_WINDOW_LIMIT };
    } catch (err) {
      if (err.conflict && attempt < 3) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("registration store: exhausted CAS retries on ip window");
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
    const detail = await r.text().catch(() => "");
    console.error(`[register] resend -> ${r.status}: ${detail.slice(0, 300)}`);
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

function magicLinkMessage(address, token, agent) {
  const link = confirmUrl(token);
  const who = agent ? `An agent calling itself "${agent}" asked` : "Someone asked";
  const subject = "Confirm your Arcaeon witness key";
  const text =
    `${who} for an Arcaeon witness key for this address.\n\n` +
    `Open this link to confirm. Your key is created when you open it, shown on that page, and comes with ${GRANT_CREDITS} credits (one credit = one pin):\n\n` +
    `${link}\n\n` +
    `The link works for 48 hours. Asking again sends a new link and the old one stops working.\n` +
    `If you did not ask for this, ignore it: nothing is created until the link is opened.\n\n` +
    `Questions: ${SUPPORT_EMAIL}\n`;
  const html =
    `<p>${esc(who)} for an Arcaeon witness key for this address.</p>` +
    `<p>Open this link to confirm. Your key is created when you open it, shown on that page, and comes with <b>${GRANT_CREDITS} credits</b> (one credit = one pin):</p>` +
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
  if (!agent.ok) return res.status(400).json({ error: "agent must be a string", reason: "bad_agent" });

  const emailHash = sha256(e.normalised);
  const statusUrl = `${baseUrl()}/api/fulfill?op=register-status&email=${encodeURIComponent(e.address)}`;

  try {
    let cur = await getFile(regPath(emailHash));
    if (cur && cur.json.state === "confirmed") {
      return res.status(200).json({ ok: true, state: "confirmed", note: "this email already has its key; nothing was sent" });
    }

    const now = new Date();
    const iph = ipHash(clientIp(req));
    const slot = await reserveIpSlot(iph, now);
    if (!slot.ok) {
      return res.status(429).json({
        error: `too many registrations from this network: at most ${IP_WINDOW_LIMIT} in ${IP_WINDOW_DAYS} days`,
        reason: "ip_registration_window",
        limit: IP_WINDOW_LIMIT,
        window_days: IP_WINDOW_DAYS,
      });
    }

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
      if (cur.json.state === "confirmed") {
        return res.status(200).json({ ok: true, state: "confirmed", note: "this email already has its key; nothing was sent" });
      }
      // Pending: rotate the token (the older link stops working).
      const next = { ...cur.json, token_hash: tokenHash, token_created_at: nowIso, sends: (Number(cur.json.sends) || 1) + 1 };
      if (agent.value) next.agent = agent.value;
      try {
        await putFile(regPath(emailHash), next, `register ${emailHash.slice(0, 12)} resend`, cur.sha);
        break;
      } catch (err) {
        if (!err.conflict || attempt === 2) throw err;
        cur = await getFile(regPath(emailHash));
      }
    }

    await putFile(tokPath(tokenHash), { email_hash: emailHash, created_at: nowIso }, `register token ${tokenHash.slice(0, 12)}`);

    try {
      await sender(magicLinkMessage(e.address, token, agent.value));
    } catch (err) {
      console.error(`[register] mail send failed for ${emailHash.slice(0, 12)}: ${err.message}`);
      return res.status(502).json({
        error: "the confirmation email could not be sent; try again in a few minutes",
        reason: "mail_send_failed",
        retry_safe: true,
      });
    }

    return res.status(202).json({
      ok: true,
      state: "pending",
      sent: true,
      email_domain: e.domain,
      status_url: statusUrl,
      note:
        "a confirmation link was sent to the address. The key is created when the human opens it, " +
        `is shown on that page, and comes with ${GRANT_CREDITS} credits. Poll status_url for the state; it never returns the key.`,
    });
  } catch (err) {
    console.error(`[register] store error: ${err.message}`);
    return res.status(503).json({ error: "registration store unavailable; nothing was sent; retry shortly", reason: "store_error", retry_safe: true });
  }
}

// ---- op: confirm ----
function confirmedHtml(rec, balanceAfter, again) {
  const ns = rec.namespace_prefix;
  return (
    `<h1>${again ? "Your witness key" : "Confirmed. Here is your witness key"}</h1>` +
    copyBox("key", rec.key) +
    `<p><b>${esc(String(balanceAfter))} credits</b> are on it (one credit = one pin). It pins any namespace starting with <code>${esc(ns)}</code>, for example <code>${esc(ns)}main</code>.</p>` +
    `<p class="warn">Save this key now. This link shows it again while it exists, so treat the link like the key.</p>` +
    `<p class="muted">Balance: <a href="${esc(baseUrl())}/api/balance">${esc(baseUrl())}/api/balance</a>. Questions: ${esc(SUPPORT_EMAIL)}.</p>`
  );
}

async function markConfirmed(emailHash, keyHash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getFile(regPath(emailHash));
    if (!cur) throw new Error("registration vanished during confirm");
    if (cur.json.state === "confirmed") return;
    const next = { ...cur.json, state: "confirmed", key_hash: keyHash, confirmed_at: new Date().toISOString() };
    try {
      await putFile(regPath(emailHash), next, `register ${emailHash.slice(0, 12)} confirmed`, cur.sha);
      return;
    } catch (err) {
      if (!err.conflict || attempt === 2) throw err;
    }
  }
}

async function handleConfirm(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only", reason: "method" });
  }
  const { q, body } = inputOf(req);
  const t = String(q.t || body.t || "");
  if (!/^[0-9a-f]{64}$/.test(t)) {
    return fail(req, res, 400, { error: "this confirmation link is malformed; use the exact link from the email", reason: "bad_token" }, "Link not recognised");
  }
  const tokenHash = sha256(t);
  try {
    const idx = await getFile(tokPath(tokenHash));
    const emailHash = idx && typeof idx.json.email_hash === "string" ? idx.json.email_hash : null;
    const reg = emailHash ? await getFile(regPath(emailHash)) : null;
    if (!reg) {
      return fail(req, res, 404, { error: "this confirmation link is not recognised; register again to get a new one", reason: "unknown_token" }, "Link not recognised");
    }
    const stored = Buffer.from(String(reg.json.token_hash || ""), "utf8");
    const given = Buffer.from(tokenHash, "utf8");
    if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) {
      return fail(req, res, 410, { error: "a newer confirmation link was sent for this address; use the latest email", reason: "superseded_token" }, "This link was replaced");
    }
    const confirmedAlready = reg.json.state === "confirmed";
    if (!confirmedAlready) {
      const age = Date.now() - Date.parse(reg.json.token_created_at || reg.json.created_at || 0);
      if (!(age >= 0 && age <= TOKEN_TTL_MS)) {
        return fail(req, res, 410, { error: "this confirmation link has expired; register again to get a new one", reason: "expired_token" }, "This link has expired");
      }
    }

    // The one-key-per-email gate: create-only, winner's record served.
    const fid = fulfillId(emailHash);
    let rec;
    const existing = await keys.readFulfillment(fid);
    if (existing) {
      rec = existing.json;
    } else {
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
        agent: reg.json.agent || null,
        created_at: new Date().toISOString(),
      });
      rec = created.record;
    }
    if (typeof rec.key !== "string" || typeof rec.key_hash !== "string" || !rec.namespace_prefix) {
      return fail(req, res, 503, { error: `the stored key record for this registration cannot be read; contact ${SUPPORT_EMAIL}`, reason: "record_unreadable", retry_safe: false }, "This key needs support");
    }

    // Idempotent side effects, run on every visit so a crash part-way heals.
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
    const grant = await balance.grantCredits(rec.key_hash, GRANT_CREDITS, "registration", fulfillId(emailHash), "register");
    if (grant.ledger_write_failed) {
      console.error(`[register] ledger write failed for a successful grant: key=${rec.key_hash.slice(0, 12)} detail=${grant.ledger_write_failed}`);
    }
    await markConfirmed(emailHash, rec.key_hash);

    const again = confirmedAlready || !!existing;
    return send(req, res, 200, {
      ok: true,
      state: "confirmed",
      key: rec.key,
      namespace: rec.namespace_prefix,
      namespace_example: `${rec.namespace_prefix}main`,
      plan: "grant",
      credits_granted: GRANT_CREDITS,
      already_credited: !!grant.already_credited,
      credit_balance: grant.balance_after,
      already_confirmed: again,
      support: SUPPORT_EMAIL,
    }, "Your Arcaeon witness key", confirmedHtml(rec, grant.balance_after, again));
  } catch (err) {
    console.error(`[register] confirm store error: ${err.message}`);
    return fail(req, res, 503, { error: "the key store is unavailable right now; open the same link again in a minute (it is safe to retry)", reason: "store_error", retry_safe: true }, "Try again in a minute");
  }
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
  const e = normaliseEmail(q.email);
  if (!e.ok) return res.status(400).json({ error: e.detail, reason: e.reason });
  res.setHeader("cache-control", "no-store");
  try {
    const cur = await getFile(regPath(sha256(e.normalised)));
    const state = !cur ? "none" : cur.json.state === "confirmed" ? "confirmed" : "pending";
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
  handle,
  normaliseEmail,
  isDisposable,
  clientIp,
  ipHash,
  setSender,
  regPath,
  tokPath,
  ipPath,
  fulfillId,
  sha256,
};
