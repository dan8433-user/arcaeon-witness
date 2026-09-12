# Bulk verify: `POST /api/verify?op=bulk`

Design for K-017 (BATCH_500 lane K, section 8 rule 4). AUDIT-A3: this
touches a verify format. Fable reads this Monday. Implemented at K-018 on
the existing `api/verify.js` — **no 13th function**, same `?op=` dispatch
`vercel.json` already routes `/api/fulfill?op=prefix-available` through.

## Why a mode, not a file

`arcaeon-witness/api/` holds exactly 12 files today (confirmed K-016),
which is the Vercel Hobby plan's function cap. `api/fulfill.js` already
proves the pattern: `vercel.json` can rewrite a clean public path onto an
existing function with `?op=`, and the function dispatches on
`req.query.op` before its normal gate. `api/verify.js` gets the same
treatment: `op=bulk` is checked first, before the single-item GET/HEAD
method gate, and routes to a separate handler function inside the same
file. No new file, no vercel.json rewrite needed for the internal case
(the caller passes `?op=bulk` directly; a friendlier public alias like
`/api/verify-bulk` can be added later as a `vercel.json` rewrite onto
`/api/verify?op=bulk`, the same way `/api/prefix-available` aliases
`/api/fulfill?op=prefix-available` — not required for this design).

## Request shape

```
POST /api/verify?op=bulk
Content-Type: application/json

{
  "items": [
    { "ns": "demo-current", "rows": 42, "chain": "cafebabe" },
    { "ns": "demo-current", "rows": 41, "digest": "deadbeef" },
    { "ns": "bad ns", "rows": 5, "chain": "aaaa" }
  ]
}
```

- **POST only** for this mode (unlike the single-item path, which is
  GET/HEAD). An array of items does not fit cleanly or safely in a query
  string, and `api/fulfill.js` already accepts POST bodies on this same
  API surface — this is not a new convention for the repo.
- Each item takes the **same three fields the single-item GET already
  takes**: `ns`, `rows`, and `chain` (`digest` remains an accepted alias
  for `chain`, same alias-conflict rule: if both are given on one item and
  disagree, that item is invalid). No new fields, no new item shape.
- `items` must be a JSON array. Anything else (missing, not an array, an
  array of non-objects) is a whole-request 400, before the cap check.

## The cap, and refusal (never truncate, never hang)

```
const MAX_BULK_ITEMS = 20;
```

Rationale: the single-item path's own comment already names the reason a
cap exists at all — "this is a public unauthenticated GET, so the cap
exists to bound this repo's shared GitHub API budget per call, not to
meter the caller." A single verify call can cost up to `MAX_HISTORY_SCAN`
(50) GitHub reads when the requested rows sits behind the current head. A
bulk call multiplies that: 20 items × 50 worst-case reads = 1,000 GitHub
API calls from one HTTP request. 20 is chosen as a batch size useful enough
to be worth building (a real caller checking a day's worth of pins in one
round trip) while keeping that worst case bounded to something the shared
budget can absorb; it is a config constant, trivially revisited if real
usage says otherwise.

An oversized batch is a **whole-request refusal**, not a truncation and
not a partial run:

```
HTTP 400
{
  "ok": false,
  "error": "batch exceeds cap of 20 items",
  "count": <items.length>,
  "cap": 20
}
```

This mirrors `arcaeon_receipt/cite_batch.py`'s cap-or-refuse pattern
(`cite.py`'s `MAX_TEXT` check: raise with a clear message naming the cap,
never chunk silently, never process the first N and drop the rest). No
items are looked up when the batch is over cap — zero GitHub reads, zero
partial results, a caller who resubmits at or under 20 either way.

## Response shape: per-item verdicts, never short-circuit

The single-item endpoint's full contract (every `witnessed` value, every
`reason` string, `pin`, `is_current_head`, `accepted_head`, `scanned`,
cadence fields, etc.) is reused **verbatim, per item** — bulk mode is not
a new verdict vocabulary, it is the same verdict vocabulary run N times
and collected in order:

