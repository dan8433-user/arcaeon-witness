#!/usr/bin/env node
// tools/supersede_namespace.js — the replacement for "test cleanup".
//
// Marks a finished namespace as superseded by PUBLISHING a new record at
// superseded/<namespace>.json. It never deletes, never overwrites, and never
// touches the namespace's pins or observations. See lib/_test_ns.js.
//
// OPERATOR COMMAND (dry run is the default; nothing is written without --write)
//
//   GITHUB_PIN_TOKEN=... node tools/supersede_namespace.js \
//     --namespace=veltest-a-1234 --reason="hostile audit fixture, 2026-09-22" [--write]
//
// A namespace without a test prefix (for example velouria-selftest) is refused
// unless --any-namespace is also given, because superseding a namespace that
// was never marked as a test is a statement about someone's record and should
// be a deliberate act.

"use strict";

const store = require("../lib/_store.js");
const tns = require("../lib/_test_ns.js");

function parseArgs(argv) {
  const out = { write: false, anyNamespace: false };
  for (const a of argv) {
    if (a === "--write") out.write = true;
    else if (a === "--any-namespace") out.anyNamespace = true;
    else if (a.startsWith("--namespace=")) out.namespace = a.slice(12);
    else if (a.startsWith("--reason=")) out.reason = a.slice(9);
    else if (a.startsWith("--now=")) out.now = a.slice(6);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const NS_RE = /^[a-z0-9-]{1,64}$/;

// deps is a seam for the test suite: {getFile, putFile, listDir}. Production uses _store.
async function supersede(opts, deps = store) {
  const ns = opts.namespace;
  // Shape check first, before any network call: a malformed name never
  // reaches the store (no path built from it, no GET issued).
  if (typeof ns !== "string" || !NS_RE.test(ns)) {
    return { ok: false, refused: "malformed-namespace", detail: `namespace ${JSON.stringify(ns)} is missing or malformed` };
  }
  if (!tns.isTestNamespace(ns) && !opts.anyNamespace) {
    return { ok: false, refused: "not-a-test-namespace",
      detail: `${ns} has no test prefix (${tns.RESERVED_TEST_PREFIX}); pass --any-namespace to supersede it deliberately` };
  }
  const path = tns.supersedePath(ns);
  if (await deps.getFile(path)) {
    return { ok: false, refused: "already-superseded", detail: `${path} already exists; it is left as published` };
  }
  // last_seq is a statement that nothing was cut off after it, so it is never
  // guessed. latest.json missing or with a non-integer seq is only a true 0
  // when the namespace has no numbered pins at all; otherwise refuse.
  const latest = await deps.getFile(`pins/${ns}/latest.json`);
  const seq = latest && latest.json ? latest.json.seq : undefined;
  let lastSeq;
  if (Number.isInteger(seq) && seq >= 0) {
    lastSeq = seq;
  } else {
    const entries = await deps.listDir(`pins/${ns}`);
    const numbered = (entries || []).filter((e) => e && /^\d+\.json$/.test(e.name));
    if (numbered.length > 0) {
      return { ok: false, refused: "latest-unreadable",
        detail: `pins/${ns}/latest.json is ${latest ? "present but its seq is not an integer" : "missing"} while ${numbered.length} numbered pin file(s) exist; last_seq cannot be stated, nothing published` };
    }
    lastSeq = 0;
  }
  const record = tns.buildSupersedeRecord({
    namespace: ns, reason: opts.reason, lastSeq,
    now: opts.now || new Date().toISOString(),
  });
  if (!opts.write) return { ok: true, dryRun: true, path, record };
  // sha = null: create-only. If the path appeared in the meantime GitHub
  // refuses the write, and putFile has no rebuild hook, so it is never
  // overwritten.
  const res = await deps.putFile(path, record,
    `supersede ${ns} (record kept, nothing removed): ${record.reason}`.slice(0, 200), null);
  return { ok: true, path, record, commit: res && res.commit ? res.commit.sha : null };
}

if (require.main === module) {
  (async () => {
    try {
      const out = await supersede(parseArgs(process.argv.slice(2)));
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 2);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}

module.exports = { supersede, parseArgs };
