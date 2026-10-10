'use strict'

/**
 * remoteE2eCrypto.test.cjs — both sides of the E2E handshake derive the same
 * session key + SAS, and the AES-GCM box round-trips / rejects tampering.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/remoteE2eCrypto.test.cjs
 */

import { describe, it, expect } from 'vitest'

const {
  generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox,
} = require('../lib/remoteE2eCrypto.cjs')

const deviceId = 'device-abc-123'

function pair() {
  const a = generateE2EKeyPair()
  const b = generateE2EKeyPair()
  return { a, b }
}

describe('remoteE2eCrypto', () => {
  it('derives identical session key and SAS from each side', () => {
    const { a, b } = pair()
    const keyA = deriveSessionKey(a.e2ePrivateKey, b.e2ePublicKey, deviceId)
    const keyB = deriveSessionKey(b.e2ePrivateKey, a.e2ePublicKey, deviceId)
    expect(keyA.length).toBe(32)
    expect(keyA.equals(keyB)).toBe(true)
    const sasA = deriveSas(a.e2ePrivateKey, b.e2ePublicKey, deviceId)
    const sasB = deriveSas(b.e2ePrivateKey, a.e2ePublicKey, deviceId)
    expect(sasA).toMatch(/^\d{6}$/)
    expect(sasA).toBe(sasB)
  })

  it('encrypts with one side key and decrypts with the other', () => {
    const { a, b } = pair()
    const keyA = deriveSessionKey(a.e2ePrivateKey, b.e2ePublicKey, deviceId)
    const keyB = deriveSessionKey(b.e2ePrivateKey, a.e2ePublicKey, deviceId)
    const box = encryptBox('{"hello":"world"}', keyA)
    expect(decryptBox(box.nonce, box.ciphertext, keyB)).toBe('{"hello":"world"}')
  })

  it('returns falsy for tampered ciphertext and for a wrong key', () => {
    const { a, b } = pair()
    const keyA = deriveSessionKey(a.e2ePrivateKey, b.e2ePublicKey, deviceId)
    const box = encryptBox('secret', keyA)
    const raw = Buffer.from(box.ciphertext, 'base64url')
    raw[0] ^= 0xff
    expect(decryptBox(box.nonce, raw.toString('base64url'), keyA)).toBeFalsy()
    const c = generateE2EKeyPair()
    const wrong = deriveSessionKey(c.e2ePrivateKey, b.e2ePublicKey, deviceId)
    expect(decryptBox(box.nonce, box.ciphertext, wrong)).toBeFalsy()
  })
})
