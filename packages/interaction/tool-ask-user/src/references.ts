/**
 * Workspace-bounded reference validation for `ask_user_question`.
 * @module @deepseek-ai/dsh-tool-ask-user/references
 */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
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
  /** Canonical Workspace-relative path carried to the receiver. */
  readonly path: string
  /** Optional reason, present only when the model supplied one. */
  readonly reason?: string
}

/** Exact bytes for one validated reference prepared for routed delivery. */
export interface AskUserQuestionReferenceDocument {
  /** Canonical Workspace-relative path matching the reference entry. */
  readonly path: string
  /** Exact bounded bytes read from the validated file. */
  readonly bytes: Uint8Array
}

/** One routed reference batch admitted and read from the same file descriptors. */
export interface ValidatedRoutedAskUserQuestionReferences {
  /** Canonical reference metadata carried on the question operation. */
  readonly references: ValidatedAskUserQuestionReference[] | undefined
  /** Exact document bytes aligned 1:1 with `references`. */
  readonly documents: AskUserQuestionReferenceDocument[]
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
  return (await validateReferenceBatch(references, workspaceRoot, false)).references
}

/**
 * Validate routed references and read each file from the descriptor that proved it.
 * @param references - model-supplied reference list, or undefined when omitted.
 * @param workspaceRoot - absolute asking-session workspace.
 * @returns canonical reference metadata and aligned bounded document bytes.
 * @throws {AskUserQuestionError} `REFERENCES_INVALID` naming every failing item.
 */
export async function validateRoutedReferences(
  references: readonly AskUserQuestionReference[] | undefined,
  workspaceRoot: string | undefined,
): Promise<ValidatedRoutedAskUserQuestionReferences> {
  return validateReferenceBatch(references, workspaceRoot, true)
}

async function validateReferenceBatch(
  references: readonly AskUserQuestionReference[] | undefined,
  workspaceRoot: string | undefined,
  readBytes: boolean,
): Promise<ValidatedRoutedAskUserQuestionReferences> {
  if (references === undefined) return { references: undefined, documents: [] }
  if (references.length > REFERENCES_MAX_COUNT) {
    throw new AskUserQuestionError(
      `REFERENCES_INVALID: references exceeds the ceiling of ${String(REFERENCES_MAX_COUNT)} items`,
      'REFERENCES_INVALID',
    )
  }
  const failures: string[] = []
  const validated: ValidatedAskUserQuestionReference[] = []
  const documents: AskUserQuestionReferenceDocument[] = []
  for (const [index, reference] of references.entries()) {
    const reasonFailure = validateReason(reference.reason)
    if (reasonFailure !== undefined) {
      failures.push(`references[${String(index)}]: ${reasonFailure}`)
      continue
    }
    let resolvedPath: string
    if (readBytes) {
      const resolved = await resolveReference(reference.path, workspaceRoot, true)
      if (typeof resolved === 'string') {
        failures.push(`references[${String(index)}]: ${resolved}`)
        continue
      }
      resolvedPath = resolved.path
      documents.push({ path: resolved.path, bytes: resolved.bytes })
    } else {
      const resolved = await resolveReference(reference.path, workspaceRoot)
      if (typeof resolved === 'string') {
        failures.push(`references[${String(index)}]: ${resolved}`)
        continue
      }
      resolvedPath = resolved.path
    }
    validated.push({
      path: resolvedPath,
      ...reference.reason !== undefined ? { reason: reference.reason } : {},
    })
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

async function resolveReference(
  path: string,
  workspaceRoot: string | undefined,
  readBytes: true,
): Promise<{ path: string; bytes: Uint8Array } | string>
async function resolveReference(
  path: string,
  workspaceRoot: string | undefined,
  readBytes?: false,
): Promise<{ path: string } | string>
async function resolveReference(
  path: string,
  workspaceRoot: string | undefined,
  readBytes = false,
): Promise<{ path: string; bytes?: Uint8Array } | string> {
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
    const expected = await lstat(canonicalTarget, { bigint: true })
    if (expected.isSymbolicLink()) return `path ${JSON.stringify(path)} changed while being validated`
    if (!expected.isFile()) return `path ${JSON.stringify(path)} is not a file`
    const handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat({ bigint: true })
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
        return `path ${JSON.stringify(path)} changed while being validated`
      }
      if (!readBytes) return { path: relativePath.split(sep).join('/') }
      const byteLimit = Math.min(
        REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes,
        REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
      )
      const bytes = await handle.readFile()
      if (bytes.byteLength > byteLimit) {
        return `path ${JSON.stringify(path)} exceeds the ${String(byteLimit)}-byte transfer ceiling`
      }
      return {
        path: relativePath.split(sep).join('/'),
        bytes,
      }
    } finally {
      await handle.close()
    }
  } catch {
    /* v8 ignore next -- realpath already proved the target exists; open/read failure is an IO race */
    return `path ${JSON.stringify(path)} is unreadable or does not exist inside the session workspace`
  }
}
