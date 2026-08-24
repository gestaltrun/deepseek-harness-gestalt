/** PostgreSQL AccountBackend shared by both Platform Instances. */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  ACCOUNT_DESKTOP_INSTALLATION_LIMIT,
  ACCOUNT_MOBILE_INSTALLATION_LIMIT,
  AccountError,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  parseDesktopInstallationPresentation,
  parseInstallationId,
  parseMobileInstallationPresentation,
  parseLoginAttemptId,
  parsePlatformAccountId,
  type AccountProofJti,
  type AccountSessionId,
  type InstallationId,
  type InstallationKind,
  type LoginAttemptId,
  type PlatformAccountId,
  type PlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import type {
  AccountBackend,
  AccountRecord,
  CreatedSession,
  GitHubIdentity,
  LoginAttemptRecord,
  SessionRecord,
} from '@deepseek-ai/dsh-platform-account-core'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_attempts (
  id text PRIMARY KEY,
  environment text NOT NULL,
  identity_namespace text NOT NULL,
  installation_id text NOT NULL,
  installation_kind text NOT NULL,
  installation_presentation jsonb,
  public_key jsonb NOT NULL,
  state text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  expires_at bigint NOT NULL,
  status text NOT NULL,
  identity jsonb
);
CREATE TABLE IF NOT EXISTS account_accounts (
  id text PRIMARY KEY,
  identity_namespace text NOT NULL,
  github_id bigint NOT NULL,
  github_login text NOT NULL,
  avatar_url text NOT NULL,
  UNIQUE (identity_namespace, github_id)
);
CREATE TABLE IF NOT EXISTS account_sessions (
  id text PRIMARY KEY,
  identity_namespace text NOT NULL,
  account_id text NOT NULL,
  installation_id text NOT NULL,
  installation_kind text NOT NULL,
  installation_presentation jsonb,
  public_key jsonb NOT NULL,
  revision integer NOT NULL,
  active boolean NOT NULL,
  refresh_hash text,
  refresh_expires_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS account_sessions_refresh_hash
  ON account_sessions (refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_sessions_active_install
  ON account_sessions (identity_namespace, installation_id) WHERE active;
CREATE TABLE IF NOT EXISTS account_proofs (
  jti text PRIMARY KEY,
  expires_at bigint NOT NULL
);
ALTER TABLE account_attempts ADD COLUMN IF NOT EXISTS installation_presentation jsonb;
ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS installation_presentation jsonb;
ALTER TABLE account_attempts DROP COLUMN IF EXISTS mobile_presentation;
ALTER TABLE account_sessions DROP COLUMN IF EXISTS mobile_presentation;
`

interface AttemptRow {
  id: string
  environment: string
  identity_namespace: string
  installation_id: string
  installation_kind: string
  installation_presentation: unknown
  public_key: JsonWebKey
  state: string
  code_verifier: string
  expires_at: string
  status: string
  identity: GitHubIdentity | null
}

interface AccountRow {
  id: string
  identity_namespace: string
  github_id: string
  github_login: string
  avatar_url: string
}

interface SessionRow {
  id: string
  identity_namespace: string
  account_id: string
  installation_id: string
  installation_kind: string
  installation_presentation: unknown
  public_key: JsonWebKey
  revision: number
  active: boolean
  refresh_hash: string | null
  refresh_expires_at: string
}

/** Durable Account persistence over one PostgreSQL database identity. */
export class PostgresAccountBackend implements AccountBackend {
  /**
   * @param databaseIdentity - deployment database identity bound to this backend.
   * @param pool - shared connection pool.
   */
  constructor(
    readonly databaseIdentity: string,
    private readonly pool: Pool,
  ) {}

  /** Create Account tables if they are absent. */
  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA)
  }

  async createAttempt(record: LoginAttemptRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO account_attempts (
        id, environment, identity_namespace, installation_id, installation_kind,
        installation_presentation, public_key, state, code_verifier, expires_at, status, identity
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb)`,
      [
        record.id, record.environment, record.identityNamespace, record.installationId,
        record.installationKind, record.presentation === undefined ? null : JSON.stringify(record.presentation),
        JSON.stringify(record.publicKey), record.state,
        record.codeVerifier, record.expiresAt, record.status,
        record.identity === undefined ? null : JSON.stringify(record.identity),
      ],
    )
  }

  async findAttemptByState(state: string): Promise<LoginAttemptRecord | undefined> {
    const result = await this.pool.query<AttemptRow>('SELECT * FROM account_attempts WHERE state = $1', [state])
    return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0])
  }

  async getAttempt(id: LoginAttemptId): Promise<LoginAttemptRecord | undefined> {
    const result = await this.pool.query<AttemptRow>('SELECT * FROM account_attempts WHERE id = $1', [id])
    return result.rows[0] === undefined ? undefined : attemptFromRow(result.rows[0])
  }

  async authorizeAttempt(id: LoginAttemptId, identity: GitHubIdentity): Promise<void> {
    const result = await this.pool.query(
      `UPDATE account_attempts
          SET status = 'authorized', identity = $2::jsonb, state = state || ':used:' || id
        WHERE id = $1 AND status = 'pending'`,
      [id, JSON.stringify(identity)],
    )
    if (result.rowCount !== 1) {
      throw new AccountError('LOGIN_ATTEMPT_USED', 'login attempt is no longer pending')
    }
  }

  async consumeAuthorizedAttempt(
    id: LoginAttemptId,
    refreshHash: string,
    refreshExpiresAt: number,
  ): Promise<CreatedSession> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const attemptResult = await client.query<AttemptRow>(
        'SELECT * FROM account_attempts WHERE id = $1 FOR UPDATE',
        [id],
      )
      const attemptRow = attemptResult.rows[0]
      if (attemptRow === undefined) throw new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is unknown')
      if (attemptRow.status === 'used') throw new AccountError('LOGIN_ATTEMPT_USED', 'login attempt was already consumed')
      if (attemptRow.status !== 'authorized' || attemptRow.identity === null) {
        throw new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is not authorized')
      }
      const identity = attemptRow.identity
      const account = await upsertAccount(client, attemptRow.identity_namespace, identity)
      await client.query('SELECT id FROM account_accounts WHERE id = $1 FOR UPDATE', [account.id])
      const replaced = await client.query<SessionRow>(
        `UPDATE account_sessions
            SET active = FALSE, revision = revision + 1, refresh_hash = NULL
          WHERE identity_namespace = $1 AND installation_id = $2 AND active = TRUE
          RETURNING *`,
        [attemptRow.identity_namespace, attemptRow.installation_id],
      )
      if (replaced.rows[0] === undefined) {
        const kind = attemptRow.installation_kind as InstallationKind
        const countResult = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM account_sessions
            WHERE account_id = $1 AND installation_kind = $2 AND active = TRUE`,
          [account.id, kind],
        )
        const count = Number(countResult.rows[0]?.count ?? 0)
        const limit = kind === 'desktop' ? ACCOUNT_DESKTOP_INSTALLATION_LIMIT : ACCOUNT_MOBILE_INSTALLATION_LIMIT
        if (count >= limit) {
          throw new AccountError(
            'QUOTA',
            `Platform Account has reached its ${kind} installation limit`,
            OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
          )
        }
      }
      const sessionId = randomUUID() as AccountSessionId
      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO account_sessions (
          id, identity_namespace, account_id, installation_id, installation_kind,
          installation_presentation, public_key, revision, active, refresh_hash, refresh_expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,1,TRUE,$8,$9)
        RETURNING *`,
        [
          sessionId, attemptRow.identity_namespace, account.id, attemptRow.installation_id,
          attemptRow.installation_kind, attemptRow.installation_presentation === null
            ? null
            : JSON.stringify(attemptRow.installation_presentation),
          JSON.stringify(attemptRow.public_key), refreshHash, refreshExpiresAt,
        ],
      )
      await client.query(
        'UPDATE account_attempts SET status = \'used\', identity = NULL WHERE id = $1',
        [id],
      )
      await client.query('COMMIT')
      const replacedSessionId = replaced.rows[0] === undefined
        ? undefined
        : replaced.rows[0].id as AccountSessionId
      const insertedSession = sessionResult.rows[0]
      if (insertedSession === undefined) {
        throw new AccountError('LOGIN_ATTEMPT_INVALID', 'session insert returned no row')
      }
      return {
        session: sessionFromRow(insertedSession),
        account,
        ...(replacedSessionId === undefined ? {} : { replacedSessionId }),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getSessionByRefreshHash(hash: string): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM account_sessions WHERE refresh_hash = $1',
      [hash],
    )
    return result.rows[0] === undefined ? undefined : sessionFromRow(result.rows[0])
  }

  async getSession(id: AccountSessionId): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<SessionRow>('SELECT * FROM account_sessions WHERE id = $1', [id])
    return result.rows[0] === undefined ? undefined : sessionFromRow(result.rows[0])
  }

  async getAccount(id: PlatformAccountId): Promise<AccountRecord | undefined> {
    const result = await this.pool.query<AccountRow>('SELECT * FROM account_accounts WHERE id = $1', [id])
    return result.rows[0] === undefined ? undefined : accountFromRow(result.rows[0])
  }

  async rotateRefresh(
    sessionId: AccountSessionId,
    expectedHash: string,
    replacementHash: string,
  ): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE account_sessions
          SET refresh_hash = $3, revision = revision + 1
        WHERE id = $1 AND active = TRUE AND refresh_hash = $2
        RETURNING *`,
      [sessionId, expectedHash, replacementHash],
    )
    return result.rows[0] === undefined ? undefined : sessionFromRow(result.rows[0])
  }

  async revokeSession(sessionId: AccountSessionId): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET active = FALSE, revision = revision + 1, refresh_hash = NULL
        WHERE id = $1 AND active = TRUE`,
      [sessionId],
    )
    return result.rowCount === 1
  }

  async consumeProof(jti: AccountProofJti, expiresAt: number, now: number): Promise<boolean> {
    await this.pool.query('DELETE FROM account_proofs WHERE expires_at < $1', [now])
    const result = await this.pool.query(
      'INSERT INTO account_proofs (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [jti, expiresAt],
    )
    return result.rowCount === 1
  }

  async countActiveInstallations(accountId: PlatformAccountId, kind: InstallationKind): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM account_sessions
        WHERE account_id = $1 AND installation_kind = $2 AND active = TRUE`,
      [accountId, kind],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async findAccountByIdentity(identityNamespace: string, providerSubject: number): Promise<AccountRecord | undefined> {
    const result = await this.pool.query<AccountRow>(
      'SELECT * FROM account_accounts WHERE identity_namespace = $1 AND github_id = $2',
      [identityNamespace, providerSubject],
    )
    return result.rows[0] === undefined ? undefined : accountFromRow(result.rows[0])
  }

  async hasActiveSessionByInstallation(
    identityNamespace: string,
    installationId: InstallationId,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM account_sessions
        WHERE identity_namespace = $1 AND installation_id = $2 AND active = TRUE`,
      [identityNamespace, installationId],
    )
    return result.rows[0] !== undefined
  }
}

