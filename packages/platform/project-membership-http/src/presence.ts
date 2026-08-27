/**
 * Member presence aggregation for the Project Membership HTTP surface: a
 * registry of per-installation heartbeat entries behind a TTL storage
 * adapter. A member is online while any of their installations holds a live
 * heartbeat; there is no manual state and no idle inference.
 * @module
 */

import type { InstallationId, PlatformAccountId } from '@deepseek-ai/dsh-platform-account'

/** One recorded installation heartbeat inside its TTL window. */
export interface PresenceEntry {
  /** Account whose installation beat. */
  readonly accountId: PlatformAccountId
  /** Installation that beat; aggregation unions these per account. */
  readonly installationId: InstallationId
  /** Unix epoch milliseconds after which the entry stops counting online. */
  readonly expiresAt: number
}

/**
 * TTL storage adapter for presence entries. The in-process default keeps
 * presence per Platform instance; a deployment that shares one presence view
 * across instances implements this interface with a shared TTL store instead
 * of changing the registry or its callers.
 */
export interface PresenceStore {
  /** Record or refresh one heartbeat, replacing the installation's previous expiry. */
  record(entry: PresenceEntry): Promise<void>
  /** Collect the candidate accounts holding at least one entry not expired at `now`. */
  onlineAccountIds(accountIds: readonly PlatformAccountId[], now: number): Promise<ReadonlySet<PlatformAccountId>>
}

/** Process-local TTL map: the default {@link PresenceStore} for one Platform instance. */
export class InProcessPresenceStore implements PresenceStore {
  private readonly installations = new Map<PlatformAccountId, Map<InstallationId, number>>()

  async record(entry: PresenceEntry): Promise<void> {
    let installations = this.installations.get(entry.accountId)
    if (installations === undefined) {
      installations = new Map()
      this.installations.set(entry.accountId, installations)
    }
    installations.set(entry.installationId, entry.expiresAt)
  }

  async onlineAccountIds(
    accountIds: readonly PlatformAccountId[],
    now: number,
  ): Promise<ReadonlySet<PlatformAccountId>> {
    const online = new Set<PlatformAccountId>()
    for (const accountId of accountIds) {
      const installations = this.installations.get(accountId)
      if (installations === undefined) continue
      for (const [installationId, expiresAt] of installations) {
        if (expiresAt > now) {
          online.add(accountId)
          break
        }
        // Lazy sweep: an entry read past its expiry is dead state.
        installations.delete(installationId)
      }
      if (installations.size === 0) this.installations.delete(accountId)
    }
    return online
  }
}

/**
 * Aggregate installation heartbeats into per-account presence. Registration
 * needs only a proven session; expiry is the only way to leave the online
 * set, and any live installation keeps its account online.
 */
export class PresenceRegistry {
  private readonly store: PresenceStore
  private readonly ttlMs: number
  private readonly now: () => number

  /**
   * @param store - TTL storage backing the entries.
   * @param ttlMs - liveness window applied to every recorded heartbeat.
   * @param now - epoch-milliseconds clock; defaults to the system clock.
   */
  constructor(store: PresenceStore, ttlMs: number, now: () => number = Date.now) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError('presence TTL must be a positive integer number of milliseconds')
    }
    this.store = store
    this.ttlMs = ttlMs
    this.now = now
  }

  /**
   * Record one installation heartbeat, keeping it online for the configured TTL.
   * @param accountId - account whose installation beat.
   * @param installationId - installation that beat.
   */
  async beat(accountId: PlatformAccountId, installationId: InstallationId): Promise<void> {
    await this.store.record({ accountId, installationId, expiresAt: this.now() + this.ttlMs })
  }

  /**
   * Collect the candidate accounts holding at least one live heartbeat.
   * @param accountIds - accounts to evaluate, typically one roster.
   * @returns the subset that is online.
   */
  async onlineAccountIds(accountIds: readonly PlatformAccountId[]): Promise<ReadonlySet<PlatformAccountId>> {
    return this.store.onlineAccountIds(accountIds, this.now())
  }
}
