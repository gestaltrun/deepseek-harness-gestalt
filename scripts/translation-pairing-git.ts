/** Git-blob operations owned by the bilingual pairing workflow. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const SNAPSHOT_REF_PREFIX = 'refs/dsh/translation-pairing/snapshots'

/** Maximum buffered stdout or stderr for repository-owned Git subprocesses. */
export const GIT_COMMAND_MAX_BUFFER = 1 << 26

/** Full SHA-1 Git blob hash (the 40-hex format used by pairing records). */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Run one Git subprocess and return its exact stdout bytes.
 *
 * @param root - Repository root used as Git's working directory.
 * @param args - Arguments following the `git` executable.
 * @param operation - Human-readable operation for failure diagnostics.
 * @param input - Optional stdin bytes.
 * @returns Exact stdout bytes.
 * @throws Error when Git cannot start or exits unsuccessfully.
 */
export function runGit(root: string, args: string[], operation: string, input?: Buffer): Buffer {
  const result = spawnSync('git', ['-C', root, ...args], {
    input,
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
  })
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`${operation} failed with status ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}

/** One regular stage-zero Git index entry and its exact blob bytes. */
export interface GitIndexBlob {
  /** Object ID recorded in the index. */
  objectId: string
  /** Blob bytes stored under that object ID. */
  content: Buffer
}

interface GitIndexEntry {
  objectId: string
  stage: string
}

/** Parse every Git index entry once and retain its stage and object id by path. */
function gitIndexEntries(root: string): Map<string, GitIndexEntry[]> {
  const entriesByPath = new Map<string, GitIndexEntry[]>()
  const entries = runGit(root, ['ls-files', '--stage', '-z'], 'listing Git index entries')
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const entry of entries) {
    const match = /^\d+ ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry)
    if (!match?.[1] || !match[2] || match[3] === undefined) {
      throw new Error('git ls-files --stage returned a malformed entry')
    }
    const current = entriesByPath.get(match[3]) ?? []
    current.push({ objectId: match[1], stage: match[2] })
    entriesByPath.set(match[3], current)
  }
  return entriesByPath
}

/** Every stage-zero path currently present in the Git index. */
export function gitIndexPaths(root: string): Set<string> {
  const paths = new Set<string>()
  for (const [path, entries] of gitIndexEntries(root)) {
    if (entries.length === 1 && entries[0]?.stage === '0') paths.add(path)
  }
  return paths
}

/**
 * Read a selected set of stage-zero index blobs through one Git batch.
 *
 * @param root - Repository root.
 * @param paths - Repository-relative paths to load; absent paths are omitted.
 * @returns Exact staged bytes keyed by path.
 * @throws Error when a selected path is unmerged or Git returns malformed batch data.
 */
export function readGitIndexBlobs(root: string, paths: Iterable<string>): Map<string, GitIndexBlob> {
  const requested = new Set(paths)
  const selected = new Map<string, GitIndexEntry>()
  const entriesByPath = gitIndexEntries(root)
  for (const path of requested) {
    const entries = entriesByPath.get(path)
    if (entries === undefined) continue
    if (entries.length !== 1 || entries[0]?.stage !== '0') {
      throw new Error(`${path} does not have exactly one resolved index entry`)
    }
    selected.set(path, entries[0])
  }
  const objectIds = [...new Set([...selected.values()].map(entry => entry.objectId))]
  if (objectIds.length === 0) return new Map()
  const output = runGit(
    root,
    ['cat-file', '--batch'],
    'reading staged blobs',
    Buffer.from(`${objectIds.join('\n')}\n`),
  )
  const contents = new Map<string, Buffer>()
  let offset = 0
  for (const requestedObjectId of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new Error('git cat-file --batch returned a truncated header')
    const header = output.subarray(offset, headerEnd).toString('utf8')
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header)
    if (!match?.[1] || !match[2] || match[1] !== requestedObjectId) {
      throw new Error(`git cat-file --batch returned an invalid header for ${requestedObjectId}`)
    }
    const size = Number(match[2])
    if (!Number.isSafeInteger(size)) throw new Error('git cat-file --batch returned an invalid blob size')
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.byteLength || output[contentEnd] !== 0x0a) {
      throw new Error(`git cat-file --batch returned truncated content for ${requestedObjectId}`)
    }
    contents.set(requestedObjectId, output.subarray(contentStart, contentEnd))
    offset = contentEnd + 1
  }
  if (offset !== output.byteLength) throw new Error('git cat-file --batch returned trailing data')
  return new Map([...selected].map(([path, entry]) => {
    const content = contents.get(entry.objectId)
    if (content === undefined) throw new Error(`git cat-file --batch omitted staged ${path}`)
    return [path, { objectId: entry.objectId, content }] as const
  }))
}

/**
 * Paths visible to a custom merge driver from the current index plus every
 * merge head Git advertises through `GITHEAD_<oid>` environment entries.
 *
 * Git invokes custom drivers before it writes clean additions from the other
 * heads into stage zero. The explicit post-conflict resolver has no GITHEAD
 * entries and therefore uses the already-merged index alone.
 */
export function gitMergeInputPaths(root: string, environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const paths = gitIndexPaths(root)
  const heads = Object.keys(environment)
    .flatMap(key => /^GITHEAD_([0-9a-f]{40})$/.exec(key)?.[1] ?? [])
    .sort()
  for (const head of heads) {
    const files = runGit(root, ['ls-tree', '-r', '--name-only', '-z', head], `listing merge-head ${head} paths`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    for (const file of files) paths.add(file)
  }
  return paths
}

/**
 * Read one path from the Git index without consulting working-tree bytes.
 *
 * @param root - Repository root.
 * @param path - Repository-relative path.
 * @returns The stage-zero blob, or `undefined` when the path is absent.
 * @throws Error when the path is unmerged or its index entries are not a valid merge state.
 */
export function readGitIndexBlob(root: string, path: string): GitIndexBlob | undefined {
  const output = runGit(
    root,
    ['ls-files', '--stage', '-z', '--', path],
    `git ls-files --stage for ${path}`,
  ).toString('utf8')
  const entries = output.split('\0').filter(Boolean)
  if (entries.length === 0) return undefined
  if (entries.length !== 1) throw new Error(`${path} does not have exactly one resolved index entry`)
  const match = /^(?:\d+) ([0-9a-f]+) 0\t[\s\S]+$/.exec(entries[0] ?? '')
  if (!match?.[1]) throw new Error(`${path} remains unmerged or has an invalid index entry`)
  return {
    objectId: match[1],
    content: runGit(root, ['cat-file', 'blob', match[1]], `reading staged ${path}`),
  }
}

/**
 * Persist exact working-tree bytes so a pairing record can later recover them
 * with `git cat-file`, even when they have never appeared in the index or a
 * commit. The returned object ID is checked against the pairing format's own
 * content hash before the caller writes a sidecar.
 */
export function storeGitBlob(root: string, content: Buffer): string {
  const expected = gitBlobHash(content)
  const stored = runGit(root, ['hash-object', '-w', '--stdin'], 'git hash-object -w --stdin', content)
    .toString('utf8')
    .trim()
  if (stored !== expected) {
    throw new Error(`git hash-object -w --stdin returned unexpected object ID ${JSON.stringify(stored)}; expected ${expected}`)
  }
  runGit(
    root,
    ['update-ref', `${SNAPSHOT_REF_PREFIX}/${stored}`, stored],
    'git update-ref for translation snapshot',
  )
  return stored
}
