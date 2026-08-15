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

// Write the numbered, immutable seq record. Create-only on purpose: a record
// in the public log is never overwritten.
//
// If the slot is already taken, that is NOT a generic store error and must not
// be reported as one (2026-08-14 audit). It means one specific, reproducible
// thing: a previous write committed the seq record (api/pin.js's first commit)
// and then FAILED to update latest.json (the second commit) — a function
// timeout or a transient GitHub error in the gap between two non-atomic
// commits. latest.json is left one behind, so every later pin recomputes the
// SAME seq, collides with the orphan, and 502s. The namespace is wedged, and
// it stays wedged until someone repairs it by hand.
//
// This helper does not repair it — it raises a typed, named `wedged` error
// carrying the orphan's seq, so the failure never masquerades as a transient
// upstream blip. The REPAIR (adopting a VERIFIED orphan into latest.json) lives
// in the handler's healIfWedged path below (2026-08-14 billing/race fix, the
// escalation the audit flagged): a record is only adopted when it verifies as
// the legitimate immediate successor of the current head, else it keeps failing
// typed rather than risk laundering a corrupt record into an append-only log.
async function putSeqRecord(namespace, seqName, record, message) {
  try {
    return await store.putFile(`pins/${namespace}/${seqName}.json`, record, message);
  } catch (err) {
    if (err && err.conflict) {
      const wedged = new Error("seq record slot already occupied");
      wedged.wedged = true;
      wedged.seqName = seqName;
      throw wedged;
    }
    throw err;
  }
}

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

// ---- metering + credit charge (2026-08-14 billing/race fix) ----
// A pin is charged — a free-tier meter increment, or a credit decrement once
// the free cap is spent — ONLY on a path that actually records a write. Every
// rejection (monotonic violation, head-conflict, renewal precondition, a wedged
// namespace) and the idempotent no-op re-pin all return BEFORE this runs, so a
// pin that records nothing burns nothing. (Audit: this used to run at the top
// of the handler, so a 409-rejected pin incremented the meter and, over the
// free cap, decremented a real credit — charging for a write that never
// happened.) Touches ONLY the meter/credit stores, never the pin store.
//
// Returns exactly one of:
//   { ok:true, source, headers }        -> proceed to the write
//   { deny:{status,body}, headers }     -> caller must return this response
async function meterAndCharge(key) {
  let m;
  try {
    m = await meter.check(key);
  } catch (err) {
    return { deny: { status: 502, body: { error: `metering store error: ${err.message}` } }, headers: {} };
  }
  const headers = {
    "X-Meter-Cap": m.cap === null || m.cap === undefined ? "unlimited" : String(m.cap),
  };
  if (m.used !== null && m.used !== undefined) headers["X-Meter-Used"] = String(m.used);

  if (m.ok) return { ok: true, source: "free", headers };

  if (m.reason === "over_cap") {
    let c;
    try {
      c = await balance.decrementCredit(key, `over free cap ${m.month}`);
    } catch (err) {
      return { deny: { status: 502, body: { error: `credit store error: ${err.message}` } }, headers };
    }
    if (c.ok) {
      headers["X-Credit-Balance"] = String(c.balance);
      headers["X-Meter-Source"] = "credit";
      return { ok: true, source: "credit", headers };
    }
    if (c.ever_purchased) {
      return {
        deny: {
          status: 402,
          body: {
            error: "credit balance exhausted — top up to continue",
            reason: "credit_exhausted",
            credit_balance: 0,
            plan: m.plan, free_tier_used: m.used, free_tier_cap: m.cap, month: m.month,
            packs: balance.PACKS,
          },
        },
        headers,
      };
    }
    return {
      deny: {
        status: 429,
        body: {
          error: "monthly pin cap reached",
          reason: "over_cap",
          plan: m.plan, used: m.used, cap: m.cap, month: m.month,
          top_up_available: true, packs: balance.PACKS,
        },
      },
      headers,
    };
  }

  // no_cap_configured: fails CLOSED — a key with no resolvable cap is denied,
  // never silently treated as unlimited. Credits do not override a misconfigured
  // account: an operator-config bug, not a usage-exhaustion state.
  return {
    deny: {
      status: 401,
      body: { error: "no usage cap configured for this key", reason: "no_cap_configured" },
    },
    headers,
  };
}

function applyHeaders(res, headers) {
  if (!headers) return;
  for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
}

