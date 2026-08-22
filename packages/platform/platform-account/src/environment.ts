import type { PlatformEnvironment } from './types.ts'

/** Public deployment identities that must differ between development and production. */
export interface PlatformEnvironmentIdentity {
  /** Selected deployment environment. */
  environment: PlatformEnvironment
  /** Trusted Platform HTTPS origin. */
  origin: string
  /** Fixed GitHub OAuth callback on the trusted origin. */
  callbackUrl: string
  /** GitHub OAuth App client id. */
  githubClientId: string
  /** Credential-store reference resolving the OAuth App secret. */
  credentialReference: string
  /** Durable Account database identity. */
  databaseIdentity: string
  /** Namespace included in Account and token identities. */
  identityNamespace: string
}

/** Complete development and production identity set. */
export interface PlatformEnvironmentPair {
  development: PlatformEnvironmentIdentity & { environment: 'development' }
  production: PlatformEnvironmentIdentity & { environment: 'production' }
}

/** Untrusted deployment fields read by an application composition. */
export interface PlatformEnvironmentSelectionInput {
  selection: unknown
  development: Record<Exclude<keyof PlatformEnvironmentIdentity, 'environment'>, unknown>
  production: Record<Exclude<keyof PlatformEnvironmentIdentity, 'environment'>, unknown>
}

/** Untrusted fields for the single operated production identity. */
export type OperatedPlatformEnvironmentInput = Record<keyof PlatformEnvironmentIdentity, unknown>

declare const selectedPlatformEnvironment: unique symbol

/** One deployment identity selected from a validated development/production pair. */
export type SelectedPlatformEnvironment = Readonly<PlatformEnvironmentIdentity> & {
  readonly [selectedPlatformEnvironment]: true
}

const validatedPairs = new WeakSet<PlatformEnvironmentPair>()

/**
 * Parse, validate, and select the complete deployment pair before app startup.
 * @param input - untrusted packaging or process environment fields.
 * @returns selected immutable deployment identity.
 */
export function loadPlatformEnvironment(input: PlatformEnvironmentSelectionInput): SelectedPlatformEnvironment {
  const identity = <T extends PlatformEnvironment>(environment: T): PlatformEnvironmentIdentity & { environment: T } => {
    const source = input[environment]
    return {
      environment,
      origin: required(source.origin, `${environment} origin`),
      callbackUrl: required(source.callbackUrl, `${environment} callback URL`),
      githubClientId: required(source.githubClientId, `${environment} GitHub client id`),
      credentialReference: required(source.credentialReference, `${environment} credential reference`),
      databaseIdentity: required(source.databaseIdentity, `${environment} database identity`),
      identityNamespace: required(source.identityNamespace, `${environment} identity namespace`),
    }
  }
  return selectPlatformEnvironment(validatePlatformEnvironmentPair({
    development: identity('development'),
    production: identity('production'),
  }), input.selection)
}

/**
 * Parse the single operated production identity used by shipped product entries.
 * @param input - untrusted packaging or deployment fields.
 * @returns immutable production identity after local origins and incomplete fields are rejected.
 */
export function loadOperatedPlatformEnvironment(
  input: OperatedPlatformEnvironmentInput,
): SelectedPlatformEnvironment {
  if (input.environment !== 'production') {
    throw new TypeError('Operated Platform environment must be production')
  }
  const origin = required(input.origin, 'production origin')
  if (isLocalHostname(new URL(origin).hostname.toLowerCase())) {
    throw new TypeError('Operated Platform origin must not use a local host')
  }
  const identity = validateEnvironmentIdentity({
    environment: 'production',
    origin,
    callbackUrl: required(input.callbackUrl, 'production callback URL'),
    githubClientId: required(input.githubClientId, 'production GitHub client id'),
    credentialReference: required(input.credentialReference, 'production credential reference'),
    databaseIdentity: required(input.databaseIdentity, 'production database identity'),
    identityNamespace: required(input.identityNamespace, 'production identity namespace'),
  }, 'production')
  return Object.freeze(identity) as SelectedPlatformEnvironment
}

/**
 * Validate and freeze both deployment identities before composition selects one.
 * @param pair - development and production identities supplied together.
 * @returns an immutable validated copy accepted by {@link selectPlatformEnvironment}.
 */
export function validatePlatformEnvironmentPair(pair: PlatformEnvironmentPair): PlatformEnvironmentPair {
  const fields = [
    'origin',
    'callbackUrl',
    'githubClientId',
    'credentialReference',
    'databaseIdentity',
    'identityNamespace',
  ] as const
  for (const field of fields) {
    if (pair.development[field] === pair.production[field]) {
      throw new TypeError(`Platform environments must use distinct ${field}`)
    }
  }
  const validated = {
    development: validateEnvironmentIdentity({ ...pair.development }, 'development'),
    production: validateEnvironmentIdentity({ ...pair.production }, 'production'),
  }
  Object.freeze(validated.development)
  Object.freeze(validated.production)
  Object.freeze(validated)
  validatedPairs.add(validated)
  return validated
}

/**
 * Select one identity only after both deployment identities have been validated.
 * @param pair - value returned by {@link validatePlatformEnvironmentPair}.
 * @param environment - explicit deployment selection from packaging or deployment.
 * @returns the selected immutable deployment identity.
 */
export function selectPlatformEnvironment(
  pair: PlatformEnvironmentPair,
  environment: unknown,
): SelectedPlatformEnvironment {
  if (!validatedPairs.has(pair)) throw new TypeError('Platform environment pair must be validated before selection')
  if (environment !== 'development' && environment !== 'production') {
    throw new TypeError('Platform environment must be development or production')
  }
  return pair[environment] as SelectedPlatformEnvironment
}

function validateEnvironmentIdentity<T extends PlatformEnvironment>(
  identity: PlatformEnvironmentIdentity & { environment: T },
  expected: T,
): PlatformEnvironmentIdentity & { environment: T } {
  if (identity.environment !== expected) throw new TypeError(`${expected} Platform environment tag is invalid`)
  const origin = new URL(identity.origin)
  const callback = new URL(identity.callbackUrl)
  if (origin.protocol !== 'https:' || identity.origin !== origin.origin
    || callback.protocol !== 'https:' || callback.origin !== origin.origin) {
    throw new TypeError(`${identity.environment} Platform origin and callback must share one HTTPS origin`)
  }
  if (callback.pathname !== '/v1/account/oauth/github/callback' || callback.search !== '' || callback.hash !== '') {
    throw new TypeError(`${identity.environment} Platform callback path is invalid`)
  }
  for (const value of [
    identity.githubClientId,
    identity.credentialReference,
    identity.databaseIdentity,
    identity.identityNamespace,
  ]) {
    if (value.trim() === '') throw new TypeError(`${identity.environment} Platform identity fields must be non-empty`)
  }
  return identity
}

function required(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  throw new TypeError(`Platform ${name} is required`)
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1'
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
}
