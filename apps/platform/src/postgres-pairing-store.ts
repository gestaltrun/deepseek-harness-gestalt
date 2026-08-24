/** PostgreSQL PersonalPairingAuthorityStore shared by every Platform Instance. */

import {
  parseInstallationId,
  parsePlatformAccountId,
  type InstallationId,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  RemoteAccessError,
  type DesktopRemoteAccessAuthority,
  type MobilePairingAuthority,
  type PendingPairingId,
  type PersonalPairingAuthorityStore,
  type PersonalPairingId,
  type PersonalPairingTransactionState,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayRouteId, type RelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  decodePairingTransactionState,
  emptyPairingTransactionState,
  encodePairingTransactionState,
} from './pairing-state-codec.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_access_desktops (
  database_identity text NOT NULL,
  access_key text NOT NULL,
  account_id text NOT NULL,
  desktop_installation_id text NOT NULL,
  active_route_id text,
  revoking_route_ids jsonb NOT NULL,
  PRIMARY KEY (database_identity, access_key)
);
CREATE TABLE IF NOT EXISTS remote_access_mobile_pairings (
  database_identity text NOT NULL,
  pending_pairing_id text NOT NULL,
  pairing_id text NOT NULL,
  account_id text NOT NULL,
  desktop_installation_id text NOT NULL,
  mobile_installation_id text NOT NULL,
  sealed_relay_authority bytea,
  PRIMARY KEY (database_identity, pending_pairing_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS remote_access_mobile_pairings_pairing
  ON remote_access_mobile_pairings (database_identity, pairing_id);
CREATE TABLE IF NOT EXISTS remote_access_pairing_transactions (
  database_identity text PRIMARY KEY,
  state jsonb NOT NULL
);
`

interface DesktopRow {
  active_route_id: string | null
  revoking_route_ids: unknown
}

interface MobileRow {
  pending_pairing_id: string
  pairing_id: string
  account_id: string
  desktop_installation_id: string
  mobile_installation_id: string
  sealed_relay_authority: Buffer | Uint8Array | null
}

/** Result rows returned by `pg.Pool` and the in-process SQL stand-in. */
interface PlatformSqlQueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number | null
}

/** Query face used by the durable store; `pg.Pool` satisfies it. */
export interface PlatformSqlClient {
  query(sql: string, values?: unknown[]): Promise<PlatformSqlQueryResult>
}

/** Pool that can open an exclusive transaction client. */
export interface PlatformSqlPool extends PlatformSqlClient {
  connect(): Promise<PlatformSqlClient & { release(): void }>
}

/** Durable pairing authority over one PostgreSQL database identity. */
export class PostgresPersonalPairingAuthorityStore implements PersonalPairingAuthorityStore {
  /**
   * @param databaseIdentity - deployment database identity bound to this store.
   * @param pool - shared connection pool.
   */
  constructor(
    readonly databaseIdentity: string,
    private readonly pool: PlatformSqlPool,
  ) {}

  /** Create pairing-authority tables if they are absent. */
  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA)
  }

  async runPairingTransaction<T>(
    operation: (state: PersonalPairingTransactionState) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO remote_access_pairing_transactions (database_identity, state)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (database_identity) DO NOTHING`,
        [this.databaseIdentity, JSON.stringify(encodePairingTransactionState(emptyPairingTransactionState()))],
      )
      const loaded = await client.query(
        `SELECT state FROM remote_access_pairing_transactions
          WHERE database_identity = $1
          FOR UPDATE`,
        [this.databaseIdentity],
      )
      const state = decodePairingTransactionState(loaded.rows[0]?.state)
      const result = await operation(state)
      await client.query(
        `UPDATE remote_access_pairing_transactions
            SET state = $2::jsonb
          WHERE database_identity = $1`,
        [this.databaseIdentity, JSON.stringify(encodePairingTransactionState(state))],
      )
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* rollback after a failed BEGIN or lock is best-effort */
      }
      throw error
    } finally {
      client.release()
    }
  }

  async getDesktop(
    accountId: PlatformAccountId,
    desktopInstallationId: InstallationId,
  ): Promise<DesktopRemoteAccessAuthority> {
    const result = await this.pool.query(
      `SELECT active_route_id, revoking_route_ids
         FROM remote_access_desktops
        WHERE database_identity = $1 AND access_key = $2`,
      [this.databaseIdentity, accessKey(accountId, desktopInstallationId)],
    )
    const routeId = asDesktopRow(result.rows[0])?.active_route_id
    return routeId === undefined || routeId === null
      ? { enabled: false }
      : { enabled: true, routeId: parseRelayRouteId(routeId) }
  }

  async enableDesktop(
    accountId: PlatformAccountId,
    desktopInstallationId: InstallationId,
    freshRouteId: RelayRouteId,
  ): Promise<RelayRouteId> {
    const key = accessKey(accountId, desktopInstallationId)
    const result = await this.pool.query(
      `INSERT INTO remote_access_desktops (
         database_identity, access_key, account_id, desktop_installation_id,
         active_route_id, revoking_route_ids
       ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb)
       ON CONFLICT (database_identity, access_key) DO UPDATE
         SET active_route_id = COALESCE(remote_access_desktops.active_route_id, EXCLUDED.active_route_id)
       RETURNING active_route_id`,
      [this.databaseIdentity, key, accountId, desktopInstallationId, freshRouteId],
    )
    const routeId = asDesktopRow(result.rows[0])?.active_route_id
    if (routeId === undefined || routeId === null) throw new Error('pairing desktop enable did not return a route')
    return parseRelayRouteId(routeId)
  }

  async disableDesktop(
    accountId: PlatformAccountId,
    desktopInstallationId: InstallationId,
  ): Promise<readonly RelayRouteId[]> {
    const key = accessKey(accountId, desktopInstallationId)
    const current = await this.pool.query(
      `SELECT active_route_id, revoking_route_ids
         FROM remote_access_desktops
        WHERE database_identity = $1 AND access_key = $2`,
      [this.databaseIdentity, key],
    )
    const row = asDesktopRow(current.rows[0])
    const revoking = new Set(row === undefined ? [] : decodeRouteIds(row.revoking_route_ids))
    if (row?.active_route_id !== undefined && row.active_route_id !== null) {
      revoking.add(row.active_route_id)
    }
    await this.pool.query(
      `INSERT INTO remote_access_desktops (
         database_identity, access_key, account_id, desktop_installation_id,
         active_route_id, revoking_route_ids
       ) VALUES ($1,$2,$3,$4,NULL,$5::jsonb)
       ON CONFLICT (database_identity, access_key) DO UPDATE
         SET active_route_id = NULL, revoking_route_ids = EXCLUDED.revoking_route_ids`,
      [this.databaseIdentity, key, accountId, desktopInstallationId, JSON.stringify([...revoking])],
    )
    await this.pool.query(
      `DELETE FROM remote_access_mobile_pairings
        WHERE database_identity = $1 AND account_id = $2 AND desktop_installation_id = $3`,
      [this.databaseIdentity, accountId, desktopInstallationId],
    )
    return [...revoking].map(parseRelayRouteId)
  }

  async completeRouteRevocation(
    accountId: PlatformAccountId,
    desktopInstallationId: InstallationId,
    routeId: RelayRouteId,
  ): Promise<void> {
    const key = accessKey(accountId, desktopInstallationId)
    const current = await this.pool.query(
      `SELECT active_route_id, revoking_route_ids
         FROM remote_access_desktops
        WHERE database_identity = $1 AND access_key = $2`,
      [this.databaseIdentity, key],
    )
    const row = asDesktopRow(current.rows[0])
    if (row === undefined) return
    const revoking = decodeRouteIds(row.revoking_route_ids).filter(id => id !== routeId)
    if (row.active_route_id === null && revoking.length === 0) {
      await this.pool.query(
        `DELETE FROM remote_access_desktops
          WHERE database_identity = $1 AND access_key = $2`,
        [this.databaseIdentity, key],
      )
      return
    }
    await this.pool.query(
      `UPDATE remote_access_desktops
          SET revoking_route_ids = $3::jsonb
        WHERE database_identity = $1 AND access_key = $2`,
      [this.databaseIdentity, key, JSON.stringify(revoking)],
    )
  }

  async confirmMobilePairing(authority: MobilePairingAuthority): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO remote_access_mobile_pairings (
           database_identity, pending_pairing_id, pairing_id, account_id,
           desktop_installation_id, mobile_installation_id, sealed_relay_authority
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (database_identity, pending_pairing_id) DO NOTHING`,
        [
          this.databaseIdentity,
          authority.pendingPairingId,
          authority.pairingId,
          authority.accountId,
          authority.desktopInstallationId,
          authority.mobileInstallationId,
          authority.sealedRelayAuthority === undefined
            ? null
            : Buffer.from(authority.sealedRelayAuthority),
        ],
      )
      const existing = await this.readMobilePairing(client, authority.pendingPairingId, true)
      if (existing === undefined) throw new Error('pairing confirm did not persist')
      if (!sameMobileAuthority(existing, authority)) {
        throw new RemoteAccessError('PAIRING_ID_COLLISION', 'Pending Pairing authority was already committed')
      }
      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ROLLBACK after a failed BEGIN is best-effort; the original error is rethrown */
      }
      throw error
    } finally {
      client.release()
    }
  }

  async getMobilePairing(pendingPairingId: PendingPairingId): Promise<MobilePairingAuthority | undefined> {
    return await this.readMobilePairing(this.pool, pendingPairingId, false)
  }

  private async readMobilePairing(
    client: PlatformSqlClient,
    pendingPairingId: PendingPairingId,
    exclusive: boolean,
  ): Promise<MobilePairingAuthority | undefined> {
    const result = await client.query(
      `SELECT pending_pairing_id, pairing_id, account_id, desktop_installation_id,
              mobile_installation_id, sealed_relay_authority
         FROM remote_access_mobile_pairings
        WHERE database_identity = $1 AND pending_pairing_id = $2${exclusive ? '\n        FOR UPDATE' : ''}`,
      [this.databaseIdentity, pendingPairingId],
    )
    const row = asMobileRow(result.rows[0])
    return row === undefined ? undefined : mobileFromRow(row)
  }

  async revokeMobilePairing(pairingId: PersonalPairingId): Promise<void> {
    await this.pool.query(
      `DELETE FROM remote_access_mobile_pairings
        WHERE database_identity = $1 AND pairing_id = $2`,
      [this.databaseIdentity, pairingId],
    )
  }
}

function asDesktopRow(value: Record<string, unknown> | undefined): DesktopRow | undefined {
  return value as DesktopRow | undefined
}

function asMobileRow(value: Record<string, unknown> | undefined): MobileRow | undefined {
  return value as MobileRow | undefined
}

function mobileFromRow(row: MobileRow): MobilePairingAuthority {
  return {
    accountId: parsePlatformAccountId(row.account_id),
    desktopInstallationId: parseInstallationId(row.desktop_installation_id),
    mobileInstallationId: parseInstallationId(row.mobile_installation_id),
    pendingPairingId: row.pending_pairing_id as PendingPairingId,
    pairingId: row.pairing_id as PersonalPairingId,
    ...(row.sealed_relay_authority === null
      ? {}
      : { sealedRelayAuthority: Uint8Array.from(row.sealed_relay_authority) }),
  }
}

function sameMobileAuthority(left: MobilePairingAuthority, right: MobilePairingAuthority): boolean {
  return left.accountId === right.accountId
    && left.desktopInstallationId === right.desktopInstallationId
    && left.mobileInstallationId === right.mobileInstallationId
    && left.pendingPairingId === right.pendingPairingId
    && left.pairingId === right.pairingId
    && bytesEqual(left.sealedRelayAuthority, right.sealedRelayAuthority)
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function decodeRouteIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('revoking route ids must be an array')
  return value.map((id, index) => {
    if (typeof id !== 'string' || id === '') throw new TypeError(`revoking route id ${String(index)} is invalid`)
    return id
  })
}

function accessKey(accountId: string, installationId: InstallationId): string {
  return JSON.stringify([accountId, installationId])
}
