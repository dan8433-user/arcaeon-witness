# Interpretive choices in the audit-state slice (part B, slice 1)

Written 2026-09-22 alongside `lib/_check_record.js`, `lib/_audit_state.js`, `lib/_audit_status.js` and `tools/check_and_sign.js`. Every place the design page (`projects/online_business/DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md`, part B) left room, or where the build brief and the page differed, is listed here with the choice made. The tie-break was the same every time: **a state is never upgraded without evidence.** Each entry names the test that pins the choice.

## D1. BROKEN is permanent, not "newer than the last VERIFIED"

The build brief said "any BROKEN newer than the last VERIFIED -> BROKEN". The page (B3) says "a reproducible BROKEN is permanent: a later VERIFIED does not clear it. The only way out is the BROKEN itself being shown wrong (its tool version withdrawn, or its inputs shown to be not the record's)". The page wins, because it is the one that never upgrades: a fresh VERIFIED after a BROKEN is two checkers disagreeing, not a repair. Implemented as: any verifiable BROKEN whose tool and key are not withdrawn is standing, regardless of order. Test: `STATE: BROKEN then a LATER VERIFIED -> still BROKEN`.

Not implemented (B9 question 2, open for Daniel): re-running a BROKEN from its public inputs before letting it flip the badge. Slice 1 accepts only records the operator commits, so an unreproducible outside BROKEN cannot reach the page yet.

## D2. "Withdrawn" is the only release, and it applies to every result

B6 lists withdrawal (tool version, checker key, recipe) as an immediate demotion of CHECKED to STALE. The page does not say what withdrawal does to a BROKEN or to an operator's own VERIFIED. Choices:
- A BROKEN from a withdrawn tool or key is no longer standing (B3's "only way out"). It stays on the record and is counted (`counts.broken_withdrawn`), and the page says "kept on the record".
- An outside VERIFIED from a withdrawn tool or key is STALE immediately, with `stale_reason: "withdrawn"`.
- An operator's own VERIFIED from a withdrawn tool is not evidence at all: the record is BLIND, not SELF-CHECKED. A withdrawn tool's yes is nothing, whoever ran it.
Recipe withdrawal is not modelled (no recipe field exists in a check record yet). Tests: the four `withdrawn` cases in `test/audit_state.test.js`.

## D3. The freshness comparison is strict less-than, in integer seconds

"CHECKED while its most recent independent VERIFIED is less than 30 days old, compared in integer seconds with no float." At exactly 30 days (2,592,000 seconds) the record is STALE. Tests: `at 30 days minus 1 second -> CHECKED`, `at exactly 30 days -> STALE`, `at 30 days plus 1 second -> STALE`.

## D4. An unreadable or absent OPERATOR_KEYS.json makes CHECKED unreachable

B5 says a result signed by a declared operator key is SELF-CHECKED. It does not say what happens when the declaration cannot be read. If the page treated "no declaration" as "no operator keys", forgetting to publish the file would turn our own daily self-check green. So when `checks/OPERATOR_KEYS.json` is absent, malformed, or unreadable, every key is treated as ours (`ownKeysUnknown`), the page says so in a note, and the best any namespace can reach is SELF-CHECKED. BROKEN still fires. Tests: `outside key but OPERATOR_KEYS unknown -> SELF-CHECKED at most`; `without OPERATOR_KEYS.json an outside key can only reach SELF-CHECKED`.

## D5. Future-dated records: 300 seconds of skew, then refused

The brief asked the verifier to refuse future-dated records. A checker's clock a few seconds ahead of ours is ordinary; a record dated an hour ahead is a claim nobody can have evidence for yet. Default tolerance 300 seconds (`DEFAULT_SKEW_SECONDS`), configurable per call. A refused record is `unverifiable`, counted, and never folded in. Tests: `REFUSE: future-dated beyond skew`; `a future-dated outside VERIFIED is ignored`.

## D6. A record that fails signature, shape, or clock is ignored and counted, never defaulted

The page's B8 day-5 test: "does a record with a missing field RAISE rather than default". In the library, `verifyCheckRecord` returns a refusal (never throws on bad input, so a hostile file cannot crash the page), and `deriveAuditState` drops the record into `counts.unverifiable` with the reason. Dropping is the non-upgrading choice: a malformed VERIFIED is not a VERIFIED. Tests: `a tampered record is ignored`; `a record missing a field is ignored, not defaulted`.

## D7. Unknown fields are refused, top-level and nested

B4 requires the signature to cover every field. Hashing the whole record minus `sig` already does that for any field present, but a verifier that tolerated unknown fields would let a reader trust a field nobody validated. So `validateShape` refuses unknown keys at every level it knows. The consequence is that the schema can only grow with a version bump (`v: 2`), which is the intended cost. Test: `unknown top-level field`, `unknown nested field` in the mutation list.

## D8. The stranger tool scopes its verdict to the namespace, and writes the repo-level verdict into `detail`

`verify.py` returns one `overall` for the whole repository. Today that is BROKEN (65 published records deleted on 2026-08-14/15 under "test cleanup", per `verifier_two/LIVE_RUN.md`). A check record is about ONE record (`target.ref`), so the tool decides per namespace from the results whose subject or file belongs to that namespace, mirroring `verify.py`'s own `overall` rule over that subset. The repo-level verdict goes into `detail` so a namespace VERIFIED is never read as a repo VERIFIED. A namespace deleted at HEAD is refused (nothing to digest), not recorded as BROKEN by a record that cannot name its bytes. Tests: `decide mirrors verify.py overall`; `carries the repo-level verdict`; `an absent namespace is refused`.

Consequence worth stating: verifier two rules `velouria-selftest` BROKEN by its own D2 (a live refused-head observation). A stranger running this tool over the live repo today would produce BROKEN for that namespace. That is verifier two's reading, recorded as such, and it would be a true BROKEN on the page.

## D9. The aggregate line includes STALE

B7's example is "12 records: 9 blind, 3 self-checked, 0 checked, 0 broken." STALE is a state and a count that hides amber is the same lie as one that hides grey, so the rendered line is "N records: a blind, b self-checked, c checked, d stale, e broken." BLIND is still first. Test: `the aggregate names BLIND first`.

## D10. The cadence badge stays, but it follows the audit state

The brief said to render the audit-state badge "instead" of the green "current"; the page (B7) says the row "keeps its cadence badge and gains an audit-state badge beside it". The cadence badge is a true statement about a different axis, so it stays. The finding was that green stood ALONE, so with the flag on the row leads with the audit state and the cadence badge follows it, prefixed "cadence:". Test: `the audit state must come before the green badge`.

## D11. Records are listed from the tree and read up to a budget; over budget is NOT FULLY READ, not a state

A hundred contents reads per render (`MAX_RECORD_READS`) bounds the GitHub API cost. A namespace whose records were not all read renders "NOT FULLY READ" and is excluded from the aggregate's denominator ("2 not fully read" is printed beside it). Deriving CHECKED from a prefix of the evidence could skip a BROKEN; deriving BROKEN from a prefix is fine in principle but the two cases are not told apart here, so neither is derived. Test: `the read budget marks a namespace NOT FULLY READ`.

## D12. A record filed under one namespace but targeting another is evidence for neither

`checks/pin/<ns>/` is a filing convention; `target.ref` is the claim. When they disagree the record is counted as `misfiled` on the namespace it was filed under and ignored for both. Test: `a misfiled record is not evidence for its target either`.
