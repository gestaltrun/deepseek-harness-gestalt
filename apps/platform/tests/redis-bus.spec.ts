import { readFileSync } from 'node:fs'
import { connect as connectTls, createServer as createTlsServer } from 'node:tls'
import type { RedisClientType } from 'redis'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedRedisOptions {
  socket?: {
    ca?: string
    host?: string
    port?: number
    rejectUnauthorized?: boolean
    servername?: string
    tls?: boolean
  }
}

const redis = vi.hoisted(() => ({
  createClient: vi.fn<(options?: CapturedRedisOptions) => RedisClientType>(),
}))

vi.mock('redis', () => ({ createClient: redis.createClient }))

import { connectRedis } from '../src/redis-bus.ts'

const TLS_CERTIFICATE = readFileSync(
  new URL('../../../packages/platform/remote-access-http/tests/fixtures/localhost-cert.pem', import.meta.url),
  'utf8',
)
const TLS_PRIVATE_KEY = readFileSync(
  new URL('../../../packages/platform/remote-access-http/tests/fixtures/localhost-key.pem', import.meta.url),
  'utf8',
)

describe('operated Redis connection ownership', () => {
  beforeEach(() => {
    redis.createClient.mockReset()
  })

  it('destroys a failed connection and removes its process error listener', async () => {
    const failure = new Error('Redis connect failed')
    const fixture = fakeRedisClient({ connect: async () => { throw failure } })
    redis.createClient.mockReturnValue(fixture.client)

    await expect(connectRedis(redisOptions())).rejects.toBe(failure)

    expect(fixture.client.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(fixture.client.destroy).toHaveBeenCalledOnce()
    expectResourcesReleased(fixture.state)
  })

  it('rejects a trusted Redis certificate for a different hostname', async () => {
    const fixture = fakeRedisClient()
    redis.createClient.mockReturnValue(fixture.client)
    const connection = await connectRedis({
      ...redisOptions(), host: 'redis.invalid.example', ca: TLS_CERTIFICATE,
    })
    const socketOptions = redis.createClient.mock.calls[0]?.[0]?.socket
    await connection.close()
    if (socketOptions === undefined
      || socketOptions.host === undefined
      || socketOptions.port === undefined
      || socketOptions.servername === undefined) {
      throw new TypeError('expected complete Redis TLS socket options')
    }

    const server = createTlsServer({ cert: TLS_CERTIFICATE, key: TLS_PRIVATE_KEY })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new TypeError('expected TCP server address')
      const failure = await new Promise<Error>((resolve, reject) => {
        const socket = connectTls({
          ca: socketOptions.ca,
          host: '127.0.0.1',
          port: address.port,
          rejectUnauthorized: socketOptions.rejectUnauthorized,
          servername: socketOptions.servername,
        }, () => {
          socket.destroy()
          reject(new Error('TLS accepted a Redis certificate for a different hostname'))
        })
        socket.once('error', resolve)
      })
      expect(failure).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    }
  })

  it('uses the maintained graceful close and releases every process resource', async () => {
    const fixture = fakeRedisClient()
    redis.createClient.mockReturnValue(fixture.client)

    const connection = await connectRedis(redisOptions())
    expect(connection.client).toBe(fixture.client)
    expect(redis.createClient.mock.calls[0]?.[0]?.socket)
      .toEqual({
        ca: 'fixture-ca', host: 'redis.fixture.example', port: 6379,
        rejectUnauthorized: true, servername: 'redis.fixture.example', tls: true,
      })
    expect(fixture.state.errorListeners).toHaveLength(1)

    await connection.close()

    expect(fixture.client.close).toHaveBeenCalledOnce()
    expect(fixture.client.quit).not.toHaveBeenCalled()
    expect(fixture.client.destroy).not.toHaveBeenCalled()
    expectResourcesReleased(fixture.state)
  })

  it('preserves a graceful-close failure after that close has released its resources', async () => {
    const closeFailure = new Error('Redis close failed after release')
    const fixture = fakeRedisClient({
      async close(state) {
        releaseResources(state)
        throw closeFailure
      },
    })
    redis.createClient.mockReturnValue(fixture.client)
    const connection = await connectRedis(redisOptions())

    await expect(connection.close()).rejects.toBe(closeFailure)

    expect(fixture.client.destroy).not.toHaveBeenCalled()
    expectResourcesReleased(fixture.state)
  })

  it('destroys an open client after graceful close rejects', async () => {
    const closeFailure = new Error('Redis close failed while open')
    const fixture = fakeRedisClient({ close: async () => { throw closeFailure } })
    redis.createClient.mockReturnValue(fixture.client)
    const connection = await connectRedis(redisOptions())

    await expect(connection.close()).rejects.toBe(closeFailure)

    expect(fixture.client.destroy).toHaveBeenCalledOnce()
    expectResourcesReleased(fixture.state)
  })

  it('preserves both close and destroy failures after the client is quiescent', async () => {
    const closeFailure = new Error('Redis close failed while open')
    const destroyFailure = new Error('Redis destroy reported cleanup failure')
    const fixture = fakeRedisClient({
      close: async () => { throw closeFailure },
      destroy: () => { throw destroyFailure },
    })
    redis.createClient.mockReturnValue(fixture.client)
    const connection = await connectRedis(redisOptions())
    let failure: unknown

    try {
      await connection.close()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new TypeError('expected AggregateError')
    expect(failure.errors).toEqual([closeFailure, destroyFailure])
    expectResourcesReleased(fixture.state)
  })
})

function redisOptions() {
  return {
    host: 'redis.fixture.example', port: 6379, username: 'fixture', password: 'secret',
    tls: true as const, ca: 'fixture-ca',
  }
}

interface FakeRedisState {
  isOpen: boolean
  timerOwned: boolean
  socketOwned: boolean
  errorListeners: Set<unknown>
}

interface FakeRedisHooks {
  connect?(): Promise<void>
  close?(state: FakeRedisState): Promise<void>
  destroy?(state: FakeRedisState): void
}

function fakeRedisClient(hooks: FakeRedisHooks = {}) {
  const state: FakeRedisState = {
    isOpen: false,
    timerOwned: false,
    socketOwned: false,
    errorListeners: new Set(),
  }
  const client = {
    get isOpen() { return state.isOpen },
    on: vi.fn((event: string, listener: unknown) => {
      if (event === 'error') state.errorListeners.add(listener)
    }),
    removeListener: vi.fn((event: string, listener: unknown) => {
      if (event === 'error') state.errorListeners.delete(listener)
    }),
    connect: vi.fn(async () => {
      await hooks.connect?.()
      state.isOpen = true
      state.timerOwned = true
      state.socketOwned = true
    }),
    close: vi.fn(async () => {
      if (hooks.close !== undefined) {
        await hooks.close(state)
        return
      }
      releaseResources(state)
    }),
    destroy: vi.fn(() => {
      releaseResources(state)
      hooks.destroy?.(state)
    }),
    quit: vi.fn(async () => {
      releaseResources(state)
      return 'OK'
    }),
  }
  return { client: client as unknown as RedisClientType & typeof client, state }
}

function releaseResources(state: FakeRedisState): void {
  state.isOpen = false
  state.timerOwned = false
  state.socketOwned = false
}

function expectResourcesReleased(state: FakeRedisState): void {
  expect(state).toMatchObject({ isOpen: false, timerOwned: false, socketOwned: false })
  expect(state.errorListeners).toHaveLength(0)
}
