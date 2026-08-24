/** Entry-owned operated Platform launch composition. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { loadOperatedPlatformEnvironment, type SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { GitHubOAuthIdentityProvider, PlatformAccount } from '@deepseek-ai/dsh-platform-account-core'
import * as PlatformAccountHttp from '@deepseek-ai/dsh-platform-account-http'
import pg, { type Pool } from 'pg'
import { PostgresAccountBackend } from './postgres-backend.ts'
import { loadOperatedPlatformConfig, type OperatedPlatformConfig } from './production-env.ts'
import { RedisAccountInvalidationBus, connectRedis } from './redis-bus.ts'
import { OperatedRemoteAccessResources } from './remote-access-resources.ts'

type RedisConnection = Awaited<ReturnType<typeof connectRedis>>

/** Replaceable connection creators used only to attach disposable durable-store fixtures. */
export interface OperatedPlatformLaunchAdapters {
  createPostgres?: (config: OperatedPlatformConfig['postgres']) => Pool
  connectRedis?: (config: OperatedPlatformConfig['redis']) => Promise<RedisConnection>
  githubFetch?: typeof fetch
}

/** Inputs owned by the executable Platform entry. */
export interface OperatedPlatformLaunchOptions {
  env?: NodeJS.Dict<string>
  publicIndex?: string
  adapters?: OperatedPlatformLaunchAdapters
}

/** Running operated Platform and its quiescent process-resource owner. */
export interface RunningOperatedPlatform {
  context: Context
  environment: SelectedPlatformEnvironment
  remoteAccess: OperatedRemoteAccessResources
  close(): Promise<void>
}

/**
 * Validate, connect, migrate, and mount the complete operated Platform product entry.
 * @param options - process configuration plus optional disposable-store adapters.
 * @returns running Cordis composition; `close` drains plugins and store clients.
 */
export async function launchOperatedPlatform(
  options: OperatedPlatformLaunchOptions = {},
): Promise<RunningOperatedPlatform> {
  const env = options.env ?? process.env
  const config = loadOperatedPlatformConfig(env)
  const environment = loadOperatedPlatformEnvironment(config.environment)
  const listen = loadListenConfig(env)
  const createPostgres = options.adapters?.createPostgres ?? (value => new pg.Pool(value))
  const connect = options.adapters?.connectRedis ?? connectRedis
  const postgres = createPostgres(config.postgres)
  let publisher: RedisConnection | undefined
  let subscriber: RedisConnection | undefined
  const context = new Context()
  let resourcesOwned = true
  const closeResources = async (): Promise<void> => {
    if (!resourcesOwned) return
    resourcesOwned = false
    const results = await Promise.allSettled([
      subscriber?.close(),
      publisher?.close(),
      postgres.end(),
    ])
    const errors: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason as unknown)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'operated Platform resources failed to close')
  }
  try {
    const backend = new PostgresAccountBackend(environment.databaseIdentity, postgres)
    await backend.migrate()
    publisher = await connect(config.redis)
    subscriber = await connect(config.redis)
    const invalidation = new RedisAccountInvalidationBus(publisher.client, subscriber.client)
    await invalidation.listen()
    const remoteAccess = new OperatedRemoteAccessResources({
      databaseIdentity: environment.databaseIdentity,
      postgres,
      redisCommand: publisher.client,
      redisSubscriber: subscriber.client,
      redisKeyPrefix: config.relayRedisKeyPrefix,
    })
    await remoteAccess.migrate()
    const github = new GitHubOAuthIdentityProvider({
      environment,
      credential: { reference: environment.credentialReference, secret: config.githubClientSecret },
      ...(options.adapters?.githubFetch === undefined ? {} : { fetch: options.adapters.githubFetch }),
    })
    context.effect(() => closeResources, 'platform: durable process resources')
    await context.plugin(WebServer, listen)
    await context.plugin({
      name: 'platform-account-provider',
      apply(inner: Context) {
        new PlatformAccount(inner, {
          backend,
          invalidation,
          github,
          environment,
          config: {
            tokenSigningKey: config.tokenSigningKey,
            pollingSigningKey: config.pollingSigningKey,
          },
        })
      },
    })
    await context.plugin(PlatformAccountHttp, { origin: environment.origin })
    registerHealth(context)
    await context.plugin(FrontendStatic, {
      distIndex: options.publicIndex ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'),
    })
    return {
      context,
      environment,
      remoteAccess,
      close: async () => { await context.fiber.dispose() },
    }
  } catch (error) {
    const cleanup = await Promise.allSettled([context.fiber.dispose(), closeResources()])
    const cleanupErrors: unknown[] = []
    for (const result of cleanup) {
      if (result.status === 'rejected') cleanupErrors.push(result.reason as unknown)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'operated Platform launch and cleanup failed')
    }
    throw error
  }
}

function registerHealth(context: Context): void {
  for (const path of ['/healthz', '/readyz']) {
    context.effect(() => context.webServer.register({
      kind: 'exact',
      path,
      handler(_req, res) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
      },
    }),
    `platform: ${path}`,
    )
  }
}

function listenPort(value: string | undefined): number {
  if (value === undefined || value === '') return 8080
  if (!/^\d+$/u.test(value)) {
    throw new TypeError('PORT must be an integer from 0 through 65535')
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('PORT must be an integer from 0 through 65535')
  }
  return port
}

function loadListenConfig(env: NodeJS.Dict<string>): { host: '0.0.0.0' | '127.0.0.1'; port: number } {
  const value = env.PLATFORM_LISTEN_HOST
  if (value !== undefined && value !== '' && value !== '0.0.0.0' && value !== '127.0.0.1') {
    throw new TypeError('PLATFORM_LISTEN_HOST accepts only 0.0.0.0 or 127.0.0.1')
  }
  return {
    host: value === '127.0.0.1' ? value : '0.0.0.0',
    port: listenPort(env.PORT),
  }
}
