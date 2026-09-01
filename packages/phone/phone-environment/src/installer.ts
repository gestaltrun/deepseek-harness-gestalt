/** Trusted download, extraction, version probe, and atomic current publication for managed mobilecli. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MOBILECLI_MANAGED_VERSION } from './manifest.ts'
import type { MobilecliReleaseAsset, PhoneRuntimeCandidate } from './types.ts'

const execFileAsync = promisify(execFile)
const MAX_REDIRECTS = 5
const VERSION_PROBE_TIMEOUT_MS = 15_000
const CURRENT_FILE = 'current.json'

/** Stable preparation failure with a client-safe code. */
export class PhoneEnvironmentError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - operator-facing explanation.
   * @param options - optional causal error.
   */
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PhoneEnvironmentError'
  }
}

/** Download progress emitted after each committed chunk. */
export interface MobilecliDownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes: number
}

/** Installer dependencies; tests replace only the nondeterministic HTTP boundary. */
export interface MobilecliInstallerOptions {
  readonly fetch?: typeof fetch
  /** Test replacement for the platform executable probe. */
  readonly probeVersion?: typeof probeMobilecliVersion
  readonly onProgress?: (progress: MobilecliDownloadProgress) => void
  readonly onPhase?: (phase: 'downloading' | 'verifying') => void
}

/** Result atomically published as the managed current runtime. */
export interface ManagedMobilecliInstall {
  readonly executablePath: string
  readonly version: string
}

/**
 * Download and publish one allowlisted mobilecli release asset.
 * @param root - private `$DSH_HOME/phone` root.
 * @param asset - immutable release manifest row.
 * @param signal - cancellation signal for HTTP and the version probe.
 * @param options - nondeterministic boundary and progress observers.
 * @returns the verified managed executable.
 */
export async function installManagedMobilecli(
  root: string,
  asset: MobilecliReleaseAsset,
  signal: AbortSignal,
  options: MobilecliInstallerOptions = {},
): Promise<ManagedMobilecliInstall> {
  await ensurePrivateRoot(root)
  const staging = await mkdtemp(join(root, '.staging-'))
  await chmod(staging, 0o700)
  try {
    options.onPhase?.('downloading')
    const archive = join(staging, asset.name)
    await downloadAsset(archive, asset, signal, options.fetch ?? fetch, options.onProgress)
    options.onPhase?.('verifying')
    const archiveBytes = new Uint8Array(await readFile(archive, { signal }))
    const entries = unzipSync(archiveBytes)
    const names = Object.keys(entries)
    if (names.length !== 1 || names[0] !== asset.executable) {
      throw new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_ARCHIVE',
        `mobilecli archive must contain exactly ${JSON.stringify(asset.executable)} at its root`,
      )
    }
    const executableBytes = entries[asset.executable]
    if (executableBytes === undefined || executableBytes.byteLength === 0) {
      throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_ARCHIVE', 'mobilecli archive contains an empty executable')
    }
    const versionDirName = `${asset.platform}-${asset.architecture}-${asset.sha256}`
    const stagedVersion = join(staging, versionDirName)
    await mkdir(stagedVersion, { mode: 0o700 })
    const stagedExecutable = join(stagedVersion, asset.executable)
    const handle = await open(stagedExecutable, 'wx', 0o700)
    try {
      await handle.writeFile(executableBytes)
    } finally {
      await handle.close()
    }
    await chmod(stagedExecutable, 0o700)
    const probeVersion = options.probeVersion ?? probeMobilecliVersion
    const version = await probeVersion(stagedExecutable, signal)
    if (version !== MOBILECLI_MANAGED_VERSION) {
      throw new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_VERSION',
        `mobilecli archive reported ${version}; expected ${MOBILECLI_MANAGED_VERSION}`,
      )
    }
    const versions = join(root, 'versions')
    await mkdir(versions, { recursive: true, mode: 0o700 })
    const finalVersion = join(versions, versionDirName)
    try {
      await rename(stagedVersion, finalVersion)
    } catch (error) {
      if (!await isExistingDirectory(finalVersion)) throw error
      const existingVersion = await probeVersion(join(finalVersion, asset.executable), signal)
      if (existingVersion !== version) {
        throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_VERSION', 'existing managed mobilecli failed the pinned version probe')
      }
    }
    const executablePath = join(finalVersion, asset.executable)
    await writeFileAtomic(join(root, CURRENT_FILE), `${JSON.stringify({
      version,
      platform: asset.platform,
      architecture: asset.architecture,
      executable: relative(root, executablePath),
    })}\n`, { mode: 0o600, dirMode: 0o700 })
    return Object.freeze({ executablePath, version })
  } catch (error) {
    if (signal.aborted) throw cancellationError(error)
    if (error instanceof PhoneEnvironmentError) throw error
    if (isDiskFailure(error)) {
      throw new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_DISK',
        'mobilecli preparation could not write its private installation directory',
        { cause: error },
      )
    }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function downloadAsset(
  target: string,
  asset: MobilecliReleaseAsset,
  signal: AbortSignal,
  fetcher: typeof fetch,
  onProgress: MobilecliInstallerOptions['onProgress'],
): Promise<void> {
  let url = asset.url
  let response: Response | undefined
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await fetcher(url, { redirect: 'manual', signal })
    if (response.status < 300 || response.status >= 400) break
    if (redirects === MAX_REDIRECTS) {
      throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_DOWNLOAD', 'mobilecli download exceeded five redirects')
    }
    const location = response.headers.get('location')
    if (location === null) {
      throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_DOWNLOAD', 'mobilecli redirect omitted Location')
    }
    const redirected = new URL(location, url)
    if (redirected.protocol !== 'https:' || redirected.hostname !== 'release-assets.githubusercontent.com') {
      throw new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_DOWNLOAD',
        `mobilecli download refused redirect to ${redirected.origin}`,
      )
    }
    url = redirected.href
  }
  const finalResponse = response as Response
  if (!finalResponse.ok || finalResponse.body === null) {
    throw new PhoneEnvironmentError(
      'PHONE_ENVIRONMENT_DOWNLOAD',
      `mobilecli download failed with HTTP ${String(finalResponse.status)}`,
    )
  }
  const declared = finalResponse.headers.get('content-length')
  if (declared !== null && Number(declared) !== asset.bytes) {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_LENGTH', 'mobilecli Content-Length did not match the pinned asset')
  }
  const handle = await open(target, 'wx', 0o600)
  const digest = createHash('sha256')
  const reader = finalResponse.body.getReader()
  let receivedBytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      receivedBytes += chunk.value.byteLength
      if (receivedBytes > asset.bytes) {
        throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_LENGTH', 'mobilecli download exceeded the pinned byte length')
      }
      digest.update(chunk.value)
      await handle.write(chunk.value)
      onProgress?.({ receivedBytes, totalBytes: asset.bytes })
    }
  } finally {
    await reader.cancel().catch(() => {})
    await handle.close()
  }
  if (receivedBytes !== asset.bytes) {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_LENGTH', 'mobilecli download was truncated')
  }
  if (digest.digest('hex') !== asset.sha256) {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_DIGEST', 'mobilecli SHA-256 did not match the pinned asset')
  }
}

