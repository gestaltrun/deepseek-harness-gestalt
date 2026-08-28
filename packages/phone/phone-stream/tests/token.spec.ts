import { randomBytes } from 'node:crypto'
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
      expiresAt,
    })
  })

  it('refuses an expired token, a forged signature, and a path mismatch', () => {
    const expiresAt = 1_700_000_030_000
    const token = signPhoneStreamToken(SECRET, 'emulator-5554', 'h264', expiresAt)
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'h264', token, expiresAt + 1)).toBeUndefined()
    expect(verifyPhoneStreamToken(OTHER, 'emulator-5554', 'h264', token, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'SIM-UDID', 'h264', token, expiresAt)).toBeUndefined()
    expect(verifyPhoneStreamToken(SECRET, 'emulator-5554', 'mjpeg', token, expiresAt)).toBeUndefined()
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
