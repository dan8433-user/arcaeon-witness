# VERDICT_DIFF_SUMMARY

Commit `feea800` on branch `verdict-required` (base `30bd34c`). Not deployed, not pushed.
This is the constructor/helper change only. The helper is a new file, so it is shown as additions; five functions are quoted whole and nothing inside them is elided. Two call-site hunks follow from `git show feea800 --unified=2`, to show what the helper replaced; the `api/verify.js` one is trimmed to the four lines around the deleted default (its `@@` header is the full hunk's), the `lib/_meter.js` one is whole. The tests, the other 23 call sites and the rest of `lib/_verdict.js` (the judges for pins, counters and listings, and the 503 refusal body) are left out; `VERDICT_SURVEY.md` has them by file and line.

```diff
--- /dev/null
+++ b/lib/_verdict.js
@@ lib/_verdict.js:58-60 @@
+function verifiedEmpty(what, extra) {
+  return Object.freeze({ ...(extra || {}), ok: true, state: STATES.EMPTY, what: String(what) });
+}
@@ lib/_verdict.js:71-82 @@
+function requireVerdict(v, where) {
+  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.ok !== "boolean") {
+    throw new VerdictRequiredError(where, v);
+  }
+  if (v.ok === true && v.state !== STATES.RECORD && v.state !== STATES.EMPTY) {
+    throw new VerdictRequiredError(`${where || "verdict"} (green without a state)`, v.state);
+  }
+  if (v.ok === false && (typeof v.reason !== "string" || !v.reason)) {
+    throw new VerdictRequiredError(`${where || "verdict"} (red without a reason)`, v.reason);
+  }
+  return v;
+}
@@ lib/_verdict.js:84-88 @@
+function requireGreen(v, where) {
+  requireVerdict(v, where);
+  if (!v.ok) throw new RedVerdictError(where, v);
+  return v;
+}
@@ lib/_verdict.js:96-102 @@
+function success(v, fields, where) {
+  requireGreen(v, where || "success");
+  if (fields && Object.prototype.hasOwnProperty.call(fields, "ok")) {
+    throw new TypeError("success(): `ok` comes from the verdict, never from the fields");
+  }
+  return { ok: true, ...(fields || {}) };
+}
@@ lib/_verdict.js:133-140 @@
+function judgeRead(got, what) {
+  if (got === undefined) throw new VerdictRequiredError(`judge(${what}): no store read was passed`, got);
+  if (got === null) return verifiedEmpty(what);
+  if (!isPlainObject(got) || !isPlainObject(got.json)) {
+    return red(what, "not_a_json_object");
+  }
+  return null; // present and an object: the caller's shape rules decide
+}
```

```diff
--- a/api/verify.js
+++ b/api/verify.js
@@ -192,6 +208,22 @@ async function verifyItem(rawNs, rawRows, rawChain, rawDigest) {
   // conclusive: match its chain, or it's a real mismatch, either way done.
-  let seq = Number.isInteger(latest.seq) ? latest.seq - 1 : 0;
+  // No `: 0` here any more: headVerdict already proved latest.seq is an integer.
+  let seq = latest.seq - 1;
--- a/lib/_meter.js
+++ b/lib/_meter.js
@@ -185,5 +191,7 @@ async function check(secret) {
   for (let attempt = 0; attempt < 2; attempt++) {
     const cur = await getUsageFile(path);
-    const used = cur ? Number(cur.json.used) || 0 : 0;
+    // `|| 0` failed OPEN here: a damaged usage file read as "nothing used this
+    // month" and re-opened a spent free tier. See lib/_verdict.js.
+    const used = usedOf(cur);
 
     if (cap !== null && used + 1 > cap) {
```

**What it guarantees.** On `/api/latest`, `/api/verify` and the stamp lookup, the `ok: true` body is built by `success()`, and `success()` throws a named error when it is handed no verdict, a bare `{ok: true}`, or a red verdict, so on those paths a success cannot be assembled by falling through defaults: somebody has to construct a green verdict and pass it in. "Empty / brand new" is a separate green state that the judges mint in one situation only, the store answering 404, so a document that is present but unreadable can no longer arrive at the same value as a document that does not exist. The stored counters (credit balance, monthly usage, daily stamp budget), the directory listings and the status board's one-word verdict follow the same rule by throwing instead of defaulting, which closes the two reads that failed open (a damaged usage counter or day counter reading as zero used).

**What it does not guarantee.** It is a convention with teeth, not a type system: a call site can still write `res.status(200).json({ ok: true })` by hand, or mint `verifiedRecord()` without having looked (the balance, status and key-page paths still assemble their own bodies after a judge that throws), which is why the planted-dead fixture stays on the producer as its own test file; and it says nothing about records that are well-formed and wrong.

**Addendum 2026-09-22.** Two things above are superseded. `judgeRead` no longer returns `null`: a present object now comes back as the typed, non-green verdict `present_unchecked`. And "mint `verifiedRecord()` without having looked" is closed: greens are bound to a `read_id` that only `judgeRead` issues, and `verifiedRecord` / `verifiedEmpty` are no longer exported. See CHANGELOG.md, 2026-09-22 (atomic-raven, Colony post 42b8d6e0). The hand-written `res.status(200).json({ ok: true })` remains the open road, and the planted-dead fixture is still what watches it.