/**
 * Probe the executable's own version output.
 * @param executablePath - verified archive output or discovered host executable.
 * @param signal - cancellation signal.
 * @returns parsed semantic version.
 */
export async function probeMobilecliVersion(executablePath: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executablePath, ['--version'], {
      encoding: 'utf8',
      env: scrubbedParentEnv(),
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    })
    const match = /^mobilecli version (\d+\.\d+\.\d+)\s*$/u.exec(stdout)
    if (match?.[1] === undefined) throw new Error(`unexpected output ${JSON.stringify(stdout.trim())}`)
    return match[1]
  } catch (error) {
    if (signal?.aborted === true) throw cancellationError(error)
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_VERSION', 'mobilecli version probe failed', { cause: error })
  }
}

/**
 * Read the atomically published managed current pointer for this host.
 * @param root - private phone root.
 * @param platform - current Node platform.
 * @param architecture - current Node architecture.
 * @param signal - optional cancellation for the durable pointer read.
 * @returns the managed candidate, or undefined when no current pointer exists.
 */
export async function readManagedMobilecli(
  root: string,
  platform: string,
  architecture: string,
  signal?: AbortSignal,
): Promise<PhoneRuntimeCandidate | undefined> {
  let raw: string
  try {
    raw = await readFile(join(root, CURRENT_FILE), {
      encoding: 'utf8',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw cancellationError(error)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_CURRENT', 'managed mobilecli current pointer is invalid JSON', { cause: error })
  }
  if (!isCurrentPointer(parsed) || parsed.platform !== platform || parsed.architecture !== architecture) return undefined
  const executablePath = resolve(root, parsed.executable)
  const escaped = relative(root, executablePath)
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || basename(executablePath) === '') {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_CURRENT', 'managed mobilecli current pointer leaves its private root')
  }
  return Object.freeze({ source: 'managed', executablePath })
}

function cancellationError(cause: unknown): PhoneEnvironmentError {
  return new PhoneEnvironmentError(
    'PHONE_ENVIRONMENT_ABORTED', 'the phone environment operation was cancelled', { cause },
  )
}

function isCurrentPointer(value: unknown): value is {
  version: string
  platform: string
  architecture: string
  executable: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 4
    && typeof record.version === 'string'
    && typeof record.platform === 'string'
    && typeof record.architecture === 'string'
    && typeof record.executable === 'string'
}

async function ensurePrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function isDiskFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EROFS' || code === 'EACCES' || code === 'EPERM'
}
