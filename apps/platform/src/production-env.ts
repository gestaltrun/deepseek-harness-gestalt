/** Production-only listen-process and deploy Environment names. */

import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { validateOperatedOssConfig, type OperatedOssConfig } from './oss-config.ts'

/** Names the listen process must receive from Environment `production`. */
export const PLATFORM_PRODUCTION_REQUIRED_ENV = [
  'PLATFORM_ORIGIN',
  'PLATFORM_GITHUB_CLIENT_ID',
  'PLATFORM_GITHUB_CLIENT_SECRET',
  'PLATFORM_GITHUB_CALLBACK',
  'PLATFORM_GITHUB_CREDENTIAL_REFERENCE',
  'PLATFORM_POSTGRES_HOST',
  'PLATFORM_POSTGRES_USER',
  'PLATFORM_POSTGRES_PASSWORD',
  'PLATFORM_POSTGRES_DATABASE',
  'PLATFORM_IDENTITY_NAMESPACE',
  'PLATFORM_REDIS_HOST',
  'PLATFORM_REDIS_USER',
  'PLATFORM_REDIS_PASSWORD',
  'PLATFORM_OSS_ENDPOINT',
  'PLATFORM_OSS_BUCKET',
  'PLATFORM_OSS_AUTH',
  'PLATFORM_OSS_OBJECT_PREFIX',
  'PLATFORM_OSS_TIMEOUT_MS',
  'PLATFORM_RELAY_REDIS_KEY_PREFIX',
  'PLATFORM_RELAY_INSTANCE_ID',
  'PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS',
  'PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS',
  'PLATFORM_RELAY_DIRECTORY_TTL_MS',
  'PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS',
  'PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES',
  'PLATFORM_RELAY_MAX_CONNECTIONS',
  'PLATFORM_RELAY_MAX_PENDING_DELIVERIES',
  'PLATFORM_RELAY_MAX_PENDING_CHALLENGES',
  'PLATFORM_RELAY_ATTACH_TIMEOUT_MS',
  'PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES',
  'PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS',
  'PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS',
  'PLATFORM_TOKEN_SIGNING_KEY',
  'PLATFORM_POLLING_SIGNING_KEY',
] as const

/** Listen-process names plus the ECS apply names. */
export const PLATFORM_DEPLOY_REQUIRED_ENV = [
  ...PLATFORM_PRODUCTION_REQUIRED_ENV,
  'PLATFORM_ECS_SSH_KEY',
  'PLATFORM_ECS_HOSTS',
] as const

/** A required production or deploy Environment name. */
export type PlatformDeployEnvName = (typeof PLATFORM_DEPLOY_REQUIRED_ENV)[number]

/** Validated operated identity before the Account package brands it. */
export interface OperatedPlatformIdentity {
  environment: 'production'
  origin: string
  callbackUrl: string
  githubClientId: string
  credentialReference: string
  databaseIdentity: string
  identityNamespace: string
}

/** Complete product configuration parsed before any durable-store connection. */
export interface OperatedPlatformConfig {
  environment: OperatedPlatformIdentity
  githubClientSecret: string
  postgres: {
    host: string
    port: number
    user: string
    password: string
    database: string
    ssl: { rejectUnauthorized: true }
  }
  redis: {
    host: string
    port: number
    username: string
    password: string
    tls: true
  }
  relayRedisKeyPrefix: string
  relay: {
    instanceId: string
    capacityRetryAfterMs: number
    deliveryAckTimeoutMs: number
    directoryTtlMs: number
    heartbeatTimeoutMs: number
    maxBufferedCiphertextBytes: number
    maxConnections: number
    maxPendingDeliveries: number
    maxPendingChallenges: number
    attachTimeoutMs: number
  }
  remoteAttachments: {
    maxBlobBytes: number
    capabilityLifetimeMs: number
    maxRetainedBlobs: number
  }
  oss: OperatedOssConfig
  tokenSigningKey: Uint8Array
  pollingSigningKey: Uint8Array
}

const SIGNING_KEY_NAMES = ['PLATFORM_TOKEN_SIGNING_KEY', 'PLATFORM_POLLING_SIGNING_KEY'] as const

/** A 32-byte hex signing-key name. */
export type PlatformSigningKeyName = (typeof SIGNING_KEY_NAMES)[number]

/**
 * Reports required names that are unset or empty.
 * @param names - Environment names to inspect
 * @param env - Process environment to inspect
 * @returns Missing names in declaration order
 */
export function missingPlatformEnv(
  names: readonly string[],
  env: NodeJS.Dict<string> = process.env,
): string[] {
  return names.filter((name) => {
    const value = env[name]
    return value === undefined || value === ''
  })
}

