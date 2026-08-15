// POST /api/pin — record a head fingerprint as a commit in the public pin repo.
//
// Auth: Authorization: Bearer <key>; the key's namespace-prefix (from
// WITNESS_KEYS) must prefix the requested namespace.
// Body: {namespace, rows, chain, intent?}. Fingerprints only — no log content, ever.
// Monotonic guard: a witness never goes backward; rows < current latest -> 409.
//
// intent:"renew" (also reachable as POST /api/renew, which just sets it) is the
// publisher-heartbeat path: restate the CURRENT head exactly and the cadence
// deadline is refreshed without claiming the content moved. It runs inside the
// same-rows/same-chain branch on purpose — a renewal can never take the
// conflict path's place, and it can never stand in for an advance.

"use strict";

const store = require("./_store.js");
const meter = require("./_meter.js");
const balance = require("./_balance.js");

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

  // Unknown intents fail CLOSED. A typo'd intent must never silently fall
  // through to the plain-pin path and get read later as a renewal that worked.
  const intent =
    body.intent === undefined || body.intent === null ? null : String(body.intent).toLowerCase();
  if (intent !== null && intent !== "renew") {
    return res.status(400).json({
      error: `unknown intent "${body.intent}" — the only supported intent is "renew"`,
      reason: "unknown_intent",
    });
  }

  if (!namespace.startsWith(prefix)) {
    return res.status(403).json({
      error: `this key may only pin namespaces starting with "${prefix}"`,
    });
  }

  if (rateLimited(key)) {
    return res.status(429).json({ error: "rate limit exceeded (naive Stage-0 limiter)" });
  }

  // --- metering (free-tier caps, native reimpl of arcaeon-meter — api/_meter.js) ---
  let m;
  try {
    m = await meter.check(key);
  } catch (err) {
    return res.status(502).json({ error: `metering store error: ${err.message}` });
  }
  res.setHeader("X-Meter-Cap", m.cap === null || m.cap === undefined ? "unlimited" : String(m.cap));
  if (m.used !== null && m.used !== undefined) {
    res.setHeader("X-Meter-Used", String(m.used));
  }
  if (!m.ok) {
    if (m.reason === "over_cap") {
      // Free-tier monthly cap is spent. Purchased credit balance
      // (api/_balance.js) is the additive overflow pool on top of it
      // (COUNCIL_PRICING_REVIEW_2026-08-14 §4 decision #5) — nothing above
      // this line changed: the free 100/mo default still behaves exactly
      // as before for a key that never bought credits. This branch only
      // decides what happens once the free allotment is exhausted.
      let c;
      try {
        c = await balance.decrementCredit(key, `over free cap ${m.month}`);
      } catch (err) {
        return res.status(502).json({ error: `credit store error: ${err.message}` });
      }
      if (c.ok) {
        res.setHeader("X-Credit-Balance", String(c.balance));
        res.setHeader("X-Meter-Source", "credit");
        // fall through — the pin proceeds below using the credit grant.
      } else if (c.ever_purchased) {
        // Bought credits before; balance is genuinely at zero now.
        // "Insufficient funds," not "never had an account" — fails
        // CLOSED, same as every other denial path here.
        return res.status(402).json({
          error: "credit balance exhausted — top up to continue",
          reason: "credit_exhausted",
          credit_balance: 0,
          plan: m.plan,
          free_tier_used: m.used,
          free_tier_cap: m.cap,
          month: m.month,
          packs: balance.PACKS,
        });
      } else {
        // Never purchased credits — same fail-closed outcome this key
        // would have hit before this build; pack info is added so the
        // denial doubles as an honest upsell (the free path itself is
        // unchanged, so this isn't a bait-and-switch on existing users).
        return res.status(429).json({
          error: "monthly pin cap reached",
          reason: "over_cap",
          plan: m.plan,
          used: m.used,
          cap: m.cap,
          month: m.month,
          top_up_available: true,
          packs: balance.PACKS,
        });
      }
    } else {
      // no_cap_configured: fails CLOSED — a key with no resolvable cap is
      // denied, never silently treated as unlimited. Credits do not
      // override a misconfigured account: this is an operator-config bug,
      // not a usage-exhaustion state, and the two shouldn't be conflated.
      return res.status(401).json({
        error: "no usage cap configured for this key",
        reason: "no_cap_configured",
      });
    }
  }

  try {
    // --- monotonic guard: read the current latest pin ---
    const latestPath = `pins/${namespace}/latest.json`;
    const cur = await store.getFile(latestPath);

    // --- renewal preconditions: a renewal may only ever RESTATE the head ---
    if (intent === "renew") {
      if (!cur) {
        return res.status(404).json({
          error: `nothing to renew: no pin recorded for namespace "${namespace}"`,
          reason: "no_head_to_renew",
          note: "renewal refreshes an existing head's deadline; POST /api/pin first",
        });
      }
      if (!Number.isInteger(cur.json.rows) || rows !== cur.json.rows) {
        return res.status(409).json({
          error: "renewal must restate the current head exactly (same rows, same chain)",
          reason: "renewal_head_mismatch",
          latest_rows: cur.json.rows,
          submitted_rows: rows,
          note: "to advance content, POST /api/pin with the new head and NO renew intent — a renewal can never record an advance",
        });
      }
    }

    if (cur && Number.isInteger(cur.json.rows) && rows < cur.json.rows) {
      return res.status(409).json({
        error: "monotonic violation: a witness never goes backward",
        latest_rows: cur.json.rows,
        submitted_rows: rows,
      });
    }

    // Same-length re-mint guard (reticuli's missing typed case, excelsior's
    // two-ledger design, 2026-08-14): equal rows + identical chain is an
    // idempotent re-pin; equal rows + DIFFERENT chain never advances accepted
    // state — it lands in an append-only observation log and returns a typed
    // conflict, so detection can't itself poison the namespace.
    if (cur && Number.isInteger(cur.json.rows) && rows === cur.json.rows) {
      if (chain.toLowerCase() === String(cur.json.chain).toLowerCase()) {
        if (intent !== "renew") {
          // Unchanged behavior: a bare re-pin is idempotent and does NOT move
          // the deadline. Refreshing a deadline has to be asked for out loud.
          return res.status(200).json({
            ok: true,
            note: "already witnessed (idempotent re-pin) — no renewal intent, deadline unchanged",
            pin: cur.json,
            hint: 'to refresh next_pin_due_by without new rows, POST /api/renew (or add "intent":"renew") — it is recorded as a publisher heartbeat, never as a content advance',
          });
        }

        // --- renewal (excelsior's invariants; see _store.appendInterval) ---
        const prev = cur.json;
        const renewedAt = new Date();
        const cadenceHours = store.resolveCadenceHours(namespace);
        const dueBy = new Date(renewedAt.getTime() + cadenceHours * 3600_000).toISOString();
        const seq = Number.isInteger(prev.seq) ? prev.seq + 1 : 1;
        const hist = store.appendInterval(prev, {
          now: renewedAt, seq, cadenceHours, dueBy, kind: "publisher_heartbeat",
        });

        const renewal = {
          namespace,
          rows,
          chain: chain.toLowerCase(),
          pinned_at: renewedAt.toISOString(), // when THIS record was written (witness clock)
          seq,
          cadence_hours: cadenceHours,
          next_pin_due_by: dueBy,
          // The typed distinction that stops a heartbeat reading as an advance.
          record_kind: "publisher_heartbeat",
          // When this exact (rows, chain) head was FIRST witnessed. Renewals
          // never move it — that's the number that exposes a log which has
          // been "kept current" for months without producing a single row.
          head_first_seen_at: prev.head_first_seen_at || prev.pinned_at || null,
          renewals_since_advance:
            (Number.isInteger(prev.renewals_since_advance) ? prev.renewals_since_advance : 0) + 1,
          renewals_total: (Number.isInteger(prev.renewals_total) ? prev.renewals_total : 0) + 1,
          auth_level: store.AUTH_LEVEL,
          auth_note: store.AUTH_LEVEL_NOTE,
          ...hist.fields,
        };

        const seqName = String(seq).padStart(8, "0");
        const put = await store.putFile(
          `pins/${namespace}/${seqName}.json`, renewal,
          `renew ${namespace} rows=${rows} seq=${seq} (publisher heartbeat, content unchanged)`
        );
        await store.putFile(latestPath, renewal,
          `latest ${namespace} rows=${rows} seq=${seq} (heartbeat)`, cur.sha);

        return res.status(201).json({
          ok: true,
          renewed: true,
          record_kind: "publisher_heartbeat",
          note: "deadline refreshed as a publisher heartbeat — content head did NOT advance",
          next_pin_due_by: dueBy,
          interval_appended: hist.interval,
          superseded_deadline_was_missed: hist.wasOverdue,
          missed_due_at: renewal.missed_due_at || null,
          missed_deadline_count: renewal.missed_deadline_count,
          auth_level: store.AUTH_LEVEL,
          auth_note: store.AUTH_LEVEL_NOTE,
          pin: renewal,
          commit: put.commit && put.commit.sha,
          public_record: `https://github.com/${store.REPO}/commits/${store.BRANCH}/pins/${namespace}`,
        });
      }
      const obs = {
        observed_at: new Date().toISOString(),
        claimed: { namespace, rows, chain: chain.toLowerCase() },
        accepted_head: { rows: cur.json.rows, chain: cur.json.chain, seq: cur.json.seq },
        auth_result: "key-valid-for-namespace",
        verdict: "head-conflict: same rows, different chain (re-mint signature)",
      };
      const obsName = obs.observed_at.replace(/[:.]/g, "-");
      await store.putFile(`observations/${namespace}/${obsName}.json`, obs,
        `OBSERVATION head-conflict ${namespace} rows=${rows}`);
      return res.status(409).json({
        error: "head-conflict: same rows, different chain — recorded as observation; accepted head unchanged",
        accepted_head: obs.accepted_head,
        observation: `observations/${namespace}/${obsName}.json`,
      });
    }

    const seq = cur && Number.isInteger(cur.json.seq) ? cur.json.seq + 1 : 1;
    const pinnedAt = new Date();
    const cadenceHours = store.resolveCadenceHours(namespace);
    const dueBy = new Date(pinnedAt.getTime() + cadenceHours * 3600_000).toISOString();
    // Same append-only history the renewal path uses. An ADVANCE doesn't get to
    // erase a missed deadline either: if the head moves after the window
    // closed, the miss is recorded here exactly as a renewal would record it.
    const hist = store.appendInterval(cur ? cur.json : null, {
      now: pinnedAt, seq, cadenceHours, dueBy, kind: "content_head_advance",
    });
    const pin = {
      namespace,
      rows,
      chain: chain.toLowerCase(),
      pinned_at: pinnedAt.toISOString(), // the witness's OWN clock
      seq,
      // Cadence deadline (excelsior's review): a promise, not a proof —
      // makes a missed cadence VISIBLE to a stranger polling /api/latest,
      // does not by itself prove tampering. See _store.resolveCadenceHours.
      cadence_hours: cadenceHours,
      next_pin_due_by: dueBy,
      record_kind: "content_head_advance",
      head_first_seen_at: pinnedAt.toISOString(),
      renewals_since_advance: 0, // reset: the head actually moved
      renewals_total: cur && Number.isInteger(cur.json.renewals_total) ? cur.json.renewals_total : 0,
      auth_level: store.AUTH_LEVEL,
      auth_note: store.AUTH_LEVEL_NOTE,
      ...hist.fields,
    };

    // --- commit the pin, then update latest.json (2 commits, Stage-0) ---
    const seqName = String(seq).padStart(8, "0");
    const msg = `pin ${namespace} rows=${rows} seq=${seq}`;
    const put = await store.putFile(`pins/${namespace}/${seqName}.json`, pin, msg);
    await store.putFile(latestPath, pin, `latest ${namespace} rows=${rows} seq=${seq}`,
      cur ? cur.sha : undefined);

    return res.status(201).json({
      ok: true,
      record_kind: "content_head_advance",
      auth_level: store.AUTH_LEVEL,
      auth_note: store.AUTH_LEVEL_NOTE,
      pin,
      commit: put.commit && put.commit.sha,
      public_record: `https://github.com/${store.REPO}/commits/${store.BRANCH}/pins/${namespace}`,
    });
  } catch (err) {
    return res.status(502).json({ error: `pin store error: ${err.message}` });
  }
};
