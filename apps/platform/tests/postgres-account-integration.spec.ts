import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseInstallationId,
  parseLoginAttemptId,
  parsePlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  parsePendingPairingId,
  parsePersonalPairingId,
  parseRelayConnectionToken,
  parseRelayCredentialFingerprint,
} from '@deepseek-ai/dsh-remote-access'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresAccountBackend } from '../src/postgres-backend.ts'
import { PostgresPersonalPairingAuthorityStore } from '../src/postgres-pairing-store.ts'

const postgresAvailable = spawnSync('initdb', ['--version'], { encoding: 'utf8' }).status === 0
  && spawnSync('postgres', ['--version'], { encoding: 'utf8' }).status === 0

describe.skipIf(!postgresAvailable)('PostgresAccountBackend with disposable PostgreSQL', () => {
  it('replaces a pre-presentation Mobile session during forced re-login', async () => {
    const runtime = await startPostgres()
    try {
      await runtime.pool.query(LEGACY_SCHEMA)
      await runtime.pool.query(
        `INSERT INTO account_accounts (id, identity_namespace, github_id, github_login, avatar_url)
         VALUES ('account-legacy', 'gestalt-production', 7, 'octocat', 'https://avatars.example/octocat')`,
      )
      await runtime.pool.query(
        `INSERT INTO account_sessions (
           id, identity_namespace, account_id, installation_id, installation_kind,
           public_key, revision, active, refresh_hash, refresh_expires_at
         ) VALUES (
           'session-legacy', 'gestalt-production', 'account-legacy', 'mobile-stable', 'mobile',
           '{}'::jsonb, 1, TRUE, 'legacy-refresh', 9999999999999
         )`,
      )
      const backend = new PostgresAccountBackend('gestalt', runtime.pool)
      await backend.migrate()
      await expect(backend.getSession('session-legacy' as never)).resolves.toMatchObject({
        installationKind: 'mobile',
        installationId: 'mobile-stable',
        active: true,
      })
      const attemptId = parseLoginAttemptId('attempt-relogin')
      await backend.createAttempt({
        id: attemptId,
        environment: 'production',
        identityNamespace: 'gestalt-production',
        installationId: parseInstallationId('mobile-stable'),
        installationKind: 'mobile',
        presentation: { name: 'Real replacement phone', platform: 'android' },
        publicKey: {},
        state: 'state-relogin',
        codeVerifier: 'verifier-relogin',
        expiresAt: Date.now() + 60_000,
        status: 'pending',
      })
      await backend.authorizeAttempt(attemptId, {
        providerSubject: 7,
        login: 'octocat',
        avatarUrl: 'https://avatars.example/octocat',
      })

      await expect(backend.hasActiveSessionByInstallation(
        'gestalt-production',
        parseInstallationId('mobile-stable'),
      )).resolves.toBe(true)
      const replacement = await backend.consumeAuthorizedAttempt(attemptId, 'replacement-refresh', Date.now() + 60_000)

      expect(replacement.replacedSessionId).toBe('session-legacy')
      expect(replacement.session).toMatchObject({
        installationId: 'mobile-stable',
        installationKind: 'mobile',
        presentation: { name: 'Real replacement phone', platform: 'android' },
        active: true,
      })
      const legacy = await runtime.pool.query<{ active: boolean }>(
        'SELECT active FROM account_sessions WHERE id = $1',
        ['session-legacy'],
      )
      expect(legacy.rows).toEqual([{ active: false }])
    } finally {
      await runtime.close()
    }
  })

  it('preserves overlapping Relay presence leases and expires a crashed connection', async () => {
    const runtime = await startPostgres()
    try {
      const writer = new PostgresPersonalPairingAuthorityStore('gestalt-production', runtime.pool)
      const reader = new PostgresPersonalPairingAuthorityStore('gestalt-production', runtime.pool)
      await writer.migrate()
      const accountId = parsePlatformAccountId('account-presence')
      const pendingPairingId = parsePendingPairingId('pending-presence')
      const pairingId = parsePersonalPairingId('pairing-presence')
      const credentialFingerprint = parseRelayCredentialFingerprint('credential-presence')
      await writer.confirmMobilePairing({
        accountId,
        desktopInstallationId: parseInstallationId('desktop-presence'),
        mobileInstallationId: parseInstallationId('mobile-presence'),
        pendingPairingId,
        pairingId,
        credentialFingerprint,
        lastAccessAt: 100,
        sealedRelayAuthority: Uint8Array.of(1, 2, 3),
      })
      await writer.recordRelayLease({
        credentialFingerprint,
        connectionToken: parseRelayConnectionToken('connection-a'),
        expiresAt: 500,
        accessedAt: 200,
      })
      await reader.recordRelayLease({
        credentialFingerprint,
        connectionToken: parseRelayConnectionToken('connection-a'),
        expiresAt: 450,
        accessedAt: 180,
      })
      await expect(writer.getPersonalPairingActivity(pairingId, 475)).resolves.toEqual({
        lastAccessAt: 200,
        online: true,
      })
      await reader.recordRelayLease({
        credentialFingerprint,
        connectionToken: parseRelayConnectionToken('connection-b'),
        expiresAt: 600,
        accessedAt: 250,
      })
      await writer.releaseRelayLease({
        credentialFingerprint,
        connectionToken: parseRelayConnectionToken('connection-a'),
        observedAt: 300,
      })
      await expect(reader.getPersonalPairingActivity(pairingId, 300)).resolves.toEqual({
        lastAccessAt: 250,
        online: true,
      })
      await expect(reader.getPersonalPairingActivity(pairingId, 600)).resolves.toEqual({
        lastAccessAt: 250,
        online: false,
      })
      const durable = await runtime.pool.query<{ presence_leases: unknown }>(
        `SELECT presence_leases
           FROM remote_access_mobile_pairings
          WHERE database_identity = $1 AND pending_pairing_id = $2`,
        ['gestalt-production', pendingPairingId],
      )
      expect(durable.rows).toEqual([{ presence_leases: {} }])
    } finally {
      await runtime.close()
    }
  })
})