// ---- orphaned-seq self-heal (2026-08-14 repair — the escalation the audit flagged) ----
// A pin is two non-atomic commits: the numbered seq record, then latest.json.
// If the first lands and the second doesn't, latest.json sits one behind and
// every later pin recomputes the same seq, collides, and 502s forever — the
// namespace is wedged. The audit shipped DETECTION (typed 409); this is the
// REPAIR the code comments always promised.
//
// Adopting a record into an append-only public log on an error path is only
// safe for a record that VERIFIES as the legitimate immediate successor of the
// current head. Everything else keeps failing typed rather than launder a
// corrupt or unrelated record into the head.
function verifyOrphanSuccessor(orphan, cur, namespace) {
  if (!orphan || typeof orphan !== "object" || !cur) return false;
  const prev = cur.json;
  // exactly one seq ahead of the current head
  const expectedSeq = (Number.isInteger(prev.seq) ? prev.seq : 0) + 1;
  if (orphan.seq !== expectedSeq) return false;
  // advances the namespace it claims to
  if (orphan.namespace !== namespace) return false;
  // a well-formed head fingerprint
  if (typeof orphan.chain !== "string" || !store.CHAIN_RE.test(orphan.chain)) return false;
  if (!Number.isSafeInteger(orphan.rows) || orphan.rows < 1) return false;
  // a real successor never goes backward (monotonic)
  if (Number.isInteger(prev.rows) && orphan.rows < prev.rows) return false;
  // a known record kind
  if (orphan.record_kind !== "content_head_advance" && orphan.record_kind !== "publisher_heartbeat") {
    return false;
  }
  // a heartbeat RESTATES the head (same rows); it never advances content
  if (orphan.record_kind === "publisher_heartbeat" && Number.isInteger(prev.rows) && orphan.rows !== prev.rows) {
    return false;
  }
  // prev-chain linkage: _store.appendInterval stamps the newest interval's
  // supersedes_due_by with the predecessor's next_pin_due_by, so a record
  // genuinely built FROM this exact latest.json carries it. This is what ties
  // the orphan to THIS head rather than to some other version of it — the
  // difference between a self-heal and a blind overwrite.
  const prevDue = typeof prev.next_pin_due_by === "string" ? prev.next_pin_due_by : null;
  const ivs = Array.isArray(orphan.intervals) ? orphan.intervals : [];
  const newest = ivs.length ? ivs[ivs.length - 1] : null;
  if (!newest) return false;
  const supersedes = "supersedes_due_by" in newest ? newest.supersedes_due_by : undefined;
  if ((supersedes || null) !== (prevDue || null)) return false;
  // the newest interval must be the orphan's OWN interval (seq matches)
  if (Number.isInteger(newest.seq) && newest.seq !== orphan.seq) return false;
  return true;
}

function orphanedSeqBody(namespace, seqName) {
  return {
    error:
      "namespace is wedged: the next sequence record already exists but latest.json is behind it, " +
      "so no new pin can be recorded until the record is reconciled",
    reason: "orphaned_seq_record",
    namespace,
    orphaned_seq_record: `pins/${namespace}/${seqName}.json`,
    cause:
      "a previous write committed the numbered record and then failed to update latest.json — " +
      "these are two separate commits and are not atomic (Stage-0, documented)",
    operator_action:
      `the witness attempts automatic repair when the orphan verifies as the legitimate successor; ` +
      `if you see this, pins/${namespace}/${seqName}.json did NOT verify — compare it against ` +
      `pins/${namespace}/latest.json in the public repo and reconcile by hand`,
    public_record: `https://github.com/${store.REPO}/commits/${store.BRANCH}/pins/${namespace}`,
  };
}

