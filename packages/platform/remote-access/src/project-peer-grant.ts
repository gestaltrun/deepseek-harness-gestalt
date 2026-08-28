/**
 * Project peer relay grant surface: durable grant records, the injected
 * active-membership proof source, the sealing adapter contract, and a
 * deterministic memory adapter for keyless assemblies.
 *
 * A grant lets one member's installation present a sealed per-endpoint Relay
 * credential on the granting member's route. Records persist only the
 * credential digest and its sealed envelope; the platform never retains or
 * transmits the bearer credential in the clear.
 * @module @deepseek-ai/dsh-remote-access/project-peer-grant
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { InstallationId, PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { encodeProtocolBase64Url } from '@deepseek-ai/dsh-remote-protocol'
import type { RelayPairingSelector, RelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import type { RelayCredentialFingerprint, RelayCredentialGrant } from './relay.ts'

/** Durable cloud-project identifier; structural twin of the Project Membership capability's id. */
export type ProjectPeerProjectId = Branded<'ProjectId'>
/** Opaque identity of one project peer relay grant; also the grant's non-secret channel selector. */
export type ProjectPeerGrantId = Branded<'ProjectPeerGrantId'>

/** Roster projection proving the reading account's active membership. */
export interface ProjectPeerRosterProof {
  /** Account ids holding an active membership at read time. */
  readonly members: ReadonlyArray<{ accountId: PlatformAccountId }>
}

/**
 * Active-membership proof source for project peer grants, satisfied by the
 * Project Membership capability's `roster` read. Every read rejects when the
 * reading account holds no active membership, so removed members lose both
 * enumeration and grant eligibility immediately.
 */
export interface ProjectPeerMembershipAuthority {
  /**
   * Prove the reading account's active membership and project the roster.
   * @param accountId - authenticated reading Platform Account.
   * @param projectId - project whose roster is read.
   * @returns the current member account ids.
   * @throws when the reading account holds no active membership in the project.
   */
  roster(accountId: PlatformAccountId, projectId: ProjectPeerProjectId): Promise<ProjectPeerRosterProof>
}

/**
 * Sealing adapter that renders one grant into its only storable and
 * deliverable form. Production sealing is part of the already-recorded
 * independent encryption review; without a composed sealer the grant surface
 * fails closed.
 */
export interface ProjectPeerGrantSealer {  /**
   * Seal one grant to the addressed peer installation.
   * @param input - project, peer identity, and the complete Relay credential grant.
   * @returns opaque sealed-envelope bytes retained beside the credential digest.
   */
  seal(input: {
    projectId: ProjectPeerProjectId
    peerAccountId: PlatformAccountId
    peerInstallationId: InstallationId
    grant: RelayCredentialGrant
  }): Promise<Uint8Array>
}

/** Construction-owned project peer grant composition injected into Remote Access. */
export interface ProjectPeerGrantComposition {
  /** Deployment-owned durable grant store shared by every Platform Instance. */
  store: ProjectPeerGrantStore
  /** Active-membership proof source satisfied by the Project Membership capability. */
  membership: ProjectPeerMembershipAuthority
  /** Sealing adapter owning the envelope form of every delivered credential. */
  sealer: ProjectPeerGrantSealer
}

/** Durable project peer relay grant; only digests and sealed envelopes persist. */
export interface ProjectPeerGrantRecord {
  /** Project whose collaboration plane this grant belongs to. */
  projectId: ProjectPeerProjectId
  /** Opaque grant identity and non-secret channel selector. */
  grantId: ProjectPeerGrantId
  /** Granting member's Relay route that carries this grant. */
  routeId: RelayRouteId
  /** Account that owns the carrying route. */
  grantorAccountId: PlatformAccountId
  /** Installation that owns the carrying route. */
  grantorInstallationId: InstallationId
  /** Account addressed by the grant. */
  peerAccountId: PlatformAccountId
  /** Installation addressed by the grant. */
  peerInstallationId: InstallationId
  /** Non-secret channel selector retained beside the credential digest. */
  pairingSelector: RelayPairingSelector
  /** SHA-256 digest registered with the Relay route authority. */
  credentialDigest: Uint8Array
  /** Sealed envelope; the only form in which the credential is stored or delivered. */
  sealedCredential: Uint8Array
  /** Superseded digest still awaiting its compensating revocation. */
  supersededCredentialDigest?: Uint8Array
  /** Route revision the registered digest was issued at. */
  revision: number
  /** Unix epoch milliseconds of the current generation's issuance. */
  grantedAt: number
  /** Unix epoch milliseconds of the revocation tombstone, once revoked. */
  revokedAt?: number
}

/** Content-free grant projection visible to the granting Desktop. */
export interface ProjectPeerGrantView {
  grantId: ProjectPeerGrantId
  projectId: ProjectPeerProjectId
  routeId: RelayRouteId
  peerAccountId: PlatformAccountId
  peerInstallationId: InstallationId
  credentialFingerprint: RelayCredentialFingerprint
  revision: number
  grantedAt: number
}

