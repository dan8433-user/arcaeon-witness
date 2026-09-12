// _oauth_crypto.js — hybrid RSA-OAEP(SHA-256) + AES-256-GCM encryption for
// the Google OAuth token payload (api/oauth/google/callback.js).
// Underscore prefix = not routed as a serverless function by Vercel.
//
// Why hybrid: RSA-OAEP has a payload-size ceiling well under what a Google
// token JSON (access_token + refresh_token + scope) needs, so a random
// AES-256-GCM key encrypts the actual JSON and RSA-OAEP-SHA256 wraps only
// that 32-byte key. Output shape: {alg, ek, iv, tag, ct} — every field
// base64, matching what bridge/google_oauth/receiver.py unwraps on the
// velouria side. This module only ever encrypts; there is no decrypt
// function here on purpose — the private key that could decrypt never
// touches this repo or this process.

"use strict";

const crypto = require("crypto");

const ALG = "RSA-OAEP-256+A256GCM";
const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12; // standard GCM nonce size

function encryptForReceiver(pubkeyPem, plaintextObj) {
  if (!pubkeyPem || typeof pubkeyPem !== "string") {
    throw new Error("encryptForReceiver: pubkeyPem is required");
  }
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), "utf-8");

  const aesKey = crypto.randomBytes(AES_KEY_BYTES);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ek = crypto.publicEncrypt(
    {
      key: pubkeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey
  );

  return {
    alg: ALG,
    ek: ek.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

module.exports = { encryptForReceiver, ALG, AES_KEY_BYTES, GCM_IV_BYTES };
