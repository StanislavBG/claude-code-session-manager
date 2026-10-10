'use strict';

// E2E encryption helpers (P-256 ECDH + AES-256-GCM, ADR §5.2).
// Shared by the agent side (webRemote.cjs) and the desktop client role.

const crypto = require('node:crypto');

/**
 * Generate a P-256 ECDH keypair. Public key is SPKI DER base64url; private key
 * is PKCS8 DER base64url. Both are stored in web-remote.json at 0600.
 */
function generateE2EKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    e2ePrivateKey: privateKey.toString('base64url'),
    e2ePublicKey: publicKey.toString('base64url'),
  };
}

/**
 * Derive an AES-256-GCM session key from two P-256 public keys via ECDH + HKDF.
 * @param myPrivateKeyB64  Agent's PKCS8 private key, base64url DER
 * @param peerPublicKeyB64 Browser's SPKI public key, base64url DER
 * @param deviceId         Used as HKDF salt for domain separation
 * @returns 32-byte Buffer (AES-256-GCM key)
 */
function deriveSessionKey(myPrivateKeyB64, peerPublicKeyB64, deviceId) {
  const myPrivKey = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const peerPubKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyB64, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: myPrivKey, publicKey: peerPubKey });
  // HKDF: salt = deviceId bytes for domain separation, info = fixed protocol label.
  const salt = Buffer.from(deviceId, 'utf8');
  const info = Buffer.from('sm-e2e-v1', 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

/**
 * Derive a 6-digit Short Authentication String from the ECDH shared secret.
 * Uses a separate HKDF info label ('sm-sas-v1') so the SAS is independent of
 * the session key. Both sides compute the same value; user confirms they match.
 */
function deriveSas(myPrivateKeyB64, peerPublicKeyB64, deviceId) {
  const myPrivKey = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const peerPubKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyB64, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: myPrivKey, publicKey: peerPubKey });
  const salt = Buffer.from(deviceId, 'utf8');
  const info = Buffer.from('sm-sas-v1', 'utf8');
  const sasBytes = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 3));
  const sasNum = ((sasBytes[0] << 16) | (sasBytes[1] << 8) | sasBytes[2]) % 1_000_000;
  return sasNum.toString().padStart(6, '0');
}

/**
 * Encrypt a plaintext JSON string into an AES-256-GCM box.
 * @returns { nonce: base64url, ciphertext: base64url } — the nonce is 12 random bytes
 */
function encryptBox(plaintext, sessionKey) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16-byte GCM authentication tag
  return {
    nonce: nonce.toString('base64url'),
    // Append the GCM tag to the ciphertext so decryptBox can locate it.
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64url'),
  };
}

/**
 * Decrypt an AES-256-GCM box produced by encryptBox (or the browser's equivalent).
 * @returns Decrypted UTF-8 string, or null if authentication fails.
 */
function decryptBox(nonceB64, ciphertextB64, sessionKey) {
  try {
    const nonce = Buffer.from(nonceB64, 'base64url');
    const data = Buffer.from(ciphertextB64, 'base64url');
    if (data.length < 16) return null; // too short to contain tag
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plain;
  } catch {
    return null; // authentication failed — drop the message
  }
}

module.exports = { generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox };
