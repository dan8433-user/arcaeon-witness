// test/helpers/stripe_sign.js — builds a valid `stripe-signature` header the
// same way stripe-webhook.js's verifyStripeSignature() checks one: hex HMAC-
// SHA256 over the RAW bytes `${t}.${rawBody}`. Not a test file.

"use strict";

const crypto = require("crypto");

function stripeSigHeader(secret, rawBody, t) {
  const ts = t || Math.floor(Date.now() / 1000);
  const payload = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), rawBody]);
  const v1 = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${ts},v1=${v1}`;
}

module.exports = { stripeSigHeader };
