/** Host-owned phone toolchain state and trusted mobilecli preparation. @module @deepseek-ai/dsh-phone-environment */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { writeJson } from '@deepseek-ai/dsh-host-webserver'
import { resolveMobilecliExecutable } from '@deepseek-ai/dsh-phone-runtime'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-request-trust'
import {
  installManagedMobilecli, PhoneEnvironmentError, probeMobilecliVersion, readManagedMobilecli,
} from './installer.ts'
import { MOBILECLI_MANAGED_VERSION, selectMobilecliReleaseAsset } from './manifest.ts'
import { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from './planner.ts'
import type {
  PhoneEnvironmentSnapshot, PhoneRuntimeCandidate, PhoneRuntimeSource, PhoneRuntimeState,
} from './types.ts'

export { MOBILECLI_MANAGED_VERSION, MOBILECLI_RELEASE_ASSETS, selectMobilecliReleaseAsset } from './manifest.ts'
export { PhoneEnvironmentError } from './installer.ts'
export { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from './planner.ts'
export type { PhoneRuntimeCandidates } from './planner.ts'
export type {
  MobilecliArchitecture, MobilecliPlatform, MobilecliReleaseAsset, PhoneEnvironmentSnapshot,
  PhonePlatformState, PhoneRuntimeCandidate, PhoneRuntimeSource, PhoneRuntimeState,
} from './types.ts'

/** Full snapshot path consumed by the Phone Devices settings client. */
export const PHONE_ENVIRONMENT_PATH = '/phone/environment'
/** Managed preparation operation path. */
export const PHONE_ENVIRONMENT_PREPARE_PATH = '/phone/environment/prepare'
/** Active preparation cancellation path. */
export const PHONE_ENVIRONMENT_CANCEL_PATH = '/phone/environment/cancel'
/** Runtime source re-detection path. */
export const PHONE_ENVIRONMENT_REFRESH_PATH = '/phone/environment/refresh'

/** Host-specific configuration; release trust facts remain fixed in source. */
export interface Config {
  /** Private phone state root; defaults to `$DSH_HOME/phone`. */
  readonly root?: string
  /** Explicit operator executable override, ahead of managed and system discovery. */
  readonly executablePath?: string
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({ root: z.string(), executablePath: z.string() })

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned phone toolchain state and preparation operations. */
    phoneEnvironment: PhoneEnvironment
  }
}

/** Stable Host Service for phone runtime discovery, preparation, and activation. */
export class PhoneEnvironment extends Service {
  static readonly Config = Config
  static inject = ['phoneDevices', 'webServer']

  private current: PhoneEnvironmentSnapshot
  private readonly listeners = new Set<(snapshot: PhoneEnvironmentSnapshot) => void>()
  private readonly root: string
  private readonly executableOverride: string | undefined
  private candidate: PhoneRuntimeCandidate | undefined
  private candidateVersion: string | undefined
  private prepareController: AbortController | undefined
  private activationController: AbortController | undefined
  private enableController: AbortController | undefined
  private refreshController: AbortController | undefined
  private prepareTask: Promise<PhoneEnvironmentSnapshot> | undefined
  private refreshTask: Promise<PhoneEnvironmentSnapshot> | undefined
  private enableTail: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private disposed = false

  /**
   * Register the trusted HTTP operations and initialize the host snapshot.
   * @param ctx - owning Cordis context.
   * @param config - private root and optional operator override.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'phoneEnvironment')
    this.root = resolve(config.root ?? join(resolveDshHome(), 'phone'))
    this.executableOverride = nonEmpty(config.executablePath)
    this.current = initialPhoneEnvironmentSnapshot(process.platform, process.arch, false)
    ctx.effect(() => () => { this.listeners.clear() }, 'phone environment subscriber cleanup')
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix', path: PHONE_ENVIRONMENT_PATH, handler: (req, res) => this.handleHttp(req, res),
    }), 'phone-environment HTTP operations')
    ctx.effect(() => ctx.phoneDevices.onReadinessChanged((ready) => {
      if (!ready && this.current.enabled && this.current.runtime.kind === 'ready') {
        this.publishRuntime(environmentFailure(new PhoneEnvironmentError(
          'PHONE_ENVIRONMENT_RUNTIME_LOST', 'the active mobilecli runtime exited unexpectedly',
        )))
      }
    }), 'phone environment runtime readiness tracking')
    ctx.effect(() => async () => {
      this.disposed = true
      this.lifetime.abort(new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_DISPOSED', 'the phone environment service is disposed',
      ))
      this.cancel()
      await this.prepareTask?.catch(() => {})
      await this.refreshTask?.catch(() => {})
      await this.enableTail.catch(() => {})
      await ctx.phoneDevices.deactivate().catch(() => {})
    }, 'phone environment teardown')
  }

  /** Detect persisted, explicit, and system runtime candidates without failing Host composition. */
  protected [Service.init](): Promise<void> {
    return this.refresh().then(() => {}, () => {})
  }

  /**
   * Read the latest committed environment state.
   * @returns the current immutable full snapshot.
   */
  snapshot(): PhoneEnvironmentSnapshot {
    return this.current
  }

  /**
   * Apply the durable settings gate and symmetrically activate or stop the child generation.
   * @param enabled - current `ui-phone.enabled` value.
   */
  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (!enabled) this.cancel()
    const controller = new AbortController()
    if (enabled) this.enableController = controller
    const operation = this.enableTail.then(() => this.applyEnabled(enabled, controller.signal))
    this.enableTail = operation.catch(() => {})
    void operation.then(
      () => { if (this.enableController === controller) this.enableController = undefined },
      () => { if (this.enableController === controller) this.enableController = undefined },
    )
    return operation
  }

  private async applyEnabled(enabled: boolean, signal: AbortSignal): Promise<void> {
    if (this.disposed || enabled === this.current.enabled) return
    this.publish({ ...this.current, enabled })
    if (!enabled) {
      await this.prepareTask?.catch(() => {})
      await this.refreshTask?.catch(() => {})
      await this.ctx.phoneDevices.deactivate()
      return
    }
    if (this.candidate === undefined || this.candidateVersion === undefined) await this.refresh(signal)
    else await this.activateCandidate(this.candidate, this.candidateVersion, signal)
  }

  /**
   * Subscribe to committed full-snapshot replacements.
   * @param listener - callback receiving the new immutable snapshot.
   * @returns the disposer.
   */
  onChanged(listener: (snapshot: PhoneEnvironmentSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Re-detect runtime sources in fixed override-managed-system precedence.
   * @param signal - optional owner cancellation for detection and activation.
   * @returns the committed full snapshot after detection settles.
   */
  refresh(signal?: AbortSignal): Promise<PhoneEnvironmentSnapshot> {
    if (this.refreshTask !== undefined) return this.refreshTask
    const controller = new AbortController()
    this.refreshController = controller
    const operationSignal = signal === undefined
      ? AbortSignal.any([this.lifetime.signal, controller.signal])
      : AbortSignal.any([this.lifetime.signal, controller.signal, signal])
    const operation = this.detectRuntime(operationSignal)
    this.refreshTask = operation
    void operation.then(
      () => {
        if (this.refreshTask === operation) this.refreshTask = undefined
        if (this.refreshController === controller) this.refreshController = undefined
      },
      () => {
        if (this.refreshTask === operation) this.refreshTask = undefined
        if (this.refreshController === controller) this.refreshController = undefined
      },
    )
    return operation
  }

  /**
   * Download, verify, publish, and optionally activate the pinned host asset.
   * @returns the committed full snapshot after preparation settles.
   */
  prepare(): Promise<PhoneEnvironmentSnapshot> {
    if (this.executableOverride !== undefined) {
      return Promise.reject(new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_OVERRIDE',
        'managed mobilecli preparation is unavailable while executablePath is configured',
      ))
    }
    if (this.prepareTask !== undefined) {
      return Promise.reject(new PhoneEnvironmentError('PHONE_ENVIRONMENT_BUSY', 'mobilecli preparation is already running'))
    }
    let asset
    try {
      asset = this.selectManagedAsset(process.platform, process.arch)
    } catch (error) {
      this.publishRuntime(environmentFailure(error))
      return Promise.reject(error)
    }
    const controller = new AbortController()
    this.prepareController = controller
    const operation = (async () => {
      try {
        const installed = await installManagedMobilecli(this.root, asset, controller.signal, {
          onPhase: phase => this.publishRuntime(phase === 'verifying'
            ? { kind: 'verifying', targetVersion: MOBILECLI_MANAGED_VERSION }
            : downloadingState(asset.bytes, 0)),
          onProgress: progress => this.publishRuntime(downloadingState(progress.totalBytes, progress.receivedBytes)),
        })
        this.candidate = Object.freeze({ source: 'managed', executablePath: installed.executablePath })
        this.candidateVersion = installed.version
        if (this.current.enabled) await this.activateCandidate(this.candidate, installed.version, controller.signal)
        else this.publishReady('managed', installed.version)
        return this.current
      } catch (error) {
        this.publishRuntime(controller.signal.aborted
          ? { kind: 'missing', targetVersion: MOBILECLI_MANAGED_VERSION, assetBytes: asset.bytes }
          : environmentFailure(error))
        throw error
      } finally {
        if (this.prepareController === controller) this.prepareController = undefined
      }
    })()
    this.prepareTask = operation
    void operation.then(
      () => { if (this.prepareTask === operation) this.prepareTask = undefined },
      () => { if (this.prepareTask === operation) this.prepareTask = undefined },
    )
    return operation
  }

  /** Cancel the current detection, download, version probe, or child activation. */
  cancel(): void {
    const reason = new PhoneEnvironmentError('PHONE_ENVIRONMENT_ABORTED', 'the phone environment operation was cancelled')
    this.prepareController?.abort(reason)
    this.activationController?.abort(reason)
    this.enableController?.abort(reason)
    this.refreshController?.abort(reason)
  }

  /**
   * Resolve the immutable release row used by managed preparation.
   * @param platform - current Node platform.
   * @param architecture - current Node architecture.
   * @returns the pinned asset admitted for this Host tuple.
   */
  protected selectManagedAsset(platform: string, architecture: string) {
    return selectMobilecliReleaseAsset(platform, architecture)
  }

  private async detectRuntime(signal: AbortSignal): Promise<PhoneEnvironmentSnapshot> {
    try {
      const managed = await readManagedMobilecli(this.root, process.platform, process.arch)
      let system: string | undefined
      try {
        system = resolveMobilecliExecutable({ env: process.env })
      } catch {
        // Absence is the ordinary missing state; fixed guidance belongs in the UI.
      }
      const candidate = selectPhoneRuntimeCandidate({
        ...(this.executableOverride === undefined ? {} : { override: this.executableOverride }),
        ...(managed === undefined ? {} : { managed: managed.executablePath }),
        ...(system === undefined ? {} : { system }),
      })
      if (candidate === undefined) {
        this.candidate = undefined
        this.candidateVersion = undefined
        if (this.current.enabled) await this.ctx.phoneDevices.deactivate()
        this.publishRuntime(initialPhoneEnvironmentSnapshot(
          process.platform, process.arch, this.current.enabled,
        ).runtime)
        return this.current
      }
      const version = await probeMobilecliVersion(candidate.executablePath, signal)
      if (version !== MOBILECLI_MANAGED_VERSION) {
        throw new PhoneEnvironmentError(
          'PHONE_ENVIRONMENT_VERSION',
          `mobilecli ${version} is installed; this Desktop requires ${MOBILECLI_MANAGED_VERSION}`,
        )
      }
      this.candidate = candidate
      this.candidateVersion = version
      if (this.current.enabled) await this.activateCandidate(candidate, version, signal)
      else this.publishReady(candidate.source, version)
    } catch (error) {
      this.candidate = undefined
      this.candidateVersion = undefined
      if (this.current.enabled) await this.ctx.phoneDevices.deactivate().catch(() => {})
      this.publishRuntime(environmentFailure(error))
    }
    return this.current
  }

  private async activateCandidate(candidate: PhoneRuntimeCandidate, version: string, signal?: AbortSignal): Promise<void> {
    this.publishRuntime({
      kind: 'activating', targetVersion: MOBILECLI_MANAGED_VERSION, source: candidate.source,
    })
    const controller = new AbortController()
    this.activationController?.abort(new PhoneEnvironmentError(
      'PHONE_ENVIRONMENT_ABORTED', 'the previous mobilecli activation was replaced',
    ))
    this.activationController = controller
    const activationSignal = signal === undefined
      ? AbortSignal.any([this.lifetime.signal, controller.signal])
      : AbortSignal.any([this.lifetime.signal, controller.signal, signal])
    try {
      await this.ctx.phoneDevices.activateExecutable(candidate.executablePath, activationSignal)
      this.publishReady(candidate.source, version)
    } catch (error) {
      this.publishRuntime(environmentFailure(error))
      throw error
    } finally {
      if (this.activationController === controller) this.activationController = undefined
    }
  }

  private publishReady(source: PhoneRuntimeSource, version: string): void {
    this.publishRuntime({ kind: 'ready', source, version })
  }

  private publishRuntime(runtime: PhoneRuntimeState): void {
    this.publish({ ...this.current, runtime: Object.freeze(runtime) })
  }

  private publish(candidate: Omit<PhoneEnvironmentSnapshot, 'revision'> & { readonly revision?: number }): void {
    const next = Object.freeze({ ...candidate, revision: this.current.revision + 1 }) as PhoneEnvironmentSnapshot
    if (sameSnapshot(this.current, next)) return
    this.current = next
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  private trustedHosts(): readonly string[] {
    const runtime = this.ctx.get('webRuntime') as { readonly trustedHosts?: readonly string[] } | undefined
    return runtime?.trustedHosts ?? []
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.trustedHosts())) {
      writeJson(res, 403, { error: { code: 'forbidden', message: 'phone environment request is not trusted' } })
      return
    }
    const pathname = pathnameOf(req)
    if (pathname === PHONE_ENVIRONMENT_PATH && req.method === 'GET') {
      writeJson(res, 200, this.current)
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: { code: 'method-not-allowed', message: 'phone environment mutation is POST-only' } })
      return
    }
    try {
      if (pathname === PHONE_ENVIRONMENT_PREPARE_PATH) await this.prepare()
      else if (pathname === PHONE_ENVIRONMENT_CANCEL_PATH) this.cancel()
      else if (pathname === PHONE_ENVIRONMENT_REFRESH_PATH) await this.refresh()
      else {
        writeJson(res, 404, { error: { code: 'not-found', message: 'unknown phone environment path' } })
        return
      }
      writeJson(res, 200, this.current)
    } catch (error) {
      const failure = environmentError(error)
      writeJson(res, failure.code === 'PHONE_ENVIRONMENT_BUSY' ? 409 : 502, {
        error: { code: failure.code, message: failure.message },
      })
    }
  }
}

function downloadingState(totalBytes: number, receivedBytes: number): PhoneRuntimeState {
  return Object.freeze({
    kind: 'downloading', targetVersion: MOBILECLI_MANAGED_VERSION, receivedBytes, totalBytes,
  })
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function environmentFailure(error: unknown): PhoneRuntimeState {
  const failure = environmentError(error)
  return Object.freeze({
    kind: 'failed', targetVersion: MOBILECLI_MANAGED_VERSION, code: failure.code, message: failure.message,
  })
}

function environmentError(error: unknown): PhoneEnvironmentError {
  return error instanceof PhoneEnvironmentError
    ? error
    : new PhoneEnvironmentError(
      'PHONE_ENVIRONMENT_ACTIVATION', error instanceof Error ? error.message : String(error), { cause: error },
    )
}

function sameSnapshot(previous: PhoneEnvironmentSnapshot, next: PhoneEnvironmentSnapshot): boolean {
  return previous.enabled === next.enabled
    && JSON.stringify(previous.runtime) === JSON.stringify(next.runtime)
    && JSON.stringify(previous.platforms) === JSON.stringify(next.platforms)
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return '/'
  }
}

export default PhoneEnvironment
