import {
  loadOperatedPlatformEnvironment,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'

/** Public build variables accepted by the shipped Mobile entry. */
export interface MobilePlatformEnvironmentSource {
  readonly VITE_PLATFORM_ENV?: unknown
  readonly VITE_PLATFORM_ORIGIN?: unknown
  readonly VITE_PLATFORM_CALLBACK_URL?: unknown
  readonly VITE_PLATFORM_GITHUB_CLIENT_ID?: unknown
  readonly VITE_PLATFORM_CREDENTIAL_REFERENCE?: unknown
  readonly VITE_PLATFORM_DATABASE_IDENTITY?: unknown
  readonly VITE_PLATFORM_IDENTITY_NAMESPACE?: unknown
}

/**
 * Parse the operated Mobile deployment identity before storage, rendering, or traffic.
 * @param source - Mobile build variables.
 * @returns immutable operated production identity.
 */
export function loadMobilePlatformEnvironment(
  source: MobilePlatformEnvironmentSource,
): SelectedPlatformEnvironment {
  if (source.VITE_PLATFORM_ENV !== undefined && source.VITE_PLATFORM_ENV !== '') {
    throw new TypeError('Mobile Platform legacy environment selection is not accepted')
  }
  return loadOperatedPlatformEnvironment({
    environment: 'production',
    origin: source.VITE_PLATFORM_ORIGIN,
    callbackUrl: source.VITE_PLATFORM_CALLBACK_URL,
    githubClientId: source.VITE_PLATFORM_GITHUB_CLIENT_ID,
    credentialReference: source.VITE_PLATFORM_CREDENTIAL_REFERENCE,
    databaseIdentity: source.VITE_PLATFORM_DATABASE_IDENTITY,
    identityNamespace: source.VITE_PLATFORM_IDENTITY_NAMESPACE,
  })
}
