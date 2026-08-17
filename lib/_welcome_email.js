// _welcome_email.js — the branded welcome/backup-copy email for a freshly
// minted witness key. Rev-2 of the fulfillment page (board item 27).
//
// TWO consumers, by design:
//   1. api/fulfill.js's email path — still a STUB (the app has no outbound
//      mail mechanism; zero deps by design), but the stub now renders THIS
//      template so the day mail creds exist, wiring a sender is the only
//      remaining work.
//   2. The manual runbook — a human doing hand-fulfillment can require() this
//      module, call renderWelcomeEmailHtml(record), and paste the result into
//      any sender. That is why both renderers take the plain fulfillment
//      record (the fulfillments/<session_id>.json shape from lib/_keys.js)
//      and read nothing else but env defaults.
//
// Email-client discipline: ALL styles inline (clients strip <style> blocks),
// table-free single-column layout, no JS, no external images. Same brand as
// the fulfillment page: dark blue, white, gold, "Arcaeon" wordmark. The KEY
// appears only in the body text — never inside any href (house rule from the
// page: a key must never land in a URL).

"use strict";

const SUPPORT_EMAIL = "support@arcaeon.io";

function docsUrl() {
  return process.env.WITNESS_DOCS_URL || "https://arcaeon.io/ai";
}
function baseUrl() {
  return process.env.WITNESS_BASE_URL || "https://arcaeon-witness.vercel.app";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const WELCOME_SUBJECT = "Your Arcaeon witness key";

// Brand tokens (keep in step with api/fulfill.js's pageShell).
const NAVY_DEEP = "#07172e";
const NAVY = "#0b2545";
const LINE = "#1e4276";
const INK = "#f4f7fb";
const MUTED = "#9db2d0";
const GOLD = "#d4af37";

function renderWelcomeEmailHtml(record) {
  const ns = record.namespace_prefix;
  const mono =
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const block =
    `background:${NAVY};border:1px solid ${LINE};border-radius:8px;` +
    `padding:14px 16px;${mono};word-break:break-all;color:${INK}`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:${NAVY_DEEP}">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;background:${NAVY_DEEP};color:${INK};font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6">
  <div style="color:${GOLD};font-weight:700;letter-spacing:.28em;text-transform:uppercase;font-size:13px;text-align:center;padding-bottom:6px">Arcaeon</div>
  <div style="height:1px;background:${GOLD};opacity:.55;max-width:280px;margin:0 auto 26px"></div>
  <h1 style="font-size:19px;font-weight:650;margin:0 0 12px;color:${INK}">Your witness key is minted</h1>
  <p style="margin:0 0 16px">Payment verified. This is your backup copy — the same key your receipt page shows.</p>
  <div style="${block};font-size:15px">${esc(record.key)}</div>
  <p style="margin:16px 0"><b>${esc(String(record.credits))} prepaid pins</b> are on your balance (plus the free tier: 100 pins/month). Your key pins any namespace starting with <span style="${mono};color:${GOLD}">${esc(ns)}</span>.</p>
  <p style="margin:0 0 16px;color:${MUTED};font-size:13px">Check your balance any time at <a href="${esc(baseUrl())}/api/balance" style="color:${GOLD}">${esc(baseUrl())}/api/balance</a> — you paste the key on the page; the link itself carries nothing.</p>
  <p style="margin:0 0 20px;color:${GOLD}">Treat this email like the key itself. Anyone holding the key can pin under your prefix.</p>
  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:${MUTED};font-weight:650;margin:24px 0 10px">Install the client</h2>
  <div style="${block};font-size:14px">pip install arcaeon-ledger</div>
  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:${MUTED};font-weight:650;margin:24px 0 10px">Quickstart</h2>
  <div style="${block};font-size:13px;white-space:pre-wrap">curl -X POST ${esc(baseUrl())}/api/pin \\
  -H "Authorization: Bearer &lt;YOUR KEY&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"namespace":"${esc(ns)}main","rows":1,"chain":"&lt;16-hex head&gt;"}'</div>
  <p style="margin:16px 0">Verification is public, no key needed: <span style="${mono}">GET ${esc(baseUrl())}/api/verify</span></p>
  <p style="margin:24px 0 0;color:${MUTED};font-size:13px">Lost this email? Your Stripe receipt links back to the fulfillment page, which re-shows the same key. Support: <a href="mailto:${SUPPORT_EMAIL}" style="color:${GOLD}">${SUPPORT_EMAIL}</a> &middot; <a href="${esc(docsUrl())}" style="color:${GOLD}">docs</a></p>
</div>
</body></html>`;
}

// Plain-text fallback (multipart/alternative text part, or for senders that
// only take text). Same content, zero markup.
function renderWelcomeEmailText(record) {
  const ns = record.namespace_prefix;
  return [
    "ARCAEON — your witness key is minted",
    "",
    "Payment verified. This is your backup copy — the same key your receipt page shows.",
    "",
    `Key:       ${record.key}`,
    `Credits:   ${record.credits} prepaid pins (plus the free tier: 100 pins/month)`,
    `Namespace: your key pins any namespace starting with ${ns}`,
    "",
    `Check your balance any time at ${baseUrl()}/api/balance — you paste the`,
    "key on the page; the link itself carries nothing.",
    "",
    "Treat this email like the key itself.",
    "",
    "Install the client:",
    "  pip install arcaeon-ledger",
    "",
    "Quickstart:",
    `  curl -X POST ${baseUrl()}/api/pin \\`,
    '    -H "Authorization: Bearer <YOUR KEY>" \\',
    '    -H "Content-Type: application/json" \\',
    `    -d '{"namespace":"${ns}main","rows":1,"chain":"<16-hex head>"}'`,
    "",
    `Verification is public, no key needed: GET ${baseUrl()}/api/verify`,
    "",
    "Lost this email? Your Stripe receipt links back to the fulfillment page,",
    "which re-shows the same key.",
    `Support: ${SUPPORT_EMAIL} · docs: ${docsUrl()}`,
    "",
  ].join("\n");
}

module.exports = { renderWelcomeEmailHtml, renderWelcomeEmailText, WELCOME_SUBJECT };
