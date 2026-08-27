/**
 * Enablement installer for the optional Sub2API sidecar component.
 *
 * Everything runs inside the Desktop Host main process with its own bundled
 * tools: `fetch` (Electron's session-aware stack in production) downloads the
 * bundle tarball and the runtime pack into a private staging directory, the
 * archives are verified against their `SHA256SUMS`, and Node's `fs`/`tar`
 * place the files. No user-PATH pnpm or `dsh` CLI is ever invoked. The
 * profile-facing half (the `dsh.profile.bundles` row) lives in
 * `sub2api-profile.ts`; this module owns downloads, verification, extraction,
 * and the rollback that keeps a failed enablement from leaving a half state.
 * @module @deepseek-ai/dsh-desktop/sub2api-install
 */

import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import * as tar from 'tar'
import {
  addSub2ApiBundleRow,
  manifestListsBundle,
  readProfileManifestText,
  readSub2ApiProfileManifest,
  removeBundlePackage,
  restoreSub2ApiProfileManifest,
  SUB2API_BUNDLE_NAME,
} from './sub2api-profile.ts'
import type { DesktopSub2ApiSources } from './sub2api-sources.ts'

/** Filesystem destinations one enablement writes. */
export interface Sub2ApiInstallLayout {
  /** The `web` profile directory (`$DSH_HOME/profiles/web`). */
  readonly profileDir: string
  /** Unpacked runtime pack root (`$DSH_HOME/sub2api/runtime`). */
  readonly runtimeDir: string
}

/** The install function signature the controller consumes (injectable in tests). */
export type Sub2ApiInstall = typeof installSub2Api

/** The complete input one install call receives. */
export type Sub2ApiInstallInput = Parameters<Sub2ApiInstall>[0]

/** Result of one completed enablement install. */
export interface Sub2ApiInstallResult {
  /** The installed bundle package name. */
  readonly bundleName: string
  /** The installed bundle package version. */
  readonly bundleVersion: string
}

/** Progress reported while the installer works. */
export type Sub2ApiInstallProgress = (phase: 'downloading' | 'verifying', percent?: number) => void

/** One `<sha256>  <filename>` line of a SHA256SUMS document. */
interface Sha256SumsEntry {
  readonly digest: string
  readonly filename: string
}

/**
 * Parse a SHA256SUMS document: one `digest` + whitespace + `filename` per
 * line, `#` comment lines allowed, exactly the `sha256sum -c` input format.
 * @param text - the document text.
 * @returns the parsed entries.
 */
export function parseSha256Sums(text: string): readonly Sha256SumsEntry[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return []
    const match = /^(?<digest>[0-9a-f]{64})\s+\*?(?<filename>.+)$/.exec(trimmed)
    const { digest, filename } = match?.groups ?? {}
    if (digest === undefined || filename === undefined) {
      throw new Error(`Sub2API installer: unparseable SHA256SUMS line: ${JSON.stringify(trimmed)}`)
    }
    return [{ digest, filename }]
  })
}

/**
 * Verify one file's SHA-256 against a SHA256SUMS document that names it.
 * @param file - absolute path of the file to hash.
 * @param sumsText - the SHA256SUMS document text.
 * @param filename - the basename the document must name.
 * @throws when the document does not name the file or the digest mismatches.
 */
export async function verifyFileAgainstSums(file: string, sumsText: string, filename: string): Promise<void> {
  const entry = parseSha256Sums(sumsText).find(candidate => candidate.filename === filename)
  if (entry === undefined) {
    throw new Error(`Sub2API installer: SHA256SUMS does not list ${JSON.stringify(filename)}`)
  }
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  const actual = hash.digest('hex')
  if (actual !== entry.digest) {
    throw new Error(
      `Sub2API installer: SHA-256 mismatch for ${JSON.stringify(filename)}`
      + ` (expected ${entry.digest}, got ${actual})`,
    )
  }
}

/**
 * Download one URL to a file, reporting integer byte progress against
 * Content-Length. Exported for the focused download-robustness tests.
 */
