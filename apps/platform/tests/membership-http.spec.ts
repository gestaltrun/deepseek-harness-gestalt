import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RedisClientType } from 'redis'
import { FileProjectMembership } from '@deepseek-ai/dsh-project-membership-core'
import { launchOperatedPlatform } from '../src/launch.ts'
import type { connectRedis as connectRedisEntry } from '../src/redis-bus.ts'
import { operatedFixtureEnv } from './operated-fixture-env.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason as unknown)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'membership HTTP fixture cleanup failed')
})

describe('operated Platform Project Membership HTTP', () => {
  it('mounts membership routes on the product composition with temp storage', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-platform-membership-'))
    cleanups.push(async () => { await rm(storagePath, { recursive: true, force: true }) })
    const running = await launchOperatedPlatform({
      env: {
        ...operatedFixtureEnv(),
        PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'postgres',
        PLATFORM_MEMBERSHIP_STORAGE: storagePath,
      },
      adapters: {
        createPostgres: () => fakePostgresPool() as Pool,
        connectRedis: async () => fakeRedisConnection(),
      },
    })
    cleanups.push(async () => { await running.close() })

    expect(running.context.projectMembership).toBeInstanceOf(FileProjectMembership)
    expect((running.context.projectMembership as FileProjectMembership).storageFile)
      .toBe(join(storagePath, 'production', 'project-membership.json'))

    const origin = `http://127.0.0.1:${String(running.context.webServer.port)}`
    const preflight = await fetch(`${origin}/v1/projects`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://platform.fixture.example',
        'access-control-request-method': 'POST',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://platform.fixture.example')

    const unauthenticated = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthenticated', remoteUrl: 'https://github.com/octocat/repo' }),
    })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: 'Bearer Account access token is required' },
    })

    const heartbeat = await fetch(`${origin}/v1/projects/presence/heartbeat`, { method: 'POST' })
    expect(heartbeat.status).toBe(401)
  })
})

function fakePostgresPool(): {
  query: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
} {
  const query = vi.fn(async (sql: string) => dispatchSql(sql))
  return {
    query,
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => dispatchSql(sql)),
      release() {},
    })),
    end: vi.fn(async () => {}),
  }
}

function dispatchSql(sql: string): { rows: Record<string, unknown>[]; rowCount: number } {
  if (/SELECT phase FROM remote_attachment_storage_phase/u.test(sql)) {
    return { rows: [{ phase: 'legacy' }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
}

function fakeRedisConnection(): Awaited<ReturnType<typeof connectRedisEntry>> {
  const listeners = new Map<string, Set<(message: string) => void>>()
  const client = {
    subscribe: async (channel: string, listener: (message: string) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
    },
    unsubscribe: async (channel: string, listener: (message: string) => void) => {
      listeners.get(channel)?.delete(listener)
    },
    publish: async () => 0,
    get: async () => null,
    sMembers: async () => [],
    set: async () => 'OK',
    eval: async () => 1,
    withAbortSignal() { return client },
  }
  return {
    client: client as unknown as RedisClientType,
    close: async () => {},
  }
}
