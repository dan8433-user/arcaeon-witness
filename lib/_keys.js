// _keys.js — DYNAMICALLY ISSUED witness keys + Stripe-fulfillment bindings.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// WHY THIS EXISTS (2026-08-17, board item 25 — instant fulfillment): until
// now every witness key lived in the WITNESS_KEYS env var, hand-provisioned.
// An env var cannot be appended to by a serverless function at runtime, so
// self-serve purchase ("pay Stripe, get a key on the receipt page") requires
// a real key store. This is that store — the MINIMAL one, deliberately built
// on the exact same primitive every other stateful module here already uses:
// JSON files in the PRIVATE usage repo (dan8433-user/arcaeon-witness-usage),
// GitHub contents API, create-only / compare-and-swap writes. Nothing new to
// operate, same GITHUB_PIN_TOKEN, same audit-by-git-history property as
// _meter.js and _balance.js.
//
// Files this module owns (all in the PRIVATE usage repo — never the public
// pin repo; a raw key or a billing hash must never land in public git):
//
//   keys/<sha256(key)>.json          issued-key record: namespace prefix the
//                                    key may pin under, plan, org, pool_id.
//                                    api/pin.js + api/balance.js consult this
//                                    AFTER the WITNESS_KEYS env lookup misses,
//                                    so env-provisioned keys are untouched.
//   fulfillments/<session_id>.json   Stripe Checkout session -> key binding.
//                                    CREATE-ONLY: this file is the idempotency
//                                    gate that guarantees one session never
//                                    mints two keys. It stores the RAW key on
//                                    purpose — the whole point of the receipt
//                                    page is that revisiting it re-shows the
//                                    same key (Stripe's receipt email links
//                                    back to it), and you cannot re-show what
//                                    you only kept a hash of. The session URL
//                                    is already a bearer of the key by design,
//                                    so a private-repo copy adds no new
//                                    exposure class beyond what the product
//                                    promise itself requires.
//   pools/<pool_id>.json             credit-pool record (org/team schema,
//                                    baked in now, UI later — see below).
//
// ORG / POOL SCHEMA (schema now, UI later): every issued key carries
// `org` (nullable) and `pool_id`. Credits conceptually live on the POOL.
// For a solo purchase — the only flow wired today — the pool is a
// single-key pool whose `credit_account` IS the key's own sha256 hash, so
// the pool's balance file is exactly the balance/<key_hash>.json that
// api/_balance.js already reads and decrements: no change to the live
// billing path. TEAM FLOW (future): N issued-key records share one
// pool_id; the pool's credit_account becomes a pool-scoped identifier and
// api/pin.js's charge path resolves key -> issued-key record -> pool_id ->
// credit_account before calling decrementCredit, so N keys draw down one
// shared balance. That resolution hop is NOT built (solo pools don't need
// it); the fields exist now so no schema migration is needed when it is.

"use strict";

const { timedFetch } = require("./_fetch.js");

const crypto = require("crypto");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

// Stripe Checkout session ids are `cs_test_...` / `cs_live_...`, alphanumeric.
// Anchored + charset-limited so a session id is path-safe by construction —
// this is what lets fulfillments/<session_id>.json use the id verbatim with
// zero traversal risk, and it doubles as the first "faked URL" rejection.
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,240}$/;

