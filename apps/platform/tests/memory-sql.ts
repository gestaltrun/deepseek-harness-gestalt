/** In-process SQL stand-in for the Platform pairing and route stores. */

import type { PlatformSqlClient, PlatformSqlPool } from '../src/postgres-pairing-store.ts'

interface DesktopRow {
  account_id: string
  desktop_installation_id: string
  active_route_id: string | null
  revoking_route_ids: string[]
}

interface MobileRow {
  pending_pairing_id: string
  pairing_id: string
  account_id: string
  desktop_installation_id: string
  mobile_installation_id: string
  credential_fingerprint: string | null
  last_access_at: number | null
  presence_leases: Record<string, number>
  sealed_relay_authority: Buffer | null
}

interface RouteRow {
  revision: number
  revoked: boolean
}

interface Tables {
  transactions: Map<string, unknown>
  desktops: Map<string, DesktopRow>
  mobile: Map<string, MobileRow>
  routes: Map<string, RouteRow>
  authorities: Map<string, { endpoint: string; digest: string }>
}

/** Exclusive in-memory pool that understands the store SQL. */
export function createMemoryPlatformSqlPool(): PlatformSqlPool {
  const live = emptyTables()
  let snapshot: Tables | undefined
  let chain = Promise.resolve()

  const run = (sql: string, values: unknown[] = []) => dispatch(live, snapshot, sql, values, (next) => {
    snapshot = next
  })

  return {
    query: async (sql, values) => run(sql, values),
    async connect() {
      let releaseLock!: () => void
      const mine = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const wait = chain
      chain = chain.then(() => mine)
      await wait
      const exclusive: PlatformSqlClient & { release(): void } = {
        query: async (sql, values) => run(sql, values),
        release() {
          releaseLock()
        },
      }
      return exclusive
    },
  }
}

function emptyTables(): Tables {
  return {
    transactions: new Map(),
    desktops: new Map(),
    mobile: new Map(),
    routes: new Map(),
    authorities: new Map(),
  }
}

function cloneTables(tables: Tables): Tables {
  return {
    transactions: new Map(tables.transactions),
    desktops: new Map([...tables.desktops].map(([key, row]) => [key, { ...row, revoking_route_ids: [...row.revoking_route_ids] }])),
    mobile: new Map([...tables.mobile].map(([key, row]) => [
      key,
      {
        ...row,
        presence_leases: { ...row.presence_leases },
        sealed_relay_authority: row.sealed_relay_authority === null ? null : Buffer.from(row.sealed_relay_authority),
      },
    ])),
    routes: new Map([...tables.routes].map(([key, row]) => [key, { ...row }])),
    authorities: new Map(tables.authorities),
  }
}

