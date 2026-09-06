import type { MobilePlatformEnvironmentSource } from './platform-environment.ts'

const RUNTIME_IDENTITY_URL = '/dsh-mobile-runtime-identity.json'

/** Load the packaged identity record consumed by Mobile product boot. */
export async function loadPackagedMobileRuntimeIdentity(
  fetchRuntime: typeof fetch = fetch,
): Promise<MobilePlatformEnvironmentSource> {
  const response = await fetchRuntime(RUNTIME_IDENTITY_URL, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Mobile runtime identity request failed with HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Mobile runtime identity must be an object')
  }
  const record = value as Record<string, unknown>
  const expected = ['callbackUrl', 'credentialReference', 'databaseIdentity', 'githubClientId', 'identityNamespace', 'origin', 'version']
  const keys = Object.keys(record).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('Mobile runtime identity fields are invalid')
  }
  if (record.version !== 1) throw new TypeError('Mobile runtime identity version must be 1')
  return {
    VITE_PLATFORM_ORIGIN: record.origin,
    VITE_PLATFORM_CALLBACK_URL: record.callbackUrl,
    VITE_PLATFORM_GITHUB_CLIENT_ID: record.githubClientId,
    VITE_PLATFORM_CREDENTIAL_REFERENCE: record.credentialReference,
    VITE_PLATFORM_DATABASE_IDENTITY: record.databaseIdentity,
    VITE_PLATFORM_IDENTITY_NAMESPACE: record.identityNamespace,
  }
}
