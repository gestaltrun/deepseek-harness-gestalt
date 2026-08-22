import { readFileSync } from 'node:fs'
import { loadOperatedPlatformEnvironment, type SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'

/** Read the operated Desktop identity embedded beside the executable entry. */
export function readDesktopPlatformEnvironment(path: string): SelectedPlatformEnvironment {
  const source = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return loadDesktopPlatformEnvironment(source)
}

/** Parse the operated Desktop deployment identity before window or network startup. */
export function loadDesktopPlatformEnvironment(source: unknown): SelectedPlatformEnvironment {
  if (!isRecord(source)) throw new TypeError('Desktop operated Platform configuration must be an object')
  return loadOperatedPlatformEnvironment({
    environment: source.environment,
    origin: source.origin,
    callbackUrl: source.callbackUrl,
    githubClientId: source.githubClientId,
    credentialReference: source.credentialReference,
    databaseIdentity: source.databaseIdentity,
    identityNamespace: source.identityNamespace,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
