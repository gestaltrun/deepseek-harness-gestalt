/**
 * Shared path resolution and regular-file policy for model-facing readers.
 * @module @deepseek-ai/dsh-tool-fs/read-policy
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Map a model-supplied path to its declared image media type by extension.
 * @param filePath - raw path before filesystem resolution.
 * @returns the declared media type, or undefined when the path does not claim an image.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Resolve the session workspace cwd for one model-facing path.
 * @param exec - tool execution carrying the optional calling agent.
 * @param requestedPath - path the filesystem provider will resolve.
 * @returns the session cwd, canonicalized when parent traversal makes symlink identity observable.
 */
export function sessionCwd(exec: ToolExecution, requestedPath: string): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) return cwd
  return canonicalPath(cwd)
}

/**
 * Build filesystem resolution options for one model-facing read.
 * @param exec - tool execution carrying session cwd and cancellation.
 * @param requestedPath - path the filesystem provider will resolve.
 * @param policyWorkspaceRoot - optional policy-owned cwd override for a mutation.
 * @returns cwd and cancellation options accepted by {@link import('@deepseek-ai/dsh-fs').FileSystem.resolve}.
 */
export function sessionResolveOptions(
  exec: ToolExecution,
  requestedPath: string,
  policyWorkspaceRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = policyWorkspaceRoot ?? sessionCwd(exec, requestedPath)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - context carrying the optional filesystem service and observation event.
 * @param exec - current tool execution, including session cwd and cancellation.
 * @param requestedPath - raw path supplied to the tool.
 * @param operation - verb used in filesystem diagnostics.
 * @returns the resolved regular-file target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
  operation = 'read',
): Promise<{ target: FsTarget; info: FsInfo }> {
  const fs = ctx.get('fs')
  /* v8 ignore next -- callers mount the filesystem capability before using this helper. */
  if (fs === undefined) throw new Error('filesystem service is unavailable')
  const target = await fs.resolve(requestedPath, sessionResolveOptions(exec, requestedPath))
  const info = await fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot ${operation} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}
