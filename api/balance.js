// GET /api/balance — a key-holder's own read-only view: purchased credit
// balance plus current free-tier monthly usage. Auth-gated the same way
// as /api/pin (Bearer <key> from WITNESS_KEYS) — this is a self-read of
// account state, not a public witnessing fact like /api/latest, so it is
// not open to the world.
//
// Read-only by construction: it calls meter.peek() (added alongside this
// endpoint), never meter.check(), so looking at your own balance can
// never itself consume a pin.
//
// REV-2 (founder design 34378) — the HUMAN face, same function: every issued
// key gets an easy way to see pins remaining, no login, no account, no PII —
// the key IS the identity. Rides this endpoint via content negotiation (the
// api/fulfill.js pattern; api/ is at Vercel Hobby's 12-function cap, so a new
// page had to live on an existing function; template shared via lib/_page.js).
//
//   - JSON is the DEFAULT and its contract is UNCHANGED: any GET without an
//     explicit `Accept: text/html` — including a bare curl's `Accept: */*` —
//     takes exactly the pre-page code path (same fields, same auth, same
//     errors). HTML is opt-in by the browser's own Accept header, never
//     inferred, so content negotiation can't repaint an existing API caller.
//   - Browser GET without a key: a paste-your-key form. The key field is
//     type=password (no shoulder-surfing) and the form POSTs — house rule:
//     the key never appears in any URL, so never a GET query param, which
//     would also land it in access logs.
//   - Browser POST with the key in the body: the balance, human layout, plus
//     the curl one-liner for the JSON version (teaching the agent path). The
//     key is never echoed back into the page — not on success, not on error.
//   - Browser GET with an Authorization: Bearer header also renders HTML
//     (an agent showing a human a page); same data.
//   - "Remember this key" checkbox, default OFF: localStorage only, client-
//     side only, nothing stored server-side.

"use strict";

const store = require("../lib/_store.js");
const meter = require("../lib/_meter.js");
const balance = require("../lib/_balance.js");
const issuedKeys = require("../lib/_keys.js");
const { baseUrl, esc, wantsJson, pageShell, copyBox } = require("../lib/_page.js");

// HTML strictly opt-in: an explicit text/html Accept AND not the JSON
// overrides (?format=json / Accept: application/json). Everything else —
// bare curl, SDK fetches, anything headerless — keeps the JSON contract.
function wantsHtml(req) {
  if (wantsJson(req)) return false;
  const accept = String((req.headers && req.headers.accept) || "");
  return accept.toLowerCase().includes("text/html");
}

function sendHtml(res, status, html) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(status).send(html);
}

// The paste-your-key form (also the error re-render — same form, one inline
// message, and NEVER the attempted key: a typo'd key is still probably 95%
// of a real key, so echoing it back into HTML would be a leak).
function formHtml(errorMsg) {
  const errorBlock = errorMsg ? `<p class="error">${esc(errorMsg)}</p>` : "";
  return pageShell(
    "Check your balance",
    `<h1>Check your witness-key balance</h1>
<p>Paste your key. It travels in the POST body — never in a URL, never in a query string, never stored here.</p>
${errorBlock}
<form method="post" action="" class="card">
  <label for="key">Witness key</label>
  <input type="password" id="key" name="key" autocomplete="off" spellcheck="false" placeholder="wk_…">
  <label class="muted" style="font-weight:400;margin-top:10px"><input type="checkbox" id="remember"> Remember this key on this device (this browser's storage only — off by default)</label>
  <button type="submit" class="mint">Check balance</button>
</form>
<p class="muted">Agents: <code>GET /api/balance</code> with <code>Authorization: Bearer &lt;YOUR KEY&gt;</code> returns the same numbers as JSON.</p>
<script>
(function(){
  var input=document.getElementById("key"),box=document.getElementById("remember");
  if(!input||!box)return;
  try{var saved=localStorage.getItem("witness_key");if(saved){input.value=saved;box.checked=true}}catch(e){}
  input.form.addEventListener("submit",function(){
    try{if(box.checked){localStorage.setItem("witness_key",input.value)}else{localStorage.removeItem("witness_key")}}catch(e){}
  });
})();
</script>`
  );
}