/** Retrieved grant envelope addressed to one peer installation. */
export interface SealedProjectPeerGrant {
  projectId: ProjectPeerProjectId
  grantId: ProjectPeerGrantId
  credentialFingerprint: RelayCredentialFingerprint
  /** Opaque sealed envelope; opening is the addressed installation's own obligation. */
  sealedCredential: Uint8Array
}

/** Deployment-owned durable store shared by every Platform Instance. */
export interface ProjectPeerGrantStore {
  /**
   * Commit one grant record keyed by project and peer installation, replacing
   * any prior generation of the same key.
   * @param record - complete record to persist.
   */
  putProjectPeerGrant(record: ProjectPeerGrantRecord): Promise<void>
  /**
   * Read the current record for one peer installation.
   * @param input - project and peer identity.
   * @returns the current record, or `undefined` without a grant.
   */
  getProjectPeerGrant(input: {
    projectId: ProjectPeerProjectId
    peerAccountId: PlatformAccountId
    peerInstallationId: InstallationId
  }): Promise<ProjectPeerGrantRecord | undefined>
  /**
   * List records, optionally scoped to one project.
   * @param input - optional project scope.
   * @returns every record, including revocation tombstones.
   */
  listProjectPeerGrantRecords(input: { projectId?: ProjectPeerProjectId }): Promise<readonly ProjectPeerGrantRecord[]>
}

/** In-memory grant store for keyless tests; deployments supply a durable shared adapter. */
export class MemoryProjectPeerGrantStore implements ProjectPeerGrantStore {
  private readonly records = new Map<string, ProjectPeerGrantRecord>()

  putProjectPeerGrant(record: ProjectPeerGrantRecord): Promise<void> {
    this.records.set(grantKey(record.projectId, record.peerAccountId, record.peerInstallationId), cloneRecord(record))
    return Promise.resolve()
  }

  getProjectPeerGrant(input: {
    projectId: ProjectPeerProjectId
    peerAccountId: PlatformAccountId
    peerInstallationId: InstallationId
  }): Promise<ProjectPeerGrantRecord | undefined> {
    const record = this.records.get(grantKey(input.projectId, input.peerAccountId, input.peerInstallationId))
    return Promise.resolve(record === undefined ? undefined : cloneRecord(record))
  }

  listProjectPeerGrantRecords(input: { projectId?: ProjectPeerProjectId }): Promise<readonly ProjectPeerGrantRecord[]> {
    const records = [...this.records.values()]
      .filter(record => input.projectId === undefined || record.projectId === input.projectId)
      .sort((left, right) => left.grantedAt - right.grantedAt || (left.grantId < right.grantId ? -1 : 1))
      .map(cloneRecord)
    return Promise.resolve(records)
  }
}

/**
 * Parse a project id at a wire or durable boundary.
 * @param value - untrusted project identifier.
 * @returns branded non-empty project id.
 */
export function parseProjectPeerProjectId(value: unknown): ProjectPeerProjectId {
  return nonEmpty(value, 'Project peer project id') as ProjectPeerProjectId
}

/**
 * Parse a project peer grant id at a wire or durable boundary.
 * @param value - untrusted grant identifier.
 * @returns branded non-empty grant id.
 */
export function parseProjectPeerGrantId(value: unknown): ProjectPeerGrantId {
  return nonEmpty(value, 'Project peer grant id') as ProjectPeerGrantId
}

/**
 * Project one durable record into its content-free grantor view.
 * @param record - durable record to project.
 * @returns view carrying the fingerprint, route, and revision without sealed bytes.
 */
export function toProjectPeerGrantView(record: ProjectPeerGrantRecord): ProjectPeerGrantView {
  return {
    grantId: record.grantId,
    projectId: record.projectId,
    routeId: record.routeId,
    peerAccountId: record.peerAccountId,
    peerInstallationId: record.peerInstallationId,
    credentialFingerprint: relayCredentialFingerprintFromDigest(record.credentialDigest),
    revision: record.revision,
    grantedAt: record.grantedAt,
  }
}

/**
 * Copy one record so provider-side mutation cannot alias store state.
 * @param record - record to copy.
 * @returns detached record copy.
 */
export function cloneProjectPeerGrantRecord(record: ProjectPeerGrantRecord): ProjectPeerGrantRecord {
  return cloneRecord(record)
}

function cloneRecord(record: ProjectPeerGrantRecord): ProjectPeerGrantRecord {
  return {
    ...record,
    credentialDigest: record.credentialDigest.slice(),
    sealedCredential: record.sealedCredential.slice(),
    ...(record.supersededCredentialDigest === undefined
      ? {}
      : { supersededCredentialDigest: record.supersededCredentialDigest.slice() }),
  }
}

function grantKey(projectId: string, peerAccountId: string, peerInstallationId: string): string {
  return `${projectId}\u0000${peerAccountId}\u0000${peerInstallationId}`
}

function relayCredentialFingerprintFromDigest(digest: Uint8Array): RelayCredentialFingerprint {
  return encodeProtocolBase64Url(digest) as RelayCredentialFingerprint
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value
}
