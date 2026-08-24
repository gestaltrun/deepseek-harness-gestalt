/** Development versus production Platform isolation and safe operations. */

/** Allowed Platform environments. There is no staging selector. */
export type PlatformEnvironment = 'development' | 'production'

/** Raw IP log retention. */
export const RAW_IP_LOG_TTL_DAYS = 7
/** Content-free security-event retention. */
export const SECURITY_EVENT_TTL_DAYS = 30

/** Isolated environment surfaces. */
export interface PlatformEnvironmentSurfaces {
  /** Trusted origin. */
  origin: string
  /** OAuth App identifier. */
  oauthApp: string
  /** OAuth callback. */
  callback: string
  /** Credential reference namespace. */
  credentials: string
  /** Database namespace. */
  database: string
  /** Identity namespace. */
  identity: string
}

/**
 * Resolve the isolated Platform environment. Arbitrary endpoints are rejected.
 * @param value - configured environment name.
 * @returns the isolated environment name.
 */
export function parsePlatformEnvironment(value: string): PlatformEnvironment {
  if (value === 'development' || value === 'production') return value
  throw new Error('Platform environment must be development or production')
}

/**
 * Surfaces that must not be shared across environments.
 * @param environment - isolated environment.
 * @returns origin and store namespaces for that environment.
 */
export function platformEnvironmentSurfaces(environment: PlatformEnvironment): PlatformEnvironmentSurfaces {
  if (environment === 'development') {
    return {
      origin: 'https://dev.platform.example',
      oauthApp: 'dev-oauth',
      callback: 'https://dev.platform.example/callback',
      credentials: 'dev-credentials',
      database: 'dev-db',
      identity: 'dev-identity',
    }
  }
  return {
    origin: 'https://platform.example',
    oauthApp: 'prod-oauth',
    callback: 'https://platform.example/callback',
    credentials: 'prod-credentials',
    database: 'prod-db',
    identity: 'prod-identity',
  }
}

/**
 * Read a deployment-managed secret reference. Missing required secrets fail closed.
 * @param references - deployment-managed map.
 * @param name - required capability secret.
 * @returns the secret value for that capability.
 */
export function requirePlatformSecret(
  references: ReadonlyMap<string, string>,
  name: 'postgres' | 'redis' | 'oss' | 'github',
): string {
  const value = references.get(name)
  if (value === undefined || value === '') throw new Error(`Platform secret ${name} is missing`)
  return value
}

/** Safe operational outcome that never includes sensitive values. */
export interface PlatformOperationEvent {
  /** Random request correlation id. */
  requestId: string
  /** HMAC-style rotating account pseudonym. */
  pseudonym: string
  /** Outcome category. */
  category: 'authentication' | 'forwarding' | 'reconnect' | 'revocation' | 'blob' | 'dependency' | 'capacity'
  /** Structured error code, if any. */
  error?: string
}

/**
 * Build a content-free operational event. Ciphertext, keys, tokens, names, and durable ids stay out.
 * @param input - category and optional error.
 * @returns a content-free operational event.
 */
export function platformOperationEvent(
  input: { category: PlatformOperationEvent['category']; error?: string },
): PlatformOperationEvent {
  return {
    requestId: crypto.randomUUID(),
    pseudonym: `hmac-${input.category}`,
    category: input.category,
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

/**
 * Whether a log class is still retainable.
 * @param kind - log class.
 * @param ageDays - age in days.
 * @returns whether that log class may still be retained.
 */
export function platformLogRetainable(kind: 'raw-ip' | 'security-event' | 'live-route', ageDays: number): boolean {
  if (kind === 'live-route') return false
  if (kind === 'raw-ip') return ageDays < RAW_IP_LOG_TTL_DAYS
  return ageDays < SECURITY_EVENT_TTL_DAYS
}
