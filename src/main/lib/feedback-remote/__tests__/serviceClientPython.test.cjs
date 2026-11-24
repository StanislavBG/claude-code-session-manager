'use strict';

// Proves the paired-service protocol with a second implementation: the Python
// reference client (session-manager-operations/architecture/reference/sm_service_client.py)
// must derive the same session key, SAS and boxes as remoteE2eCrypto.cjs for the
// same fixed keys. Vector test only — no network. Missing python3 or the
// `cryptography` package FAILS the test (no silent skip).

const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
import { describe, it, expect, beforeAll } from 'vitest';

const { deriveSessionKey, deriveSas, encryptBox, decryptBox } = require('../remoteE2eCrypto.cjs');
const { pickDevice } = require('../serviceClient.cjs');

const REPO = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(REPO, 'session-manager-operations/architecture/reference/sm_service_client.py');

// Fixed P-256 vectors (generated once with generateE2EKeyPair).
const SERVICE_PRIV = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtQlnIbr2vRXPZkC37OBIqVgK5MFzEmC2trWhVG9WevChRANCAASKesEnhw0OYUj5xPZwqtV4fGRGi3SAxdXqQHVKOQaAbWNPwk6lkSo45yZ0g4paJyVfJuDmH-jfddm37hr8b4W0';
const SERVICE_PUB = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEinrBJ4cNDmFI-cT2cKrVeHxkRot0gMXV6kB1SjkGgG1jT8JOpZEqOOcmdIOKWiclXybg5h_o33XZt-4a_G-FtA';
const DESKTOP_PRIV = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5IGyKXqX__chfj5etKI9bkO_DVej3Qv2cp_AVoAM6PqhRANCAARQElFHjlw9jL8SuyvqEDsjxTcDwZ5BMwIiZmguC-2I4h3utlHu_VfT50BoklihD5vHsceT1OL372ZMOhvPHIkw';
const DESKTOP_PUB = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUBJRR45cPYy_Ersr6hA7I8U3A8GeQTMCImZoLgvtiOId7rZR7v1X0-dAaJJYoQ-bx7HHk9Ti9-9mTDobzxyJMA';
const DEVICE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NONCE = 'AAECAwQFBgcICQoL'; // bytes 0..11
const PLAINTEXT = JSON.stringify({ type: 'mcp:result', id: 'x', payload: { jsonrpc: '2.0', id: 'svc-1', result: { ok: 'ünïcødé' } } });

function runPython(args, input) {
  return spawnSync('python3', ['-I', ...args], { input, encoding: 'utf8', timeout: 60_000 });
}

/** Fail loudly naming the missing piece. */
function requirePython() {
  const probe = runPython(['-c', 'import sys; print(sys.version)']);
  if (probe.error && probe.error.code === 'ENOENT') {
    throw new Error('python3 is missing: install Python 3 so the reference client can be checked');
  }
  if (probe.error || probe.status !== 0) {
    throw new Error(`python3 failed to run: ${probe.error ? probe.error.message : probe.stderr}`);
  }
  const crypt = runPython(['-c', 'import cryptography']);
  if (crypt.status !== 0) {
    throw new Error(`python3 'cryptography' package is missing: pip install cryptography (${String(crypt.stderr).trim().split('\n').pop()})`);
  }
}

function encryptWithNonce(plaintext, key, nonceB64) {
  const nonce = Buffer.from(nonceB64, 'base64url');
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonceB64, ciphertext: enc.toString('base64url') };
}

function vectors(extra = {}) {
  const key = deriveSessionKey(SERVICE_PRIV, DESKTOP_PUB, DEVICE_ID);
  return {
    privateKey: SERVICE_PRIV,
    peerPublicKey: DESKTOP_PUB,
    deviceId: DEVICE_ID,
    box: encryptBox(PLAINTEXT, key),
    plaintext: PLAINTEXT,
    nonce: NONCE,
    ...extra,
  };
}

function runVectors(v) {
  const res = runPython([SCRIPT, '--vectors'], JSON.stringify(v));
  if (res.status !== 0) throw new Error(`sm_service_client.py --vectors failed (${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe('sm_service_client.py matches remoteE2eCrypto.cjs', () => {
  beforeAll(() => { requirePython(); });

  it('derives the same session key and SAS as both Node sides', () => {
    const out = runVectors(vectors());
    const serviceKey = deriveSessionKey(SERVICE_PRIV, DESKTOP_PUB, DEVICE_ID);
    const desktopKey = deriveSessionKey(DESKTOP_PRIV, SERVICE_PUB, DEVICE_ID);
    expect(desktopKey.equals(serviceKey)).toBe(true);
    expect(out.sessionKey).toBe(serviceKey.toString('base64url'));
    expect(out.sas).toMatch(/^\d{6}$/);
    expect(out.sas).toBe(deriveSas(SERVICE_PRIV, DESKTOP_PUB, DEVICE_ID));
    expect(out.sas).toBe(deriveSas(DESKTOP_PRIV, SERVICE_PUB, DEVICE_ID));
  });

  it('decrypts a Node box and seals one Node opens, byte-for-byte', () => {
    const v = vectors();
    const out = runVectors(v);
    expect(out.decrypted).toBe(PLAINTEXT);
    const desktopKey = deriveSessionKey(DESKTOP_PRIV, SERVICE_PUB, DEVICE_ID);
    expect(out.box).toEqual(encryptWithNonce(PLAINTEXT, desktopKey, NONCE));
    expect(decryptBox(out.box.nonce, out.box.ciphertext, desktopKey)).toBe(PLAINTEXT);
  });

  it('rejects a tampered box', () => {
    const v = vectors();
    const bad = Buffer.from(v.box.ciphertext, 'base64url');
    bad[0] ^= 1;
    const out = runVectors({ ...v, box: { nonce: v.box.nonce, ciphertext: bad.toString('base64url') } });
    expect(out.decrypted).toBeNull();
  });

  it('a different deviceId salt gives a different key', () => {
    const out = runVectors({ ...vectors(), deviceId: 'bbbbbbbb-2222-4222-8222-222222222222' });
    expect(out.sessionKey).toBe(deriveSessionKey(SERVICE_PRIV, DESKTOP_PUB, 'bbbbbbbb-2222-4222-8222-222222222222').toString('base64url'));
    expect(out.sessionKey).not.toBe(deriveSessionKey(SERVICE_PRIV, DESKTOP_PUB, DEVICE_ID).toString('base64url'));
  });

  it('picks the device like serviceClient.cjs', () => {
    const devices = [
      { deviceId: 'aaaaaaaa-1111-4111-8111-111111111111' },
      { deviceId: 'bbbbbbbb-2222-4222-8222-222222222222' },
      { deviceId: 'aaaaaaab-3333-4333-8333-333333333333' },
    ];
    const nodePick = (list, device) => {
      try { return pickDevice(list, device).deviceId; } catch (e) { return { error: e.code }; }
    };
    const cases = [
      [devices.slice(0, 1), undefined],
      [devices, undefined],
      [devices, 'bbbbbb'],
      [devices, 'aaaaaa'],
      [devices, 'aaaaaaab'],
      [devices, 'bbb'],
      [devices, 'cccccc'],
    ];
    for (const [list, device] of cases) {
      const extra = device === undefined ? { devices: list } : { devices: list, device };
      expect(runVectors(vectors(extra)).picked).toEqual(nodePick(list, device));
    }
  });
});
