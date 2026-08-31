/** Host-owned phone toolchain state and trusted mobilecli preparation. @module @deepseek-ai/dsh-phone-environment */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { writeJson } from '@deepseek-ai/dsh-host-webserver'
import {
  resolveMobilecliExecutable, verifyAnnexBH264KeyAccessUnit, verifyMjpegJpegPicture, type DeviceId,
} from '@deepseek-ai/dsh-phone-runtime'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-request-trust'
import {
  installManagedMobilecli, PhoneEnvironmentError, probeMobilecliVersion, readManagedMobilecli,
} from './installer.ts'
import { MOBILECLI_MANAGED_VERSION, selectMobilecliReleaseAsset } from './manifest.ts'
import { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from './planner.ts'
import type {
  AndroidEnvironmentProvider, AndroidPrepareRequest, IosEnvironmentProvider, PhoneAndroidState,
  PhoneEnvironmentSnapshot, PhoneIosState,
  PhoneRuntimeCandidate, PhoneRuntimeSource, PhoneRuntimeState,
} from './types.ts'

export { MOBILECLI_MANAGED_VERSION, MOBILECLI_RELEASE_ASSETS, selectMobilecliReleaseAsset } from './manifest.ts'
export { PhoneEnvironmentError } from './installer.ts'
export { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from './planner.ts'
export type { PhoneRuntimeCandidates } from './planner.ts'
export type {
  AndroidEnvironmentProvider, AndroidPreparationPlan, AndroidPrepareRequest, AndroidSdkSource,
  IosDeviceTypePlan, IosEnvironmentProvider, IosPreparationPlan, IosRuntimePlan,
  MobilecliArchitecture, MobilecliPlatform, MobilecliReleaseAsset, PhoneAndroidState, PhoneIosState,
  PhoneEnvironmentSnapshot, PhonePlatformState, PhoneRuntimeCandidate, PhoneRuntimeSource, PhoneRuntimeState,
} from './types.ts'

/** Full snapshot path consumed by the Phone Devices settings client. */
export const PHONE_ENVIRONMENT_PATH = '/phone/environment'
/** Managed preparation operation path. */
export const PHONE_ENVIRONMENT_PREPARE_PATH = '/phone/environment/prepare'
/** Active preparation cancellation path. */
export const PHONE_ENVIRONMENT_CANCEL_PATH = '/phone/environment/cancel'
/** Runtime source re-detection path. */
export const PHONE_ENVIRONMENT_REFRESH_PATH = '/phone/environment/refresh'
/** Android SDK and default-AVD preparation path. */
export const PHONE_ENVIRONMENT_ANDROID_PREPARE_PATH = '/phone/environment/android/prepare'
/** Android environment cancellation path. */
export const PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH = '/phone/environment/android/cancel'
/** Android environment re-detection path. */
export const PHONE_ENVIRONMENT_ANDROID_REFRESH_PATH = '/phone/environment/android/refresh'
/** Start the prepared default Android emulator. */
export const PHONE_ENVIRONMENT_ANDROID_START_PATH = '/phone/environment/android/start'
/** iOS Runtime and default-Simulator preparation path. */
export const PHONE_ENVIRONMENT_IOS_PREPARE_PATH = '/phone/environment/ios/prepare'
/** iOS environment cancellation path. */
export const PHONE_ENVIRONMENT_IOS_CANCEL_PATH = '/phone/environment/ios/cancel'
/** iOS environment re-detection path. */
export const PHONE_ENVIRONMENT_IOS_REFRESH_PATH = '/phone/environment/ios/refresh'
/** Start the prepared default iOS Simulator. */
export const PHONE_ENVIRONMENT_IOS_START_PATH = '/phone/environment/ios/start'

/** Maximum wait for one syntactically recognizable H264 key access unit from a booted Android device. */
const ANDROID_RUNTIME_VERIFY_MS = 15_000
/** Maximum Android H264 bytes inspected before readiness fails. */
const ANDROID_H264_PROBE_MAX_BYTES = 4 * 1024 * 1024
/** Maximum wait for one recognizable JPEG picture from a booted iOS Simulator. */
const IOS_RUNTIME_VERIFY_MS = 15_000
/** Maximum MJPEG bytes inspected before iOS readiness fails. */
const IOS_MJPEG_PROBE_MAX_BYTES = 8 * 1024 * 1024

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
  private android: AndroidEnvironmentProvider | undefined
  private unsubscribeAndroid: (() => void) | undefined
  private androidController: AbortController | undefined
  private androidTask: Promise<void> | undefined
  private ios: IosEnvironmentProvider | undefined
  private unsubscribeIos: (() => void) | undefined
  private iosController: AbortController | undefined
  private iosTask: Promise<void> | undefined
  private transactionTail: Promise<unknown> = Promise.resolve()
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
      const failures: unknown[] = []
      this.disposed = true
      this.lifetime.abort(new PhoneEnvironmentError(
        'PHONE_ENVIRONMENT_DISPOSED', 'the phone environment service is disposed',
      ))
      this.cancel()
      try { await this.androidTask } catch (error) { if (!isCancellation(error)) failures.push(error) }
      try { await this.android?.deactivate() } catch (error) { failures.push(error) }
      try { await this.iosTask } catch (error) { if (!isCancellation(error)) failures.push(error) }
      try { await this.ios?.deactivate() } catch (error) { failures.push(error) }
      await this.prepareTask?.catch(() => {})
      await this.refreshTask?.catch(() => {})
      await this.enableTail.catch(() => {})
      await ctx.phoneDevices.deactivate().catch(() => {})
      if (failures.length > 0) throw new AggregateError(failures, 'phone environment teardown failed')
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
      await this.androidTask?.catch(() => {})
      await this.android?.deactivate()
      await this.iosTask?.catch(() => {})
      await this.ios?.deactivate()
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
   * Register the Android platform Provider while retaining this Service as the full-snapshot owner.
   * @param provider - Android SDK, AVD, and emulator lifecycle owner.
   * @returns disposer that detaches the Provider and restores the deferred state.
   */
  registerAndroidEnvironment(provider: AndroidEnvironmentProvider): () => void {
    if (this.android !== undefined) throw new Error('phone-environment: Android Provider is already registered')
    this.android = provider
    this.unsubscribeAndroid = provider.onChanged((state) => {
      this.publishAndroid(this.pendingAndroidRuntime(state))
    })
    this.publishAndroid(this.pendingAndroidRuntime(provider.snapshot()))
    void provider.refresh(this.lifetime.signal).catch(() => {})
    return () => {
      if (this.android !== provider) return
      this.unsubscribeAndroid?.()
      this.unsubscribeAndroid = undefined
      this.android = undefined
      this.publishAndroid({ kind: 'deferred' })
    }
  }

  /**
   * Register the iOS platform Provider while retaining this Service as the full-snapshot owner.
   * @param provider - Xcode runtime and Simulator lifecycle owner.
   * @returns disposer that detaches the Provider and restores the deferred state.
   */
  registerIosEnvironment(provider: IosEnvironmentProvider): () => void {
    if (this.ios !== undefined) throw new Error('phone-environment: iOS Provider is already registered')
    this.ios = provider
    this.unsubscribeIos = provider.onChanged((state) => {
      this.publishIos(this.pendingIosRuntime(state))
    })
    this.publishIos(this.pendingIosRuntime(provider.snapshot()))
    void provider.refresh(this.lifetime.signal).catch(() => {})
    return () => {
      if (this.ios !== provider) return
      this.unsubscribeIos?.()
      this.unsubscribeIos = undefined
      this.ios = undefined
      this.publishIos({ kind: 'deferred' })
    }
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
    const operation = this.transactionTail.then(() => this.detectRuntime(operationSignal))
    this.transactionTail = operation.catch(() => {})
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
   * @throws {@link PhoneEnvironmentError} with `PHONE_ENVIRONMENT_OVERRIDE` while
   *   `executablePath` is authoritative, `PHONE_ENVIRONMENT_BUSY` for concurrent
   *   preparation, or the documented download, verification, filesystem,
   *   cancellation, and activation codes.
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
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const controller = new AbortController()
    this.prepareController = controller
    const operation = this.transactionTail.then(async () => {
      try {
        const installed = await installManagedMobilecli(this.root, asset, controller.signal, {
          onPhase: (phase) => {
            this.publishRuntime(phase === 'verifying'
              ? { kind: 'verifying', targetVersion: MOBILECLI_MANAGED_VERSION }
              : downloadingState(asset.bytes, 0))
          },
          onProgress: (progress) => {
            this.publishRuntime(downloadingState(progress.totalBytes, progress.receivedBytes))
          },
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
    })
    this.transactionTail = operation.catch(() => {})
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
    this.androidController?.abort(reason)
    this.android?.cancel()
    this.iosController?.abort(reason)
    this.ios?.cancel()
  }

  private async prepareAndroid(request: AndroidPrepareRequest): Promise<void> {
    await this.runAndroidOperation(async (provider, signal) => {
      const prepared = await provider.prepare(request, signal)
      if (!this.current.enabled || this.candidate === undefined || this.candidateVersion === undefined) return
      const running = prepared.kind === 'ready' && prepared.running
        ? prepared
        : await provider.start(signal)
      await this.activateAndroidRuntime(running, signal)
    })
  }

  private async startAndroid(): Promise<void> {
    if (!this.current.enabled || this.candidate === undefined || this.candidateVersion === undefined) {
      throw new PhoneEnvironmentError(
        'PHONE_ANDROID_RUNTIME_REQUIRED',
        'enable Phone Devices and prepare mobilecli before starting the Android Emulator',
      )
    }
    await this.runAndroidOperation(async (provider, signal) => {
      await this.activateAndroidRuntime(await provider.start(signal), signal)
    })
  }

  private async refreshAndroid(): Promise<void> {
    await this.runAndroidOperation(async (provider, signal) => {
      this.publishAndroid(this.pendingAndroidRuntime(await provider.refresh(signal)))
    })
  }

  private requireAndroid(): AndroidEnvironmentProvider {
    if (this.android !== undefined) return this.android
    throw new PhoneEnvironmentError('PHONE_ANDROID_UNAVAILABLE', 'the Android environment Provider is unavailable')
  }

  private async activateAndroidRuntime(state: PhoneAndroidState, signal: AbortSignal): Promise<void> {
    if (state.kind !== 'ready' || this.candidate === undefined || this.candidateVersion === undefined) return
    if (!state.running || state.deviceId === undefined) return
    this.publishAndroid({ kind: 'booting', plan: state.plan })
    try {
      await this.activateCandidate(this.candidate, this.candidateVersion, signal)
      await this.verifyAndroidRuntime(state.deviceId, signal)
      signal.throwIfAborted()
      this.requireCurrentAndroidRuntime(state.deviceId)
      this.publishAndroid(state)
    } catch (error) {
      await this.ctx.phoneDevices.deactivate().catch(() => {})
      await this.android?.deactivate().catch(() => {})
      const failure = environmentError(error)
      this.publishAndroid({
        kind: 'failed', plan: state.plan, code: failure.code, message: failure.message, retryable: true,
      })
      throw error
    }
  }

  private pendingAndroidRuntime(state: PhoneAndroidState): PhoneAndroidState {
    return state.kind === 'ready' && state.running
      ? { kind: 'booting', plan: state.plan }
      : state
  }

  private requireCurrentAndroidRuntime(expectedId: DeviceId): void {
    const current = this.android?.snapshot()
    if (current?.kind === 'failed') {
      throw new PhoneEnvironmentError(current.code, current.message)
    }
    if (current?.kind !== 'ready' || !current.running || current.deviceId !== expectedId) {
      throw new PhoneEnvironmentError(
        'PHONE_ANDROID_RUNTIME_VERIFY',
        `the Android Provider revoked running device ${expectedId} before Host readiness commit`,
      )
    }
  }

  private async runAndroidOperation(
    operation: (provider: AndroidEnvironmentProvider, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.androidTask !== undefined) {
      throw new PhoneEnvironmentError('PHONE_ANDROID_BUSY', 'an Android environment operation is already running')
    }
    const provider = this.requireAndroid()
    const controller = new AbortController()
    this.androidController = controller
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const task = operation(provider, signal)
    this.androidTask = task
    try {
      await task
    } finally {
      if (this.androidTask === task) this.androidTask = undefined
      if (this.androidController === controller) this.androidController = undefined
    }
  }

  private async cancelAndroid(): Promise<void> {
    this.androidController?.abort(new PhoneEnvironmentError(
      'PHONE_ANDROID_ABORTED', 'the Android environment operation was cancelled',
    ))
    this.android?.cancel()
    let failure: unknown
    try { await this.androidTask } catch (error) { if (!isCancellation(error)) failure = error }
    try { await this.android?.deactivate() } catch (error) { failure ??= error }
    if (this.android !== undefined) this.publishAndroid(this.android.snapshot())
    if (failure !== undefined) throw failure
  }

  private async prepareIos(): Promise<void> {
    await this.runIosOperation(async (provider, signal) => {
      const prepared = await provider.prepare(signal)
      if (!this.current.enabled || this.candidate === undefined || this.candidateVersion === undefined) return
      const running = prepared.kind === 'ready' && prepared.running
        ? prepared
        : await provider.start(signal)
      await this.activateIosRuntime(running, signal)
    })
  }

  private async startIos(): Promise<void> {
    if (!this.current.enabled || this.candidate === undefined || this.candidateVersion === undefined) {
      throw new PhoneEnvironmentError(
        'PHONE_IOS_RUNTIME_REQUIRED',
        'enable Phone Devices and prepare mobilecli before starting iOS Simulator',
      )
    }
    await this.runIosOperation(async (provider, signal) => {
      await this.activateIosRuntime(await provider.start(signal), signal)
    })
  }

  private async refreshIos(): Promise<void> {
    await this.runIosOperation(async (provider, signal) => {
      this.publishIos(this.pendingIosRuntime(await provider.refresh(signal)))
    })
  }

  private requireIos(): IosEnvironmentProvider {
    if (this.ios !== undefined) return this.ios
    throw new PhoneEnvironmentError('PHONE_IOS_UNAVAILABLE', 'the iOS environment Provider is unavailable')
  }

  private async activateIosRuntime(state: PhoneIosState, signal: AbortSignal): Promise<void> {
    if (state.kind !== 'ready' || this.candidate === undefined || this.candidateVersion === undefined) return
    if (!state.running) return
    this.publishIos({ kind: 'preparing', plan: state.plan, step: 'booting' })
    try {
      await this.activateCandidate(this.candidate, this.candidateVersion, signal)
      await this.verifyIosRuntime(state.deviceId, signal)
      signal.throwIfAborted()
      this.requireCurrentIosRuntime(state.deviceId)
      this.publishIos(state)
    } catch (error) {
      await this.ctx.phoneDevices.deactivate().catch(() => {})
      await this.ios?.deactivate().catch(() => {})
      const failure = environmentError(error)
      this.publishIos({
        kind: 'failed', plan: state.plan, code: failure.code, message: failure.message, retryable: true,
      })
      throw error
    }
  }

  private pendingIosRuntime(state: PhoneIosState): PhoneIosState {
    return state.kind === 'ready' && state.running
      ? { kind: 'preparing', plan: state.plan, step: 'booting' }
      : state
  }

  private requireCurrentIosRuntime(expectedId: DeviceId): void {
    const current = this.ios?.snapshot()
    if (current?.kind === 'failed') throw new PhoneEnvironmentError(current.code, current.message)
    if (current?.kind !== 'ready' || !current.running || current.deviceId !== expectedId) {
      throw new PhoneEnvironmentError(
        'PHONE_IOS_RUNTIME_VERIFY',
        `the iOS Provider revoked running device ${expectedId} before Host readiness commit`,
      )
    }
  }

  private async runIosOperation(
    operation: (provider: IosEnvironmentProvider, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.iosTask !== undefined) {
      throw new PhoneEnvironmentError('PHONE_IOS_BUSY', 'an iOS environment operation is already running')
    }
    const provider = this.requireIos()
    const controller = new AbortController()
    this.iosController = controller
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const task = operation(provider, signal)
    this.iosTask = task
    try {
      await task
    } finally {
      if (this.iosTask === task) this.iosTask = undefined
      if (this.iosController === controller) this.iosController = undefined
    }
  }

  private async cancelIos(): Promise<void> {
    this.iosController?.abort(new PhoneEnvironmentError(
      'PHONE_IOS_ABORTED', 'the iOS environment operation was cancelled',
    ))
    this.ios?.cancel()
    let failure: unknown
    try { await this.iosTask } catch (error) { if (!isCancellation(error)) failure = error }
    try { await this.ios?.deactivate() } catch (error) { failure ??= error }
    if (this.ios !== undefined) this.publishIos(this.ios.snapshot())
    if (failure !== undefined) throw failure
  }

  private async verifyIosRuntime(id: DeviceId, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new PhoneEnvironmentError(
        'PHONE_IOS_RUNTIME_VERIFY',
        `mobilecli did not produce an iOS Simulator MJPEG picture within ${String(IOS_RUNTIME_VERIFY_MS)}ms`,
      ))
    }, IOS_RUNTIME_VERIFY_MS)
    timeout.unref()
    const verificationSignal = AbortSignal.any([signal, controller.signal])
    try {
      const devices = await this.ctx.phoneDevices.listDevices(verificationSignal)
      const listed = devices.ios.simulators.find(device => device.id === id && device.online)
      if (listed === undefined) {
        throw new PhoneEnvironmentError(
          'PHONE_IOS_RUNTIME_VERIFY',
          `mobilecli did not list the prepared iOS Simulator ${id} online`,
        )
      }
      const capture = await this.ctx.phoneDevices.startCapture({
        deviceId: id, format: 'mjpeg', signal: verificationSignal,
      })
      if (!/^(?:multipart\/x-mixed-replace|image\/jpeg)(?:;|$)/iu.test(capture.contentType)) {
        await capture.body.cancel()
        throw new PhoneEnvironmentError(
          'PHONE_IOS_RUNTIME_VERIFY',
          `mobilecli returned ${capture.contentType || 'no Content-Type'} for the iOS Simulator MJPEG probe`,
        )
      }
      await verifyMjpegJpegPicture(capture.body, {
        signal: verificationSignal, maxBytes: IOS_MJPEG_PROBE_MAX_BYTES,
      })
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
      if (signal.aborted) throw signal.reason
      if (error instanceof PhoneEnvironmentError && error.code === 'PHONE_IOS_RUNTIME_VERIFY') throw error
      throw new PhoneEnvironmentError(
        'PHONE_IOS_RUNTIME_VERIFY',
        `mobilecli could not verify the iOS Simulator MJPEG stream: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private async verifyAndroidRuntime(id: DeviceId, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new PhoneEnvironmentError(
        'PHONE_ANDROID_RUNTIME_VERIFY',
        `mobilecli did not produce an Android H264 frame within ${String(ANDROID_RUNTIME_VERIFY_MS)}ms`,
      ))
    }, ANDROID_RUNTIME_VERIFY_MS)
    timeout.unref()
    const verificationSignal = AbortSignal.any([signal, controller.signal])
    try {
      const devices = await this.ctx.phoneDevices.listDevices(verificationSignal)
      const listed = devices.android.find(device => device.id === id && device.online)
      if (listed === undefined) {
        throw new PhoneEnvironmentError(
          'PHONE_ANDROID_RUNTIME_VERIFY',
          `mobilecli did not list the prepared Android device ${id} online`,
        )
      }
      const capture = await this.ctx.phoneDevices.startCapture({
        deviceId: id, format: 'h264', signal: verificationSignal,
      })
      if (!/^video\/h264(?:;|$)/iu.test(capture.contentType)) {
        await capture.body.cancel()
        throw new PhoneEnvironmentError(
          'PHONE_ANDROID_RUNTIME_VERIFY',
          `mobilecli returned ${capture.contentType || 'no Content-Type'} for the Android H264 probe`,
        )
      }
      await verifyAnnexBH264KeyAccessUnit(capture.body, {
        signal: verificationSignal, maxBytes: ANDROID_H264_PROBE_MAX_BYTES,
      })
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
      if (signal.aborted) throw signal.reason
      if (error instanceof PhoneEnvironmentError && error.code === 'PHONE_ANDROID_RUNTIME_VERIFY') throw error
      throw new PhoneEnvironmentError(
        'PHONE_ANDROID_RUNTIME_VERIFY',
        `mobilecli could not verify the Android H264 stream: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(timeout)
    }
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

  /**
   * Probe one discovered runtime candidate at the Host subprocess boundary.
   * @param executablePath - absolute candidate executable.
   * @param signal - operation cancellation.
   * @returns the candidate semantic version.
   */
  protected probeRuntimeVersion(executablePath: string, signal: AbortSignal): Promise<string> {
    return probeMobilecliVersion(executablePath, signal)
  }

  private async detectRuntime(signal: AbortSignal): Promise<PhoneEnvironmentSnapshot> {
    try {
      const managed = await readManagedMobilecli(this.root, process.platform, process.arch, signal)
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
      const version = await this.probeRuntimeVersion(candidate.executablePath, signal)
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
      await this.ctx.phoneDevices.activateExecutable(
        candidate.executablePath,
        activationSignal,
        this.android?.runtimeEnvironment(),
      )
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

  private publishAndroid(android: PhoneAndroidState): void {
    this.publish({
      ...this.current,
      platforms: Object.freeze({ ...this.current.platforms, android: Object.freeze(android) }),
    })
  }

  private publishIos(ios: PhoneIosState): void {
    this.publish({
      ...this.current,
      platforms: Object.freeze({ ...this.current.platforms, ios: Object.freeze(ios) }),
    })
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
      else if (pathname === PHONE_ENVIRONMENT_ANDROID_PREPARE_PATH) {
        const body = await readJsonBody(req)
        if (!record(body) || body.licenseAccepted !== true) {
          throw new PhoneEnvironmentError(
            'PHONE_ANDROID_LICENSE_REQUIRED',
            'Android SDK preparation requires explicit license acceptance',
          )
        }
        await this.prepareAndroid({ licenseAccepted: true })
      } else if (pathname === PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH) await this.cancelAndroid()
      else if (pathname === PHONE_ENVIRONMENT_ANDROID_REFRESH_PATH) await this.refreshAndroid()
      else if (pathname === PHONE_ENVIRONMENT_ANDROID_START_PATH) await this.startAndroid()
      else if (pathname === PHONE_ENVIRONMENT_IOS_PREPARE_PATH) await this.prepareIos()
      else if (pathname === PHONE_ENVIRONMENT_IOS_CANCEL_PATH) await this.cancelIos()
      else if (pathname === PHONE_ENVIRONMENT_IOS_REFRESH_PATH) await this.refreshIos()
      else if (pathname === PHONE_ENVIRONMENT_IOS_START_PATH) await this.startIos()
      else {
        writeJson(res, 404, { error: { code: 'not-found', message: 'unknown phone environment path' } })
        return
      }
      writeJson(res, 200, this.current)
    } catch (error) {
      const failure = environmentError(error)
      writeJson(res, ['PHONE_ENVIRONMENT_BUSY', 'PHONE_ANDROID_BUSY', 'PHONE_IOS_BUSY'].includes(failure.code) ? 409 : 502, {
        error: { code: failure.code, message: failure.message },
      })
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    bytes += chunk.byteLength
    if (bytes > 4_096) throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_REQUEST', 'request body exceeds 4096 bytes')
    chunks.push(chunk)
  }
  if (bytes === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_REQUEST', 'request body is not valid JSON', { cause: error })
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { readonly code?: unknown }).code
  return code === 'PHONE_ANDROID_ABORTED'
    || code === 'PHONE_IOS_ABORTED'
    || code === 'PHONE_ENVIRONMENT_ABORTED'
    || code === 'PHONE_ENVIRONMENT_DISPOSED'
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
