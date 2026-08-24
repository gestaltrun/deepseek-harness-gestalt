import { describe, expect, it } from 'vitest'
import {
  platformEnvironmentSurfaces,
  platformLogRetainable,
  platformOperationEvent,
  parsePlatformEnvironment,
  requirePlatformSecret,
} from '../src/platform-operations.ts'

describe('Platform operations', () => {
  it('isolates development and production and rejects arbitrary environments', () => {
    expect(parsePlatformEnvironment('development')).toBe('development')
    expect(parsePlatformEnvironment('production')).toBe('production')
    expect(() => parsePlatformEnvironment('staging')).toThrow('development or production')
    expect(platformEnvironmentSurfaces('development').database).not
      .toBe(platformEnvironmentSurfaces('production').database)
  })

  it('fails closed on a missing deployment-managed secret', () => {
    const refs = new Map([['postgres', 'ref-pg'], ['redis', 'ref-redis'], ['oss', 'ref-oss'], ['github', 'ref-gh']])
    expect(requirePlatformSecret(refs, 'postgres')).toBe('ref-pg')
    expect(() => requirePlatformSecret(new Map(), 'redis')).toThrow('redis is missing')
  })

  it('emits content-free events and expires raw IP, security, and live-route logs', () => {
    expect(platformOperationEvent({ category: 'authentication' }).error).toBeUndefined()
    const event = platformOperationEvent({ category: 'revocation', error: 'quota' })
    expect(event.requestId.length).toBeGreaterThan(0)
    expect(event.pseudonym.startsWith('hmac-')).toBe(true)
    expect(JSON.stringify(event)).not.toMatch(/token|ciphertext|device/i)
    expect(platformLogRetainable('raw-ip', 6)).toBe(true)
    expect(platformLogRetainable('raw-ip', 7)).toBe(false)
    expect(platformLogRetainable('security-event', 29)).toBe(true)
    expect(platformLogRetainable('security-event', 30)).toBe(false)
    expect(platformLogRetainable('live-route', 0)).toBe(false)
  })
})