function dispatch(
  live: Tables,
  snapshot: Tables | undefined,
  sql: string,
  values: unknown[],
  setSnapshot: (next: Tables | undefined) => void,
): { rows: never[] | Array<Record<string, unknown>>; rowCount: number } {
  const text = collapse(sql)
  if (text.startsWith('create table') || text.startsWith('create unique index') || text.startsWith('alter table')) {
    return { rows: [], rowCount: 0 }
  }
  if (text === 'begin') {
    setSnapshot(cloneTables(live))
    return { rows: [], rowCount: 0 }
  }
  if (text === 'commit') {
    setSnapshot(undefined)
    return { rows: [], rowCount: 0 }
  }
  if (text === 'rollback') {
    if (snapshot !== undefined) {
      live.transactions = snapshot.transactions
      live.desktops = snapshot.desktops
      live.mobile = snapshot.mobile
      live.routes = snapshot.routes
      live.authorities = snapshot.authorities
    }
    setSnapshot(undefined)
    return { rows: [], rowCount: 0 }
  }
  if (text.includes('insert into remote_access_pairing_transactions')) {
    const identity = asString(values[0], 'database identity')
    if (!live.transactions.has(identity)) live.transactions.set(identity, JSON.parse(asString(values[1], 'state')))
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('from remote_access_pairing_transactions')) {
    const identity = asString(values[0], 'database identity')
    const state = live.transactions.get(identity)
    return state === undefined ? { rows: [], rowCount: 0 } : { rows: [{ state }], rowCount: 1 }
  }
  if (text.includes('update remote_access_pairing_transactions')) {
    live.transactions.set(asString(values[0], 'database identity'), JSON.parse(asString(values[1], 'state')))
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('insert into remote_access_desktops') && text.includes('returning')) {
    return upsertDesktop(live, values, true)
  }
  if (text.includes('insert into remote_access_desktops')) {
    return upsertDesktop(live, values, false)
  }
  if (text.includes('from remote_access_desktops')) {
    const row = live.desktops.get(desktopKey(values[0], values[1]))
    return row === undefined
      ? { rows: [], rowCount: 0 }
      : { rows: [{ active_route_id: row.active_route_id, revoking_route_ids: row.revoking_route_ids }], rowCount: 1 }
  }
  if (text.includes('delete from remote_access_desktops')) {
    live.desktops.delete(desktopKey(values[0], values[1]))
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('update remote_access_desktops')) {
    const key = desktopKey(values[0], values[1])
    const row = live.desktops.get(key)
    if (row === undefined) return { rows: [], rowCount: 0 }
    row.revoking_route_ids = parseJsonArray(values[2])
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('insert into remote_access_mobile_pairings')) {
    const identity = asString(values[0], 'database identity')
    const pending = asString(values[1], 'pending pairing id')
    const key = `${identity}\n${pending}`
    if (!live.mobile.has(key)) {
      live.mobile.set(key, {
        pending_pairing_id: pending,
        pairing_id: asString(values[2], 'pairing id'),
        account_id: asString(values[3], 'account id'),
        desktop_installation_id: asString(values[4], 'desktop installation'),
        mobile_installation_id: asString(values[5], 'mobile installation'),
        credential_fingerprint: values[6] === null || values[6] === undefined
          ? null
          : asString(values[6], 'credential fingerprint'),
        last_access_at: values[7] === null || values[7] === undefined ? null : asNumber(values[7], 'last access'),
        presence_leases: {},
        sealed_relay_authority: values[8] === null || values[8] === undefined ? null : Buffer.from(values[8] as Buffer),
      })
    }
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('from remote_access_mobile_pairings') && text.includes('pending_pairing_id')) {
    const row = live.mobile.get(`${asString(values[0], 'database identity')}\n${asString(values[1], 'pending pairing id')}`)
    return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...row }], rowCount: 1 }
  }
  if (text.includes('returning last_access_at, presence_leases')) {
    const identity = asString(values[0], 'database identity')
    const pairingId = asString(values[1], 'pairing id')
    const row = [...live.mobile.entries()].find(([key, candidate]) =>
      key.startsWith(`${identity}\n`) && candidate.pairing_id === pairingId)?.[1]
    if (row !== undefined) prunePresenceLeases(row, asNumber(values[2], 'observed at'))
    return row === undefined
      ? { rows: [], rowCount: 0 }
      : { rows: [{ last_access_at: row.last_access_at, presence_leases: { ...row.presence_leases } }], rowCount: 1 }
  }
  if (text.includes('update remote_access_mobile_pairings') && text.includes('jsonb_build_object')) {
    const identity = asString(values[0], 'database identity')
    const fingerprint = asString(values[1], 'credential fingerprint')
    for (const [key, row] of live.mobile) {
      if (!key.startsWith(`${identity}\n`) || row.credential_fingerprint !== fingerprint) continue
      prunePresenceLeases(row, asNumber(values[4], 'observed at'))
      const connectionToken = asString(values[2], 'connection token')
      const expiresAt = asNumber(values[3], 'lease expiry')
      row.presence_leases[connectionToken] = Math.max(row.presence_leases[connectionToken] ?? expiresAt, expiresAt)
      const accessedAt = asNumber(values[4], 'last access')
      row.last_access_at = Math.max(row.last_access_at ?? accessedAt, accessedAt)
    }
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('update remote_access_mobile_pairings') && text.includes('entry.key <>')) {
    const identity = asString(values[0], 'database identity')
    const fingerprint = asString(values[1], 'credential fingerprint')
    for (const [key, row] of live.mobile) {
      if (!key.startsWith(`${identity}\n`) || row.credential_fingerprint !== fingerprint) continue
      prunePresenceLeases(row, asNumber(values[3], 'observed at'))
      Reflect.deleteProperty(row.presence_leases, asString(values[2], 'connection token'))
    }
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('delete from remote_access_mobile_pairings') && text.includes('desktop_installation_id')) {
    const identity = asString(values[0], 'database identity')
    const account = asString(values[1], 'account id')
    const desktop = asString(values[2], 'desktop installation')
    for (const [key, row] of [...live.mobile]) {
      if (key.startsWith(`${identity}\n`) && row.account_id === account && row.desktop_installation_id === desktop) {
        live.mobile.delete(key)
      }
    }
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('delete from remote_access_mobile_pairings')) {
    const identity = asString(values[0], 'database identity')
    const pairingId = asString(values[1], 'pairing id')
    for (const [key, row] of [...live.mobile]) {
      if (key.startsWith(`${identity}\n`) && row.pairing_id === pairingId) live.mobile.delete(key)
    }
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('insert into remote_access_routes')) {
    live.routes.set(routeKey(values[0], values[1]), {
      revision: asNumber(values[2], 'revision'),
      revoked: values[3] === true,
    })
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('from remote_access_routes')) {
    const row = live.routes.get(routeKey(values[0], values[1]))
    return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...row }], rowCount: 1 }
  }
  if (text.includes('insert into remote_access_route_authorities')) {
    const digest = digestKey(values[3])
    live.authorities.set(
      `${routeKey(values[0], values[1])}\n${asString(values[2], 'endpoint')}\n${digest}`,
      { endpoint: asString(values[2], 'endpoint'), digest },
    )
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('select 1 from remote_access_route_authorities')) {
    const key = `${routeKey(values[0], values[1])}\n${asString(values[2], 'endpoint')}\n${digestKey(values[3])}`
    return live.authorities.has(key) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  }
  if (text.includes('delete from remote_access_route_authorities') && text.includes('digest')) {
    live.authorities.delete(
      `${routeKey(values[0], values[1])}\n${asString(values[2], 'endpoint')}\n${digestKey(values[3])}`,
    )
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('delete from remote_access_route_authorities') && text.includes('endpoint')) {
    const prefix = `${routeKey(values[0], values[1])}\n${asString(values[2], 'endpoint')}\n`
    for (const key of [...live.authorities.keys()]) if (key.startsWith(prefix)) live.authorities.delete(key)
    return { rows: [], rowCount: 1 }
  }
  if (text.includes('delete from remote_access_route_authorities')) {
    const prefix = `${routeKey(values[0], values[1])}\n`
    for (const key of [...live.authorities.keys()]) if (key.startsWith(prefix)) live.authorities.delete(key)
    return { rows: [], rowCount: 1 }
  }
  throw new Error(`memory sql does not implement: ${text}`)
}

