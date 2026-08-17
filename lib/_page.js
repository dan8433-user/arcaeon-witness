// lib/_page.js — the shared human-facing page template: brand shell, copy
// boxes, HTML escaping, and the JSON-vs-HTML content-negotiation check.
// Extracted VERBATIM from api/fulfill.js (rev-2 ceremony restyle) so
// api/balance.js could grow a human face without becoming a 13th api/
// function (Vercel Hobby hard-caps api/ at 12 serverless functions; lib/
// files don't count toward it).
//
// Brand (rev-2): dark blue / white / gold, "Arcaeon" wordmark. Palette note:
// projects/arcaeon_site carries a slate+teal palette with no logo asset; this
// shell uses the founder-decided navy/gold family instead (12288/12291) and
// borrows only the site's text-wordmark treatment (uppercase, letterspaced).
// The same tokens live in lib/_welcome_email.js — keep them in step.
//
// Env is read at CALL time (docsUrl()/baseUrl() functions, the
// _welcome_email.js idiom) rather than require time; test files set env
// before requiring modules, so both idioms behave identically there, and
// call-time is the more forgiving of the two for late-bound Vercel env.

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

// Content negotiation: JSON is the DEFAULT (agents; a bare curl sends
// Accept: */* and must keep getting JSON); HTML is opt-in via an explicit
// Accept: text/html (what every browser sends) checked by the caller.
function wantsJson(req) {
  const q = req.query || {};
  if (String(q.format || "").toLowerCase() === "json") return true;
  const accept = String((req.headers && req.headers.accept) || "");
  return accept.toLowerCase().includes("application/json");
}

// The one deliberate delta from the verbatim fulfill.js copy: the input
// selectors gained `input[name=key]` (the balance page's key field) alongside
// `input[name=prefix]`. Additive CSS only — no fulfill page contains an
// input[name=key], so fulfill rendering is unchanged.
function pageShell(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{--navy-deep:#07172e;--navy:#0b2545;--panel:#0e2c52;--line:#1e4276;--ink:#f4f7fb;--muted:#9db2d0;--gold:#d4af37;--gold-soft:#e8cc74}
*{box-sizing:border-box}
body{font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--navy-deep);color:var(--ink);max-width:680px;margin:36px auto;padding:0 20px;line-height:1.6}
.wordmark{color:var(--gold);font-weight:700;letter-spacing:.28em;text-transform:uppercase;font-size:13px;text-align:center;margin:4px 0 8px}
.rule{height:1px;border:0;background:linear-gradient(90deg,transparent,var(--gold),transparent);max-width:320px;margin:0 auto 30px}
h1{font-size:1.35rem;font-weight:650;letter-spacing:-.01em;margin:0 0 12px}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:650;margin:28px 0 10px}
a{color:var(--gold-soft)}
code,pre,.copybox code,input[name=prefix],input[name=key]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--navy);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:.85rem}
.copybox{display:flex;align-items:center;gap:12px;background:var(--navy);border:1px solid var(--gold);border-radius:10px;padding:14px 16px;margin:14px 0}
.copybox code{flex:1;word-break:break-all;font-size:1rem}
button.copy{flex:none;background:var(--gold);color:var(--navy-deep);border:0;border-radius:8px;padding:8px 14px;font-weight:700;font-size:.85rem;cursor:pointer}
button.copy:hover{background:var(--gold-soft)}
.card{background:var(--navy);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:16px 0}
label{display:block;font-weight:650;margin:0 0 6px}
input[name=prefix],input[name=key]{width:100%;background:var(--navy-deep);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:1rem}
input[name=prefix]:focus,input[name=key]:focus{outline:none;border-color:var(--gold)}
button.mint{display:block;width:100%;margin-top:16px;background:var(--gold);color:var(--navy-deep);border:0;border-radius:8px;padding:12px;font-weight:700;font-size:1rem;cursor:pointer}
button.mint:hover{background:var(--gold-soft)}
.muted{color:var(--muted);font-size:.85rem}
.warn{color:var(--gold-soft)}
.error{color:#ff9d9d;background:rgba(255,157,157,.08);border:1px solid rgba(255,157,157,.35);border-radius:8px;padding:10px 14px}
</style></head><body>
<div class="wordmark">Arcaeon</div>
<hr class="rule">
${inner}
<p class="muted">support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> · <a href="${esc(docsUrl())}">docs</a></p>
<script>
(function(){
  function fallbackCopy(t){var ta=document.createElement("textarea");ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand("copy")}catch(e){}ta.remove()}
  var btns=document.querySelectorAll("[data-copy-target]");
  for(var i=0;i<btns.length;i++){(function(btn){
    btn.addEventListener("click",function(){
      var el=document.getElementById(btn.getAttribute("data-copy-target"));
      var text=el?el.textContent:"";
      var done=function(){btn.textContent="Copied";setTimeout(function(){btn.textContent="Copy"},1600)};
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text);done()})}
      else{fallbackCopy(text);done()}
    });
  })(btns[i])}
})();
</script>
</body></html>`;
}

// A styled block with a copy button — the key and the pip command each get
// one ("a key delivery is a little ceremony"). Vanilla-JS clipboard, no deps;
// the handler lives once in pageShell's script.
function copyBox(id, text) {
  return `<div class="copybox"><code id="${esc(id)}">${esc(text)}</code><button type="button" class="copy" data-copy-target="${esc(id)}">Copy</button></div>`;
}

module.exports = { SUPPORT_EMAIL, docsUrl, baseUrl, esc, wantsJson, pageShell, copyBox };
