/** Durable Remote Access adapters owned by the operated Platform composition. */

import { RedisRelayCoordinator, type RelayRedisClient } from '@deepseek-ai/dsh-remote-access-redis'
import type { PlatformSqlPool } from './postgres-pairing-store.ts'
import { PostgresPersonalPairingAuthorityStore } from './postgres-pairing-store.ts'
import { PostgresRelayRouteStore } from './postgres-route-store.ts'

/** Inputs for the production PostgreSQL and Redis Remote Access adapters. */
export interface OperatedRemoteAccessResourcesOptions {
  databaseIdentity: string
  postgres: PlatformSqlPool
  redisCommand: RelayRedisClient
  redisSubscriber: RelayRedisClient
  redisKeyPrefix: string
}

/** Product-owned durable authority, route, and ephemeral coordination adapters. */
export class OperatedRemoteAccessResources {
  readonly authority: PostgresPersonalPairingAuthorityStore
  readonly routeStore: PostgresRelayRouteStore
  readonly coordinator: RedisRelayCoordinator

  /** @param options - connected deployment-selected PostgreSQL and Redis clients. */
  constructor(options: OperatedRemoteAccessResourcesOptions) {
    this.authority = new PostgresPersonalPairingAuthorityStore(options.databaseIdentity, options.postgres)
    this.routeStore = new PostgresRelayRouteStore(options.databaseIdentity, options.postgres)
    this.coordinator = new RedisRelayCoordinator({
      command: options.redisCommand,
      subscriber: options.redisSubscriber,
      keyPrefix: options.redisKeyPrefix,
    })
  }

  /** Create the durable Remote Access tables before any Consumer is mounted. */
  async migrate(): Promise<void> {
    await this.authority.migrate()
    await this.routeStore.migrate()
  }
}
