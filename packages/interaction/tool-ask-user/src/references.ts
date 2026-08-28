/**
 * Workspace-bounded reference validation for `ask_user_question`.
 * @module @deepseek-ai/dsh-tool-ask-user/references
 */

import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
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
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    return `path ${JSON.stringify(path)} is outside the session workspace`
  }
  try {
    const info = await lstat(canonicalTarget)
    if (!info.isFile()) return `path ${JSON.stringify(path)} is not a file`
  } catch {
    return `path ${JSON.stringify(path)} is unreadable or does not exist inside the session workspace`
  }
  return undefined
}
