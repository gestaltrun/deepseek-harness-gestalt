import { describe, expect, it } from 'vitest'
import { loadMobilePlatformEnvironment } from '../src/platform-environment.ts'

const OPERATED = {
  VITE_PLATFORM_ORIGIN: 'https://platform.example.com',
  VITE_PLATFORM_CALLBACK_URL: 'https://platform.example.com/v1/account/oauth/github/callback',
  VITE_PLATFORM_GITHUB_CLIENT_ID: 'mobile-production',
  VITE_PLATFORM_CREDENTIAL_REFERENCE: 'credentials://production',
  VITE_PLATFORM_DATABASE_IDENTITY: 'database-production',
  VITE_PLATFORM_IDENTITY_NAMESPACE: 'gestalt-production',
}

describe('Mobile operated Platform environment', () => {
  it('loads one complete production identity', () => {
    expect(loadMobilePlatformEnvironment(OPERATED)).toMatchObject({
      environment: 'production',
      origin: OPERATED.VITE_PLATFORM_ORIGIN,
      callbackUrl: OPERATED.VITE_PLATFORM_CALLBACK_URL,
    })
  })

  it('rejects missing, local, and legacy development selection before app mount', () => {
    expect(() => loadMobilePlatformEnvironment({ ...OPERATED, VITE_PLATFORM_CALLBACK_URL: undefined }))
      .toThrow('production callback URL is required')
    expect(() => loadMobilePlatformEnvironment({ ...OPERATED, VITE_PLATFORM_ORIGIN: 'https://localhost' }))
      .toThrow('must not use a local host')
    expect(() => loadMobilePlatformEnvironment({ ...OPERATED, VITE_PLATFORM_ENV: 'development' }))
      .toThrow('legacy environment selection is not accepted')
  })
})
