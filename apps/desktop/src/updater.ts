/**
 * electron-updater lifecycle: discover, user-confirmed download, quit-and-install.
 * @module @deepseek-ai/dsh-desktop/updater
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  UpdaterPhase, UpdaterStatus,
} from '@deepseek-ai/dsh-client-ui-desktop/protocol'

const INITIAL_CHECK_DELAY_MS = 3_000
const CHECK_INTERVAL_MS = 15 * 60 * 1_000
/** How long macOS may stay in `preparing` waiting for native Squirrel. */
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1_000

/** electron-updater logger methods the packaged Desktop Host persists. */
interface AutoUpdaterLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Minimal port over electron-updater's AppUpdater. */
export interface AutoUpdaterPort {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload?: boolean
  disableWebInstaller?: boolean
  logger?: AutoUpdaterLogger | null
  readonly checkForUpdates: () => Promise<unknown>
  readonly downloadUpdate: () => Promise<unknown>
  readonly quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
  readonly on: (event: string, listener: (...args: unknown[]) => void) => this
  readonly removeListener: (event: string, listener: (...args: unknown[]) => void) => this
}

/** Electron `autoUpdater` events that mean Squirrel finished staging. */
export interface NativeStagePort {
  readonly on: (event: 'update-downloaded' | 'error', listener: (...args: unknown[]) => void) => this
  readonly removeListener: (event: 'update-downloaded' | 'error', listener: (...args: unknown[]) => void) => this
}

/** Node ESM view of electron-updater's named or CommonJS default export. */
export interface AutoUpdaterModule {
  /** Native ESM export, when the package provides one. */
  readonly autoUpdater?: AutoUpdaterPort
  /** CommonJS namespace exposed as the default export. */
  readonly default?: { readonly autoUpdater?: AutoUpdaterPort }
}

/**
 * Resolve electron-updater across its ESM and CommonJS export forms.
 * @param module - namespace returned by dynamic import.
 * @returns the updater singleton.
 * @throws when neither export form contains `autoUpdater`.
 */
export function autoUpdaterFromModule(module: AutoUpdaterModule): AutoUpdaterPort {
  const updater = module.autoUpdater ?? module.default?.autoUpdater
  if (updater === undefined) throw new Error('electron-updater did not expose autoUpdater')
  return updater
}

/**
 * Configure GitHub NSIS updates: full installer download, no web stub, on-disk log.
 * @param updater - electron-updater singleton.
 * @param options.logFile - append-only log under userData.
 * @returns nothing; mutates `updater` in place.
 */
export function configurePackagedAutoUpdater(
  updater: AutoUpdaterPort,
  options: { readonly logFile: string },
): void {
  updater.disableDifferentialDownload = true
  updater.disableWebInstaller = true
  updater.logger = fileLogger(options.logFile)
}

function fileLogger(logFile: string): AutoUpdaterLogger {
  mkdirSync(dirname(logFile), { recursive: true })
  const write = (level: string, message: string): void => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch (error) {
      console.error('failed to write updater log', error)
    }
  }
  return {
    info: (message) => { write('info', message) },
    warn: (message) => { write('warn', message) },
    error: (message) => { write('error', message) },
  }
}

/** Testable updater state machine. */
export interface AutoUpdaterLifecycle {
  state(): UpdaterStatus
  checkForUpdates(): void
  download(): void
  install(): void
  dispose(): void
}

/**
 * Drive updater phases. autoDownload stays false; the user must confirm.
 * `available` still rechecks the GitHub feed on the same interval without
 * leaving that phase; a newer `update-available` replaces `newVersion`.
 * A recheck error while `available` keeps the offered version.
 * @param options.updater - electron-updater port.
 * @param options.onStateChange - notify the page / menu.
 * @param options.autoInstallOnAppQuit - macOS Squirrel prefetch after download; ordinary quit still does not install.
 * @param options.nativeStage - Electron autoUpdater; when present, Install waits until Squirrel stages.
 * @param options.stageTimeoutMs - fail `preparing` if native staging never signals.
 * @returns lifecycle handle.
 */