// ---- store clients (2026-09-28, registration store split) ----
// storeClient(loc) binds the get/put/list trio below to ONE repo, branch and
// token. loc = {repo, branch, token: () => string|undefined, split}. The token
// is a function so the pin store keeps reading GITHUB_PIN_TOKEN per request,
// exactly as before this split.
function makeHeaders(tok) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-keys",
    "x-github-api-version": "2022-11-28",
  };
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// Same gh get/put pair as _meter.js/_balance.js. Duplicated rather than
// imported on purpose — each stateful module here carries its own copy so its
// error redaction and logging tag stay legible by inspection (the established
// house pattern; see _balance.js which did the same next to _meter.js).
async function clientGetFile(loc, path) {
  const r = await timedFetch(
    `${API}/repos/${loc.repo}/contents/${path}?ref=${loc.branch}`,
    { headers: makeHeaders(loc.token()) }
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    // Path redacted from thrown messages (2026-08-14 audit discipline):
    // callers interpolate err.message into response bodies, and these paths
    // name key hashes / session ids in a PRIVATE repo.
    console.error(`[keys] GET ${path} -> ${r.status}`);
    throw new Error(`key store read failed (${r.status})`);
  }
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

async function clientPutFile(loc, path, obj, message, sha) {
  const payload = {
    message,
    branch: loc.branch,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await timedFetch(`${API}/repos/${loc.repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...makeHeaders(loc.token()), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) {
    console.error(`[keys] PUT ${path} -> 409 sha conflict`);
    const err = new Error("key store write conflict (concurrent writer)");
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    // GitHub's create-race shape (two writers both tried to CREATE the same
    // not-yet-existing file) — same tagging idiom as _store/_meter/_balance.
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    console.error(`[keys] PUT ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
    const err = new Error(`key store write failed (${r.status})`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

function storeClient(loc) {
  return {
    repo: loc.repo,
    branch: loc.branch,
    split: loc.split === true,
    // Header set for modules that keep their own get/put copy (lib/_register.js,
    // lib/_meter.js) and only borrow this client's coordinates.
    headers: () => makeHeaders(loc.token()),
    getFile: (path) => clientGetFile(loc, path),
    putFile: (path, obj, message, sha) => clientPutFile(loc, path, obj, message, sha),
    listDir: (path) => clientListDir(loc, path),
  };
}

// The pin store: the private usage repo every paying pin's key, balance and
// meter files live in, on GITHUB_PIN_TOKEN. Unchanged by the split.
const PIN_STORE = storeClient({
  repo: USAGE_REPO,
  branch: USAGE_BRANCH,
  token: () => process.env.GITHUB_PIN_TOKEN,
  split: false,
});
function pinStore() {
  return PIN_STORE;
}

// registerStore() -> the store every REGISTRATION-owned file goes to
// (registrations/ and its _ip/_ipc/_domain/_sends/_tok/_timing subtrees,
// trial_namespaces/, fulfillments/reg-*, the registration pool record and the
// durable hour counter for register-sourced keys). Why: a signup spike must
// not spend the write budget GitHub gives GITHUB_PIN_TOKEN on the repo paying
// pins write to. Bound to REGISTER_STORE_REPO + REGISTER_STORE_TOKEN (+
// REGISTER_STORE_BRANCH, default "main") only when BOTH are set; otherwise it
// IS the pin store, so nothing changes until the env exists. Read per call.
// The issued-key record (keys/) and the credit balance (balance/, ledger/)
// stay in the pin store whatever this returns: api/pin.js reads them there.
function registerStore() {
  const repo = (process.env.REGISTER_STORE_REPO || "").trim();
  const tok = (process.env.REGISTER_STORE_TOKEN || "").trim();
  if (!repo || !tok) return PIN_STORE;
  return storeClient({
    repo,
    branch: (process.env.REGISTER_STORE_BRANCH || "").trim() || "main",
    token: () => tok,
    split: true,
  });
}

// Pin-store shorthands: every path in this module that is not registration-owned.
const getFile = (path) => PIN_STORE.getFile(path);
const putFile = (path, obj, message, sha) => PIN_STORE.putFile(path, obj, message, sha);
const listDir = (path) => PIN_STORE.listDir(path);

// Registration fulfillments are "reg-<emailHash>" (lib/_register.js
// fulfillId); a Stripe session id always matches SESSION_ID_RE (cs_...), so
// the id alone says which store owns the record.
function fulfillmentStore(sessionId) {
  return String(sessionId).startsWith("reg-") ? registerStore() : PIN_STORE;
}

// ---- minting ----
// wk_ prefix so an issued key is recognizable in support conversations
// without revealing anything; 24 random bytes = 192 bits, hex-encoded.
function mintKey() {
  return "wk_" + crypto.randomBytes(24).toString("hex");
}

// The namespace prefix an issued key may pin under. Random and DERIVED FROM
// NOTHING — deliberately not a slice of the key hash: sha256(key) is the
// billing identifier (client_reference_id, balance file names) and the public
// pin repo must never carry any recognizable piece of it (_store.js's
// OWNER_ID_DOMAIN comment states the rule). Matches _store.NS_RE by
// construction ([a-z0-9-], well under 64 chars, leaving the buyer room for a
// suffix like "prod" or "agent-7").
function mintNamespacePrefix() {
  return `wk-${crypto.randomBytes(6).toString("hex")}-`;
}

// TRIAL prefix (2026-09-27, pricing council anti-abuse control 5). A key
// minted by REGISTRATION (source "register") gets "trial-<8 hex>-" instead of
// the random wk-... one, so a free key is recognisable on the public status
// page and in the pin repo as what it is. Same construction rules as
// mintNamespacePrefix: random, derived from nothing, trailing dash, matches
// _store.NS_RE. A prefix is a NAME, not a tier: a trial key that later buys a
// pack keeps it (renaming would orphan its pins), and nothing reads the stem
// to decide what a key may do. The cap below reads the key RECORD's source and
// the balance file's purchased flag, never the prefix.
// Collision odds: 32 bits, so two registrations share a prefix with
// probability about n^2 / 2^33 (about 1 in 8,600 at 1,000 keys). Not checked
// against listPrefixes here, same as the wk- mint.
function mintTrialNamespacePrefix() {
  return `trial-${crypto.randomBytes(4).toString("hex")}-`;
}
const TRIAL_PREFIX_RE = /^trial-[0-9a-f]{8}-$/;

// A registration key may pin under at most this many DISTINCT namespaces
// until it makes a real purchase. The trial prefix alone does not bound
// namespaces (a key pins every namespace starting with its prefix), and every
// namespace is a directory of public commits: without a cap one free key can
// mint an unbounded number of public logs.
const TRIAL_NAMESPACE_CAP = 3;

function mintPoolId() {
  return `pool_${crypto.randomBytes(8).toString("hex")}`;
}

// ---- prefix picking (rev-2, board item 27) ----
// A buyer may now CHOOSE the namespace prefix at mint time instead of taking
// the random wk-… one. The prefix is an AUTHORIZATION boundary — a key pins
// every namespace starting with its prefix — so two rules are load-bearing:
//
//   1. FORMAT: lowercase [a-z0-9-], starts alphanumeric, ends in '-', ≤48
//      chars total (leaves ≥16 chars of namespace room under _store.NS_RE's
//      64). The trailing dash is required so "acme-" can never accidentally
//      startsWith-match an unrelated namespace like "acmecorp-main".
//   2. NO TWO-WAY OVERLAP with any existing prefix: a new prefix must neither
//      BE a prefix of an existing one nor HAVE an existing one as its prefix
//      ("acme-" vs "acme-labs-" is rejected in BOTH directions). Overlapping
//      prefixes would let two different customers' keys pin into each other's
//      namespaces — that is the harm this check exists to prevent.
//
// "wk-" is RESERVED for auto-minted prefixes: a customer who claimed "wk-"
// (or any wk-… stem) could otherwise sit upstream of every random mint that
// follows, so the whole stem is refused to custom pickers outright.
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,46}-$/;

// RESERVED_BRAND_STEMS — the operator's own brand namespaces (2026-09-20,
// second-model review). Before this, a customer could claim "velouria-x" or
// "arcaeon-x" (only "wk-" was reserved), which did two bad things at once:
// (a) lib/_status_data.js's isReferenceNamespace() tags any "velouria-"/
// "arcaeon-" namespace as "our own log" on the PUBLIC status page, so a
// paying customer's row would be mislabelled as the operator's; and (b) it
// let a customer squat the operator's brand stem outright, same class of
// harm as an unreserved "wk-" would have been.
//
// SINGLE SOURCE OF TRUTH: this array is the only place these stems are
// spelled out. lib/_status_data.js's REFERENCE_PREFIXES is DERIVED from it
// (never a separate literal) so the claim-time refusal and the status
// page's "reference" tag can never drift apart — a stem reserved here is
// always a stem the page calls ours, and vice versa.
//
// Matching mirrors the "wk-" check exactly: a bare stem or the stem plus a
// trailing dash plus anything ("velouria-", "velouria-x", …) is refused; a
// stem merely APPEARING inside a longer, differently-rooted prefix
// ("acme-velouria-mirror-", "myarcaeon-x-") is not — same startsWith
// discipline PREFIX overlap already uses elsewhere in this file.
const RESERVED_BRAND_STEMS = ["velouria", "arcaeon"];

function validatePrefix(p) {
  if (typeof p !== "string" || p.length === 0) {
    return { ok: false, reason: "empty", detail: "prefix is empty" };
  }
  if (!PREFIX_RE.test(p)) {
    return {
      ok: false,
      reason: "format",
      detail:
        "prefix must be lowercase [a-z0-9-], start with a letter or digit, " +
        "end in '-', and be at most 48 characters",
    };
  }
  if (p.startsWith("wk-")) {
    return {
      ok: false,
      reason: "reserved",
      detail: "the wk- stem is reserved for auto-minted prefixes",
    };
  }
  // Same reasoning as wk-: a buyer holding "trial-" would sit upstream of
  // every registration prefix minted after it.
  if (p.startsWith("trial-")) {
    return {
      ok: false,
      reason: "reserved",
      detail: "the trial- stem is reserved for registration keys",
    };
  }
  for (const stem of RESERVED_BRAND_STEMS) {
    if (p.startsWith(`${stem}-`)) {
      return {
        ok: false,
        reason: "reserved",
        detail: `the ${stem}- stem is reserved for the operator's own namespaces`,
      };
    }
  }
  return { ok: true };
}

// Two-way overlap check. Returns true if the candidate collides with ANY
// existing prefix (equal, contains, or is contained by). The caller never
// echoes WHICH prefix collided — existing prefixes belong to other customers.
function prefixConflicts(candidate, existingPrefixes) {
  for (const ex of existingPrefixes || []) {
    if (!ex) continue;
    if (candidate.startsWith(ex) || ex.startsWith(candidate)) return true;
  }
  return false;
}

// Pre-suggest a prefix from what Stripe already knows about the buyer: the
// email local part first ("jane.doe@acme.com" -> "jane-doe-"), else the
// customer name/company. Returns a VALID prefix string or null — a suggestion
// that fails validatePrefix (e.g. sanitizes to nothing, or lands on the
// reserved wk- stem) is dropped rather than repaired into surprise.
function suggestPrefix(email, name) {
  const candidates = [];
  if (email && typeof email === "string" && email.includes("@")) {
    candidates.push(email.split("@")[0]);
  }
  if (name && typeof name === "string") candidates.push(name);
  for (const raw of candidates) {
    const base = String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "");
    if (!base) continue;
    const p = `${base}-`;
    if (validatePrefix(p).ok) return p;
  }
  return null;
}

// Prefixes already bound in the WITNESS_KEYS env var ("key:prefix" pairs,
// comma-separated — same format _store.keyPrefixFor consumes). Env keys are
// hand-provisioned, but their prefixes are just as much authorization
// boundaries as issued-store ones, so the overlap check must see them.
function envKeyPrefixes() {
  const raw = process.env.WITNESS_KEYS || "";
  const out = [];
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const prefix = pair.slice(i + 1).trim();
    if (prefix) out.push(prefix);
  }
  return out;
}

// GitHub contents API directory listing (array of entries; 404 = no dir yet,
// which is simply "no issued keys yet" -> empty). NOTE the API caps a
// directory listing at 1000 entries; combined with the one-read-per-key fan
// out below, this listing approach is deliberately the CHEAP version for the
// current scale (self-serve keys number in the tens). When key volume ever
// approaches that cap, replace with a maintained prefix-index file — do NOT
// silently validate against a truncated list.
async function clientListDir(loc, path) {
  const r = await timedFetch(
    `${API}/repos/${loc.repo}/contents/${path}?ref=${loc.branch}`,
    { headers: makeHeaders(loc.token()) }
  );
  if (r.status === 404) return [];
  if (!r.ok) {
    console.error(`[keys] LIST ${path} -> ${r.status}`);
    throw new Error(`key store list failed (${r.status})`);
  }
  const body = await r.json();
  // [] only via the 404 above: a 200 that is not a listing must not read as
  // "no prefixes are spoken for" (lib/_verdict.js).
  return require("./_verdict.js").requireListing(body, `key store list ${path}`).map((e) => e.name);
}

// Every prefix currently spoken for: env WITNESS_KEYS bindings + every
// issued-key record in the store. Revoked keys KEEP their prefix reserved —
// a revoked key may be un-revoked, and freeing its prefix would let a new
// customer sit on top of its historical pins.
async function listPrefixes() {
  const out = new Set(envKeyPrefixes());
  const names = await listDir("keys");
  const reads = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => getFile(`keys/${n}`));
  for (const rec of await Promise.all(reads)) {
    const p =
      rec && rec.json && typeof rec.json.namespace_prefix === "string"
        ? rec.json.namespace_prefix.trim()
        : "";
    if (p) out.add(p);
  }
  return [...out];
}

function keyHash(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

// ---- paths ----
function issuedKeyPath(hash) {
  return `keys/${hash}.json`;
}
function poolPath(poolId) {
  return `pools/${poolId}.json`;
}
function fulfillmentPath(sessionId) {
  return `fulfillments/${sessionId}.json`;
}
function trialNamespacesPath(hash) {
  return `trial_namespaces/${hash}.json`;
}

// ---- trial namespace cap (2026-09-27, council anti-abuse control 5) ----
// claimTrialNamespace(hash, namespace, isPurchased) ->
//   {ok:true, namespaces, wrote}                     allowed
//   {ok:false, reason:"namespace_cap", cap, namespaces} refused
// The durable list lives in a SIBLING file of the key record,
// trial_namespaces/<key hash>.json (private usage repo), not in the key record
// itself: the key record is create-only by design and every other reader of it
// stays untouched. Written by CAS (sha on update, create-only on first write),
// so two concurrent pins under two new namespaces cannot both land a 4th: the
// loser re-reads and is judged against the winner's list.
//   - a namespace already on the list: allowed, no write;
//   - fewer than the cap: appended, then allowed;
//   - at the cap: isPurchased() is asked (one balance read, only here), and a
//     key that has bought is allowed without a write. It keeps its prefix.
// A store error throws; the caller fails closed. A slot is spent when the
// claim lands, before the pin's own write, so a pin that later fails keeps
// its namespace on the list (the namespace is the key's either way).
async function claimTrialNamespace(hash, namespace, isPurchased) {
  const path = trialNamespacesPath(hash);
  const rs = registerStore(); // registration-owned file (split 2026-09-28)
  let lastErr = null;
  // cap + 3 attempts: with N racing writers each round lands one, so the
  // cap-th loser still gets a final read that judges it (403, not 503).
  for (let attempt = 0; attempt < TRIAL_NAMESPACE_CAP + 3; attempt++) {
    const cur = await rs.getFile(path);
    const list = cur && cur.json && Array.isArray(cur.json.namespaces)
      ? cur.json.namespaces.filter((n) => typeof n === "string")
      : [];
    if (cur && (!cur.json || !Array.isArray(cur.json.namespaces))) {
      // Present but unreadable: never read a damaged file as "no namespaces yet".
      throw new Error("trial namespace record unreadable");
    }
    if (list.includes(namespace)) return { ok: true, namespaces: list, wrote: false };
    if (list.length >= TRIAL_NAMESPACE_CAP) {
      if (await isPurchased()) return { ok: true, namespaces: list, wrote: false };
      return { ok: false, reason: "namespace_cap", cap: TRIAL_NAMESPACE_CAP, namespaces: list };
    }
    const next = {
      key_id: hash.slice(0, 12),
      cap: TRIAL_NAMESPACE_CAP,
      namespaces: [...list, namespace],
      updated_at: new Date().toISOString(),
    };
    try {
      await rs.putFile(path, next, `trial ns ${hash.slice(0, 12)} +1 (${next.namespaces.length}/${TRIAL_NAMESPACE_CAP})`, cur ? cur.sha : undefined);
      return { ok: true, namespaces: next.namespaces, wrote: true };
    } catch (err) {
      if (!err.conflict) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("trial namespace record: exhausted CAS retries");
}

// ---- issued-key auth resolution ----
// The dynamic half of what _store.keyPrefixFor does for env keys. Returns the
// key's namespace prefix (string) or null for an unknown/revoked key. Callers
// (pin.js, balance.js) try the env lookup FIRST — it's free and covers every
// hand-provisioned key — and only reach here on a miss, so env-key requests
// cost zero extra store reads. Fails CLOSED on a malformed record: a key file
// without a usable prefix authorizes nothing.
// issuedKeyRecord(secret) -> {prefix, plan, source} | null. Same read and same
// refusals as issuedKeyPrefix; it also hands back the record's plan and source
// so a caller can meter a "grant" key, and api/pin.js can apply the durable
// hour counter to registration keys (source "register") only, without a
// second store read (2026-09-27). The plan is a HINT: lib/_meter.js only
// honours "grant" from a record, and WITNESS_PLANS still wins.
async function issuedKeyRecord(secret) {
  if (!secret) return null;
  const rec = await getFile(issuedKeyPath(keyHash(secret)));
  if (!rec) return null;
  if (rec.json && rec.json.revoked === true) return null;
  const prefix = rec.json && typeof rec.json.namespace_prefix === "string"
    ? rec.json.namespace_prefix.trim()
    : "";
  // Same empty-prefix refusal as _store.keyPrefixFor: "" would startsWith-match
  // every namespace, and a malformed record must never widen authorization.
  if (!prefix) return null;
  const plan = typeof rec.json.plan === "string" ? rec.json.plan : null;
  const source = typeof rec.json.source === "string" ? rec.json.source : null;
  return { prefix, plan, source };
}

// The issued-key record by key HASH (no raw key needed), or null. Used by
// api/fulfill.js to report the plan a revisited session's key actually has.
async function readIssuedKey(hash) {
  const rec = await getFile(issuedKeyPath(hash));
  return rec ? rec.json : null;
}

async function issuedKeyPrefix(secret) {
  const r = await issuedKeyRecord(secret);
  return r ? r.prefix : null;
}

// ---- fulfillment binding (the session -> key idempotency record) ----
async function readFulfillment(sessionId) {
  return fulfillmentStore(sessionId).getFile(fulfillmentPath(sessionId));
}

// Create-only. Returns {created:true, record} if this call won the slot, or
// {created:false, record} with the WINNER's record if a concurrent visit (or a
// prior one) already bound this session — the caller must then serve the
// winner's key and throw its own freshly-minted one away (never minted twice
// for one session, even under a race: the create-only CAS is the guarantee).
async function createFulfillment(sessionId, record) {
  const fs = fulfillmentStore(sessionId);
  try {
    await fs.putFile(
      fulfillmentPath(sessionId),
      record,
      `fulfill ${sessionId.slice(0, 24)} pack=${record.pack}`
    );
    return { created: true, record };
  } catch (err) {
    if (!err.conflict) throw err;
    const cur = await fs.getFile(fulfillmentPath(sessionId));
    if (!cur) throw err; // conflict but nothing readable — surface the error
    return { created: false, record: cur.json };
  }
}

// Small CAS update loop for mutating an existing fulfillment record (consent
// capture). Best-effort semantics decided by the caller; this just does the
// read-modify-write honestly. Returns the updated record.
async function updateFulfillment(sessionId, mutate) {
  const fs = fulfillmentStore(sessionId);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await fs.getFile(fulfillmentPath(sessionId));
    if (!cur) return null;
    const next = mutate({ ...cur.json });
    try {
      await fs.putFile(
        fulfillmentPath(sessionId),
        next,
        `fulfill update ${sessionId.slice(0, 24)}`,
        cur.sha
      );
      return next;
    } catch (err) {
      if (err.conflict && attempt === 0) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("key store: exhausted CAS retries on fulfillment update");
}

// Create-only writes for the key + pool records. A conflict here means a
// concurrent request for the SAME session already wrote them (both derive from
// the same fulfillment record), so it is idempotent success, not an error.
async function writeIssuedKey(record) {
  try {
    await putFile(
      issuedKeyPath(record.key_hash),
      record,
      `issue key ${record.key_hash.slice(0, 12)} (${record.source})`
    );
  } catch (err) {
    if (!err.conflict) throw err;
  }
}

// opts.registration: a registration key's pool record goes to the register
// store (nothing reads pools/ today; api/pin.js resolves nothing through it).
async function writePool(record, opts) {
  const ps = opts && opts.registration === true ? registerStore() : PIN_STORE;
  try {
    await ps.putFile(poolPath(record.pool_id), record, `pool ${record.pool_id}`);
  } catch (err) {
    if (!err.conflict) throw err;
  }
}

module.exports = {
  SESSION_ID_RE,
  PREFIX_RE,
  RESERVED_BRAND_STEMS,
  mintKey,
  mintNamespacePrefix,
  mintTrialNamespacePrefix,
  TRIAL_PREFIX_RE,
  TRIAL_NAMESPACE_CAP,
  trialNamespacesPath,
  claimTrialNamespace,
  mintPoolId,
  validatePrefix,
  prefixConflicts,
  suggestPrefix,
  envKeyPrefixes,
  listPrefixes,
  keyHash,
  issuedKeyPath,
  poolPath,
  fulfillmentPath,
  issuedKeyPrefix,
  issuedKeyRecord,
  readIssuedKey,
  readFulfillment,
  createFulfillment,
  updateFulfillment,
  writeIssuedKey,
  writePool,
  USAGE_REPO,
  USAGE_BRANCH,
  pinStore,
  registerStore,
  // exported for tests:
  getFile,
};
