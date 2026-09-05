import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isCaptureFormat, signPhoneStreamToken, verifyPhoneStreamToken } from '../src/token.ts'

const SECRET = randomBytes(32)
const OTHER = randomBytes(32)

describe('phone stream capability tokens', () => {
  it('accepts a freshly signed token at or before expiry', () => {
    const expiresAt = 1_700_000_030_000
    const token = signPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', expiresAt)
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', token, expiresAt)).toEqual({
      deviceId: 'emulator-5554',
      format: 'mjpeg',
      captureId: token,
      expiresAt,
    })
  })

  it('mints a unique identity for equal grants', () => {
    const expiresAt = 1_700_000_030_000
    const first = signPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', expiresAt)
    const second = signPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', expiresAt)
    expect(second).not.toBe(first)
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', first, expiresAt)?.captureId).toBe(first)
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', second, expiresAt)?.captureId).toBe(second)
  })

  it('refuses an expired token, a forged signature, and a path mismatch', () => {
    const expiresAt = 1_700_000_030_000
    const token = signPhoneStreamToken(SECRET, 'emulator-5554', 'h264', expiresAt)
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'h264', token, expiresAt + 1)).toBeUndefined()
    expect(verifyPhoneStreamToken(OTHER, 'emulator-5554', 'h264', token, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'SIM-UDID', 'h264', token, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', token, expiresAt)).toBeUndefined()
  })

  it('refuses noncanonical expiry and signature aliases', () => {
    const expiresAt = 1_700_000_030_000
    const token = signPhoneStreamToken(SECRET, 'id', 'mjpeg', expiresAt)
    const [expiry, nonce, signature] = token.split('.')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `0${expiry}.${nonce}.${signature}`, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${expiry}.${nonce}.${signature}=`, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${expiry}.${nonce}.${signature}==`, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${expiry}.${nonce}=.${signature}`, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${expiry}.${nonce}A.${signature}`, expiresAt)).toBeUndefined()
  })

  it('refuses cryptographically valid signatures over noncanonical token text', () => {
    const expiresAt = 1_700_000_030_000
    const nonce = randomBytes(18).toString('base64url')
    const expiryText = `0${String(expiresAt)}`
    const expirySignature = createHmac('sha256', SECRET).update(`id\nmjpeg\n${expiryText}\n${nonce}`).digest('base64url')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${expiryText}.${nonce}.${expirySignature}`, expiresAt)).toBeUndefined()
    const paddedNonce = `${nonce}=`
    const nonceSignature = createHmac('sha256', SECRET).update(`id\nmjpeg\n${String(expiresAt)}\n${paddedNonce}`).digest('base64url')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', `${String(expiresAt)}.${paddedNonce}.${nonceSignature}`, expiresAt)).toBeUndefined()
  })

  it('refuses valid HMACs over invalid nonce lengths and unsafe expiry text', () => {
    const expiresAt = 1_700_000_030_000
    const shortNonce = randomBytes(17).toString('base64url')
    const shortSignature = createHmac('sha256', SECRET).update(`id\nh264\n${String(expiresAt)}\n${shortNonce}`).digest('base64url')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'h264', `${String(expiresAt)}.${shortNonce}.${shortSignature}`, expiresAt)).toBeUndefined()
    const unsafe = String(Number.MAX_SAFE_INTEGER + 1)
    const nonce = randomBytes(18).toString('base64url')
    const unsafeSignature = createHmac('sha256', SECRET).update(`id\nh264\n${unsafe}\n${nonce}`).digest('base64url')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'h264', `${unsafe}.${nonce}.${unsafeSignature}`, 1)).toBeUndefined()
  })

  it('refuses extra token segments and signature canonical aliases', () => {
    const expiresAt = 1_700_000_030_000
    const token = signPhoneStreamToken(SECRET, 'id', 'h264', expiresAt)
    expect(verifyPhoneStreamToken(SECRET, 'id', 'h264', `${token}.extra`, expiresAt)).toBeUndefined()
    const [expiry, nonce, signature] = token.split('.')
    expect(verifyPhoneStreamToken(SECRET, 'id', 'h264', `${expiry}.${nonce}.${signature}=`, expiresAt)).toBeUndefined()
  })

  it('refuses malformed tokens and unknown encodings', () => {
    expect(isCaptureFormat('avc')).toBe(false)
    expect(isCaptureFormat('mjpeg')).toBe(true)
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', 'not-a-token', 1)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', '.sig', 1)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'mjpeg', 'abc.sig', 1)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'id', 'avc', '1.sig', 1)).toBeUndefined()
  })
})