// The human balance view — same data the JSON exposes (bal + peek + the
// prefix the auth lookup already resolved), zero extra reads, and the raw
// key never appears anywhere in the page.
function balanceHtml(prefix, bal, freeTier) {
  const freeLine =
    freeTier.cap === null
      ? `Free tier: plan <b>${esc(freeTier.plan)}</b> — no monthly cap configured.`
      : `Free tier (<b>${esc(freeTier.plan)}</b> plan, ${esc(freeTier.month)}): ${esc(String(freeTier.used))} of ${esc(String(freeTier.cap))} used — <b>${esc(String(Math.max(0, freeTier.cap - freeTier.used)))} remaining</b> this month.`;
  const creditLine = bal.ever_purchased
    ? `<b>${esc(String(bal.balance))} prepaid pins</b> remaining${bal.updated_at ? ` <span class="muted">(updated ${esc(bal.updated_at)})</span>` : ""}.`
    : `<b>0 prepaid pins</b> — no credit pack purchased yet (the free tier below still applies).`;
  return pageShell(
    "Your balance",
    `<h1>Your balance</h1>
<div class="card">
<p>${creditLine}</p>
<p>${freeLine}</p>
<p class="muted">Namespace prefix: <code>${esc(prefix)}</code> · key id: <code>${esc(bal.key_id)}</code></p>
</div>
<h2>The agent path</h2>
${copyBox("curl", `curl -s ${baseUrl()}/api/balance -H "Authorization: Bearer <YOUR KEY>"`)}
<p class="muted">Same numbers, JSON shape — checking a balance never consumes anything. <a href="">Check another key</a>.</p>`
  );
}

// Shared auth resolution (the same two tiers the JSON path has always used):
// WITNESS_KEYS env first, then the dynamic issued-key store. Returns
// {prefix} | {prefix:null} | {storeError}.
async function resolvePrefix(key) {
  let prefix = key ? store.keyPrefixFor(key) : null;
  if (prefix === null && key) {
    try {
      prefix = await issuedKeys.issuedKeyPrefix(key);
    } catch (err) {
      return { prefix: null, storeError: err };
    }
  }
  return { prefix, storeError: null };
}

module.exports = async (req, res) => {
  const isHtml = wantsHtml(req);

  // ---- HTML mode (browsers only — explicit Accept: text/html) ----
  if (isHtml && (req.method === "GET" || req.method === "POST")) {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const auth = req.headers.authorization || "";
    const key =
      req.method === "POST"
        ? String(body.key || "").trim()
        : auth.startsWith("Bearer ")
          ? auth.slice(7).trim()
          : "";
    if (!key) {
      // GET with no key = the front door (200). POST with no key = a form
      // submitted empty (400) — same form back, one clean message.
      if (req.method === "GET") return sendHtml(res, 200, formHtml(null));
      return sendHtml(res, 400, formHtml("Paste your witness key first — the field came through empty."));
    }
    const { prefix, storeError } = await resolvePrefix(key);
    if (storeError) {
      return sendHtml(res, 502, formHtml("The key store is unreachable right now — nothing is wrong with your key. Retry in a minute."));
    }
    if (prefix === null) {
      return sendHtml(res, 401, formHtml("That key isn't recognized. Check for missing or extra characters and try again."));
    }
    try {
      const [bal, freeTier] = await Promise.all([
        balance.readBalance(balance.keyHash(key)),
        meter.peek(key),
      ]);
      return sendHtml(res, 200, balanceHtml(prefix, bal, freeTier));
    } catch (err) {
      return sendHtml(res, 502, formHtml("Balance read failed upstream — retry in a minute."));
    }
  }

  // ---- JSON mode: the original contract, unchanged byte for byte ----
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  // Same two-tier auth as api/pin.js: WITNESS_KEYS env first, then the
  // dynamic issued-key store (self-serve keys from api/fulfill.js).
  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let prefix = key ? store.keyPrefixFor(key) : null;
  if (prefix === null && key) {
    try {
      prefix = await issuedKeys.issuedKeyPrefix(key);
    } catch (err) {
      return res.status(502).json({ error: `key store error: ${err.message}` });
    }
  }
  if (prefix === null) {
    return res.status(401).json({ error: "invalid or missing bearer key" });
  }

  try {
    const [bal, freeTier] = await Promise.all([
      balance.readBalance(balance.keyHash(key)),
      meter.peek(key),
    ]);
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      ok: true,
      key_id: bal.key_id,
      credit_balance: bal.balance,
      credit_ever_purchased: bal.ever_purchased,
      credit_updated_at: bal.updated_at,
      free_tier: {
        plan: freeTier.plan,
        month: freeTier.month,
        used: freeTier.used,
        cap: freeTier.cap,
      },
    });
  } catch (err) {
    return res.status(502).json({ error: `balance read error: ${err.message}` });
  }
};