/**
 * Reports listen-process names that are unset or empty.
 * @param env - Process environment to inspect
 * @returns Missing names in declaration order
 */
export function missingPlatformProductionEnv(env: NodeJS.Dict<string> = process.env): string[] {
  return missingPlatformEnv(PLATFORM_PRODUCTION_REQUIRED_ENV, env)
}

/**
 * Reports deploy names that are unset or empty.
 * @param env - Process environment to inspect
 * @returns Missing names in declaration order
 */
export function missingPlatformDeployEnv(env: NodeJS.Dict<string> = process.env): string[] {
  return missingPlatformEnv(PLATFORM_DEPLOY_REQUIRED_ENV, env)
}

/**
 * Reads one required production or deploy name.
 * @param name - Environment name
 * @param env - Process environment to inspect
 * @returns The non-empty value
 */
export function requiredPlatformEnv(
  name: PlatformDeployEnvName,
  env: NodeJS.Dict<string> = process.env,
): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`platform: missing deployment secrets: ${name}`)
  }
  return value
}

/**
 * Reads a 32-byte hex signing key.
 * @param name - Token or polling signing-key name
 * @param env - Process environment to inspect
 * @returns 32 raw key bytes
 */
export function readPlatformSigningKey(
  name: PlatformSigningKeyName,
  env: NodeJS.Dict<string> = process.env,
): Uint8Array {
  const hex = requiredPlatformEnv(name, env)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new TypeError(`${name} must be 32 bytes of hex`)
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

/**
 * Parse the operated identity and durable-store configuration before traffic.
 * @param env - process environment supplied by Environment `production`.
 * @returns validated identity, credentials, verified TLS settings, and store namespaces.
 */
export function loadOperatedPlatformConfig(
  env: NodeJS.Dict<string> = process.env,
): OperatedPlatformConfig {
  const missing = missingPlatformProductionEnv(env)
  if (missing.length > 0) throw new Error(`platform: missing deployment secrets: ${missing.join(', ')}`)
  assertOperatedPlatformEnvironment(env.PLATFORM_ENVIRONMENT)
  requireSafeTlsSelection(env.PLATFORM_POSTGRES_SSL, 'PLATFORM_POSTGRES_SSL', 'require')
  requireSafeTlsSelection(env.PLATFORM_REDIS_TLS, 'PLATFORM_REDIS_TLS', '1')
  return {
    environment: operatedIdentity({
      environment: 'production',
      origin: requiredPlatformEnv('PLATFORM_ORIGIN', env),
      callbackUrl: requiredPlatformEnv('PLATFORM_GITHUB_CALLBACK', env),
      githubClientId: requiredPlatformEnv('PLATFORM_GITHUB_CLIENT_ID', env),
      credentialReference: requiredPlatformEnv('PLATFORM_GITHUB_CREDENTIAL_REFERENCE', env),
      databaseIdentity: requiredPlatformEnv('PLATFORM_POSTGRES_DATABASE', env),
      identityNamespace: requiredPlatformEnv('PLATFORM_IDENTITY_NAMESPACE', env),
    }),
    githubClientSecret: requiredPlatformEnv('PLATFORM_GITHUB_CLIENT_SECRET', env),
    postgres: {
      host: requiredPlatformEnv('PLATFORM_POSTGRES_HOST', env),
      port: optionalPort(env.PLATFORM_POSTGRES_PORT, 'PLATFORM_POSTGRES_PORT', 5432),
      user: requiredPlatformEnv('PLATFORM_POSTGRES_USER', env),
      password: requiredPlatformEnv('PLATFORM_POSTGRES_PASSWORD', env),
      database: requiredPlatformEnv('PLATFORM_POSTGRES_DATABASE', env),
      ssl: { rejectUnauthorized: true },
    },
    redis: {
      host: requiredPlatformEnv('PLATFORM_REDIS_HOST', env),
      port: optionalPort(env.PLATFORM_REDIS_PORT, 'PLATFORM_REDIS_PORT', 6379),
      username: requiredPlatformEnv('PLATFORM_REDIS_USER', env),
      password: requiredPlatformEnv('PLATFORM_REDIS_PASSWORD', env),
      tls: true,
    },
    relayRedisKeyPrefix: requiredPlatformEnv('PLATFORM_RELAY_REDIS_KEY_PREFIX', env),
    relay: {
      instanceId: requiredPlatformEnv('PLATFORM_RELAY_INSTANCE_ID', env),
      capacityRetryAfterMs: positiveIntegerEnv(env, 'PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS'),
      deliveryAckTimeoutMs: positiveIntegerEnv(env, 'PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS'),
      directoryTtlMs: positiveIntegerEnv(env, 'PLATFORM_RELAY_DIRECTORY_TTL_MS'),
      heartbeatTimeoutMs: positiveIntegerEnv(env, 'PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS'),
      maxBufferedCiphertextBytes: positiveIntegerEnv(env, 'PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES'),
      maxConnections: positiveIntegerEnv(env, 'PLATFORM_RELAY_MAX_CONNECTIONS'),
      maxPendingDeliveries: positiveIntegerEnv(env, 'PLATFORM_RELAY_MAX_PENDING_DELIVERIES'),
      maxPendingChallenges: positiveIntegerEnv(env, 'PLATFORM_RELAY_MAX_PENDING_CHALLENGES'),
      attachTimeoutMs: positiveIntegerEnv(env, 'PLATFORM_RELAY_ATTACH_TIMEOUT_MS'),
    },
    remoteAttachments: {
      maxBlobBytes: boundedPositiveIntegerEnv(
        env, 'PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES', REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes,
      ),
      capabilityLifetimeMs: boundedPositiveIntegerEnv(
        env,
        'PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS',
        REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs,
      ),
      maxRetainedBlobs: positiveIntegerEnv(env, 'PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS'),
    },
    oss: validateOperatedOssConfig({
      endpoint: requiredPlatformEnv('PLATFORM_OSS_ENDPOINT', env),
      bucket: requiredPlatformEnv('PLATFORM_OSS_BUCKET', env),
      auth: requiredPlatformEnv('PLATFORM_OSS_AUTH', env),
      objectPrefix: requiredPlatformEnv('PLATFORM_OSS_OBJECT_PREFIX', env),
      timeoutMs: positiveIntegerEnv(env, 'PLATFORM_OSS_TIMEOUT_MS'),
    }),
    tokenSigningKey: readPlatformSigningKey('PLATFORM_TOKEN_SIGNING_KEY', env),
    pollingSigningKey: readPlatformSigningKey('PLATFORM_POLLING_SIGNING_KEY', env),
  }
}

function operatedIdentity(identity: OperatedPlatformIdentity): OperatedPlatformIdentity {
  const origin = new URL(identity.origin)
  const callback = new URL(identity.callbackUrl)
  const hostname = origin.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0'
    || hostname === '[::1]' || hostname === '::1' || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)) {
    throw new TypeError('Operated Platform origin must not use a local host')
  }
  if (origin.protocol !== 'https:' || identity.origin !== origin.origin
    || callback.protocol !== 'https:' || callback.origin !== origin.origin) {
    throw new TypeError('production Platform origin and callback must share one HTTPS origin')
  }
  if (callback.pathname !== '/v1/account/oauth/github/callback' || callback.search !== '' || callback.hash !== '') {
    throw new TypeError('production Platform callback path is invalid')
  }
  return Object.freeze(identity)
}