// Detect a wedged namespace BEFORE any charge, and self-heal if the orphan
// verifies. `cur` is the latest.json read this pass (or null). Returns:
//   { clear:true }            slot is free — proceed to the write
//   { repaired:true }         orphan adopted into latest.json — retry the pin
//   { deny:{status,body} }    orphan present but NOT verifiable — fail typed
async function healIfWedged(namespace, cur, latestPath) {
  const nextSeq = (cur && Number.isInteger(cur.json.seq) ? cur.json.seq : 0) + 1;
  const nextSeqName = String(nextSeq).padStart(8, "0");
  const orphan = await store.getFile(`pins/${namespace}/${nextSeqName}.json`);
  if (!orphan) return { clear: true };
  if (verifyOrphanSuccessor(orphan.json, cur, namespace)) {
    try {
      await store.putFile(
        latestPath, orphan.json,
        `latest ${namespace} rows=${orphan.json.rows} seq=${orphan.json.seq} (self-heal: adopt verified orphaned seq record)`,
        cur ? cur.sha : undefined
      );
    } catch (err) {
      // Another writer advanced latest.json first — the wedge is already being
      // resolved. Just retry against the fresh head.
      if (err && err.conflict) return { repaired: true };
      throw err;
    }
    return { repaired: true };
  }
  return { deny: { status: 409, body: orphanedSeqBody(namespace, nextSeqName) } };
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

  // Metering + credit are charged INSIDE the write paths below (via
  // meterAndCharge), never here (2026-08-14 billing/race fix). Every rejection
  // — monotonic, head-conflict, renewal precondition, wedged namespace — and
  // the idempotent no-op re-pin all return BEFORE any charge, so a pin that
  // records nothing burns nothing. `metered` guards against charging twice
  // across a self-heal retry.
  let metered = false;

  const latestPath = `pins/${namespace}/latest.json`;
  const MAX_PASSES = 4; // 1 normal pass; extra passes only when a wedge self-heals

  try {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // --- read the current latest pin ---
      const cur = await store.getFile(latestPath);

      // --- renewal preconditions: a renewal may only ever RESTATE the head ---
      // (rejections here charge nothing — no write happens)
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

      // --- monotonic guard (rejection charges nothing) ---
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
            // Unchanged behavior: a bare re-pin is idempotent. It records
            // NOTHING, so it now also charges nothing — the metering used to run
            // before this branch and burned a meter count on a pure no-op.
            return res.status(200).json({
              ok: true,
              note: "already witnessed (idempotent re-pin) — no renewal intent, deadline unchanged",
              pin: cur.json,
              hint: 'to refresh next_pin_due_by without new rows, POST /api/renew (or add "intent":"renew") — it is recorded as a publisher heartbeat, never as a content advance',
            });
          }

          // --- renewal write path: heal-if-wedged, THEN charge, THEN write ---
          const heal = await healIfWedged(namespace, cur, latestPath);
          if (heal.repaired) continue;
          if (heal.deny) return res.status(heal.deny.status).json(heal.deny.body);

          if (!metered) {
            const charge = await meterAndCharge(key);
            applyHeaders(res, charge.headers);
            if (charge.deny) return res.status(charge.deny.status).json(charge.deny.body);
            metered = true;
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
          try {
            const put = await putSeqRecord(
              namespace, seqName, renewal,
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
          } catch (err) {
            // A wedge the proactive check missed (contents-API read lag). Self-
            // heal and retry rather than 502; `metered` stays true so the
            // eventual success isn't charged twice.
            if (err && err.wedged && pass < MAX_PASSES - 1) {
              const reheal = await healIfWedged(namespace, cur, latestPath);
              if (reheal.deny) return res.status(reheal.deny.status).json(reheal.deny.body);
              continue;
            }
            throw err;
          }
        }
        // --- head-conflict: same rows, different chain (409, charges nothing) ---
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

      // --- content advance write path: heal-if-wedged, THEN charge, THEN write ---
      const heal = await healIfWedged(namespace, cur, latestPath);
      if (heal.repaired) continue;
      if (heal.deny) return res.status(heal.deny.status).json(heal.deny.body);

      if (!metered) {
        const charge = await meterAndCharge(key);
        applyHeaders(res, charge.headers);
        if (charge.deny) return res.status(charge.deny.status).json(charge.deny.body);
        metered = true;
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
      try {
        const put = await putSeqRecord(namespace, seqName, pin, msg);
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
        // A wedge the proactive check missed (read lag) — self-heal and retry;
        // `metered` stays true so the retry isn't charged again.
        if (err && err.wedged && pass < MAX_PASSES - 1) {
          const reheal = await healIfWedged(namespace, cur, latestPath);
          if (reheal.deny) return res.status(reheal.deny.status).json(reheal.deny.body);
          continue;
        }
        throw err;
      }
    }

    // Passes exhausted — the namespace kept re-wedging faster than repair could
    // converge (should be unreachable in practice). Report typed, don't spin.
    return res.status(409).json({
      error: "namespace is wedged and automatic repair did not converge within the retry budget",
      reason: "orphaned_seq_record",
      namespace,
      public_record: `https://github.com/${store.REPO}/commits/${store.BRANCH}/pins/${namespace}`,
    });
  } catch (err) {
    if (err && err.wedged) {
      return res.status(409).json(orphanedSeqBody(namespace, err.seqName));
    }
    // Generic store failure. err.message is deliberately short and carries no
    // upstream response body — api/_store.js logs the detail server-side.
    return res.status(502).json({ error: `pin store error: ${err.message}` });
  }
};
