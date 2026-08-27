/**
 * Durable JSON format for the file-backed Project Membership store. The whole
 * committed corpus lives in one document per environment namespace; every
 * mutation republishes it atomically through a temp-file rename. Parsing
 * accepts exactly the recorded shape — absent fields, extra fields, wrong
 * types, or rows referencing a project the document does not define are
 * corruption, not defaults.
 * @module @deepseek-ai/dsh-project-membership-core/persisted-state
 */

import type { InvitationState, ProjectRole } from '@deepseek-ai/dsh-project-membership'

/** Current durable format; bumped only by structural format changes. */
export const PROJECT_MEMBERSHIP_FORMAT_VERSION = 0

/** One stored cloud-project row. */
export interface PersistedProject {
  readonly id: string
  readonly name: string
  readonly boundRemoteUrl: string
  readonly createdAt: number
  /** Roster projection version; increases with every published membership mutation. */
  readonly rosterVersion: number
}

/** One stored membership row. */
export interface PersistedMembership {
  readonly id: string
  readonly projectId: string
  readonly accountId: string
  readonly role: ProjectRole
  readonly tags: readonly string[]
  readonly link?: { readonly workspaceName: string; readonly normalizedRemoteUrl?: string }
  readonly joinedAt: number
}

/** One stored invitation row. */
export interface PersistedInvitation {
  readonly id: string
  readonly projectId: string
  readonly inviterAccountId: string
  readonly inviteeAccountId: string
  readonly state: InvitationState
  readonly invitedAt: number
  readonly settledAt?: number
}

/** Complete durable store contents for one environment namespace. */
export interface PersistedState {
  readonly formatVersion: typeof PROJECT_MEMBERSHIP_FORMAT_VERSION
  readonly projects: readonly PersistedProject[]
  readonly memberships: readonly PersistedMembership[]
  readonly invitations: readonly PersistedInvitation[]
}

/**
 * Render the complete state as UTF-8 text ending in exactly one newline.
 * @param state - committed in-memory state.
 * @returns the next document body.
 */
export function serialize(state: PersistedState): string {
  return `${JSON.stringify({
    formatVersion: PROJECT_MEMBERSHIP_FORMAT_VERSION,
    projects: state.projects,
    memberships: state.memberships,
    invitations: state.invitations,
  }, null, 2)}\n`
}

/**
 * Parse and validate one stored document. Every field is checked explicitly;
 * any deviation throws instead of silently repairing. Membership and
 * invitation rows must reference a project the same document defines.
 * @param text - raw file content.
 * @returns the parsed durable state.
 * @throws when the document disagrees with {@link PersistedState}, carries a foreign `formatVersion`, or references an unknown project.
 */
export function parse(text: string): PersistedState {
  const record = expectRecord(parseJson(text), 'document')
  if (record.formatVersion !== PROJECT_MEMBERSHIP_FORMAT_VERSION) {
    throw new Error(
      `project-membership: durable state formatVersion ${JSON.stringify(record.formatVersion)} is not supported `
      + `(this build reads ${PROJECT_MEMBERSHIP_FORMAT_VERSION})`,
    )
  }
  const state: PersistedState = {
    formatVersion: PROJECT_MEMBERSHIP_FORMAT_VERSION,
    projects: expectArray(record.projects, 'projects').map(row => parseProject(expectRecord(row, 'project'))),
    memberships: expectArray(record.memberships, 'memberships').map(row =>
      parseMembership(expectRecord(row, 'membership'))),
    invitations: expectArray(record.invitations, 'invitations').map(row =>
      parseInvitation(expectRecord(row, 'invitation'))),
  }
  assertKnownProjects(state)
  return state
}

/**
 * Reject any row whose `projectId` names no project in the same document: a
 * dangling referent is corruption, and loading it would half-assemble the
 * store instead of failing loud.
 * @param state - fully row-validated durable state.
 * @throws naming the offending membership or invitation row and the unknown project id.
 */
