# Release notes — arcaeon-witness, 2026-09-23b release tree

Branch `release-candidate-2026-09-23b`, worktree `C:/Users/USER/arcaeon-witness-rc3b`. Local only: nothing pushed, nothing deployed.

## What production is today

- Deployment `dpl_4dBieifo`, built from `1266d39` (tip of `release-candidate-2026-09-23`, see `RELEASE_NOTES_2026-09-23.md`).
- `1266d39` is an ancestor of this tree, and so are `8f0c2d1`, `30a65a7`, `d398315`, `10d2b62`, `b30906b`, `56dba46`, `11f2c60`, `a796e9f`, `f12d0ed` and `4aef102` (`git merge-base --is-ancestor <c> HEAD` exits 0 for each).

## What this tree adds over production

Base `release-candidate-2026-09-23` (`1266d39`), then three merges in this order: `log-tree-golive` (`11f2c60`), `merkle-fix` (`a796e9f`), `verdict-required` (`4aef102`), plus one test-only commit.

| Change | Commits | Touches live behaviour? |
|---|---|---|
| Witness log go-live prep: `tools/logtree_keygen.js`, `docs/LOGTREE_KEY_RUNBOOK.md`, README "Witness log" section, `.gitignore` `*.signer.key` | `11f2c60` | No. Nothing deployed reads `WITNESS_LOG_SIGNER_KEY`; the signer runs on the operator's machine |
| Merkle inclusion proofs bind `tree_size` to the tree shape and the published root (M-1), refuse a bare `leaf_hash` (M-2); `tools/reconcile_batches.js` passes root.json's `tree_size`; design doc §5 | `a796e9f` | No. `lib/_merkle.js` `verifyInclusion` has no caller under `api/`; the batch path stays behind `WITNESS_BATCH_SHADOW` (unset) |
| Verdict layer `lib/_verdict.js`: no `ok:true` body without a verdict judged from a store read; present-but-unreadable is red, only a 404 is empty; `judgeRead` never returns null (`present_unchecked`); greens bound to their read and, where named, to their record | `feea800`, `b051719`, `0a8de81`, `f12d0ed`, `4aef102` | **Yes**, see the list below |
| S-1 contract pinned: the typed 409 `record_mismatch` is asserted, not only "not stamped" (6 tests) | `17623b6` | No, tests only |

Live behaviour changes from `verdict-required` (from its CHANGELOG entries, all tested):

- `/api/latest` and `/api/verify`: a damaged head (present, not a pin record) is `503 {ok:false, reason}`; it used to be 200. `/api/verify` answers `witnessed:null, reason:"history_unreadable"` where a hole or unreadable record sits in the scanned history (it used to be a conclusive `false`). `/api/latest` no longer falls back to the raw CDN when the fresh copy was reached and is not JSON.
- `/api/pin`: refuses with 503 before any charge over a damaged head (the monotonic and re-mint guards used to be skipped). A pointer that turns unreadable, or literally `null`, between read and write is refused by name, never rebuilt over at seq 0; that refusal is 503 (was 502).
- `/api/stamp`: a stored stamp gets a verdict before it is shown; a stamp file that is not a stamp is 503. The day-budget counter holding `null` or no readable count refuses (was: restarted at 0). The S-1 compare still runs first, so a record/path mismatch stays the 409 `record_mismatch` production answers today.
- Free-tier meter and credit balance: a damaged usage or balance file throws instead of reading as 0; a grant never overwrites a damaged balance.
- `/api/fulfill`, `/api/stripe-webhook`: the fulfillment record is judged through the verdict layer; a non-USD currency still refuses, upper-case USD still credits.
- `/status`, `/api/status.json`, `/api/badge`: see "Flag-off byte-identity" below. The one-word verdict can no longer fall through to "ok".

No new files under `api/` (still 12, the Hobby cap) and `vercel.json` is identical to production's.

### Merge conflicts and how they were resolved

