/** Alibaba Cloud OSS client backed by an ECS RAM role and IMDSv2 credentials. */

import OSS from 'ali-oss'
import { Readable } from 'node:stream'
import {
  validateOperatedOssConfig,
  type OperatedOssConfig,
} from './oss-config.ts'

const ECS_METADATA_ORIGIN = 'http://100.100.100.200'
const ATTACHMENT_LIFECYCLE_RULE_ID = 'gestalt-remote-attachments-one-day'

/** Temporary Alibaba Cloud credentials returned by ECS instance metadata. */
interface OssTemporaryCredentials {
  accessKeyId: string
  accessKeySecret: string
  stsToken: string
}

export { parseEcsRamRole } from './oss-config.ts'

/** Minimal ciphertext-object operations owned by the Platform attachment store. */
export interface OssObjectClient {
  putObject(key: string, ciphertext: Uint8Array, expiresAt: number): Promise<void>
  getObject(key: string, expectedByteLength: number): Promise<Uint8Array>
  deleteObject(key: string): Promise<void>
}

/**
 * Create a private OSS client whose temporary credentials refresh through ECS IMDSv2.
 * @param config - bucket, endpoint, RAM-role selector, and request timeout.
 * @param fetchImpl - metadata transport; production uses global Fetch.
 * @returns bounded object operations that never expose credentials or public URLs.
 */
export async function createEcsRamRoleOssClient(
  config: OperatedOssConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OssObjectClient> {
  const validated = validateOperatedOssConfig(config)
  const client = await createAliOssClient(validated, fetchImpl)
  return {
    async putObject(key, ciphertext, expiresAt) {
      await client.put(key, Buffer.from(ciphertext), {
        headers: {
          'x-oss-object-acl': 'private',
          'x-oss-meta-expires-at': String(expiresAt),
        },
      })
    },
    async getObject(key, expectedByteLength) {
      const result = await client.getStream(key)
      const stream: unknown = result.stream
      if (!(stream instanceof Readable)) throw new TypeError('OSS returned an invalid attachment ciphertext stream')
      const declared = contentLength(result.res.headers)
      if (declared !== expectedByteLength) {
        stream.destroy()
        throw new TypeError('OSS attachment ciphertext length does not match PostgreSQL authority')
      }
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        received += bytes.byteLength
        if (received > expectedByteLength) {
          stream.destroy()
          throw new TypeError('OSS attachment ciphertext exceeded PostgreSQL authority')
        }
        chunks.push(bytes)
      }
      if (received !== expectedByteLength) {
        throw new TypeError('OSS attachment ciphertext length does not match PostgreSQL authority')
      }
      return new Uint8Array(Buffer.concat(chunks, received))
    },
    async deleteObject(key) { await client.delete(key) },
  }
}

/**
 * Ensure the deployment-owned one-day cleanup backstop while preserving unrelated bucket rules.
 * @param config - operated bucket, prefix, RAM role, and timeout.
 * @param fetchImpl - ECS metadata transport.
 */
export async function ensureEcsRamRoleOssLifecycle(
  config: OperatedOssConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const validated = validateOperatedOssConfig(config)
  const client = await createAliOssClient(validated, fetchImpl)
  await ensureAttachmentLifecycle(client, validated.bucket, `${validated.objectPrefix}/`)
}

async function createAliOssClient(
  validated: ReturnType<typeof validateOperatedOssConfig>,
  fetchImpl: typeof fetch,
): Promise<OSS> {
  const credentials = async (): Promise<OssTemporaryCredentials> => await loadCredentials(
    validated.role,
    validated.timeoutMs,
    fetchImpl,
  )
  const initial = await credentials()
  const client = new OSS({
    accessKeyId: initial.accessKeyId,
    accessKeySecret: initial.accessKeySecret,
    stsToken: initial.stsToken,
    endpoint: validated.endpoint,
    bucket: validated.bucket,
    region: validated.region,
    secure: true,
    authorizationV4: true,
    timeout: validated.timeoutMs,
    refreshSTSToken: credentials,
  })
  return client
}

async function ensureAttachmentLifecycle(client: OSS, bucket: string, prefix: string): Promise<void> {
  let rules: OSS.LifecycleRule[]
  try {
    const result = await client.getBucketLifecycle(bucket)
    rules = Array.isArray(result.rules) ? result.rules : []
  } catch (error) {
    if (!isMissingLifecycle(error)) throw error
    rules = []
  }
  const current = rules.find(rule => isRecord(rule) && rule.id === ATTACHMENT_LIFECYCLE_RULE_ID)
  if (current !== undefined && lifecycleRuleMatches(current, prefix)) return
  const retained = rules.filter(rule => !isRecord(rule) || rule.id !== ATTACHMENT_LIFECYCLE_RULE_ID)
  await client.putBucketLifecycle(bucket, [...retained, {
    id: ATTACHMENT_LIFECYCLE_RULE_ID,
    prefix,
    status: 'Enabled',
    days: 1,
    date: '',
  }])
}

function lifecycleRuleMatches(value: unknown, prefix: string): boolean {
  if (!isRecord(value) || value.prefix !== prefix || value.status !== 'Enabled') return false
  if (value.days === 1 || value.days === '1') return true
  return isRecord(value.expiration) && (value.expiration.days === 1 || value.expiration.days === '1')
}

function isMissingLifecycle(error: unknown): boolean {
  return isRecord(error) && (error.code === 'NoSuchLifecycle' || error.status === 404 || error.statusCode === 404)
}

async function loadCredentials(role: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<OssTemporaryCredentials> {
  const tokenResponse = await fetchImpl(`${ECS_METADATA_ORIGIN}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-aliyun-ecs-metadata-token-ttl-seconds': '21600' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!tokenResponse.ok) throw new Error(`OSS credential metadata token returned ${String(tokenResponse.status)}`)
  const token = await tokenResponse.text()
  if (token === '') throw new Error('OSS credential metadata token is empty')
  const credentialResponse = await fetchImpl(
    `${ECS_METADATA_ORIGIN}/latest/meta-data/ram/security-credentials/${encodeURIComponent(role)}`,
    {
      headers: { 'X-aliyun-ecs-metadata-token': token },
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  if (!credentialResponse.ok) {
    throw new Error(`OSS RAM role credentials returned ${String(credentialResponse.status)}`)
  }
  return parseTemporaryCredentials(await credentialResponse.json())
}

function parseTemporaryCredentials(value: unknown): OssTemporaryCredentials {
  if (!isRecord(value) || value.Code !== 'Success') throw new TypeError('OSS RAM role credential response is invalid')
  return {
    accessKeyId: requiredString(value.AccessKeyId, 'AccessKeyId'),
    accessKeySecret: requiredString(value.AccessKeySecret, 'AccessKeySecret'),
    stsToken: requiredString(value.SecurityToken, 'SecurityToken'),
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`OSS RAM role ${name} is invalid`)
  return value
}

function contentLength(headers: unknown): number {
  if (!isRecord(headers)) throw new TypeError('OSS attachment response headers are invalid')
  const value = headers['content-length']
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError('OSS attachment content-length is invalid')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new TypeError('OSS attachment content-length is invalid')
  return length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
