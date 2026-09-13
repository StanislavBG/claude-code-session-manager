import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

async function freshModule() {
  vi.resetModules();
  return import('../e2eKeyStore');
}

async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  ) as Promise<CryptoKeyPair>;
}

describe('e2eKeyStore', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
  });

  it('round-trips a saved keypair through a simulated reload', async () => {
    const { saveKeyPair } = await freshModule();
    const keyPair = await generateP256KeyPair();
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyB64 = Buffer.from(new Uint8Array(spki)).toString('base64');

    await saveKeyPair('device-a', keyPair.privateKey, publicKeyB64);

    // Simulate a page reload with a fresh module import.
    const { loadKeyPair } = await freshModule();
    const loaded = await loadKeyPair('device-a');

    expect(loaded).not.toBeNull();
    expect(loaded?.publicKeyB64).toBe(publicKeyB64);
    expect(loaded?.privateKey.type).toBe('private');
  });

  it('returns null for an unknown deviceId', async () => {
    const { loadKeyPair } = await freshModule();
    const loaded = await loadKeyPair('never-seen-device');
    expect(loaded).toBeNull();
  });

  it('stores independent keypairs per deviceId', async () => {
    const { saveKeyPair, loadKeyPair } = await freshModule();
    const keyPairA = await generateP256KeyPair();
    const keyPairB = await generateP256KeyPair();
    const spkiA = await crypto.subtle.exportKey('spki', keyPairA.publicKey);
    const spkiB = await crypto.subtle.exportKey('spki', keyPairB.publicKey);
    const pubA = Buffer.from(new Uint8Array(spkiA)).toString('base64');
    const pubB = Buffer.from(new Uint8Array(spkiB)).toString('base64');

    await saveKeyPair('device-a', keyPairA.privateKey, pubA);
    await saveKeyPair('device-b', keyPairB.privateKey, pubB);

    const loadedA = await loadKeyPair('device-a');
    const loadedB = await loadKeyPair('device-b');

    expect(loadedA?.publicKeyB64).toBe(pubA);
    expect(loadedB?.publicKeyB64).toBe(pubB);
    expect(loadedA?.publicKeyB64).not.toBe(loadedB?.publicKeyB64);
  });
});