function assertKnownProjects(state: PersistedState): void {
  const known = new Set(state.projects.map(project => project.id))
  for (const membership of state.memberships) {
    if (!known.has(membership.projectId)) {
      throw new Error(
        `project-membership: durable state membership ${membership.id} references unknown project ${membership.projectId}`,
      )
    }
  }
  for (const invitation of state.invitations) {
    if (!known.has(invitation.projectId)) {
      throw new Error(
        `project-membership: durable state invitation ${invitation.id} references unknown project ${invitation.projectId}`,
      )
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`project-membership: durable state is not valid JSON: ${String(error)}`)
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`project-membership: durable state ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`project-membership: durable state ${label} must be an array`)
  return value
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`project-membership: durable state row is missing non-empty string ${key}`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new Error(`project-membership: durable state ${key} must be undefined or a non-empty string`)
  }
  return value
}

/** Read one safe-integer epoch field, optionally bounded below. */
function epoch(record: Record<string, unknown>, key: string, bounds?: { min?: number }): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (bounds?.min !== undefined && value < bounds.min)) {
    const floor = bounds?.min === undefined ? '' : ` >= ${bounds.min}`
    throw new Error(`project-membership: durable state ${key} must be a safe integer${floor}`)
  }
  return value
}

function parseProject(record: Record<string, unknown>): PersistedProject {
  return {
    id: requiredString(record, 'id'),
    name: requiredString(record, 'name'),
    boundRemoteUrl: requiredString(record, 'boundRemoteUrl'),
    createdAt: epoch(record, 'createdAt', { min: 0 }),
    rosterVersion: epoch(record, 'rosterVersion', { min: 0 }),
  }
}

function parseRole(value: unknown): ProjectRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member') {
    throw new Error(`project-membership: durable state role ${JSON.stringify(value)} is outside owner|admin|member`)
  }
  return value
}

function parseTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('project-membership: durable state tags must be an array')
  const tags = value.map((tag) => {
    if (typeof tag !== 'string' || tag.trim() !== tag || tag === '') {
      throw new Error('project-membership: durable state tags must be non-blank strings')
    }
    return tag
  })
  if (new Set(tags).size !== tags.length) throw new Error('project-membership: durable state tags contain duplicates')
  return tags
}

function parseMembership(record: Record<string, unknown>): PersistedMembership {
  const linkValue = record.link
  let link: PersistedMembership['link']
  if (linkValue !== undefined) {
    const linkRecord = expectRecord(linkValue, 'link')
    const normalizedRemoteUrl = optionalString(linkRecord, 'normalizedRemoteUrl')
    link = {
      workspaceName: requiredString(linkRecord, 'workspaceName'),
      ...(normalizedRemoteUrl === undefined ? {} : { normalizedRemoteUrl }),
    }
  }
  return {
    id: requiredString(record, 'id'),
    projectId: requiredString(record, 'projectId'),
    accountId: requiredString(record, 'accountId'),
    role: parseRole(record.role),
    tags: parseTags(record.tags),
    ...(link === undefined ? {} : { link }),
    joinedAt: epoch(record, 'joinedAt', { min: 0 }),
  }
}

function parseInvitationState(value: unknown): InvitationState {
  if (value !== 'pending' && value !== 'accepted' && value !== 'declined' && value !== 'retracted') {
    throw new Error(`project-membership: durable state invitation state ${JSON.stringify(value)} is unknown`)
  }
  return value
}

function parseInvitation(record: Record<string, unknown>): PersistedInvitation {
  const settledAtRaw = record.settledAt
  if (settledAtRaw !== undefined && (typeof settledAtRaw !== 'number' || !Number.isSafeInteger(settledAtRaw))) {
    throw new Error('project-membership: durable state settledAt must be undefined or a safe integer epoch')
  }
  return {
    id: requiredString(record, 'id'),
    projectId: requiredString(record, 'projectId'),
    inviterAccountId: requiredString(record, 'inviterAccountId'),
    inviteeAccountId: requiredString(record, 'inviteeAccountId'),
    state: parseInvitationState(record.state),
    invitedAt: epoch(record, 'invitedAt', { min: 0 }),
    ...(settledAtRaw === undefined ? {} : { settledAt: settledAtRaw }),
  }
}