export function startAutoUpdater(options: {
  readonly updater: AutoUpdaterPort
  readonly onStateChange?: (state: UpdaterStatus) => void
  readonly now?: () => number
  readonly autoInstallOnAppQuit?: boolean
  readonly nativeStage?: NativeStagePort
  readonly stageTimeoutMs?: number
}): AutoUpdaterLifecycle {
  const now = options.now ?? Date.now
  let disposed = false
  let checking = false
  let availableVersion: string | undefined
  let lastCheckedAt: number | null = null
  let current: UpdaterStatus = Object.freeze({ state: 'idle', lastCheckedAt })

  const transition = (
    state: UpdaterPhase,
    detail: Pick<UpdaterStatus, 'newVersion' | 'downloadPercent' | 'errorMessage'> = {},
  ): void => {
    if (disposed) return
    const next = Object.freeze({ state, lastCheckedAt, ...detail })
    current = next
    try {
      options.onStateChange?.(next)
    } catch (error) {
      console.error('failed to publish updater state', error)
    }
  }

  const handleError = (error: unknown): void => {
    if (current.state === 'available') return
    clearStageTimer()
    transition('error', {
      ...versionDetail(availableVersion),
      errorMessage: error instanceof Error ? error.message : String(error),
    })
  }

  const check = (): void => {
    if (
      disposed || checking
      || current.state === 'downloading'
      || current.state === 'preparing' || current.state === 'downloaded'
      || current.state === 'installing'
    ) return
    const silent = current.state === 'available'
    checking = true
    if (!silent) transition('checking')
    void options.updater.checkForUpdates().catch((error: unknown) => {
      if (!silent) handleError(error)
    }).finally(() => { checking = false })
  }

  options.updater.autoDownload = false
  // macOS Squirrel only prefetches after HTTP download when this is true.
  // MacUpdater does not install on an ordinary quit.
  options.updater.autoInstallOnAppQuit = options.autoInstallOnAppQuit === true
  const handleChecking = (): void => {
    if (current.state === 'available' || current.state === 'downloading'
      || current.state === 'preparing' || current.state === 'downloaded'
      || current.state === 'installing') return
    transition('checking')
  }
  const handleAvailable = (info: unknown): void => {
    if (current.state === 'downloading' || current.state === 'preparing'
      || current.state === 'downloaded' || current.state === 'installing') return
    availableVersion = versionOf(info)
    lastCheckedAt = now()
    transition('available', versionDetail(availableVersion))
  }
  const handleNotAvailable = (): void => {
    if (current.state === 'downloading' || current.state === 'preparing'
      || current.state === 'downloaded' || current.state === 'installing') return
    availableVersion = undefined
    lastCheckedAt = now()
    transition('idle')
  }
  const handleProgress = (info: unknown): void => {
    if (current.state !== 'downloading') return
    transition('downloading', {
      ...versionDetail(availableVersion),
      ...percentDetail(percentOf(info)),
    })
  }
  let stageTimer: ReturnType<typeof setTimeout> | undefined
  const clearStageTimer = (): void => {
    if (stageTimer === undefined) return
    clearTimeout(stageTimer)
    stageTimer = undefined
  }
  const handleStaged = (): void => {
    if (current.state !== 'preparing') return
    clearStageTimer()
    transition('downloaded', versionDetail(availableVersion))
  }
  const handleStageError = (error: unknown): void => {
    if (current.state !== 'preparing') return
    handleError(error)
  }
  const handleDownloaded = (info: unknown): void => {
    availableVersion = versionOf(info) ?? availableVersion
    if (options.nativeStage === undefined) {
      transition('downloaded', versionDetail(availableVersion))
      return
    }
    transition('preparing', versionDetail(availableVersion))
    clearStageTimer()
    stageTimer = setTimeout(() => {
      handleError(new Error('update preparation timed out'))
    }, options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS)
  }
  options.updater.on('checking-for-update', handleChecking)
  options.updater.on('update-available', handleAvailable)
  options.updater.on('update-not-available', handleNotAvailable)
  options.updater.on('download-progress', handleProgress)
  options.updater.on('update-downloaded', handleDownloaded)
  options.updater.on('error', handleError)
  options.nativeStage?.on('update-downloaded', handleStaged)
  options.nativeStage?.on('error', handleStageError)

  const initial = setTimeout(check, INITIAL_CHECK_DELAY_MS)
  const interval = setInterval(check, CHECK_INTERVAL_MS)

  return {
    state: () => current,
    checkForUpdates: check,
    download(): void {
      if (disposed || current.state !== 'available') return
      transition('downloading', { ...versionDetail(availableVersion), downloadPercent: 0 })
      void options.updater.downloadUpdate().catch(handleError)
    },
    install(): void {
      if (disposed || current.state !== 'downloaded') return
      transition('installing', versionDetail(availableVersion))
      options.updater.quitAndInstall(false, true)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimeout(initial)
      clearInterval(interval)
      clearStageTimer()
      options.updater.removeListener('checking-for-update', handleChecking)
      options.updater.removeListener('update-available', handleAvailable)
      options.updater.removeListener('update-not-available', handleNotAvailable)
      options.updater.removeListener('download-progress', handleProgress)
      options.updater.removeListener('update-downloaded', handleDownloaded)
      options.updater.removeListener('error', handleError)
      options.nativeStage?.removeListener('update-downloaded', handleStaged)
      options.nativeStage?.removeListener('error', handleStageError)
    },
  }
}

function versionOf(info: unknown): string | undefined {
  if (info === null || typeof info !== 'object' || !('version' in info)) return undefined
  return typeof info.version === 'string' ? info.version : undefined
}

function percentOf(info: unknown): number | undefined {
  if (info === null || typeof info !== 'object' || !('percent' in info)) return undefined
  if (typeof info.percent !== 'number' || !Number.isFinite(info.percent)) return undefined
  return Math.max(0, Math.min(100, Math.trunc(info.percent)))
}

function versionDetail(version: string | undefined): Pick<UpdaterStatus, 'newVersion'> {
  return version === undefined ? {} : { newVersion: version }
}

function percentDetail(percent: number | undefined): Pick<UpdaterStatus, 'downloadPercent'> {
  return percent === undefined ? {} : { downloadPercent: percent }
}
