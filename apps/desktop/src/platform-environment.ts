import { readFileSync } from 'node:fs'
import { loadOperatedPlatformEnvironment, type SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import {
  validateDesktopRemoteRelayConfig, type DesktopRemoteRelayConfig,
} from './remote-relay.ts'

/** Desktop-operated Platform identity, attachment admission deadline, and public Relay configuration. */
export interface DesktopPlatformEnvironment extends SelectedPlatformEnvironment {
  companionAttachmentHostTimeoutMs: number
  remoteRelay: DesktopRemoteRelayConfig
}

/** Read the operated Desktop identity embedded beside the executable entry. */
export function readDesktopPlatformEnvironment(path: string): DesktopPlatformEnvironment {
  const source = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return loadDesktopPlatformEnvironment(source)
}

/** Parse the operated Desktop deployment identity before window or network startup. */
export function loadDesktopPlatformEnvironment(source: unknown): DesktopPlatformEnvironment {
  if (!isRecord(source)) throw new TypeError('Desktop operated Platform configuration must be an object')
  const environment = loadOperatedPlatformEnvironment({
    environment: source.environment,
    origin: source.origin,
    callbackUrl: source.callbackUrl,
    githubClientId: source.githubClientId,
    credentialReference: source.credentialReference,
    databaseIdentity: source.databaseIdentity,
    identityNamespace: source.identityNamespace,
  })
  if (!Number.isSafeInteger(source.companionAttachmentHostTimeoutMs)
    || (source.companionAttachmentHostTimeoutMs as number) <= 0) {
    throw new TypeError('Desktop companionAttachmentHostTimeoutMs must be a positive safe integer')
  }
  return {
    ...environment,
    companionAttachmentHostTimeoutMs: source.companionAttachmentHostTimeoutMs as number,
    remoteRelay: validateDesktopRemoteRelayConfig(source.remoteRelay),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
