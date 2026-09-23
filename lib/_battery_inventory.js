// _battery_inventory.js — a check battery that can tell you it was not there.
//
// WHY (2026-09-23). A correspondent found three of the four selftest
// functions in their library defined and called by nothing, while the daily
// beat had reported "the battery ran" green for days. A battery that cannot
// see its own missing members reports green by construction. This module is
// the guard: every run compares the check functions DEFINED in the battery's
// own source file against the check functions the runner actually CALLED on
// that run, and says so in one line:
//
//   battery: N defined, M called, K orphaned [names]
//
// K > 0 is red. The line prints on every run, green or not.
//
// DEFINED is read by a plain parser over the source text, not from the
// registry, so a function someone added and forgot to register still counts:
// a line that starts (after whitespace) with `function check_<name>(`,
// `async function check_<name>(`, or `const|let|var check_<name> =` bound to
// a function or arrow. Comment lines do not match (they start with // or *).
// CALLED is what the runner recorded as it invoked each check (the runner
// adds fn.name to a Set before the call), so a registered check the loop
// skips is caught too. ORPHANED = defined and not called.

"use strict";

const DEF_PATTERNS = [
  /^[ \t]*(?:async[ \t]+)?function[ \t]*\*?[ \t]*(check_[A-Za-z0-9_$]+)[ \t]*\(/gm,
  /^[ \t]*(?:const|let|var)[ \t]+(check_[A-Za-z0-9_$]+)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function\b|\(|[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=>)/gm,
];

// Every check function defined in `source`, sorted, each name once.
function definedChecks(source) {
  const out = new Set();
  for (const re of DEF_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(String(source))) !== null) out.add(m[1]);
  }
  return [...out].sort();
}

// Compare. `called` is any iterable of names the runner recorded.
// Returns {defined, called, orphaned, ok, line}.
function inventory({ source, called }) {
  const defined = definedChecks(source);
  const calledSet = new Set(called || []);
  const orphaned = defined.filter((n) => !calledSet.has(n));
  const calledDefined = defined.filter((n) => calledSet.has(n));
  return {
    defined,
    called: [...calledSet].sort(),
    orphaned,
    ok: orphaned.length === 0 && defined.length > 0,
    line: batteryLine(defined.length, calledDefined.length, orphaned),
  };
}

function batteryLine(nDefined, nCalled, orphaned) {
  return `battery: ${nDefined} defined, ${nCalled} called, ${orphaned.length} orphaned [${orphaned.join(", ")}]`;
}

// Run `fn` and record that it was called, by its own name, before the call:
// a check that throws was still called.
function callRecorded(called, fn, ...args) {
  called.add(fn.name);
  return fn(...args);
}

module.exports = { definedChecks, inventory, batteryLine, callRecorded };