`verdict-required` is based on `30bd34c`, before the rc lineage. Only three files conflicted. `api/pin.js`, `lib/_verdict.js`, `api/latest.js`, `api/fulfill.js` and `lib/_status_data.js` auto-merged because the rc lineage never touched them; `lib/_store.js`, `api/status.js` and `lib/_status_json.js` were touched on both sides and merged without a textual conflict (reviewed: the new rc-side callers of `getTree`/`getTreeMeta` in `lib/_audit_status.js` and `tools/reconcile_batches.js` already catch a throw and report it as could-not-look, so the verdict branch's `requireListing` throw lands in those catches).

- `lib/_stamp.js`, three hunks (GET, POST re-stamp of a prior record, POST lost create race): the S-1 `recordMatches` compare runs first and returns the 409 `record_mismatch`; the answer is then built by the verdict branch's `sendStamp` (judgeStamp + `verdict.success`). Both survive.
- `api/verify.js`, history scan: the W-1/W-2 `recordMismatch` 409 and the `Number.isInteger` / `String()` guards stay; `witnessedResponse` takes the verdict branch's `recVerdict`.
- `CHANGELOG.md`: every entry from both sides kept.

## Tests

`npm test` (Node 24): **641 tests, 641 pass, 0 fail, 0 todo.** Production's tree ran 578 with 2 todo; M-1 and M-2 are now real assertions. Every test name from both merge parents (583 and 435) is present in the merged run.

Break arms, run by hand on this tree and restored (`git status` clean after each):

- `lib/_stamp.js` GET skips the sha compare: **3 fail**, the three new S-1 CONTRACT GET cases. Before `17623b6` this arm failed **0**: the verdict's `judgeStamp` also refuses a mismatched sha, so the older "not stamped" S-1 cases could not see the compare go.
- Same, and `judgeStamp`'s sha rule also removed: 3 fail (both S-1 GET record cases and STAMP LOOKUP / DAMAGED vs EMPTY vs GOOD).
- `lib/_verdict.js` `judgeRead` returns `null`: **166 fail**, including all three PRESENT_UNCHECKED tests. Narrow form (null, with `judgeWith` treating null as go-on): 2 fail, both PRESENT_UNCHECKED.
- `lib/_merkle.js` `verifyInclusion` accepts any `tree_size` (path-length checks and the published `tree_size` compare removed): **4 fail**, including M-1 "tree_size inflated beyond the real tree, or shrunk against the published root".
- `lib/_audit_state.js` derive always CHECKED: **29 fail**.

## Flag-off byte-identity

`WITNESS_AUDIT_STATE` unset, frozen clock (2026-09-23T12:00Z), the same seeded mock store, `/status` and `/api/status.json` rendered from `1266d39` (exported) and from this tree:

- Healthy store (two namespaces, anchor present): **identical**, HTML 12979 bytes, JSON identical.
- Mixed store (overdue, legacy no-deadline, heartbeat, retired, one conflict observation): **identical**, HTML 17632 bytes, JSON identical.

Differences, all intended by the verdict branch, and only when a read fails:

- Observations tree unreadable. Header badge `OK` becomes `⚠ INDETERMINATE · 0 namespaces not gradeable · conflicts not counted`; the stat shows `?` instead of `0`; the panel line `0 conflicts observed, ever. (count may be incomplete: …)` becomes `Conflicts could not be counted on this render: …. That is not zero — browse the folder directly.` In JSON, `ok:false`, `status:"indeterminate"`, `conflicts_observed:null`, `conflict_observations.count:null` plus a `note`. (The "0 namespaces not gradeable ·" prefix reads oddly when the only cause is the conflict log; wording, not correctness.)
- A `latest.json` that is not a pin record: production's `/status` throws (`TypeError` at `api/status.js:113`, reading `r.chain.length`); this tree renders a red row `read error: latest.json is present but is not a readable pin record (<reason>)` and the board reads DEGRADED.

## Before deploying (carried from the verdict-required entry)

The judges assume every stored pin carries `namespace`, `rows`, `chain`, `seq`; every balance file a numeric `balance`; every usage file an integer `used`; every day counter an integer `count`. That was checked against the code that writes them, not against the live repos. **Do a read-only pass over the live pins, usage and stamps repos first**: a legacy document that breaks the assumption becomes a 503 after this deploy instead of a quiet default. Not done in this assembly.

## Environment: do NOT change

- `WITNESS_AUDIT_STATE` stays **unset**.
- `WITNESS_BATCH_SHADOW` stays **unset**. M-1/M-2 are fixed, but turning the batch path on is its own decision.
- `WITNESS_LOG_SIGNER_KEY`: may be added per `docs/LOGTREE_KEY_RUNBOOK.md`, but nothing deployed reads it; this deploy does not need it.
- No new env vars are required. Every other variable (`GITHUB_PIN_*`, `GITHUB_USAGE_*`, `STAMP_*`, `WITNESS_*`, Stripe keys) keeps its current production value.

## Deploy (one command, when Daniel says go)

```bash
OUT=$(mktemp -d)
git -C C:/Users/USER/arcaeon-witness-rc3b archive release-candidate-2026-09-23b | tar -x -C "$OUT"
mkdir -p "$OUT/.vercel" && cp C:/Users/USER/arcaeon-witness/.vercel/project.json "$OUT/.vercel/project.json"
# VERCEL_TOKEN must be in the environment
npx --yes vercel@59.25.0 deploy --cwd "$OUT" --prod --yes --scope arcaeon --archive=tgz
```

Archive the branch name (or its commit hash), not a moving `HEAD`, so the export is the reviewed tree.

## Rollback target

`dpl_4dBieifo` (`1266d39`): `npx --yes vercel@59.25.0 rollback dpl_4dBieifo --scope arcaeon` with `VERCEL_TOKEN` set, or promote that deployment in the dashboard. Nothing in this tree writes a new store format, so rolling back leaves no orphaned data.

## Post-deploy read-back

1. `GET https://witness.arcaeon.io/api/stamp?sha256=89fe2de58e7e9a07238b1a5f01bc4ea1347dfdf8005489e297d3279549d0e6aa` is **200**, `ok:true`, and the record's `sha256` is that exact value (neither the S-1 compare nor the verdict refuses a good record).
2. `GET /api/health` is **200**.
3. `GET /api/latest?ns=<a live namespace>` is **200** `ok:true`, and `/api/verify` on that namespace's current head is `witnessed:true` (the verdict layer passes real records).
4. `/status` bytes unchanged against a capture taken just before the deploy, except live timestamps. No `BLIND`, `SELF-CHECKED` or `audit state`; no `conflicts not counted`, no `?` in the conflicts stat, no `not a readable pin record` row. `/api/status.json` `status` and `conflicts_observed` match the pre-deploy capture.
5. `py C:/Users/USER/velouria/bridge/tmp/stamps_release/verify_stamps_live.py` reports **PASS**.

If any of 1, 2, 3 or 5 fails, or 4 shows a new red row, roll back to `dpl_4dBieifo` first and diagnose after.
