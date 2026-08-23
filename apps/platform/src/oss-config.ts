/** Pure validation for the operated Alibaba Cloud OSS deployment identity. */

const ROLE_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/u
const ENDPOINT_PATTERN = /^(oss-[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/u

/** Operated OSS identity and request bounds with no long-lived access key. */
export interface OperatedOssConfig {
  endpoint: string
  bucket: string
  auth: string
  objectPrefix: string
  timeoutMs: number
}

/** Validated values needed by the Alibaba Cloud SDK and attachment store. */
export interface ValidatedOperatedOssConfig extends OperatedOssConfig {
  role: string
  region: string
}

/** @returns a validated OSS deployment identity plus its derived RAM role and region. */
export function validateOperatedOssConfig(config: OperatedOssConfig): ValidatedOperatedOssConfig {
  const endpoint = ENDPOINT_PATTERN.exec(config.endpoint)
  if (endpoint?.[1] === undefined) {
    throw new TypeError('PLATFORM_OSS_ENDPOINT must be an Alibaba Cloud OSS hostname')
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(config.bucket)) {
    throw new TypeError('PLATFORM_OSS_BUCKET is invalid')
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 60_000) {
    throw new TypeError('PLATFORM_OSS_TIMEOUT_MS must be an integer from 1 through 60000')
  }
  return {
    ...config,
    objectPrefix: validateOssObjectPrefix(config.objectPrefix),
    role: parseEcsRamRole(config.auth),
    region: endpoint[1],
  }
}

/** @returns the role name from the deployment-owned `ecs-ram-role/<name>` selector. */
export function parseEcsRamRole(auth: string): string {
  const prefix = 'ecs-ram-role/'
  if (!auth.startsWith(prefix)) throw new TypeError('PLATFORM_OSS_AUTH must select an ECS RAM role')
  const role = auth.slice(prefix.length)
  if (!ROLE_PATTERN.test(role)) throw new TypeError('PLATFORM_OSS_AUTH role name is invalid')
  return role
}

/** @returns one canonical private object namespace without a trailing slash. */
export function validateOssObjectPrefix(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,254}[A-Za-z0-9_-]$/u.test(value) || value.includes('//')) {
    throw new TypeError('PLATFORM_OSS_OBJECT_PREFIX is invalid')
  }
  return value
}
