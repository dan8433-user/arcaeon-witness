// _prefix_ui.js — the buyer-facing half of the prefix picker: the exact
// commands a key holder runs, and the browser script that checks a prefix
// live while they type. Underscore prefix = not routed as a serverless
// function by Vercel.
//
// Board item I-daniel-01 (Daniel 12288/12291, "shouldnt we let our users pick
// a prefix that isnt selected"). Rev-2 shipped the prefix FIELD; this is the
// live answer next to it — plus the copy-ready install and first-pin commands
// with the buyer's own prefix already substituted, so nobody has to hand-edit
// a placeholder out of a curl.
//
// ==== BOUNDARY — NOTHING HERE MINTS ========================================
// This is a picker and a command display. The script checks availability and
// previews commands; it never issues a key and never writes anything. Key
// MINTING stays where it already lives: api/fulfill.js's POST path, behind
// server-side Stripe checkout verification (self-serve), or an operator's
// hands per projects/online_business/FULFILLMENT_RUNBOOK.md (manual). A green
// "available" here is advice, not a reservation — the binding check reruns at
// mint time (see lib/_prefix_check.js's boundary note).
// ===========================================================================
//
// TWO COPIES OF ONE COMMAND, ON PURPOSE. `pinCurlCommand()` renders the curl
// server-side on the success page; `buildPinCurl()` inside PICKER_SCRIPT
// renders the same string in the browser as the buyer types. They must agree
// character for character or the preview lies about what they will run.
// test/prefix_ui.test.js evaluates the browser copy out of the script source
// and diffs it against this one across a table of prefixes — that test is the
// fence. If you edit one, the suite tells you about the other.

"use strict";

// The pip line is a constant, not a template: there is nothing to substitute,
// and the value of showing it is that it is copyable verbatim.
const PIP_COMMAND = "pip install arcaeon-ledger";

// The first-pin command. `<YOUR KEY>` stays a PLACEHOLDER deliberately even
// on the success page where the real key is one box above: a one-click copy
// of a command containing a live bearer key lands that key in shell history
// and in whatever the buyer pastes it into next. The prefix is the part that
// is theirs and unguessable-by-them; that is what gets substituted.
function pinCurlCommand(base, prefix) {
  return (
    "curl -X POST " + base + "/api/pin \\\n" +
    '  -H "Authorization: Bearer <YOUR KEY>" \\\n' +
    '  -H "Content-Type: application/json" \\\n' +
    "  -d '{\"namespace\":\"" + prefix + "main\",\"rows\":1,\"chain\":\"<16-hex head>\"}'"
  );
}

// Safe interpolation of a server value into an inline <script>: JSON-encode,
// then neutralize the one sequence that can end the script element early.
function jsString(value) {
  return JSON.stringify(String(value)).replace(/</g, "\\u003c");
}

// The browser MIRROR of pinCurlCommand(), as source text. Held in its own
// exported constant rather than buried in the script template so the test can
// eval THIS EXACT STRING and diff its output against the server function,
// instead of trying to brace-match a function whose body is mostly quoted
// braces. pickerScript() interpolates it verbatim; the test asserts that too,
// so the thing evaluated is provably the thing shipped.
const BUILD_PIN_CURL_JS = `function buildPinCurl(base, prefix){
    return "curl -X POST " + base + "/api/pin \\\\\\n" +
      "  -H \\"Authorization: Bearer <YOUR KEY>\\" \\\\\\n" +
      "  -H \\"Content-Type: application/json\\" \\\\\\n" +
      "  -d '{\\"namespace\\":\\"" + prefix + "main\\",\\"rows\\":1,\\"chain\\":\\"<16-hex head>\\"}'";
  }`;

// The picker's browser script. Vanilla, no deps (README "Layout": this repo
// has zero dependencies and keeps them at zero), ES5-shaped so it needs no
// transpile step and runs anywhere the buyer's receipt link opens.
//
// Behavior:
//   - DEBOUNCE_MS after the last keystroke, GET /api/prefix-available.
//   - A sequence guard drops out-of-order responses: with a debounce plus a
//     network, a slow answer for "acm" can land after a fast one for "acme-"
//     and repaint a stale verdict. Only the newest request may render.
//   - Three states are rendered distinctly: free / taken / could-not-check.
//     "Could not check" is never painted as free (fail closed in the UI too).
//   - On taken, the server's three verified-free alternatives render as
//     one-click buttons.
//   - The submit button is never disabled on a red: the server re-validates,
//     and a UI that blocks submission on a check that might itself be wrong
//     can strand a paying buyer.
function pickerScript(baseUrl) {
  return `
(function(){
  var BASE = ${jsString(baseUrl)};
  var DEBOUNCE_MS = 400;
  var input = document.getElementById("prefix");
  var stat = document.getElementById("prefix-status");
  var alts = document.getElementById("prefix-alts");
  var nsPrev = document.getElementById("ns-preview");
  var curlPrev = document.getElementById("curl-preview");
  if(!input||!stat) return;
  var timer = null, seq = 0;

  // MIRROR of lib/_prefix_ui.js pinCurlCommand() — kept identical by
  // test/prefix_ui.test.js, which evals this function and diffs the output.
  ${BUILD_PIN_CURL_JS}

  function norm(){ return (input.value||"").trim().toLowerCase(); }

  function preview(p){
    if(nsPrev) nsPrev.textContent = p ? p + "main" : "";
    if(curlPrev) curlPrev.textContent = p ? buildPinCurl(BASE, p) : "";
  }

  function paint(state, msg){
    stat.className = "pstat " + state;
    stat.textContent = msg;
  }

  function renderAlts(list){
    if(!alts) return;
    alts.innerHTML = "";
    if(!list || !list.length) return;
    var label = document.createElement("span");
    label.className = "muted";
    label.textContent = "Free instead: ";
    alts.appendChild(label);
    for(var i=0;i<list.length;i++){
      (function(p){
        var b = document.createElement("button");
        b.type = "button";
        b.className = "alt";
        b.textContent = p;
        b.addEventListener("click", function(){ input.value = p; check(); });
        alts.appendChild(b);
      })(list[i]);
    }
  }

  function check(){
    var p = norm();
    preview(p);
    if(!p){ paint("idle",""); renderAlts([]); return; }
    var mine = ++seq;
    paint("checking","Checking availability...");
    fetch("/api/prefix-available?prefix=" + encodeURIComponent(p), {headers:{"accept":"application/json"}})
      .then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); })
      .then(function(o){
        if(mine !== seq) return;              // a newer keystroke already won
        var b = o.body || {};
        if(b.available === true){
          paint("free", "\\u2713 " + p + " is available \\u2014 you'll pin " + p + "main, " + p + "staging, and so on.");
          renderAlts([]);
        } else if(b.available === false && b.reason === "taken"){
          paint("taken", "\\u2717 " + p + " is taken (or overlaps a prefix already in use). Pick another.");
          renderAlts(b.suggestions);
        } else if(b.available === false){
          paint("taken", "\\u2717 " + (b.detail || "That prefix can't be used."));
          renderAlts([]);
        } else {
          paint("unknown", "Couldn't check right now \\u2014 you can still submit; the prefix is verified when your key is minted.");
          renderAlts([]);
        }
      })
      .catch(function(){
        if(mine !== seq) return;
        paint("unknown", "Couldn't check right now \\u2014 you can still submit; the prefix is verified when your key is minted.");
        renderAlts([]);
      });
  }

  input.addEventListener("input", function(){
    clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  });
  check();
})();
`;
}

module.exports = { PIP_COMMAND, pinCurlCommand, pickerScript, jsString, BUILD_PIN_CURL_JS };
