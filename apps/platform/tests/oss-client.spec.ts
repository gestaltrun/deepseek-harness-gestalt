import { beforeEach, describe, expect, it, vi } from 'vitest'

const oss = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  put: vi.fn(async () => ({})),
  get: vi.fn(async () => ({ content: Buffer.from([1, 2, 3]) })),
  delete: vi.fn(async () => ({})),
  getBucketLifecycle: vi.fn(async () => ({ rules: [{
    id: 'unrelated', prefix: 'logs/', status: 'Enabled', days: 30, date: '',
  }] })),
  putBucketLifecycle: vi.fn(async () => ({})),
}))

vi.mock('ali-oss', () => ({
  default: class {
    constructor(options: Record<string, unknown>) { oss.options = options }
    put = oss.put
    get = oss.get
    delete = oss.delete
    getBucketLifecycle = oss.getBucketLifecycle
    putBucketLifecycle = oss.putBucketLifecycle
  },
}))

import {
  createEcsRamRoleOssClient,
  ensureEcsRamRoleOssLifecycle,
  parseEcsRamRole,
} from '../src/oss-client.ts'

beforeEach(() => {
  oss.options = undefined
  oss.put.mockClear()
  oss.get.mockClear()
  oss.delete.mockClear()
  oss.getBucketLifecycle.mockReset()
  oss.getBucketLifecycle.mockResolvedValue({ rules: [{
    id: 'unrelated', prefix: 'logs/', status: 'Enabled', days: 30, date: '',
  }] })
  oss.putBucketLifecycle.mockReset()
  oss.putBucketLifecycle.mockResolvedValue({})
})

describe('ECS RAM role OSS client', () => {
  it('loads IMDSv2 credentials and exposes only private ciphertext object operations', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.endsWith('/latest/api/token')) return new Response('metadata-token')
      return new Response(JSON.stringify({
        Code: 'Success', AccessKeyId: 'temporary-id', AccessKeySecret: 'temporary-secret', SecurityToken: 'sts-token',
      }), { headers: { 'content-type': 'application/json' } })
    })
    const client = await createEcsRamRoleOssClient({
      endpoint: 'oss-cn-hangzhou-internal.aliyuncs.com',
      bucket: 'gestalt-secret',
      auth: 'ecs-ram-role/gestalt-vpc',
      objectPrefix: 'remote-attachments/production',
      timeoutMs: 1_000,
    }, fetch)

    expect(requests[0]).toMatchObject({
      url: 'http://100.100.100.200/latest/api/token',
      init: { method: 'PUT', headers: { 'X-aliyun-ecs-metadata-token-ttl-seconds': '21600' } },
    })
    expect(requests[1]?.url).toContain('/ram/security-credentials/gestalt-vpc')
    expect(oss.options).toMatchObject({
      accessKeyId: 'temporary-id', stsToken: 'sts-token', bucket: 'gestalt-secret',
      region: 'oss-cn-hangzhou', secure: true, authorizationV4: true,
    })
    expect(oss.getBucketLifecycle).not.toHaveBeenCalled()

    await client.putObject('remote/key', Uint8Array.of(1, 2), 2_000)
    expect(oss.put).toHaveBeenCalledWith('remote/key', Buffer.from([1, 2]), {
      headers: { 'x-oss-object-acl': 'private', 'x-oss-meta-expires-at': '2000' },
    })
    await expect(client.getObject('remote/key')).resolves.toEqual(Uint8Array.of(1, 2, 3))
    await client.deleteObject('remote/key')
    expect(oss.delete).toHaveBeenCalledWith('remote/key')
  })

  it('rejects non-role auth, unsafe endpoints, invalid buckets, metadata failures, and malformed credentials', async () => {
    expect(() => parseEcsRamRole('access-key/plaintext')).toThrow('ECS RAM role')
    expect(() => parseEcsRamRole('ecs-ram-role/')).toThrow('role name')
    const ok = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      return url.endsWith('/token')
        ? new Response('token')
        : new Response(JSON.stringify({ Code: 'Success', AccessKeyId: 'id', AccessKeySecret: 'secret', SecurityToken: 'token' }))
    })
    await expect(createEcsRamRoleOssClient({
      endpoint: 'example.com', bucket: 'gestalt-secret', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/test', timeoutMs: 10,
    }, ok)).rejects.toThrow('Alibaba Cloud OSS hostname')
    await expect(createEcsRamRoleOssClient({
      endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'Bad', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/test', timeoutMs: 10,
    }, ok)).rejects.toThrow('BUCKET')
    await expect(createEcsRamRoleOssClient({
      endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'valid-bucket', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/test', timeoutMs: 10,
    }, vi.fn(async () => new Response('', { status: 500 })))).rejects.toThrow('metadata token returned 500')
    await expect(createEcsRamRoleOssClient({
      endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'valid-bucket', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/test', timeoutMs: 10,
    }, vi.fn(async () => new Response('')))).rejects.toThrow('metadata token is empty')
  })

  it('accepts the exact namespaced lifecycle and creates it when the bucket has none', async () => {
    const credentials = vi.fn(async (input: string | URL | Request) => requestUrl(input).endsWith('/token')
      ? new Response('token')
      : new Response(JSON.stringify({
        Code: 'Success', AccessKeyId: 'id', AccessKeySecret: 'secret', SecurityToken: 'token',
      })))
    oss.getBucketLifecycle.mockResolvedValueOnce({ rules: [{
      id: 'gestalt-remote-attachments-one-day',
      prefix: 'remote-attachments/production/',
      status: 'Enabled',
      expiration: { days: '1' },
    }] })
    await ensureEcsRamRoleOssLifecycle({
      endpoint: 'oss-cn-hangzhou-internal.aliyuncs.com', bucket: 'gestalt-secret', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/production', timeoutMs: 10,
    }, credentials)
    expect(oss.putBucketLifecycle).not.toHaveBeenCalled()

    oss.getBucketLifecycle.mockRejectedValueOnce({ code: 'NoSuchLifecycle', status: 404 })
    await ensureEcsRamRoleOssLifecycle({
      endpoint: 'oss-cn-hangzhou-internal.aliyuncs.com', bucket: 'gestalt-secret', auth: 'ecs-ram-role/role',
      objectPrefix: 'remote-attachments/production', timeoutMs: 10,
    }, credentials)
    expect(oss.putBucketLifecycle).toHaveBeenCalledWith('gestalt-secret', [expect.objectContaining({
      id: 'gestalt-remote-attachments-one-day', prefix: 'remote-attachments/production/', days: 1,
    })])
  })
})

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}
