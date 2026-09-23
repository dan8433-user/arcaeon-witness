// test/rerun_portable.test.js — a check record's `rerun` is published, so it
// must be a public, portable command. 2026-09-23: the daily self-check wrote
// "py C:/Users/<name>/velouria/projects/.../verify.py ..." into every record,
// a Windows user folder name in a field bound for a public repo.
//   - lib/_check_record.js refuses a drive letter, a home-directory path, or a
//     backslash in `rerun` (reason rerun_not_portable), at sign and verify;
//   - tools/publish_self_checks.js refuses such a file in its pre-flight;
//   - the writer (tools/check_and_sign.js, used by tools/self_check_daily.js)
//     names verifier two by its public placeholder, never the local path.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cr = require("../lib/_check_record.js");
const { unsignedRecord } = require("./helpers/check_fixtures.js");
const cas = require("../tools/check_and_sign.js");
const daily = require("../tools/self_check_daily.js");
const pub = require("../tools/publish_self_checks.js");

const kp = cr.generateKeyPair();
const LOCAL = "py C:/Users/USER/velouria/projects/online_business/verifier_two/verify.py https://github.com/dan8433-user/arcaeon-witness-pins --json";
const AT = "2026-09-23T13:40:45Z";
const NOW_S = Math.floor(Date.parse("2026-09-23T14:00:00Z") / 1000);

// Sign past signCheckRecord's refusal, the way a hostile or old writer could.
function forceSigned(over) {
  const rec = unsignedRecord({ checked_at: AT, ...over });
  rec.checker = { ...rec.checker, key: kp.keyId };
  const sig = crypto.sign(null, cr.preimage(rec), kp.privateKey).toString("base64");
  return { ...rec, sig };
}

const NOT_PORTABLE = [
  ["today's exact field", LOCAL],
  ["lower-case drive, backslashes", "py c:\\tools\\verify.py https://github.com/o/r --json"],
  ["drive letter mid-command", "node tools/check_and_sign.js --verify-py D:/v/verify.py --repo https://github.com/o/r"],
  ["a lone backslash", "py verify.py https://github.com/o/r --json \\"],
  ["tilde home", "py ~/src/verify.py https://github.com/o/r --json"],
  ["tilde user", "py ~alice/verify.py https://github.com/o/r"],
  ["/home", "py /home/alice/verify.py https://github.com/o/r"],
  ["/Users", "py /Users/alice/verify.py https://github.com/o/r"],
  ["/root", "py /root/verify.py https://github.com/o/r"],
  ["%USERPROFILE%", "py %USERPROFILE%/verify.py https://github.com/o/r"],
  ["$HOME", "py $HOME/verify.py https://github.com/o/r"],
  ["${HOME}", "py ${HOME}/verify.py https://github.com/o/r"],
  ["$env:", "py $env:USERPROFILE/verify.py https://github.com/o/r"],
];
const PORTABLE = [
  "py verify.py https://github.com/dan8433-user/arcaeon-witness-pins --json > out.json && node tools/check_and_sign.js --from-json out.json --verify-py verify.py --repo https://github.com/dan8433-user/arcaeon-witness-pins --namespace velouria-demo --key your.pem",
  "py verify.py https://github.com/Users/home --json",
  "python3 ./verify.py https://raw.githubusercontent.com/o/r/main --json",
];

test("rerunIsPortable: refuses a drive letter, a home-directory path, or a backslash; keeps relative commands and https URLs", () => {
  for (const [label, s] of NOT_PORTABLE) assert.equal(cr.rerunIsPortable(s), false, label);
  for (const s of PORTABLE) assert.equal(cr.rerunIsPortable(s), true, s);
});