export async function downloadToFile(
  url: string,
  file: string,
  fetchImpl: typeof fetch,
  onBytes: (percent: number | undefined) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchImpl(url, { signal, redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`Sub2API installer: download failed for ${url} (status ${String(response.status)})`)
  }
  const totalHeader = response.headers.get('content-length')
  const total = totalHeader === null ? undefined : Number(totalHeader)
  let received = 0
  let lastReported = -1
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total !== undefined && Number.isFinite(total) && total > 0) {
      const percent = Math.min(100, Math.floor((received / total) * 100))
      if (percent !== lastReported) {
        lastReported = percent
        onBytes(percent)
      }
    }
  })
  await pipeline(source, createWriteStream(file, { mode: 0o600 }))
  if (total !== undefined && Number.isFinite(total) && received !== total) {
    throw new Error(`Sub2API installer: truncated download for ${url} (${String(received)}/${String(total)} bytes)`)
  }
}

interface ArchiveFacts {
  readonly bundleName: string
  readonly bundleVersion: string
  readonly declaresBundle: boolean
}

/** The manifest slice the installer trusts from inside a bundle tarball. */
interface BundlePackageManifest {
  name?: unknown
  version?: unknown
  dsh?: { bundle?: { patch?: unknown } }
}

/**
 * Extract a bundle tarball and read the package facts the install needs.
 * @param archive - absolute path of the bundle `.tgz`.
 * @param destDir - extraction target (contents land directly there).
 * @returns the package name and version, plus whether `dsh.bundle` is declared.
 */
