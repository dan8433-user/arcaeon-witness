// test/helpers/mock_store.js — in-memory stand-in for the GitHub contents API
// that api/_store.js, api/_balance.js, and api/_meter.js all talk to over
// `fetch`. Not a test file itself (no `test()` calls) — a fixture the real
// test files require and drive.
//
// Contract mirrored from the real GitHub Contents API, as consumed by the
// three modules under test (read their getFile/putFile pairs before touching
// this — the CAS conflict shape is load-bearing to every regression here):
//
//   GET  /repos/<repo>/contents/<path>?ref=<branch>
//        -> 200 {content:<base64>, sha:<hex>}   | 404 if missing
//
//   PUT  /repos/<repo>/contents/<path>
//        body {message, branch, content:<base64>, sha?}
//        - sha OMITTED  + file exists     -> 422 {message:'..."sha" wasn\'t supplied...'}
//                                             (the CREATE-race shape; _store.js /
//                                             _balance.js / _meter.js all regex-match
//                                             this to set err.conflict = true)
//        - sha OMITTED  + file absent     -> 200, file created
//        - sha PROVIDED + doesn't match   -> 409 (the UPDATE-race shape)
//        - sha PROVIDED + matches         -> 200, file updated
//        on success: {content:{sha}, commit:{sha}}  (real shape; pin.js reads
//        `put.commit.sha` off exactly this)
//
// `forceConflict(repo, path, n)` lets a regression test simulate n concurrent
// writers colliding on one path — the shape that made THE money bug possible
// (two overlapping Stripe deliveries both winning a stale read).

"use strict";

const crypto = require("crypto");

function fakeResponse(status, bodyObj) {
  const bodyText = JSON.stringify(bodyObj);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => bodyObj,
    text: async () => bodyText,
  };
}

class MockGitHubStore {
  constructor() {
    this.repos = new Map(); // repo -> Map(path -> {content, sha})
    this.commitCounter = 0;
    this.putLog = []; // [{repo, path, sha}] — every successful write, in order
    this._forced = new Map(); // "repo::path" -> remaining forced-conflict count
  }

  _repoMap(repo) {
    if (!this.repos.has(repo)) this.repos.set(repo, new Map());
    return this.repos.get(repo);
  }

  _newSha() {
    return crypto.randomBytes(20).toString("hex");
  }

  // Seed a file as it would exist BEFORE any handler under test runs.
  seed(repo, path, obj) {
    this._repoMap(repo).set(path, {
      content: JSON.stringify(obj, null, 2) + "\n",
      sha: this._newSha(),
    });
  }

  // Read back the current stored JSON for a path (test assertions).
  read(repo, path) {
    const rec = this._repoMap(repo).get(path);
    return rec ? JSON.parse(rec.content) : null;
  }

  has(repo, path) {
    return this._repoMap(repo).has(path);
  }

  // Force the next `n` PUTs to `path` to fail as a 409 conflict, regardless
  // of the sha sent — simulates n-1 losers of a concurrent-write race.
  forceConflict(repo, path, n = 1) {
    this._forced.set(`${repo}::${path}`, n);
  }

  async handleFetch(url, opts) {
    const u = new URL(String(url));
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (!m) return fakeResponse(404, { message: `mock: unhandled path ${u.pathname}` });

    const repo = m[1];
    const path = decodeURIComponent(m[2]);
    const method = (opts && opts.method) || "GET";
    const map = this._repoMap(repo);

    if (method === "GET") {
      const rec = map.get(path);
      if (!rec) return fakeResponse(404, { message: "Not Found" });
      return fakeResponse(200, {
        content: Buffer.from(rec.content, "utf-8").toString("base64"),
        sha: rec.sha,
      });
    }

    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      const cur = map.get(path);
      const forceKey = `${repo}::${path}`;
      const forced = this._forced.get(forceKey);
      if (forced && forced > 0) {
        this._forced.set(forceKey, forced - 1);
        return fakeResponse(409, { message: "mock: forced conflict (simulated racing writer)" });
      }

      if (body.sha) {
        if (!cur || cur.sha !== body.sha) {
          return fakeResponse(409, { message: "sha does not match current file sha" });
        }
      } else if (cur) {
        // Create-race shape: two writers both tried to create the same
        // not-yet-existing file. GitHub's real error text for this.
        return fakeResponse(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      }

      const decoded = Buffer.from(body.content, "base64").toString("utf-8");
      const newSha = this._newSha();
      map.set(path, { content: decoded, sha: newSha });
      this.commitCounter += 1;
      this.putLog.push({ repo, path, sha: newSha });
      return fakeResponse(200, {
        content: { sha: newSha, path },
        commit: { sha: `commit-${this.commitCounter}` },
      });
    }

    if (method === "DELETE") {
      map.delete(path);
      return fakeResponse(200, { ok: true });
    }

    return fakeResponse(405, { message: `mock: unsupported method ${method}` });
  }
}

// Patches global.fetch to route through `store`. Returns a restore function —
// ALWAYS call it in an afterEach, or one test's mock store leaks into the next.
function install(store) {
  const original = global.fetch;
  global.fetch = (url, opts) => store.handleFetch(url, opts);
  return function restore() {
    global.fetch = original;
  };
}

module.exports = { MockGitHubStore, install };