const LEGACY_SCHEMA = `
CREATE TABLE account_attempts (
  id text PRIMARY KEY, environment text NOT NULL, identity_namespace text NOT NULL,
  installation_id text NOT NULL, installation_kind text NOT NULL, public_key jsonb NOT NULL,
  state text NOT NULL UNIQUE, code_verifier text NOT NULL, expires_at bigint NOT NULL,
  status text NOT NULL, identity jsonb
);
CREATE TABLE account_accounts (
  id text PRIMARY KEY, identity_namespace text NOT NULL, github_id bigint NOT NULL,
  github_login text NOT NULL, avatar_url text NOT NULL, UNIQUE (identity_namespace, github_id)
);
CREATE TABLE account_sessions (
  id text PRIMARY KEY, identity_namespace text NOT NULL, account_id text NOT NULL,
  installation_id text NOT NULL, installation_kind text NOT NULL, public_key jsonb NOT NULL,
  revision integer NOT NULL, active boolean NOT NULL, refresh_hash text,
  refresh_expires_at bigint NOT NULL
);
CREATE TABLE account_proofs (jti text PRIMARY KEY, expires_at bigint NOT NULL);
`

async function startPostgres(): Promise<{ pool: pg.Pool; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-account-pg-'))
  const initialized = spawnSync('initdb', ['-D', directory, '-A', 'trust', '--no-locale'], {
    encoding: 'utf8',
  })
  if (initialized.status !== 0) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`initdb failed: ${initialized.stderr}`)
  }
  const server = spawn('postgres', ['-D', directory, '-k', directory, '-h', '', '-p', '5432'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  server.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const pool = new pg.Pool({ host: directory, port: 5432, user: process.env.USER, database: 'postgres' })
  await waitForPostgres(server, pool, () => stderr)
  return {
    pool,
    close: async () => {
      await pool.end()
      await stopProcess(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function waitForPostgres(process: ChildProcess, pool: pg.Pool, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`postgres exited before readiness: ${stderr()}`)
    try {
      await pool.query('SELECT 1')
      return
    } catch {
      // The disposable server has not opened its Unix socket yet.
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  await stopProcess(process)
  throw new Error('postgres did not accept a connection')
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { process.once('exit', () => { resolve() }) })
  process.kill('SIGTERM')
  await exited
}