async function extractBundle(archive: string, destDir: string): Promise<ArchiveFacts> {
  await mkdir(destDir, { recursive: true })
  // npm pack archives carry one `package/` root; strip it so the payload is
  // the package directory itself.
  await tar.x({ file: archive, cwd: destDir, strip: 1 })
  let raw: string
  try {
    raw = await readFile(join(destDir, 'package.json'), 'utf8')
  } catch {
    throw new Error('Sub2API installer: bundle tarball has no package.json at its root')
  }
  let manifest: BundlePackageManifest
  try {
    manifest = JSON.parse(raw) as BundlePackageManifest
  } catch (error) {
    throw new Error(`Sub2API installer: bundle package.json does not parse: ${String(error)}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error('Sub2API installer: bundle package.json declares no name')
  }
  if (manifest.dsh?.bundle?.patch === undefined) {
    throw new Error(
      `Sub2API installer: package ${JSON.stringify(manifest.name)} declares no dsh.bundle`
      + ' and cannot be installed as a profile layer',
    )
  }
  return {
    bundleName: manifest.name,
    bundleVersion: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    declaresBundle: true,
  }
}

/**
 * Replace the runtime pack directory with the extracted archive contents.
 * The old tree is removed first: the pack is read-only, replaceable on
 * upgrade, and never holds user data (that lives in `data/`).
 */
async function extractPackReplacing(archive: string, dir: string): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-sub2api-extract-'))
  try {
    const packDir = join(parent, 'pack')
    await mkdir(packDir, { recursive: true })
    // The pack carries one top-level `runtime-pack-<ver>-<os>-<arch>/` root.
    await tar.x({ file: archive, cwd: packDir, strip: 1 })
    if ((await countFiles(packDir)) === 0) {
      throw new Error('Sub2API installer: runtime pack archive is empty')
    }
    await verifyExtractedPack(packDir)
    await rm(dir, { recursive: true, force: true })
    await mkdir(join(dir, '..'), { recursive: true })
    await renamePack(packDir, dir)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

/** Move the extracted tree into place, falling back to a copy across devices. */
async function renamePack(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    // EXDEV or similar: stage and destination share no filesystem, so a
    // recursive copy is the only way to complete the install.
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Verify the extracted runtime pack against its inner SHA256SUMS. The pack's
 * own document names every payload file relative to the pack root.
 * @param dir - the extracted pack root.
 */
export async function verifyExtractedPack(dir: string): Promise<void> {
  const sumsPath = join(dir, 'SHA256SUMS')
  const sumsText = await readFile(sumsPath, 'utf8')
    .catch(() => { throw new Error('Sub2API installer: runtime pack has no inner SHA256SUMS') })
  for (const entry of parseSha256Sums(sumsText)) {
    const hash = createHash('sha256')
    try {
      await pipeline(createReadStream(join(dir, entry.filename)), hash)
    } catch {
      throw new Error(`Sub2API installer: runtime pack is missing ${JSON.stringify(entry.filename)}`)
    }
    if (hash.digest('hex') !== entry.digest) {
      throw new Error(`Sub2API installer: runtime pack file ${JSON.stringify(entry.filename)} failed its SHA-256 check`)
    }
  }
}

/** Count files under a directory tree, for the extraction sanity check. */
async function countFiles(dir: string): Promise<number> {
  let count = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name))
    else count += 1
  }
  return count
}

/** The published filename a SHA256SUMS document lists for one source URL. */
function archiveNameFromUrl(url: string): string {
  // Sources are validated absolute http(s) URLs before this runs.
  return decodeURIComponent(basename(new URL(url).pathname))
}

/**
 * Run one full enablement install: download both archives and their sums,
 * verify, install the bundle package into the profile, patch the profile
 * manifest, unpack the runtime pack. Every failure after the manifest patch
 * rolls the row back (and removes this run's extraction) so the Web Host never
 * boots a half-installed component.
 * @param input - sources, layout, fetch implementation, progress sink, abort signal.
 * @returns the installed bundle identity.
 */
export async function installSub2Api(input: {
  readonly sources: DesktopSub2ApiSources
  readonly layout: Sub2ApiInstallLayout
  readonly fetchImpl: typeof fetch
  readonly onProgress?: Sub2ApiInstallProgress
  readonly signal?: AbortSignal
}): Promise<Sub2ApiInstallResult> {
  const { sources, layout, fetchImpl, onProgress, signal } = input
  if (manifestListsBundle(await readSub2ApiProfileManifest(layout.profileDir), SUB2API_BUNDLE_NAME)) {
    throw new Error(`Sub2API installer: ${JSON.stringify(SUB2API_BUNDLE_NAME)} is already installed in the web profile`)
  }
  const staging = await mkdtemp(join(tmpdir(), 'dsh-sub2api-staging-'))
  let manifestBefore: string | undefined
  let bundleDir: string | undefined
  try {
    const bundleArchive = join(staging, 'bundle.tgz')
    const packArchive = join(staging, 'runtime-pack.tar.gz')
    const bundleSums = join(staging, 'bundle-SHA256SUMS')
    const packSums = join(staging, 'runtime-pack-SHA256SUMS')
    onProgress?.('downloading', 0)
    await downloadToFile(sources.bundleUrl, bundleArchive, fetchImpl, () => {}, signal)
    await downloadToFile(sources.runtimePackUrl, packArchive, fetchImpl, (percent) => {
      onProgress?.('downloading', percent)
    }, signal)
    await downloadToFile(sources.bundleSha256SumsUrl, bundleSums, fetchImpl, () => {}, signal)
    await downloadToFile(sources.runtimePackSha256SumsUrl, packSums, fetchImpl, () => {}, signal)
    onProgress?.('verifying')
    await verifyFileAgainstSums(bundleArchive, await readFile(bundleSums, 'utf8'), archiveNameFromUrl(sources.bundleUrl))
    await verifyFileAgainstSums(packArchive, await readFile(packSums, 'utf8'), archiveNameFromUrl(sources.runtimePackUrl))

    // Everything before this point is staging-only. From here every failure
    // rolls the manifest row and this run's extraction back: the Web Host must
    // never boot a half-installed component.
    manifestBefore = await readProfileManifestText(layout.profileDir)
    const extracted = join(staging, 'bundle')
    const facts = await extractBundle(bundleArchive, extracted)
    if (facts.bundleName !== SUB2API_BUNDLE_NAME) {
      throw new Error(
        `Sub2API installer: unexpected bundle package ${JSON.stringify(facts.bundleName)}`
        + ` (expected ${JSON.stringify(SUB2API_BUNDLE_NAME)})`,
      )
    }
    bundleDir = join(layout.profileDir, 'node_modules', facts.bundleName)
    await mkdir(join(bundleDir, '..'), { recursive: true })
    await rm(bundleDir, { recursive: true, force: true })
    await renamePack(extracted, bundleDir)
    await addSub2ApiBundleRow(layout.profileDir)
    await extractPackReplacing(packArchive, layout.runtimeDir)
    return { bundleName: facts.bundleName, bundleVersion: facts.bundleVersion }
  } catch (error) {
    if (manifestBefore !== undefined) await rollback(layout, manifestBefore, bundleDir)
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Roll back the manifest row and this run's bundle extraction. */
async function rollback(
  layout: Sub2ApiInstallLayout,
  manifestBefore: string,
  bundleDir: string | undefined,
): Promise<void> {
  await restoreSub2ApiProfileManifest(layout.profileDir, manifestBefore)
  if (bundleDir !== undefined) await removeBundlePackage(layout.profileDir)
}