/**
 * Accepts only the operated production selection.
 * @param selection - `PLATFORM_ENVIRONMENT` or an explicit selection
 * @returns `production`
 */
export function assertOperatedPlatformEnvironment(
  selection: string | undefined = process.env.PLATFORM_ENVIRONMENT,
): 'production' {
  if (selection === undefined || selection === '' || selection === 'production') {
    return 'production'
  }
  throw new Error(`platform: operated listen process accepts only production, got ${JSON.stringify(selection)}`)
}

/**
 * Prints missing deploy names without values and checks signing-key hex.
 * @param env - Process environment to inspect
 * @returns Process exit status
 */
export function runPlatformProductionEnvCli(env: NodeJS.Dict<string> = process.env): number {
  const missing = missingPlatformDeployEnv(env)
  if (missing.length > 0) {
    console.error(`platform: missing deployment secrets: ${missing.join(', ')}`)
    return 1
  }
  try {
    loadOperatedPlatformConfig(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    return 1
  }
  return 0
}

function optionalPort(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 through 65535`)
  }
  return port
}

function positiveIntegerEnv(env: NodeJS.Dict<string>, name: PlatformDeployEnvName): number {
  const value = Number(requiredPlatformEnv(name, env))
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function boundedPositiveIntegerEnv(
  env: NodeJS.Dict<string>,
  name: PlatformDeployEnvName,
  maximum: number,
): number {
  const value = positiveIntegerEnv(env, name)
  if (value > maximum) throw new TypeError(`${name} must not exceed ${String(maximum)}`)
  return value
}

function requireSafeTlsSelection(value: string | undefined, name: string, accepted: string): void {
  if (value !== undefined && value !== '' && value !== accepted) {
    throw new TypeError(`${name} accepts only ${accepted}`)
  }
}
