/**
 * Workspace-bounded reference validation for `ask_user_question`.
 * @module @deepseek-ai/dsh-tool-ask-user/references
 */

import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { AskUserQuestionError, REFERENCE_REASON_MAX_CODE_POINTS, REFERENCES_MAX_COUNT } from './errors.ts'

/** One model-supplied document reference. */
export interface AskUserQuestionReference {
  /** Path resolved inside the asking session's workspace. */
  readonly path: string
  /** Optional one-liner explaining why the document matters. */
  readonly reason?: string
}

/** One validated reference whose path exists inside the workspace. */
export interface ValidatedAskUserQuestionReference {
  /** Model-supplied path, unchanged. */
  readonly path: string
  /** Optional reason, present only when the model supplied one. */
  readonly reason?: string
}

/** One routed reference whose bytes were read after workspace validation. */
export interface AskUserQuestionReferenceDocument {
  /** Workspace-relative path matching the validated reference. */
  readonly path: string
  /** Arbitrary file bytes admitted for Companion document-chunk transfer. */
  readonly bytes: Uint8Array
}

/** Validated routed references plus the aligned document bytes. */
export interface ValidatedRoutedAskUserQuestionReferences {
  readonly references: ValidatedAskUserQuestionReference[] | undefined
  readonly documents: readonly AskUserQuestionReferenceDocument[]
}

/**
 * Count Unicode code points without treating UTF-16 surrogates as two units.
 * @param value - string whose code points are counted.
 * @returns the number of Unicode code points in `value`.
 */
export function countUnicodeCodePoints(value: string): number {
  let count = 0
  for (const _codePoint of value) count++
  return count
}

/**
 * Validate `references` against the asking session's workspace: each `path`
 * must resolve to an existing file inside that workspace, and each `reason`
 * must stay within 100 code points.
 * @param references - model-supplied reference list, or undefined when omitted.
 * @param workspaceRoot - absolute session cwd; omitted, the call fails if any reference is present.
 * @returns the same list once every item is proven, or undefined when omitted.
 * @throws {AskUserQuestionError} `REFERENCES_INVALID` naming every failing item.
 */
export async function validateReferences(
  references: readonly AskUserQuestionReference[] | undefined,
  workspaceRoot: string | undefined,
): Promise<ValidatedAskUserQuestionReference[] | undefined> {
  if (references === undefined) return undefined
  if (references.length > REFERENCES_MAX_COUNT) {
    throw new AskUserQuestionError(
      `REFERENCES_INVALID: references exceeds the ceiling of ${String(REFERENCES_MAX_COUNT)} items`,
      'REFERENCES_INVALID',
    )
  }
  const failures: string[] = []
  const validated: ValidatedAskUserQuestionReference[] = []
  for (const [index, reference] of references.entries()) {
    const reasonFailure = validateReason(reference.reason)
    if (reasonFailure !== undefined) {
      failures.push(`references[${String(index)}]: ${reasonFailure}`)
      continue
    }
    const pathFailure = await validatePath(reference.path, workspaceRoot)
    if (pathFailure !== undefined) {
      failures.push(`references[${String(index)}]: ${pathFailure}`)
      continue
    }
    validated.push({
      path: reference.path,
      ...reference.reason !== undefined ? { reason: reference.reason } : {},
    })
  }
  if (failures.length > 0) {
    throw new AskUserQuestionError(`REFERENCES_INVALID: ${failures.join('; ')}`, 'REFERENCES_INVALID')
  }
  return validated
}

/**
 * Validate routed `references` and read each file's bytes for document-chunk
 * transfer. Local asks keep {@link validateReferences} and do not load bodies.
 * @param references - model-supplied reference list, or undefined when omitted.
 * @param workspaceRoot - absolute session cwd.
 * @returns validated references plus aligned document bytes.
 */
export async function validateRoutedReferences(
  references: readonly AskUserQuestionReference[] | undefined,
  workspaceRoot: string | undefined,
): Promise<ValidatedRoutedAskUserQuestionReferences> {
  const validated = await validateReferences(references, workspaceRoot)
  if (validated === undefined) return { references: undefined, documents: [] }
  const documents: AskUserQuestionReferenceDocument[] = []
  const failures: string[] = []
  const byteLimit = Math.min(
    REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes,
    REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
  )
  /* v8 ignore next -- validateReferences admits a non-empty list only with a workspace root. */
  const root = workspaceRoot ?? ''
  for (const [index, reference] of validated.entries()) {
    const resolved = isAbsolute(reference.path)
      ? reference.path
      : resolvePath(root, reference.path)
    try {
      const bytes = await readFile(resolved)
      if (bytes.byteLength > byteLimit) {
        failures.push(
          `references[${String(index)}]: path ${JSON.stringify(reference.path)} exceeds the ${String(byteLimit)}-byte transfer ceiling`,
        )
        continue
      }
      documents.push({ path: reference.path, bytes: new Uint8Array(bytes) })
    } catch (error: unknown) {
      /* ENOENT/EACCES/EISDIR: the path failed workspace-file reads after validatePath. */
      void error
      failures.push(
        `references[${String(index)}]: path ${JSON.stringify(reference.path)} is unreadable or does not exist inside the session workspace`,
      )
    }
  }
  if (failures.length > 0) {
    throw new AskUserQuestionError(`REFERENCES_INVALID: ${failures.join('; ')}`, 'REFERENCES_INVALID')
  }
  return { references: validated, documents }
}

function validateReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  if (reason.length === 0 || countUnicodeCodePoints(reason) > REFERENCE_REASON_MAX_CODE_POINTS) {
    return `reason must contain 1-${String(REFERENCE_REASON_MAX_CODE_POINTS)} code points`
  }
  return undefined
}

async function validatePath(path: string, workspaceRoot: string | undefined): Promise<string | undefined> {
  if (path.length === 0) return 'path must be a non-empty string'
  if (workspaceRoot === undefined) {
    return `path ${JSON.stringify(path)} cannot be resolved without a session workspace`
  }
  const resolved = isAbsolute(path) ? path : resolvePath(workspaceRoot, path)
  let canonicalWorkspace: string
  let canonicalTarget: string
  try {
    canonicalWorkspace = await realpath(workspaceRoot)
  } catch {
    return `workspace ${JSON.stringify(workspaceRoot)} is unreadable`
  }
  try {
    canonicalTarget = await realpath(resolved)
  } catch {
    return `path ${JSON.stringify(path)} is unreadable or does not exist inside the session workspace`
  }
  const relativePath = relative(canonicalWorkspace, canonicalTarget)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    return `path ${JSON.stringify(path)} is outside the session workspace`
  }
  /* v8 ignore next 3 -- relative() yields an absolute path only for a Windows cross-drive target */
  if (isAbsolute(relativePath)) {
    return `path ${JSON.stringify(path)} is outside the session workspace`
  }
  try {
    const info = await lstat(canonicalTarget)
    if (!info.isFile()) return `path ${JSON.stringify(path)} is not a file`
  } catch {
    /* v8 ignore next -- realpath already proved the target exists; lstat failure is a TOCTOU/IO race */
    return `path ${JSON.stringify(path)} is unreadable or does not exist inside the session workspace`
  }
  return undefined
}
