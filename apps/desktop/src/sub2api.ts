/**
 * Desktop Host controller for the optional Sub2API sidecar component.
 *
 * Owns the offer-card state machine (`missing → downloading → verifying →
 * installed → starting → running / error`), drives the installer and the
 * profile surgery, probes the running component through the Web Host's
 * same-origin proxy seam, and pushes every transition to the renderer. The
 * card only renders what this controller pushes. All Web Host lifecycle work
 * goes through the injected {@link Sub2ApiHostControl} — the controlled
 * restart keeps the Electron window alive; sessions survive on disk.
 * @module @deepseek-ai/dsh-desktop/sub2api
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DesktopSub2ApiSnapshot } from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import { installSub2Api } from './sub2api-install.ts'
import type { Sub2ApiInstallResult } from './sub2api-install.ts'
import {
  addSub2ApiBundleRow,
  installedBundleVersion,
  isSub2ApiDisabled,
  manifestListsBundle,
  readSub2ApiProfileManifest,
  removeBundlePackage,
  removeSub2ApiBundleRow,
  setSub2ApiDisabled,
} from './sub2api-profile.ts'
import type { DesktopSub2ApiSources } from './sub2api-sources.ts'
import { readDesktopSub2ApiSources } from './sub2api-sources.ts'

/** How often the running probe polls the proxy seam. Robustness invariant, not a tunable. */
const PROBE_INTERVAL_MS = 2_000

/** probe budget: first boots run PostgreSQL initdb plus migrations (the sidecar's own budget is 120s). */
const PROBE_TIMEOUT_MS = 180_000

/** Web Host startup budget only for the first boot after installation. */
const FRESH_INSTALL_HOST_START_TIMEOUT_MS = 180_000

/** The proxy-seam route a 2xx from proves the supervised chain is healthy. */
const SUB2API_PROBE_PATH = '/plugins/dsh-sub2api/quota-snapshot'

/** Web Host lifecycle facts the controller needs. */
export interface Sub2ApiHostControl {
  /** Stop and respawn the Web Host child; resolves with the new origin. */
  readonly restart: (startTimeoutMs?: number) => Promise<string>
  /** Current Web Host origin, or `undefined` while it is down. */
  readonly origin: () => string | undefined
}

/** Everything the controller does on the caller's behalf, injectable for tests. */
export interface Sub2ApiControllerOptions {
  /** Download sources; `undefined` reports an unconfigured deployment. */
  readonly sources: DesktopSub2ApiSources | undefined
  /** The `web` profile directory (`$DSH_HOME/profiles/web`). */
  readonly profileDir: string
  /** Unpacked runtime pack root (`$DSH_HOME/sub2api/runtime`). */
  readonly runtimeDir: string
  /** The sidecar's user data (`$DSH_HOME/sub2api/data`). */
  readonly dataDir: string
  /** Web Host restart and origin access. */
  readonly host: Sub2ApiHostControl
  /** HTTP client for downloads and the running probe. */
  readonly fetchImpl: typeof fetch
  /** Install implementation (defaults to the real installer). */
  readonly install?: typeof installSub2Api
  /** One probe attempt; true when the component answered healthy. */
  readonly probe?: (origin: string) => Promise<boolean>
  /** Probe poll cadence override (tests). */
  readonly probeIntervalMs?: number
  /** Probe budget override (tests). */
  readonly probeTimeoutMs?: number
}

export interface DesktopSub2ApiActions {
  /** Current snapshot for a freshly attached renderer. */
  readonly getSnapshot: () => DesktopSub2ApiSnapshot
  /** Download, verify, install, restart, and wait for health. */
  readonly enable: () => Promise<DesktopSub2ApiSnapshot>
  /** Disable the component for future Web Host boots and restart now. */
  readonly disable: () => Promise<DesktopSub2ApiSnapshot>
  /** Remove the bundle row and extracted files; optionally delete account data. */
  readonly uninstall: (deleteData: boolean) => Promise<DesktopSub2ApiSnapshot>
  /** Subscribe to snapshot transitions. */
  readonly subscribe: (listener: (snapshot: DesktopSub2ApiSnapshot) => void) => () => void
  /** Re-probe after an out-of-band Web Host replacement (crash respawn). */
  readonly onHostOriginChanged: () => void
  /** Abort in-flight work; pushes stop. */
  readonly dispose: () => void
}

const INITIAL_SNAPSHOT: DesktopSub2ApiSnapshot = { state: 'missing', enabled: true }

