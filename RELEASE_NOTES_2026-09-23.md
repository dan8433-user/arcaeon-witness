# Release notes — arcaeon-witness, 2026-09-23 release tree

Branch `release-candidate-2026-09-23`, worktree `C:/Users/USER/arcaeon-witness-rc3`. Local only: nothing pushed, nothing deployed.

## What production is today

- Deployment `dpl_3FpJxq5z`, built from release candidate `8f0c2d1` ("merge live status-page commits (a1b2052, 8739675) into the release candidate").
- `8f0c2d1` is an ancestor of this tree (`git merge-base --is-ancestor 8f0c2d1 HEAD` exits 0), and so are `a1b2052`, `8739675` and `cbd567c` (the tip of `release-candidate-2026-09-22`).

## What this tree adds over production

Base: `honest-commit-time-2026-09-22` (`d398315`), which sits on `fix-false-yes-2026-09-22` (`30a65a7`). Then three merges, in this order: `no-delete-record` (`10d2b62`), `log-tree-slice1` (`b30906b`), `audit-state-slice1` (`56dba46`).

| Change | Commits | Touches live behaviour? |
|---|---|---|
| Stamp check refuses a record whose own sha256 disagrees with its path (S-1, S-1b, S-1c): 409 `record_mismatch`, never "stamped" | `d80b176` | Yes, `lib/_stamp.js` (GET and the POST re-read paths) |
| Verify cross-checks record vs path and parses rows strictly (W-1, W-2, W-3) | `30a65a7` | Yes, `api/verify.js` |
| Commit dates described as the operator's own clock, not GitHub's (README, status page two paragraphs, `status.json` `independence.note`, `lib/_store.js` comment, PRACTICES v1.3) | `d398315` | Yes, wording on `/status` and `/api/status.json` |
| Failure-conformance suites (merkle, verify, stamp) | `cbd567c`, `e374c2b` | No, tests only |
| No-delete rule: `lib/_test_ns.js`, `tools/supersede_namespace.js`, the DELETE guard test | `b76323e`, `10d2b62` | No, nothing in `api/` calls it |
| Log tree: `lib/_logtree.js`, `lib/_checkpoint.js`, `tools/publish_checkpoint.js`, `tools/follow.js` | `214e6ff`, `b30906b` | No, not wired to any endpoint; nothing publishes |
| Audit state: `lib/_check_record.js`, `lib/_audit_state.js`, `lib/_audit_status.js`, `tools/check_and_sign.js`, status column | `a40762c`, `56dba46` | Only with `WITNESS_AUDIT_STATE=1`. Off by default. |
| Flag-off whitespace fix in `api/status.js` + pinning test | merge `6232062` | Restores byte-identity with the flag off |

No new files under `api/` (the Hobby 12-function cap is unchanged) and `vercel.json` is identical to production's.

### The flag-off fix made during assembly

`audit-state-slice1` placed the summary-panel placeholder on its own template line, so with the flag OFF the page gained `"  \n"` (3 bytes) between the legend and the table. Its CHANGELOG line says "byte-identical to before (tested)"; the test only checked vocabulary and could not see it. The conditional now carries its own leading newline. Evidence, with a frozen clock and the same seeded mock store rendered from exported trees:

- this tree, flag off == `d398315`, byte for byte (13788 bytes);
- `8f0c2d1` (production) == `30a65a7` (`fix-false-yes-2026-09-22`), byte for byte (13634 bytes);
- this tree vs those two differs only by the two `d398315` paragraphs (the commit-date wording), 8 diff lines;
- flag-on output is unchanged by the fix (16454 bytes before and after).

`test/audit_status_page.test.js` gained a test that pins the adjacency; it fails against the unfixed `56dba46` `api/status.js`.

## Tests

`npm test` (Node 24.14.1): **578 tests, 576 pass, 0 fail, 2 todo.** The two todos are main's strict known-false-yes rows M-1 (`verifyInclusion` accepts a wrong `tree_size`) and M-2 (leaf-hash-only proof accepts an interior node), from `e374c2b`. They are open findings in the batch verifier, not regressions, and the batch path stays behind `WITNESS_BATCH_SHADOW` (unset).

Break arms, run by hand and restored:

- `lib/_stamp.js` GET skips the sha256 comparison: 3 fail (the three S-1 record-at-A's-path cases).
- `lib/_audit_state.js` derive always returns CHECKED: 29 fail.
- `lib/_logtree.js` `verifyConsistency` always ok: 4 fail (the follow.js cross-check, the refusal battery, both lying-verifier arms).

## Environment: do NOT change

- `WITNESS_AUDIT_STATE` stays **unset**. Turning it on renders every namespace BLIND and needs verifier two published and `checks/OPERATOR_KEYS.json` published first (see the audit-state CHANGELOG entry), plus Daniel's word.
- `WITNESS_BATCH_SHADOW` stays unset (M-1/M-2 are open).
- No new env vars are required. Every other variable (`GITHUB_PIN_*`, `GITHUB_USAGE_*`, `STAMP_*`, `WITNESS_*`, Stripe keys) keeps its current production value.

## Deploy (one command, when Daniel says go)

```bash
OUT=$(mktemp -d)
git -C C:/Users/USER/arcaeon-witness-rc3 archive release-candidate-2026-09-23 | tar -x -C "$OUT"
mkdir -p "$OUT/.vercel" && cp C:/Users/USER/arcaeon-witness/.vercel/project.json "$OUT/.vercel/project.json"
# VERCEL_TOKEN must be in the environment
npx --yes vercel@59.25.0 deploy --cwd "$OUT" --prod --yes --scope arcaeon --archive=tgz
```

Archive the branch name (or its commit hash), not a moving `HEAD`, so the export is the reviewed tree.

## Rollback target

`dpl_3FpJxq5z` (release candidate `8f0c2d1`): `npx --yes vercel@59.25.0 rollback dpl_3FpJxq5z --scope arcaeon` with `VERCEL_TOKEN` set, or promote that deployment in the dashboard. Nothing in this tree writes a new store format, so rolling back leaves no orphaned data.

## Post-deploy read-back

1. `GET https://witness.arcaeon.io/api/stamp?sha256=89fe2de58e7e9a07238b1a5f01bc4ea1347dfdf8005489e297d3279549d0e6aa` is **200** and the record's `sha256` is that exact value (the S-1 check must not refuse a good record).
2. `GET /api/health` is **200**.
3. `/status` bytes unchanged against a capture taken just before the deploy, **except** the two `d398315` commit-date paragraphs, which are the intended change, and live timestamps. No `BLIND`, `SELF-CHECKED` or `audit state` anywhere on the page. `/api/status.json` differs only in `independence.note`.
4. `py C:/Users/USER/velouria/bridge/tmp/stamps_release/verify_stamps_live.py` reports **PASS**.

If any of 1, 2 or 4 fails, roll back to `dpl_3FpJxq5z` first and diagnose after.
