// POST /api/pin — record a head fingerprint as a commit in the public pin repo.
//
// Auth: Authorization: Bearer <key>; the key's namespace-prefix (from
// WITNESS_KEYS) must prefix the requested namespace.
// Body: {namespace, rows, chain}. Fingerprints only — no log content, ever.
// Monotonic guard: a witness never goes backward; rows < current latest -> 409.

"use strict";

const store = require("./_store.js");

// Naive per-key rate limit (Stage-0): per-instance, resets on cold start.
const RATE_LIMIT = 60; // pins per key per hour, per warm instance
const rateBuckets = new Map(); // key -> {windowStart, count}

function rateLimited(key) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now - b.windowStart > 3600_000) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  // --- auth ---
  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const prefix = key ? store.keyPrefixFor(key) : null;
  if (prefix === null) {
    return res.status(401).json({ error: "invalid or missing bearer key" });
  }

  // --- validate ---
  const body = typeof req.body === "object" ? req.body : null;
  const bad = store.validatePin(body);
  if (bad) return res.status(400).json({ error: bad });

  const { namespace, rows, chain } = body;
  if (!namespace.startsWith(prefix)) {
    return res.status(403).json({
      error: `this key may only pin namespaces starting with "${prefix}"`,
    });
  }

  if (rateLimited(key)) {
    return res.status(429).json({ error: "rate limit exceeded (naive Stage-0 limiter)" });
  }

  try {
    // --- monotonic guard: read the current latest pin ---
    const latestPath = `pins/${namespace}/latest.json`;
    const cur = await store.getFile(latestPath);
    if (cur && Number.isInteger(cur.json.rows) && rows < cur.json.rows) {
      return res.status(409).json({
        error: "monotonic violation: a witness never goes backward",
        latest_rows: cur.json.rows,
        submitted_rows: rows,
      });
    }

    const seq = cur && Number.isInteger(cur.json.seq) ? cur.json.seq + 1 : 1;
    const pin = {
      namespace,
      rows,
      chain: chain.toLowerCase(),
      pinned_at: new Date().toISOString(), // the witness's OWN clock
      seq,
    };

    // --- commit the pin, then update latest.json (2 commits, Stage-0) ---
    const seqName = String(seq).padStart(8, "0");
    const msg = `pin ${namespace} rows=${rows} seq=${seq}`;
    const put = await store.putFile(`pins/${namespace}/${seqName}.json`, pin, msg);
    await store.putFile(latestPath, pin, `latest ${namespace} rows=${rows} seq=${seq}`,
      cur ? cur.sha : undefined);

    return res.status(201).json({
      ok: true,
      pin,
      commit: put.commit && put.commit.sha,
      public_record: `https://github.com/${store.REPO}/commits/${store.BRANCH}/pins/${namespace}`,
    });
  } catch (err) {
    return res.status(502).json({ error: `pin store error: ${err.message}` });
  }
};
