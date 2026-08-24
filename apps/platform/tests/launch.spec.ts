import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RedisClientType } from 'redis'
import { launchOperatedPlatform } from '../src/launch.ts'
import type { connectRedis as connectRedisEntry } from '../src/redis-bus.ts'

const HEX = 'ab'.repeat(32)

describe('operated Platform launch configuration', () => {
  it.each([
    ['PORT', '8080oops', 'PORT must be an integer from 0 through 65535'],
    ['PORT', ' 8080 ', 'PORT must be an integer from 0 through 65535'],
    ['PLATFORM_LISTEN_HOST', '127.0.0.11', 'PLATFORM_LISTEN_HOST'],
  ])('rejects invalid %s before acquiring process resources', async (name, value, message) => {
    const createPostgres = vi.fn(() => {
      throw new Error('PostgreSQL resource was acquired')
    })
    const connectRedis = vi.fn(async () => {
      throw new Error('Redis resource was acquired')
    })

    await expect(launchOperatedPlatform({
      env: { ...operatedFixtureEnv(), [name]: value },
      adapters: { createPostgres, connectRedis },
    })).rejects.toThrow(message)
    expect(createPostgres).not.toHaveBeenCalled()
    expect(connectRedis).not.toHaveBeenCalled()
  })

  it('closes PostgreSQL when the first Redis acquisition fails', async () => {
    const pool = fakePostgresPool()
    const failure = new Error('first Redis acquisition failed')
    const connectRedis = vi.fn().mockRejectedValue(failure)

    await expect(launchOperatedPlatform({
      env: operatedFixtureEnv(),
      adapters: { createPostgres: () => pool, connectRedis },
    })).rejects.toBe(failure)
    expect(connectRedis).toHaveBeenCalledOnce()
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('closes the first Redis owner and PostgreSQL when the second Redis acquisition fails', async () => {
    const pool = fakePostgresPool()
    const publisher = fakeRedisConnection()
    const failure = new Error('second Redis acquisition failed')
    const connectRedis = vi.fn()
      .mockResolvedValueOnce(publisher)
      .mockRejectedValueOnce(failure)

    await expect(launchOperatedPlatform({
      env: operatedFixtureEnv(),
      adapters: { createPostgres: () => pool, connectRedis },
    })).rejects.toBe(failure)
    expect(connectRedis).toHaveBeenCalledTimes(2)
    expect(publisher.close).toHaveBeenCalledOnce()
    expect(pool.end).toHaveBeenCalledOnce()
  })
})

function fakePostgresPool(): Pool & { end: ReturnType<typeof vi.fn> } {
  const pool = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => {}),
  }
  return pool as unknown as Pool & { end: ReturnType<typeof vi.fn> }
}

function fakeRedisConnection(): Awaited<ReturnType<typeof connectRedisEntry>> & {
  close: ReturnType<typeof vi.fn>
} {
  const connection = {
    client: {} as RedisClientType,
    close: vi.fn(async () => {}),
  }
  return connection
}

function operatedFixtureEnv(): NodeJS.Dict<string> {
  return {
    PLATFORM_ENVIRONMENT: 'production',
    PLATFORM_ORIGIN: 'https://platform.fixture.example',
    PLATFORM_GITHUB_CLIENT_ID: 'github-client-fixture',
    PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-fixture',
    PLATFORM_GITHUB_CALLBACK: 'https://platform.fixture.example/v1/account/oauth/github/callback',
    PLATFORM_GITHUB_CREDENTIAL_REFERENCE: 'credentials://github-oauth/fixture',
    PLATFORM_POSTGRES_HOST: 'postgres.operated.fixture',
    PLATFORM_POSTGRES_USER: 'fixture',
    PLATFORM_POSTGRES_PASSWORD: 'postgres-secret-fixture',
    PLATFORM_POSTGRES_DATABASE: 'product-entry-fixture',
    PLATFORM_IDENTITY_NAMESPACE: 'identity-fixture',
    PLATFORM_REDIS_HOST: 'redis.operated.fixture',
    PLATFORM_REDIS_USER: 'fixture',
    PLATFORM_REDIS_PASSWORD: 'redis-secret-fixture',
    PLATFORM_RELAY_REDIS_KEY_PREFIX: 'gestalt:relay:fixture',
    PLATFORM_TOKEN_SIGNING_KEY: HEX,
    PLATFORM_POLLING_SIGNING_KEY: HEX,
    PLATFORM_POSTGRES_SSL: 'require',
    PLATFORM_REDIS_TLS: '1',
    PLATFORM_LISTEN_HOST: '127.0.0.1',
    PORT: '0',
  }
}
