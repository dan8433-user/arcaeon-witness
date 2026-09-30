// _contents.js — the one decoder every GitHub contents-API file reader goes
// through (queue task 171, 2026-09-29).
//
// Before this, the six readers (lib/_store.js getFile + getRawFile,
// _balance.js getFile, _keys.js getFile, _meter.js getUsageFile,
// _pending.js readUsageDoc) each did `Buffer.from(body.content, "base64")`
// and trusted the result. Two shapes slipped through that:
//
//   - GitHub answers a file over 1 MB with `content: ""` and
//     `encoding: "none"`. Decoding "" as base64 is "", and the caller's
//     JSON.parse fails — closed, but by accident, and as a SyntaxError that
//     api/latest.js reads as a damaged record (and getRawFile does not parse
//     at all: it would have returned "" as the anchor text).
//   - A 200 whose `content` is shorter than the file it claims to be (a
//     truncated or substituted body). A truncation that still parses is a
//     different record that reads as the real one.
//
// So: `encoding` must be "base64", `size` must be a non-negative integer, and
// the decoded byte length must equal `size`. Anything else throws
// StoreFileUnreadableError. Its message carries the class word and code and
// never the path (the private-repo readers redact paths; callers put
// err.message verbatim in a 5xx body), so the caller that answers a store
// failure the usual way answers this one the same way.

"use strict";

const CODE = "store_file_unreadable";

class StoreFileUnreadableError extends Error {
  constructor(where, reason) {
    super(`${where || "store read"}: stored file unreadable (StoreFileUnreadableError ${CODE}: ${reason})`);
    this.name = "StoreFileUnreadableError";
    this.code = CODE;
    this.reason = reason;
    // Same flag lib/_pending.js already sets on a read it could not complete:
    // "I cannot see it", never "it is not there".
    this.unreadable = true;
  }
}

// `body` is the parsed JSON of a contents-API 200. Returns the file bytes as
// a UTF-8 string. `where` is a caller-chosen, path-free label.
function decodeContents(body, where) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new StoreFileUnreadableError(where, "not_a_file_object");
  }
  if (body.encoding !== "base64") {
    throw new StoreFileUnreadableError(where, `encoding_not_base64 (${JSON.stringify(body.encoding === undefined ? null : body.encoding)})`);
  }
  if (typeof body.content !== "string") {
    throw new StoreFileUnreadableError(where, "content_not_a_string");
  }
  if (!Number.isInteger(body.size) || body.size < 0) {
    throw new StoreFileUnreadableError(where, "size_not_an_integer");
  }
  const bytes = Buffer.from(body.content, "base64");
  if (bytes.length !== body.size) {
    throw new StoreFileUnreadableError(where, `size_mismatch (decoded ${bytes.length}, size ${body.size})`);
  }
  return bytes.toString("utf-8");
}

module.exports = { StoreFileUnreadableError, decodeContents, CODE };
