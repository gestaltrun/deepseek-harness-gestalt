/** Companion Session list projection shared by Mobile browse and keyless equality proofs. */

import type { MobileContentBlock } from './mobile-content.ts'

/** One Session row in the Mobile Companion list. */
export interface CompanionSessionSummary {
  /** Opaque Session identity. */
  id: string
  /** Desktop-confirmed title. */
  title: string
  /** Optional Workspace name. */
  workspace?: string
  /** Optional project name inside a Workspace. */
  project?: string
  /** Hidden-session summary text. */
  summary: string
  /** Whether the transcript is currently open and live. */
  live?: boolean
  /** Desktop-confirmed transcript lines when the Session is open. */
  transcript?: readonly string[]
  /** Structured conversation blocks for the Mobile renderer. */
  blocks?: readonly MobileContentBlock[]
}

/** Grouped Mobile list: named Workspace/project buckets plus Ungrouped. */
export interface CompanionSessionGroups {
  /** Workspace or project groups in first-seen order. */
  groups: readonly { name: string; sessions: readonly CompanionSessionSummary[] }[]
  /** Sessions without a Workspace or project. */
  ungrouped: readonly CompanionSessionSummary[]
}

/** Default history page ceiling for phone-sized paging. */
export const COMPANION_HISTORY_PAGE_SIZE = 20

/**
 * Group Sessions by Workspace/project, leaving unlabeled rows in Ungrouped.
 * @param sessions - Desktop-confirmed Session rows.
 * @returns named groups plus Ungrouped.
 */
export function groupCompanionSessions(sessions: readonly CompanionSessionSummary[]): CompanionSessionGroups {
  const groups = new Map<string, CompanionSessionSummary[]>()
  const ungrouped: CompanionSessionSummary[] = []
  for (const session of sessions) {
    const name = session.workspace ?? session.project
    if (name === undefined || name === '') {
      ungrouped.push(session)
      continue
    }
    const bucket = groups.get(name) ?? []
    bucket.push(session)
    groups.set(name, bucket)
  }
  return {
    groups: [...groups].map(([name, rows]) => ({ name, sessions: rows })),
    ungrouped,
  }
}

/**
 * Page a history list with an explicit ceiling; extra rows spill.
 * @param sessions - ordered history.
 * @param page - zero-based page.
 * @param ceiling - maximum visible rows per page.
 * @returns visible rows and the count that spilled past the ceiling.
 */
export function pageCompanionHistory(
  sessions: readonly CompanionSessionSummary[],
  page: number,
  ceiling: number = COMPANION_HISTORY_PAGE_SIZE,
): { visible: readonly CompanionSessionSummary[]; spilled: number } {
  if (!Number.isSafeInteger(page) || page < 0) throw new TypeError('Companion history page must be a non-negative integer')
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) throw new TypeError('Companion history ceiling must be a positive integer')
  const start = page * ceiling
  const visible = sessions.slice(start, start + ceiling)
  const remaining = Math.max(0, sessions.length - start - visible.length)
  return { visible, spilled: remaining }
}

/**
 * Project Desktop-confirmed history into the Mobile list without inventing rows.
 * @param desktopConfirmed - authoritative Desktop history.
 * @returns a Mobile-safe copy used for equality proofs.
 */
export function projectMobileCompanionHistory(
  desktopConfirmed: readonly CompanionSessionSummary[],
): readonly CompanionSessionSummary[] {
  return desktopConfirmed.map(session => ({
    id: session.id,
    title: session.title,
    ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
    ...(session.project === undefined ? {} : { project: session.project }),
    summary: session.summary,
    ...(session.live === undefined ? {} : { live: session.live }),
    ...(session.transcript === undefined ? {} : { transcript: [...session.transcript] }),
    ...(session.blocks === undefined ? {} : { blocks: session.blocks }),
  }))
}

/** Request to create one Desktop-default Session from Mobile. */
export interface CreateCompanionSessionInput {
  /** Idempotency key attributed to the Device Principal. */
  operationId: string
  /** Session title using Desktop defaults. */
  title: string
  /** Target Workspace; omit for Ungrouped. */
  workspace?: string
  /** Device Principal that requested the create. */
  devicePrincipalId: string
}

/**
 * Append one created Session unless this operation id already committed.
 * @param sessions - current Desktop-confirmed list.
 * @param committed - previously applied operation ids.
 * @param input - create request.
 * @returns next list and whether a new row was appended.
 */
export function createCompanionSession(
  sessions: readonly CompanionSessionSummary[],
  committed: ReadonlySet<string>,
  input: CreateCompanionSessionInput,
): { sessions: readonly CompanionSessionSummary[]; created: boolean } {
  if (input.operationId === '') throw new TypeError('Companion create operation id must be non-empty')
  if (committed.has(input.operationId)) return { sessions, created: false }
  const created: CompanionSessionSummary = {
    id: input.operationId,
    title: input.title,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    summary: 'New Session',
    blocks: [],
  }
  return { sessions: [...sessions, created], created: true }
}