function upsertDesktop(
  live: Tables,
  values: unknown[],
  returning: boolean,
): { rows: Array<Record<string, unknown>>; rowCount: number } {
  const key = desktopKey(values[0], values[1])
  const incoming: DesktopRow = {
    account_id: asString(values[2], 'account id'),
    desktop_installation_id: asString(values[3], 'desktop installation'),
    active_route_id: values[4] === null || values[4] === undefined ? null : asString(values[4], 'route id'),
    revoking_route_ids: parseJsonArray(values[5] ?? '[]'),
  }
  const existing = live.desktops.get(key)
  if (existing === undefined) live.desktops.set(key, incoming)
  else if (returning) existing.active_route_id ??= incoming.active_route_id
  else {
    existing.active_route_id = null
    existing.revoking_route_ids = incoming.revoking_route_ids
  }
  const row = live.desktops.get(key)
  if (row === undefined) throw new Error('desktop upsert lost the row')
  return returning
    ? { rows: [{ active_route_id: row.active_route_id }], rowCount: 1 }
    : { rows: [], rowCount: 1 }
}

function collapse(sql: string): string {
  return sql.replaceAll(/\s+/gu, ' ').trim().toLowerCase()
}

function desktopKey(identity: unknown, accessKey: unknown): string {
  return `${asString(identity, 'database identity')}\n${asString(accessKey, 'access key')}`
}

function routeKey(identity: unknown, routeId: unknown): string {
  return `${asString(identity, 'database identity')}\n${asString(routeId, 'route id')}`
}

function prunePresenceLeases(row: MobileRow, observedAt: number): void {
  for (const [token, expiresAt] of Object.entries(row.presence_leases)) {
    if (expiresAt <= observedAt) Reflect.deleteProperty(row.presence_leases, token)
  }
}

function digestKey(value: unknown): string {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString('hex')
  throw new TypeError('credential digest must be bytes')
}

function parseJsonArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!Array.isArray(parsed)) throw new TypeError('json array required')
  return parsed.map((item, index) => asString(item, `json[${String(index)}]`))
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function asNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`)
  return value
}
