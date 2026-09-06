import { describe, expect, it, vi } from 'vitest'
import { loadPackagedMobileRuntimeIdentity } from '../src/runtime-identity.ts'

const IDENTITY = {
  version: 1,
  origin: 'https://www.beikejiedeliulangmao.top',
  callbackUrl: 'https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback',
  githubClientId: 'client-id',
  credentialReference: 'credentials://production',
  databaseIdentity: 'database-production',
  identityNamespace: 'namespace-production',
}

describe('packaged Mobile runtime identity', () => {
  it('loads the exact packaged record used by product boot', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(IDENTITY)))
    await expect(loadPackagedMobileRuntimeIdentity(fetch)).resolves.toEqual({
      VITE_PLATFORM_ORIGIN: IDENTITY.origin,
      VITE_PLATFORM_CALLBACK_URL: IDENTITY.callbackUrl,
      VITE_PLATFORM_GITHUB_CLIENT_ID: IDENTITY.githubClientId,
      VITE_PLATFORM_CREDENTIAL_REFERENCE: IDENTITY.credentialReference,
      VITE_PLATFORM_DATABASE_IDENTITY: IDENTITY.databaseIdentity,
      VITE_PLATFORM_IDENTITY_NAMESPACE: IDENTITY.identityNamespace,
    })
    expect(fetch).toHaveBeenCalledWith('/dsh-mobile-runtime-identity.json', {
      cache: 'no-store', credentials: 'same-origin',
    })
  })

  it('rejects missing, version-skewed, and expanded records', async () => {
    for (const value of [
      { ...IDENTITY, origin: undefined },
      { ...IDENTITY, version: 2 },
      { ...IDENTITY, extra: 'unexpected' },
    ]) {
      const fetch = vi.fn(async () => new Response(JSON.stringify(value)))
      await expect(loadPackagedMobileRuntimeIdentity(fetch)).rejects.toThrow('runtime identity')
    }
  })
})