async function upsertAccount(client: PoolClient, namespace: string, identity: GitHubIdentity): Promise<AccountRecord> {
  const existing = await client.query<AccountRow>(
    'SELECT * FROM account_accounts WHERE identity_namespace = $1 AND github_id = $2',
    [namespace, identity.providerSubject],
  )
  if (existing.rows[0] !== undefined) {
    const updated = await client.query<AccountRow>(
      `UPDATE account_accounts SET github_login = $3, avatar_url = $4
        WHERE identity_namespace = $1 AND github_id = $2
        RETURNING *`,
      [namespace, identity.providerSubject, identity.login, identity.avatarUrl],
    )
    const updatedRow = updated.rows[0]
    if (updatedRow === undefined) throw new AccountError('LOGIN_ATTEMPT_INVALID', 'account update returned no row')
    return accountFromRow(updatedRow)
  }
  const created = await client.query<AccountRow>(
    `INSERT INTO account_accounts (id, identity_namespace, github_id, github_login, avatar_url)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [randomUUID(), namespace, identity.providerSubject, identity.login, identity.avatarUrl],
  )
  const createdRow = created.rows[0]
  if (createdRow === undefined) throw new AccountError('LOGIN_ATTEMPT_INVALID', 'account insert returned no row')
  return accountFromRow(createdRow)
}

function attemptFromRow(row: AttemptRow): LoginAttemptRecord {
  const installationKind = installationKindFromRow(row.installation_kind)
  return {
    id: parseLoginAttemptId(row.id),
    environment: row.environment as PlatformEnvironment,
    identityNamespace: row.identity_namespace,
    installationId: parseInstallationId(row.installation_id),
    installationKind,
    ...installationPresentationFromRow(installationKind, row.installation_presentation),
    publicKey: row.public_key,
    state: row.state,
    codeVerifier: row.code_verifier,
    expiresAt: Number(row.expires_at),
    status: row.status as LoginAttemptRecord['status'],
    ...(row.identity === null ? {} : { identity: row.identity }),
  }
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: parsePlatformAccountId(row.id),
    identityNamespace: row.identity_namespace,
    githubId: Number(row.github_id),
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  const installationKind = installationKindFromRow(row.installation_kind)
  return {
    id: row.id as AccountSessionId,
    identityNamespace: row.identity_namespace,
    accountId: parsePlatformAccountId(row.account_id),
    installationId: parseInstallationId(row.installation_id),
    installationKind,
    ...installationPresentationFromRow(installationKind, row.installation_presentation),
    publicKey: row.public_key,
    revision: row.revision,
    active: row.active,
    refreshHash: row.refresh_hash ?? '',
    refreshExpiresAt: Number(row.refresh_expires_at),
  }
}

function installationKindFromRow(value: string): InstallationKind {
  if (value !== 'desktop' && value !== 'mobile') {
    throw new TypeError('installation kind must be desktop or mobile')
  }
  return value
}

function installationPresentationFromRow(
  kind: InstallationKind,
  value: unknown,
): { presentation?: ReturnType<typeof parseMobileInstallationPresentation> | ReturnType<typeof parseDesktopInstallationPresentation> } {
  if (value === null) return {}
  return {
    presentation: kind === 'desktop'
      ? parseDesktopInstallationPresentation(value)
      : parseMobileInstallationPresentation(value),
  }
}
