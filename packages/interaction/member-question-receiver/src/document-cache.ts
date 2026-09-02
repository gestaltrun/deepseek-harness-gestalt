/**
  * Receiver-owned hidden Workspace cache for transferred Member Question
  * documents. Bytes land under `.dsh/member-questions/<questionId>/` so a
  * same-named Workspace file is never replaced or opened by mistake.
  */
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** Workspace-relative root of every receiver-owned transferred document. */
export const MEMBER_QUESTION_DOCUMENT_CACHE_ROOT = '.dsh/member-questions'

/** One transferred document written beside its Decision Brief metadata. */
export interface MemberQuestionTransferredDocument {
  /** Workspace-relative path named by the asking Session. */
  readonly path: string
  /** Exact transferred bytes; never written over a same-named Workspace file. */
  readonly bytes: Uint8Array
}

/** Decision Brief reference after the receiver-owned cache path is assigned. */
export interface MemberQuestionCachedReference {
  /** Workspace-relative path named by the asking Session. */
  readonly path: string
  /** Why this document matters, rendered as the chip subtitle. */
  readonly reason: string
  /** Receiver-owned hidden Workspace path of the transferred copy. */
  readonly cachedPath: string
}

/**
  * Write transferred document bytes under a receiver-owned hidden directory.
  * Same-named Workspace files stay untouched. Colliding basenames inside one
  * question receive a numeric suffix before the extension.
  * @param input - bound Workspace, question identity, references, and bytes.
  * @returns references with their receiver-owned cache paths.
  */
export async function writeMemberQuestionDocumentCache(input: {
  workspacePath: string
  questionId: string
  references: readonly { path: string; reason: string }[]
  documents: readonly MemberQuestionTransferredDocument[]
}): Promise<readonly MemberQuestionCachedReference[]> {
  const bytesByPath = new Map(input.documents.map(document => [document.path, document.bytes]))
  const used = new Map<string, number>()
  const questionSegment = sanitizeSegment(input.questionId)
  const workspaceRoot = resolve(input.workspacePath)
  const cacheRoot = join(workspaceRoot, MEMBER_QUESTION_DOCUMENT_CACHE_ROOT, questionSegment)
  await mkdirOwnerOnlyTree([
    join(workspaceRoot, '.dsh'),
    join(workspaceRoot, MEMBER_QUESTION_DOCUMENT_CACHE_ROOT),
    cacheRoot,
  ])
  const cached: MemberQuestionCachedReference[] = []
  for (const reference of input.references) {
    const uniqueName = uniqueBasename(basename(reference.path.replaceAll('\\', '/')), used)
    const cachedPath = `${MEMBER_QUESTION_DOCUMENT_CACHE_ROOT}/${questionSegment}/${uniqueName}`
    const bytes = bytesByPath.get(reference.path)
    if (bytes !== undefined) {
      await writeExclusiveOwnerFile(join(workspaceRoot, cachedPath), Buffer.from(bytes))
    }
    cached.push({ path: reference.path, reason: reference.reason, cachedPath })
  }
  return cached
}

function uniqueBasename(name: string, used: Map<string, number>): string {
  const safe = sanitizeSegment(name)
  const key = safe.toLowerCase()
  const count = used.get(key) ?? 0
  used.set(key, count + 1)
  if (count === 0) return safe
  const dot = safe.lastIndexOf('.')
  if (dot <= 0) return `${safe}-${String(count + 1)}`
  return `${safe.slice(0, dot)}-${String(count + 1)}${safe.slice(dot)}`
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim()
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_')
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe
}

/**
 * Create each cache parent as an owner-only real directory. A planted
 * symlink at `.dsh`, `.dsh/member-questions`, or the question directory is
 * unlinked first so `mkdir` cannot follow it into a Workspace twin.
 * @param directories - cache parents from `.dsh` down to the question directory.
 */
async function mkdirOwnerOnlyTree(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    await unlinkLinkShapedPath(directory)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      /* v8 ignore next -- mkdir fails for EEXIST or a TOCTOU/IO race on the parent. */
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await lstat(directory)
      if (!info.isDirectory()) {
        throw new Error(`member-question-receiver: cache path ${directory} is not a directory`)
      }
    }
  }
}

/**
 * Write transferred bytes without following a planted symlink. `lstat` +
 * `unlink` remove a link-shaped or leftover cache path first, then `wx`
 * exclusive-creates an owner-only regular file so the write cannot land on
 * a referent.
 * @param path - absolute cache file path under the receiver-owned directory.
 * @param bytes - transferred document body.
 */
async function writeExclusiveOwnerFile(path: string, bytes: Buffer): Promise<void> {
  await replaceCacheFile(path)
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
}

async function unlinkLinkShapedPath(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) await unlink(path)
  } catch (error) {
    /* v8 ignore next -- lstat fails for absence or a TOCTOU/IO race. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function replaceCacheFile(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      throw new Error(`member-question-receiver: cache path ${path} is a directory`)
    }
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
