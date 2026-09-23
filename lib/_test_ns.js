// _test_ns.js — test namespaces and the supersede record. Nothing is deleted.
//
// WHY (2026-09-22, verifier-two findings D1 and D2). On 2026-08-14 65 published
// records in the public pin repo, 19 whole namespaces and two conflict
// observations, were removed by hand through the contents API as "test
// cleanup". An outside verifier cannot tell test cleanup from suppression, so
// by the rule it was written against, every one of those deletions is BROKEN.
// It was right. A transparency log that deletes is not one.
//
// THE RULE NOW.
//   1. Test namespaces use the reserved prefix `veltest-`. The older prefixes
//      seen in the record (`test-`, `velouria-tmp-`) are recognised as test
//      data but new tests should not use them.
//   2. A test namespace is left in place forever. When it is finished, a NEW
//      record is published at `superseded/<namespace>.json` saying so. That is
//      an addition to the record, never a removal.
//   3. The write is create-only (no sha sent), so a supersede record, once
//      published, cannot be quietly replaced by this code either.
//
// There is no delete function for the pin repo anywhere in lib/, api/ or
// tools/; test/no_delete_record.test.js fails the build if one appears.

"use strict";

const RESERVED_TEST_PREFIX = "veltest-";
const LEGACY_TEST_PREFIXES = ["test-", "velouria-tmp-"];
const SUPERSEDE_DIR = "superseded";

function isReservedTestNamespace(ns) {
  return typeof ns === "string" && ns.startsWith(RESERVED_TEST_PREFIX);
}

function isTestNamespace(ns) {
  return isReservedTestNamespace(ns) ||
    (typeof ns === "string" && LEGACY_TEST_PREFIXES.some((p) => ns.startsWith(p)));
}

function supersedePath(ns) {
  return `${SUPERSEDE_DIR}/${ns}.json`;
}

// Build the record. `lastSeq` is the seq of the namespace's latest pin at the
// moment of superseding, so a reader can see nothing was cut off after it.
function buildSupersedeRecord({ namespace, reason, lastSeq, now }) {
  if (typeof namespace !== "string" || !/^[a-z0-9-]{1,64}$/.test(namespace)) {
    throw new Error("namespace missing or malformed");
  }
  if (typeof reason !== "string" || reason.trim().length < 8) {
    throw new Error("a reason of at least 8 characters is required");
  }
  if (!Number.isInteger(lastSeq) || lastSeq < 0) {
    throw new Error("lastSeq must be a non-negative integer (0 = no pins)");
  }
  if (typeof now !== "string" || !/Z$|[+-]\d\d:\d\d$/.test(now)) {
    throw new Error("now must be an ISO time with a zone");
  }
  return {
    kind: "superseded",
    v: 1,
    namespace,
    test_namespace: isTestNamespace(namespace),
    last_seq: lastSeq,
    reason: reason.trim(),
    superseded_at: now,
    note:
      "Every pin and observation for this namespace stays in place. This record " +
      "says the namespace is finished and should not be read as a customer's " +
      "live witnessed log. It removes nothing.",
  };
}

module.exports = {
  RESERVED_TEST_PREFIX,
  LEGACY_TEST_PREFIXES,
  SUPERSEDE_DIR,
  isReservedTestNamespace,
  isTestNamespace,
  supersedePath,
  buildSupersedeRecord,
};
