import { afterEach, describe, expect, it, vi } from 'vitest'
import { mobileRuntimeIdentity } from '../vite-runtime-identity.ts'

const ENV = {
  VITE_PLATFORM_ORIGIN: 'https://www.beikejiedeliulangmao.top',
  VITE_PLATFORM_CALLBACK_URL: 'https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback',
  VITE_PLATFORM_GITHUB_CLIENT_ID: 'client-id',
  VITE_PLATFORM_CREDENTIAL_REFERENCE: 'credentials://production',
  VITE_PLATFORM_DATABASE_IDENTITY: 'database-production',
  VITE_PLATFORM_IDENTITY_NAMESPACE: 'namespace-production',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Mobile runtime identity Vite plugin', () => {
  it('emits the same validated identity for Web, Android, and iOS packaging', async () => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value)
    const plugin = mobileRuntimeIdentity()
    const configResolved = hook(plugin.configResolved)
    const generateBundle = hook(plugin.generateBundle)
    await configResolved({ mode: 'production', root: '/missing' } as never)
    const emitted: unknown[] = []
    await generateBundle.call({ emitFile: (value: unknown) => emitted.push(value) } as never, {} as never, {} as never, false)
    expect(emitted).toHaveLength(1)
    const asset = emitted[0]
    if (typeof asset !== 'object' || asset === null || !('source' in asset)) throw new Error('expected runtime identity asset')
    expect(asset).toMatchObject({ type: 'asset', fileName: 'dsh-mobile-runtime-identity.json' })
    expect(asset.source).toEqual(expect.stringContaining(ENV.VITE_PLATFORM_ORIGIN))
  })

  it('fails configuration before serving or building when identity is missing', async () => {
    const configResolved = hook(mobileRuntimeIdentity().configResolved)
    await expect(Promise.resolve().then(() => configResolved({ mode: 'production', root: '/missing' } as never)))
      .rejects.toThrow('production origin is required')
  })
})

function hook<Args extends unknown[], Result>(
  value: ((...args: Args) => Result) | { handler: (...args: Args) => Result } | undefined,
): (...args: Args) => Result {
  if (value === undefined) throw new Error('expected Vite hook')
  return typeof value === 'function' ? value : value.handler
}