/**
 * Probe once through the Web Host proxy seam: a 2xx proves the bundle is
 * mounted and the supervised chain is healthy. Transport errors mean "not yet".
 */
export async function probeByProxySeam(origin: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL(SUB2API_PROBE_PATH, origin), { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The real controller. One operation runs at a time; a second verb returns the
 * current snapshot instead of interleaving. Errors land in `state: 'error'`
 * with an actionable message; disk state is never left half-patched.
 */
export class DesktopSub2ApiController implements DesktopSub2ApiActions {
  private readonly options: Sub2ApiControllerOptions
  private readonly listeners = new Set<(snapshot: DesktopSub2ApiSnapshot) => void>()
  private snapshot: DesktopSub2ApiSnapshot = INITIAL_SNAPSHOT
  private busy = false
  private disposed = false
  private probeAbort: AbortController | undefined
  /** Whether the install completed inside the current enable() call. */
  private justInstalled = false

  constructor(options: Sub2ApiControllerOptions) {
    this.options = options
  }

  /**
   * Read the installed state from disk and start a probe when the component
   * should be running. Call once after the Web Host is up.
   */
  async start(): Promise<void> {
    await this.syncFromDisk()
    if (this.snapshot.state === 'installed' && this.snapshot.enabled) {
      void this.probeUntilRunning()
    }
  }

  getSnapshot(): DesktopSub2ApiSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: DesktopSub2ApiSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onHostOriginChanged(): void {
    if (this.disposed || this.busy) return
    if (this.snapshot.state !== 'installed' && this.snapshot.state !== 'running' && this.snapshot.state !== 'starting') return
    if (!this.snapshot.enabled) return
    void this.probeUntilRunning()
  }

  async enable(): Promise<DesktopSub2ApiSnapshot> {
    if (this.busy || this.disposed) return this.snapshot
    this.busy = true
    try {
      const installed = await this.installedOnDisk()
      if (!installed) {
        if (this.options.sources === undefined) {
          this.set({ state: 'error', enabled: true, error: PLACEHOLDER_ERROR })
          return this.snapshot
        }
        this.set({ state: 'downloading', enabled: true })
        await this.runInstall(this.options.sources)
        this.justInstalled = true
      }
      await setSub2ApiDisabled(this.options.profileDir, false)
      await this.restartAndProbe()
      return this.snapshot
    } catch (error) {
      this.set({ state: 'error', enabled: this.snapshot.enabled, error: errorMessage(error) })
      return this.snapshot
    } finally {
      this.busy = false
      this.justInstalled = false
    }
  }

  async disable(): Promise<DesktopSub2ApiSnapshot> {
    if (this.busy || this.disposed) return this.snapshot
    this.busy = true
    try {
      if (!(await this.installedOnDisk())) {
        this.set({ state: 'missing', enabled: true })
        return this.snapshot
      }
      await setSub2ApiDisabled(this.options.profileDir, true)
      const version = await installedBundleVersion(this.options.profileDir)
      if (this.options.host.origin() !== undefined) {
        this.set({ state: 'starting', enabled: false, version })
        await this.options.host.restart()
      }
      // The Web Host now boots with the row disabled: no processes run, so
      // there is nothing to probe — `installed` is the resting disabled state.
      this.set({ state: 'installed', enabled: false, version })
      return this.snapshot
    } catch (error) {
      this.set({ state: 'error', enabled: this.snapshot.enabled, error: errorMessage(error) })
      return this.snapshot
    } finally {
      this.busy = false
    }
  }

  async uninstall(deleteData: boolean): Promise<DesktopSub2ApiSnapshot> {
    if (this.busy || this.disposed) return this.snapshot
    this.busy = true
    try {
      if (!(await this.installedOnDisk())) {
        await this.cleanupFiles(deleteData)
        this.set({ state: 'missing', enabled: true })
        return this.snapshot
      }
      const removed = await removeSub2ApiBundleRow(this.options.profileDir)
      if (removed && this.options.host.origin() !== undefined) {
        try {
          this.set({ state: 'starting', enabled: true })
          await this.options.host.restart()
        } catch (error) {
          // Put the row back: the profile must not lose a working install
          // because one restart failed.
          await addSub2ApiBundleRow(this.options.profileDir)
          throw error
        }
      }
      await removeBundlePackage(this.options.profileDir)
      await rm(this.options.runtimeDir, { recursive: true, force: true })
      await this.cleanupFiles(deleteData)
      this.set({ state: 'missing', enabled: true })
      return this.snapshot
    } catch (error) {
      this.set({ state: 'error', enabled: this.snapshot.enabled, error: errorMessage(error) })
      return this.snapshot
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.probeAbort?.abort()
    this.listeners.clear()
  }

  /** Re-read installed state from disk (used at start and after external edits). */
  private async syncFromDisk(): Promise<void> {
    const manifest = await readSub2ApiProfileManifest(this.options.profileDir)
    const installed = manifestListsBundle(manifest, 'dsh-sub2api-sidecar')
    if (!installed) {
      this.set({ state: 'missing', enabled: true })
      return
    }
    const disabled = await isSub2ApiDisabled(this.options.profileDir)
    const version = await installedBundleVersion(this.options.profileDir)
    this.set({ state: 'installed', enabled: !disabled, version })
  }

  private async installedOnDisk(): Promise<boolean> {
    const manifest = await readSub2ApiProfileManifest(this.options.profileDir)
    return manifestListsBundle(manifest, 'dsh-sub2api-sidecar')
  }

  private async runInstall(sources: DesktopSub2ApiSources): Promise<void> {
    const abort = new AbortController()
    this.probeAbort?.abort()
    this.probeAbort = abort
    const result: Sub2ApiInstallResult = await (this.options.install ?? installSub2Api)({
      sources,
      layout: { profileDir: this.options.profileDir, runtimeDir: this.options.runtimeDir },
      fetchImpl: this.options.fetchImpl,
      signal: abort.signal,
      onProgress: (phase, percent) => {
        if (phase === 'downloading') this.set({ state: 'downloading', enabled: true, ...(percent === undefined ? {} : { downloadPercent: percent }) })
        if (phase === 'verifying') this.set({ state: 'verifying', enabled: true })
      },
    })
    this.set({ state: 'installed', enabled: true, version: result.bundleVersion })
  }

  /**
   * Controlled Web Host restart followed by the health probe. A failure right
   * after a fresh install rolls the install back and retries once: a Web Host
   * that cannot boot must not strand a half-installed component.
   */
  private async restartAndProbe(): Promise<void> {
    try {
      const origin = this.justInstalled
        ? await this.options.host.restart(FRESH_INSTALL_HOST_START_TIMEOUT_MS)
        : await this.options.host.restart()
      await this.probeUntilRunning(origin)
    } catch (error) {
      if (!this.justInstalled) throw error
      await removeSub2ApiBundleRow(this.options.profileDir)
      await removeBundlePackage(this.options.profileDir)
      await rm(this.options.runtimeDir, { recursive: true, force: true })
      try {
        await this.options.host.restart()
      } catch {
        // The second failure is the Web Host's own; its error page owns the
        // surface. Keep the actionable rollback message here.
      }
      this.set({ state: 'error', enabled: true, error: `${ROLLBACK_ERROR_PREFIX}${errorMessage(error)}` })
    }
  }

  private async probeUntilRunning(origin?: string): Promise<void> {
    const start = origin ?? this.options.host.origin()
    if (start === undefined) return
    this.probeAbort?.abort()
    const abort = new AbortController()
    this.probeAbort = abort
    const probe = this.options.probe ?? ((target: string) => probeByProxySeam(target, this.options.fetchImpl))
    // v8 ignore next -- production cadence; every test overrides it.
    const interval = this.options.probeIntervalMs ?? PROBE_INTERVAL_MS
    // v8 ignore next -- production budget; every test overrides it.
    const deadline = Date.now() + (this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS)
    this.set({
      state: 'starting',
      enabled: true,
      ...(this.snapshot.version === undefined ? {} : { version: this.snapshot.version }),
    })
    for (;;) {
      if (this.probeStopped(abort)) return
      if (await probe(start)) {
        if (this.probeStopped(abort)) return
        this.set({ state: 'running', enabled: true, version: await installedBundleVersion(this.options.profileDir) })
        return
      }
      if (Date.now() >= deadline) {
        // A dispose that raced the final poll lands in set(), which drops
        // pushes (and writes) after disposal.
        this.set({
          state: 'error',
          enabled: true,
          version: await installedBundleVersion(this.options.profileDir),
          error: STARTUP_TIMEOUT_ERROR,
        })
        return
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }

  /** Whether this probe's budget or the controller's lifetime ended. */
  private probeStopped(abort: AbortController): boolean {
    return abort.signal.aborted || this.disposed
  }

  private async cleanupFiles(deleteData: boolean): Promise<void> {
    if (deleteData) await rm(this.options.dataDir, { recursive: true, force: true })
  }

  private set(next: DesktopSub2ApiSnapshot): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener(next)
  }
}

// The two enable paths set this around their install call so the restart
// failure handler can tell a fresh install (rollback) from a re-enable (report).

/** Error text for a deployment without configured component sources. */
const PLACEHOLDER_ERROR =
  'Sub2API 组件下载源未配置。请使用包含 sub2api-sources.json 的 Desktop 发行版，或通过 DSH_DESKTOP_SUB2API_SOURCES 指向经批准的发布源。'

/** Error text prefix after a rolled-back failed install. */
export const ROLLBACK_ERROR_PREFIX = '安装失败，已回滚到未安装状态：'

/** Error text for a startup probe that never turned healthy. */
export const STARTUP_TIMEOUT_ERROR =
  '启动超时：组件未在预算时间内变为健康状态。可查看 ~/.dsh/sub2api/run/ 下的日志，或重试；卸载后重新启用会重新下载运行时。'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Controller used when the controller could not start (unreadable sources
 * file, missing profile manifest). Every verb reports the reason; the card
 * renders it as the actionable error.
 */
export class UnavailableDesktopSub2ApiController implements DesktopSub2ApiActions {
  private readonly snapshot: DesktopSub2ApiSnapshot

  constructor(reason: string) {
    this.snapshot = { state: 'error', enabled: false, error: reason }
  }

  getSnapshot(): DesktopSub2ApiSnapshot {
    return this.snapshot
  }

  enable(): Promise<DesktopSub2ApiSnapshot> {
    return Promise.resolve(this.snapshot)
  }

  disable(): Promise<DesktopSub2ApiSnapshot> {
    return Promise.resolve(this.snapshot)
  }

  uninstall(): Promise<DesktopSub2ApiSnapshot> {
    return Promise.resolve(this.snapshot)
  }

  subscribe(): () => void {
    return () => {}
  }

  onHostOriginChanged(): void {}

  dispose(): void {}
}

/** Filesystem locations the optional component owns under the Harness home. */
export interface Sub2ApiPaths {
  /** The `web` profile directory (`$DSH_HOME/profiles/web`). */
  readonly profileDir: string
  /** Unpacked runtime pack root (`$DSH_HOME/sub2api/runtime`). */
  readonly runtimeDir: string
  /** The sidecar's user data (`$DSH_HOME/sub2api/data`). */
  readonly dataDir: string
}

/**
 * Resolve the component's paths under one Harness home. The profile is always
 * the `web` profile: the Desktop Web Host is `dsh web`, the alias of
 * `--profile web`.
 * @param home - the Harness home (`resolveDshHome()`).
 */
export function sub2ApiPathsFromHome(home: string): Sub2ApiPaths {
  return {
    profileDir: join(home, 'profiles', 'web'),
    runtimeDir: join(home, 'sub2api', 'runtime'),
    dataDir: join(home, 'sub2api', 'data'),
  }
}

/** Options for {@link createDesktopSub2Api} supplied by the Desktop main process. */
export interface Sub2ApiFactoryOptions {
  /** HTTP client for downloads and the running probe (Electron net). */
  readonly fetch: typeof fetch
  /** Web Host restart and origin access. */
  readonly host: Sub2ApiHostControl
}

/**
 * Build the Sub2API controller for this run. A broken sources file or an
 * unreadable profile manifest degrades to the unavailable controller carrying
 * the reason, so the card states the failure instead of crashing Desktop boot.
 * @param options - fetch client and Web Host control.
 * @returns the started controller.
 */
export async function createDesktopSub2Api(options: Sub2ApiFactoryOptions): Promise<DesktopSub2ApiActions> {
  try {
    const controller = new DesktopSub2ApiController({
      sources: readDesktopSub2ApiSources(import.meta.url),
      ...sub2ApiPathsFromHome(resolveDshHome()),
      host: options.host,
      fetchImpl: options.fetch,
    })
    await controller.start()
    return controller
  } catch (error) {
    return new UnavailableDesktopSub2ApiController(errorMessage(error))
  }
}

/** Parse the renderer-provided delete-data choice at the Electron IPC boundary. */
export function parseSub2ApiDeleteData(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Desktop Sub2API deleteData must be boolean')
  return value
}

/** Validate an IPC value before invoking the uninstall mutation. */
export function uninstallSub2ApiFromIpc(
  actions: Pick<DesktopSub2ApiActions, 'uninstall'>,
  value: unknown,
): Promise<DesktopSub2ApiSnapshot> {
  return actions.uninstall(parseSub2ApiDeleteData(value))
}