```
HTTP 200
{
  "ok": true,
  "count": 3,
  "results": [
    {
      "ns": "demo-current", "rows": 42, "chain": "cafebabe",
      "http_status": 200, "ok": true,
      "witnessed": true, "is_current_head": true, "pin": {...}, ...
    },
    {
      "ns": "demo-current", "rows": 41, "chain": "deadbeef",
      "http_status": 200, "ok": true,
      "witnessed": false, "reason": "rows_match_chain_mismatch", ...
    },
    {
      "ns": "bad ns", "rows": 5, "chain": "aaaa",
      "http_status": 400, "ok": false,
      "error": "ns must match [a-z0-9-]{1,64}"
    }
  ]
}
```

Rules, all load-bearing:

- **Every item gets a result, in the same order as the request.** A
  malformed item (bad `ns`, non-integer `rows`, bad `chain`, conflicting
  `chain`/`digest`) does not abort the batch — it produces that one item's
  own 400-shaped result (`http_status: 400`, the same `error` string the
  single-item endpoint would have returned for that input) and processing
  continues to the next item.
- **A store-read error on one item does not fail the batch.** The single
  item's own 502-shaped body (`{error: "pin store read error: ..."}`)
  becomes that item's result; the loop is a plain `for`/`await`, never a
  `Promise.all` that would let one rejection reject the whole response.
- **No new verdict words.** `witnessed`'s three values (`true`/`false`/
  `null`) and every `reason` string are exactly the set `api/verify.js`
  already emits (`no_pin_recorded_for_namespace`, `exceeds_current_head`,
  `rows_match_chain_mismatch`, `rows_never_witnessed`, `scan_bound_reached`,
  `not_found_in_history`, and the implicit "matches current head" /
  "matches historical head" true cases). Bulk mode calls the identical
  lookup logic the single path uses — see Implementation note below — so
  there is exactly one place that can emit a reason string, not two
  hand-copies that could drift.
- The top-level `ok`/`http_status` on each result item stands in for the
  HTTP status the single-item GET would have returned for that one input;
  the whole-request HTTP status is 200 whenever the batch itself was
  processed (even if every item inside it is a mismatch or an error) — an
  all-or-nothing whole-request status would defeat the point of per-item
  verdicts.

## Cap and malformed-batch precedence

Checked in this order, each a hard stop before the next:

1. Method must be POST (`op=bulk` on GET/HEAD/etc. is a 405, same `allow`
   header discipline as the single path).
2. Body must parse to `{ items: [...] }` with `items` an array — else 400,
   no store reads.
3. `items.length` must be `1..MAX_BULK_ITEMS` — 0 items is a 400 ("items
   must be a non-empty array"), over-cap is the 400 shown above. Neither
   case touches the store.
4. Only past all three does per-item processing begin, item by item, in
   order, never short-circuiting on the first invalid or mismatched item.

## Rate limiting

The existing per-IP limiter (`lib/_ratelimit.js`, 30 calls/10min/warm
instance) still applies to the bulk request as **one call**, the same as
any other hit to this endpoint — it is not scaled by `items.length`. This
is an accepted, named trade-off, not an oversight: the `MAX_BULK_ITEMS`
cap is what bounds per-request cost; the per-IP limiter bounds request
*frequency*. A caller who wants to check more than 20×30=600 records in 10
minutes is already past what this Stage-0 limiter was sized for on the
single-item path too. Revisit together if real bulk traffic makes this the
binding constraint — not decided here.

## Implementation note (for K-018, not decided further by this file)

`api/verify.js`'s current single-item logic lives inline in the exported
handler. K-018 extracts the per-item validate-and-lookup logic (namespace
format check, rows check, chain/digest alias check, the three-case store
lookup) into one function that both the existing single-item path and the
new bulk path call — so bulk mode is not a second implementation of the
verify logic, it is the same implementation called N times. This keeps
Rule 6 (section 8: never introduce a second implementation of a digest —
or, by the same logic, a second implementation of a *verdict* — without a
parity mechanism) satisfied by construction rather than by a vector this
lane would otherwise have to build.

## Test coverage (K-019)

- A batch mixing a valid match, a valid mismatch, a malformed item, and a
  never-witnessed namespace, in one call — asserts all four verdicts land
  in the right array positions with the right `http_status`/`reason`.
- An over-cap batch (21+ items) — asserts the whole-request 400, `count`
  and `cap` in the body, and (via the mock store's call log) that **zero**
  store reads happened.
- A non-array `items` and a missing `items` — both 400, zero store reads.
- Confirms no new `reason`/`witnessed` value appears anywhere that isn't
  already emitted by the existing single-item test suite (`test/verify.test.js`).