test("REFUSE rerun_not_portable: at sign time, and at verify time for a record signed past the fence", () => {
  for (const [label, s] of NOT_PORTABLE) {
    assert.throws(() => cr.signCheckRecord(unsignedRecord({ rerun: s }), kp.privateKey), (e) => e.reason === "rerun_not_portable" && e.field === "rerun", label);
    const v = cr.verifyCheckRecord(forceSigned({ rerun: s }), { nowSeconds: NOW_S });
    assert.deepEqual([v.ok, v.reason, v.field], [false, "rerun_not_portable", "rerun"], label);
  }
  assert.equal(cr.verifyCheckRecord(forceSigned({ rerun: PORTABLE[0] }), { nowSeconds: NOW_S }).ok, true, "control: the same forced signing passes with a portable rerun");
});

test("PUBLISHER PRE-FLIGHT: a record whose rerun names a local path is refused as rerun_not_portable, and nothing is published", async () => {
  const rec = forceSigned({
    rerun: LOCAL,
    target: { type: "pin", ref: "pins/velouria-demo/00000004.json" },
  });
  const rel = cr.checkRecordPath(rec);
  const r = pub.validateRecordFile({ rel, bytes: Buffer.from(JSON.stringify(rec)) }, { ownKeys: new Set([kp.keyId]), nowSeconds: NOW_S });
  assert.deepEqual([r.ok, r.reason, r.field], [false, "rerun_not_portable", "rerun"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-"));
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(rec, null, 1) + "\n");
  const keys = path.join(dir, "OPERATOR_KEYS.json");
  fs.writeFileSync(keys, JSON.stringify({ keys: [{ key: kp.keyId }] }));
  let err = "";
  let out = "";
  let tokenRead = false;
  const code = await pub.main(["--dir", dir, "--operator-keys", keys, "--date", "2026-09-23", "--now", "2026-09-23T14:00:00Z", "--publish"],
    { out: (s) => { out += s; }, err: (s) => { err += s; } },
    { token: () => { tokenRead = true; return "x"; }, ghImpl: async () => { throw new Error("no network expected"); } });
  assert.equal(code, 2);
  assert.ok(err.includes(`REFUSED  ${rel}  rerun_not_portable (rerun)`), err);
  assert.equal(out, "");
  assert.equal(tokenRead, false, "refused before the token is read");
});

test("WRITER: the daily self-check's record carries the public verifier name, not the local --verify-py path, and passes the publisher", async () => {
  const ns = "velouria-demo";
  const verifierOutput = {
    overall: "VERIFIED",
    results: [
      { check: "pin-record", subject: `pins/${ns}/00000004.json`, verdict: "VERIFIED", detail: "ok" },
    ],
  };
  const localPath = "C:/Users/USER/velouria/projects/online_business/verifier_two/verify.py";
  const repo = "https://github.com/dan8433-user/arcaeon-witness-pins";
  const built = await daily.buildDailyRecords({
    verifierOutput, repo, rawBase: "https://raw.githubusercontent.com/dan8433-user/arcaeon-witness-pins/main",
    fetchBytes: async () => Buffer.from('{"seq":4}\n'), checkedAt: AT, privateKey: kp.privateKey,
    ownKeys: new Set([kp.keyId]), toolSha256: "ab".repeat(32), verifyPyPath: localPath, nowSeconds: NOW_S,
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].error, undefined, built[0].error);
  const rec = built[0].record;
  assert.equal(rec.rerun,
    `py verify.py ${repo} --json > out.json && node tools/check_and_sign.js --from-json out.json --verify-py verify.py --repo ${repo} --namespace ${ns} --key your.pem`);
  assert.equal(rec.rerun, cas.rerunFor(repo, ns));
  assert.equal(cr.PUBLIC_VERIFIER, "verify.py");
  for (const leak of ["C:", "Users", "USER", "projects/", "verifier_two", "\\"]) assert.ok(!rec.rerun.includes(leak), `rerun leaks ${leak}`);
  const r = pub.validateRecordFile({ rel: built[0].rel, bytes: Buffer.from(JSON.stringify(rec, null, 1) + "\n") }, { ownKeys: new Set([kp.keyId]), nowSeconds: NOW_S });
  assert.equal(r.ok, true, JSON.stringify(r));
});
