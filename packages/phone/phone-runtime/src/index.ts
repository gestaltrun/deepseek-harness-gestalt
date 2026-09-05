/**
 * Host-half Service Definition + Provider for the phone device fleet capability,
 * folded into one package while mobilecli is its only backend. The Service owns
 * the external `mobilecli server start` child process, its loopback HTTP
 * JSON-RPC endpoint health, health/device polling, and publishes grouped
 * Android/iOS listings through `ctx.phoneDevices`. The iOS real-device link is
 * exposed through the listing's real group plus one-shot `mobilecli agent
 * status` / `agent install` runs that keep the on-device agent installed and
 * re-signed, with structured failure arms for locked devices, untrusted
 * certificates, expired profiles, failed tunnels, and unplugged handsets.
 * @module @deepseek-ai/dsh-phone-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { deadline, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { openAndroidSystemH264 } from './android-h264-process.ts'
import { readAndroidLogicalDisplay } from './android-display.ts'
import { runMobilecliAgent } from './agent-process.ts'
import { changeSets, groupEntries, parseDeviceInfos } from './devices.ts'
import { phoneFailureWithCleanup, PhoneDevicesError } from './errors.ts'
import { iosScreenSize, upstreamIo, type IosScreenSize } from './io.ts'
import { JpegFrameOrientationObserver, probeMjpegExifRotation } from './jpeg.ts'
import { inspectAnnexBH264KeyAccessUnit } from './h264.ts'
import { rejectWhenAborted } from './recognizable-stream.ts'
import type { MobilecliAgentAnswer } from './agent-process.ts'
import { runMobilecliScreenshot } from './screenshot-process.ts'
import { persistPhoneScreenshot } from './screenshot-store.ts'
import { MobilecliRpc, normalizeOperationError } from './rpc.ts'
import { resolveMobilecliExecutable } from './resolve-binary.ts'
import { statSync } from 'node:fs'
import {
  PHONE_RUNTIME_STATE_OWNER,
  phoneRuntimeStateValidator,
  registerPhoneRuntimeStateReader,
  type PhoneRuntimeStateOwner,
} from './runtime-state.ts'
import { MobilecliServerProcess } from './server-process.ts'
import type {
  DeviceId,
  PhoneAgentInstallOptions,
  PhoneAgentInstallResult,
  PhoneAgentStatus,
  PhoneCaptureRequest,
  PhoneCaptureStream,
  PhoneDeviceChange,
  PhoneDeviceList,
  PhoneDeviceRef,
  PhoneIoRequest,
  PhoneCaptureId,
  PhoneRotation,
  PhoneScreenshot,
} from './types.ts'

export type {
  DeviceId,
  PhoneAgentInfo,
  PhoneAgentInstallOptions,
  PhoneAgentInstallResult,
  PhoneAgentStatus,
  PhoneCaptureFormat,
  PhoneCaptureId,
  PhoneCaptureRequest,
  PhoneCaptureStream,
  PhoneDeviceChange,
  PhoneDeviceKind,
  PhoneDeviceList,
  PhoneDeviceRef,
  PhoneErrorCode,
  PhoneIoMethod,
  PhoneIoRequest,
  PhoneRealDeviceIssue,
  PhoneRotation,
  PhoneScreenshot,
} from './types.ts'
export { PhoneDevicesError } from './errors.ts'
export { deviceId, phoneCaptureId } from './ids.ts'
export { verifyAnnexBH264KeyAccessUnit } from './h264.ts'
export type { H264KeyAccessUnitVerificationOptions } from './h264.ts'
export { jpegExifRotation, probeMjpegExifRotation, verifyMjpegJpegPicture } from './jpeg.ts'
export type { MjpegPictureVerificationOptions } from './jpeg.ts'
export { resolveMobilecliExecutable } from './resolve-binary.ts'
export type { ServerExit } from './server-process.ts'

/**
 * Fixed operator guidance attached to every agent answer about a re-signed
 * real handset: free-team provisioning profiles expire after seven days and
 * the documented re-run entry is a forced reinstall.
 */
export const FREE_SIGNING_PROFILE_REMINDER = 'the agent is re-signed with the configured provisioning profile; free-team profiles expire after 7 days, so re-run installAgent(id, { force: true }) to re-sign when taps, text, buttons, or capture start failing'

/** OpenRPC method listing every Android and iOS device, including offline ones. */
const METHOD_DEVICES_LIST = 'devices.list'
/** OpenRPC method booting one simulator or emulator. */
const METHOD_DEVICE_BOOT = 'device.boot'
/** OpenRPC method shutting down one simulator or emulator. */
const METHOD_DEVICE_SHUTDOWN = 'device.shutdown'
/** OpenRPC method reporting logical screen size and device-pixel scale. */
const METHOD_DEVICE_INFO = 'device.info'
/** OpenRPC method opening an MJPEG or AVC screen-capture stream. */
const METHOD_DEVICE_SCREENCAPTURE = 'device.screencapture'
/** OpenRPC method probed until the spawned server answers its first request. */
const METHOD_SERVER_INFO = 'server.info'
/** Maximum bytes inspected before one Android H264 source is rejected. */
const ANDROID_H264_PROBE_MAX_BYTES = 4 * 1024 * 1024

const IOS_ROTATION_PROBE_MAX_BYTES = 256 * 1024

/**
 * Validated runtime configuration. Defaults carry the upstream facts they can:
 * `serverPort` mirrors mobilecli's documented default listen port and
 * `bootTimeoutMs` mirrors the extended upstream deadline granted to
 * `device.boot`; the polling cadence fields are deployment-varying choices.
 */
export interface Config {
  /**
   * Absolute path to the `mobilecli` executable. When omitted, `PATH` is
   * searched first, then npm-global, the npx cache, and `npm_config_prefix`.
   * An Electron-minimal PATH also probes `/opt/homebrew/bin` and `/usr/local/bin`.
   */
  executablePath?: string
  /** Wait for the environment owner to select and activate an executable. */
  deferStart?: boolean
  /** Loopback TCP port the spawned server listens on. */
  serverPort?: number
  /** Interval between health probes and device-list polls, in milliseconds. */
  pollIntervalMs?: number
  /** Stable-child interval required after the first valid device listing, in milliseconds. */
  readyStabilityMs?: number
  /** Total window granted to readiness probing, baseline listing, and stability, in milliseconds. */
  readyTimeoutMs?: number
  /** Ceiling on each JSON-RPC round trip other than boot, in milliseconds. */
  requestTimeoutMs?: number
  /** Ceiling for recognizing one H264 key access unit from each Android source. */
  h264ProbeTimeoutMs?: number
  /** Maximum milliseconds spent joining foreign capture reader cleanup. */
  captureCleanupTimeoutMs?: number
  /** Ceiling on a `device.boot` round trip, in milliseconds. */
  bootTimeoutMs?: number
  /** Ceiling on one `agent status` / `agent install` child run, in milliseconds. */
  agentTimeoutMs?: number
  /**
   * Absolute path to the `.mobileprovision` file passed as
   * `--provisioning-profile` when installing or re-signing the on-device agent
   * on a physical handset; the upstream command requires it for real iOS
   * installs. When set, the path must name an existing file.
   */
  provisioningProfilePath?: string
}

/** Runtime configuration schema applied by composition. */
export const Config: z<Config> = z.object({
  deferStart: z.boolean().default(false),
  serverPort: z.number().default(12_000),
  pollIntervalMs: z.number().default(5_000),
  readyStabilityMs: z.number().default(50),
  readyTimeoutMs: z.number().default(60_000),
  requestTimeoutMs: z.number().default(30_000),
  h264ProbeTimeoutMs: z.number().default(15_000),
  captureCleanupTimeoutMs: z.number().default(1_000),
  bootTimeoutMs: z.number().default(180_000),
  agentTimeoutMs: z.number().default(120_000),
})

type ResolvedConfig = Omit<Required<Config>, 'executablePath' | 'provisioningProfilePath'> & Pick<Config, 'executablePath' | 'provisioningProfilePath'>

/** Immutable references that keep a chained io operation on one runtime generation. */
interface RotationObservation {
  readonly rotation: PhoneRotation
  readonly revision: object
}

interface ActiveCaptureObservation {
  readonly deviceId: DeviceId
  readonly format: 'mjpeg' | 'h264'
  readonly revision: object
}

interface RotationProbe {
  readonly abort: AbortController
  readonly promise: Promise<PhoneRotation>
  readonly settled: Promise<void>
}

interface IoGeneration {
  readonly identity: object
  readonly client: MobilecliRpc
  readonly lifetime: AbortController
  readonly iosScreenSizes: Map<DeviceId, { readonly incarnation: object; readonly screen: IosScreenSize }>
  readonly rotations: Map<PhoneCaptureId, RotationObservation>
  readonly activeCaptures: Map<PhoneCaptureId, ActiveCaptureObservation>
  readonly rotationProbes: Map<DeviceId, RotationProbe>
  readonly deviceIncarnations: Map<DeviceId, object>
  readonly childEnvironment: Readonly<Record<string, string>>
}

function assertDurationField(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`phone-runtime: ${name} must be a positive safe integer`)
  }
}

function assertPortField(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('phone-runtime: serverPort must be a safe integer between 1 and 65535')
  }
}

function resolveValidatedConfig(config: Config): ResolvedConfig {
  const values = config as ResolvedConfig
  assertPortField(values.serverPort)
  assertDurationField('pollIntervalMs', values.pollIntervalMs)
  assertDurationField('readyStabilityMs', values.readyStabilityMs)
  assertDurationField('readyTimeoutMs', values.readyTimeoutMs)
  assertDurationField('requestTimeoutMs', values.requestTimeoutMs)
  assertDurationField('captureCleanupTimeoutMs', values.captureCleanupTimeoutMs)
  assertDurationField('h264ProbeTimeoutMs', values.h264ProbeTimeoutMs)
  assertDurationField('bootTimeoutMs', values.bootTimeoutMs)
  assertDurationField('agentTimeoutMs', values.agentTimeoutMs)
  const trimmedPath = values.executablePath?.trim()
  const trimmedProfile = values.provisioningProfilePath?.trim()
  const resolved: ResolvedConfig = {
    ...values,
    ...(trimmedPath !== undefined && trimmedPath.length > 0 ? { executablePath: trimmedPath } : {}),
    ...(trimmedProfile !== undefined && trimmedProfile.length > 0 ? { provisioningProfilePath: trimmedProfile } : {}),
  }
  if (resolved.provisioningProfilePath !== undefined) assertProfileFile(resolved.provisioningProfilePath)
  return resolved
}

function assertProfileFile(path: string): void {
  try {
    if (statSync(path).isFile()) return
  } catch {
    // A missing or unreadable profile path is exactly the misconfiguration
    // reported below; there is no other readable fact to surface first.
  }
  throw new Error(`phone-runtime: provisioningProfilePath ${JSON.stringify(path)} is not an existing file; fix the path or drop the field.`)
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function failedCaptureBody(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.error(errorValue(error)) } })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The phone device fleet Service backed by one local mobilecli server. */
    phoneDevices: PhoneDevices
  }
}

/**
 * Phone fleet Service over one external mobilecli server child. All operations
 * accept an optional cancellation signal and enforce validated time ceilings;
 * every failure normalizes onto {@link PhoneDevicesError}. A device-set
 * notification is published only after a poll observes a real difference from
 * the previously committed listing. An unresolvable mobilecli still activates
 * the Service; every operation then rejects with `PHONE_UNRESOLVED` and
 * install guidance instead of failing composition.
 *
 * Operation failure codes:
 * - `PHONE_DISPOSED` — the owning fiber began teardown.
 * - `PHONE_ABORTED` — the caller's signal won before completion.
 * - `PHONE_TIMEOUT` — the operation's configured ceiling elapsed.
 * - `PHONE_UNAVAILABLE` — the child died or its socket refuses connections.
 * - `PHONE_UNRESOLVED` — the mobilecli executable could not be resolved.
 * - `PHONE_PROTOCOL` — the upstream answer breaks its documented contract.
 * - `PHONE_UPSTREAM` — mobilecli returned a JSON-RPC error other than `-32010`.
 * - `PHONE_DEVICE_NOT_FOUND` — the id answers nothing upstream (`-32010`).
 * - `PHONE_REAL_DEVICE` — boot/shutdown targeted a physical handset.
 * - `PHONE_REAL_DEVICE_ISSUE` — the upstream output named a structured real-device
 *   failure arm; {@link PhoneDevicesError.issue} carries which one
 *   (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`,
 *   `device-unplugged`).
 *
 * `io`, `startCapture`, and `screenshot` accept physical handsets; they only
 * refuse ids absent from the latest published listing. `agentStatus` and `installAgent`
 * drive the upstream `agent status` / `agent install` commands as one-shot
 * child runs of the same executable, keep the on-device agent installed
 * idempotently, re-sign real handsets through the configured provisioning
 * profile, and attach the free-signing expiry reminder to every answer about
 * a re-signed real handset.
 */
export class PhoneDevices extends Service {
  /** Validated configuration schema applied by composition. */
  static readonly Config = Config

  /** Package-private identity of this concrete Service generation. */
  readonly [PHONE_RUNTIME_STATE_OWNER]: PhoneRuntimeStateOwner = Object.freeze({})

  private readonly resolved: ResolvedConfig
  private executablePath: string | undefined
  private childEnvironment: Readonly<Record<string, string>> = Object.freeze({})
  private resolutionFailure: PhoneDevicesError | undefined
  private readonly subscribers = new Set<(change: PhoneDeviceChange) => void>()
  private readonly readinessSubscribers = new Set<(ready: boolean) => void>()
  private lifetime = new AbortController()
  private activationTail: Promise<void> = Promise.resolve()
  private queueTail: Promise<void> = Promise.resolve()
  private teardownPromise: Promise<void> | undefined
  private closing = false
  private disposed = false
  private ready = false
  private publishedReadiness = false
  private lost: PhoneDevicesError | undefined
  private child: MobilecliServerProcess | undefined
  private rpcClient: MobilecliRpc | undefined
  private publishedList: PhoneDeviceList | undefined
  private iosScreenSizes = new Map<DeviceId, { readonly incarnation: object; readonly screen: IosScreenSize }>()
  private rotations = new Map<PhoneCaptureId, RotationObservation>()
  private activeCaptures = new Map<PhoneCaptureId, ActiveCaptureObservation>()
  private rotationProbes = new Map<DeviceId, RotationProbe>()
  private deviceIncarnations = new Map<DeviceId, object>()
  private generationIdentity = Object.freeze({})
  private readonly openNativeAndroidH264 = openAndroidSystemH264
  private readonly readAndroidLogicalDisplay = readAndroidLogicalDisplay
  private startupOutcome: Promise<void> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Resolve the external binary, spawn the loopback server child, and
   * register lifecycle effects. A missing or unusable mobilecli still
   * activates the Service; later operations reject with `PHONE_UNRESOLVED`
   * and install guidance. Other startup failures still reject plugin
   * initialization so a broken child remains visible.
   * @param ctx - Owning Cordis context.
   * @param config - Composition config validated against {@link PhoneDevices.Config}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'phoneDevices')
    this.resolved = resolveValidatedConfig(config)
    if (this.resolved.deferStart) {
      this.resolutionFailure = new PhoneDevicesError(
        'PHONE_UNRESOLVED',
        'the phone runtime is waiting for its environment owner to select mobilecli',
      )
    }
    if (this.resolutionFailure === undefined) {
      const override = this.resolved.executablePath
      try {
        this.executablePath = resolveMobilecliExecutable({
          ...(override !== undefined ? { executablePath: override } : {}),
          env: process.env,
        })
      } catch (error) {
        this.resolutionFailure = new PhoneDevicesError(
          'PHONE_UNRESOLVED',
          (error as Error).message,
          { cause: error },
        )
      }
    }
    this.registerEffects(ctx)
    if (this.resolutionFailure !== undefined) return
    this.child = new MobilecliServerProcess({
      executablePath: this.executable,
      port: this.resolved.serverPort,
    })
    this.rpcClient = new MobilecliRpc(`http://127.0.0.1:${String(this.resolved.serverPort)}`)
  }

  private registerEffects(ctx: Context): void {
    ctx.effect(() => () => {
      this.subscribers.clear()
      this.readinessSubscribers.clear()
    }, 'phone runtime subscriber registry cleanup')
    ctx.effect(() => () => this.teardown(), 'phone runtime teardown')
    ctx.effect(
      () => registerPhoneRuntimeStateReader(this[PHONE_RUNTIME_STATE_OWNER], () => this.publishedList),
      'phone runtime state reader',
    )
  }

  /**
   * Await server readiness as part of plugin initialization. An unresolved
   * binary skips the child; a rejected start still fails the plugin loudly.
   */
  protected [Service.init](): Promise<void> {
    if (this.resolutionFailure !== undefined) return Promise.resolve()
    this.startupOutcome ??= this.startup()
    return this.startupOutcome
  }

  /**
   * Read whether the current child may accept fleet operations.
   * @returns current generation readiness.
   */
  isReady(): boolean {
    return this.ready && this.lost === undefined && !this.closing && !this.disposed
  }

  /**
   * Subscribe to ready/not-ready transitions of the replaceable runtime generation.
   * @param listener - callback receiving the committed readiness value.
   * @returns the disposer.
   */
  onReadinessChanged(listener: (ready: boolean) => void): () => void {
    this.readinessSubscribers.add(listener)
    return () => { this.readinessSubscribers.delete(listener) }
  }

  /**
   * Replace the owned mobilecli child generation without replacing this Service.
   * In-flight work on the prior generation is aborted and its process is stopped
   * before the replacement begins readiness probing.
   * @param executablePath - absolute executable path selected by the environment owner.
   * @param signal - optional cancellation signal for replacement and readiness.
   * @param environment - non-sensitive SDK/AVD environment owned by the selected generation.
   */
  async activateExecutable(
    executablePath: string,
    signal?: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    this.assertAccepting()
    if (signal?.aborted === true) throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime activation was cancelled')
    const resolved = resolveMobilecliExecutable({ executablePath, env: process.env })
    const operation = this.activationTail.then(async () => {
      this.assertAccepting()
      await this.stopRuntime(new PhoneDevicesError('PHONE_ABORTED', 'the phone runtime generation was replaced'))
      this.assertAccepting()
      if (signal?.aborted === true) throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime activation was cancelled')
      this.executablePath = resolved
      this.childEnvironment = Object.freeze({ ...environment })
      this.resolutionFailure = undefined
      this.lost = undefined
      this.lifetime = new AbortController()
      this.generationIdentity = Object.freeze({})
      this.iosScreenSizes = new Map()
      this.rotations = new Map()
      this.activeCaptures = new Map()
      this.rotationProbes = new Map()
      this.deviceIncarnations = new Map()
      this.child = new MobilecliServerProcess({
        executablePath: resolved,
        port: this.resolved.serverPort,
        environment: this.childEnvironment,
      })
      this.rpcClient = new MobilecliRpc(`http://127.0.0.1:${String(this.resolved.serverPort)}`)
      this.startupOutcome = this.startup(signal)
      await this.startupOutcome
    })
    this.activationTail = operation.catch(() => {})
    await operation
  }

  /** Stop the current child generation while retaining this Service for later activation. */
  async deactivate(): Promise<void> {
    this.assertAccepting()
    const operation = this.activationTail.then(async () => {
      this.assertAccepting()
      await this.stopRuntime(new PhoneDevicesError('PHONE_ABORTED', 'the phone runtime generation was disabled'))
      this.executablePath = undefined
      this.childEnvironment = Object.freeze({})
      this.resolutionFailure = new PhoneDevicesError('PHONE_UNRESOLVED', 'the phone runtime is not prepared')
    })
    this.activationTail = operation.catch(() => {})
    await operation
  }

  /** Refuse operations while the mobilecli executable is unresolvable. */
  private requireResolved(): void {
    if (this.resolutionFailure !== undefined) throw this.resolutionFailure
  }

  /**
   * The resolved executable path.
   * @returns the path accepted by spawn; callers run after {@link requireResolved}.
   */
  private get executable(): string {
    return this.executablePath as string
  }

  /** Reject work entering after teardown begins. */
  private assertAccepting(): void {
    if (this.closing || this.disposed) {
      throw new PhoneDevicesError('PHONE_DISPOSED', 'the phone runtime service is disposed')
    }
  }

  /** Reject operations once the server generation is known to be gone or halt-listed. */
  private assertUsable(): void {
    if (this.lost !== undefined) throw this.lost
  }

  private async startup(signal?: AbortSignal): Promise<void> {
    // The constructor spawned the child before any effect could dispose it;
    // teardown nulls these fields only after init has settled either way.
    const child = this.child as MobilecliServerProcess
    const client = this.rpcClient as MobilecliRpc
    let settledExit: { readonly code: number | null } | undefined
    const exitSeen = child.exit.then((exit) => {
      settledExit = exit
    })
    const window = deadline(undefined, this.resolved.readyTimeoutMs, 'READY_WINDOW')
    const startupSignal = signal === undefined
      ? AbortSignal.any([window.signal, this.lifetime.signal])
      : AbortSignal.any([window.signal, this.lifetime.signal, signal])
    try {
      for (;;) {
        if (settledExit !== undefined) throw exitedBeforeReady(child, settledExit)
        if (signal?.aborted === true) throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime activation was cancelled')
        if (window.signal.aborted) throw this.readinessWindowElapsed(child)
        try {
          // The lifetime signal lets teardown interrupt a hung probe at once.
          await client.call(METHOD_SERVER_INFO, {}, startupSignal)
          break
        } catch {
          // Probes fail while the server binary is still starting up; the next
          // iteration re-checks child exit and window state first.
        }
        await pauseBeforeNextProbe(
          Math.min(this.resolved.pollIntervalMs, this.resolved.requestTimeoutMs),
          window.signal,
          this.lifetime.signal,
          signal,
          exitSeen,
        )
      }
      void child.exit.then((exit) => { this.onChildExit(child, exit) })
      // Commit the baseline listing inside initialization so every observer
      // attaches to a stable starting point and receives only later changes.
      await this.pollAttempt(true, startupSignal)
      // Hold readiness for the configured stability interval. A process can flush
      // the baseline response immediately before exiting; the close event may
      // arrive on a later event-loop turn and must win before readiness is
      // published.
      await pauseBeforeNextProbe(
        this.resolved.readyStabilityMs,
        window.signal,
        this.lifetime.signal,
        signal,
        exitSeen,
      )
      const exitAfterStability = readSettledExit(() => settledExit)
      if (exitAfterStability !== undefined) throw exitedBeforeReady(child, exitAfterStability)
      if (this.lost !== undefined) throw this.lost
      if (isSignalAborted(signal) || this.lifetime.signal.aborted) {
        throw new PhoneDevicesError('PHONE_ABORTED', 'phone runtime activation was cancelled')
      }
      if (isSignalAborted(window.signal)) throw this.readinessWindowElapsed(child)
      this.assertAccepting()
      this.ready = true
      this.publishReadiness(true)
      this.armPoll()
    } catch (error) {
      const failure = signal?.aborted === true
        ? new PhoneDevicesError('PHONE_ABORTED', 'phone runtime activation was cancelled', { cause: error })
        : error instanceof PhoneDevicesError
          ? error
          : new PhoneDevicesError('PHONE_PROTOCOL', `mobilecli startup failed unexpectedly: ${String(error)}`, { cause: error })
      this.lost = failure
      try {
        await child.stop()
      } catch (cleanup) {
        throw phoneFailureWithCleanup(failure, cleanup, 'mobilecli startup process-tree cleanup failed')
      }
      throw failure
    } finally {
      window[Symbol.dispose]()
    }
  }

  private readinessWindowElapsed(child: MobilecliServerProcess): PhoneDevicesError {
    const tail = tailOf(child.lastStderr)
    return new PhoneDevicesError(
      'PHONE_TIMEOUT',
      `the mobilecli server did not become ready within ${String(this.resolved.readyTimeoutMs)}ms on 127.0.0.1:${String(this.resolved.serverPort)}; stderr tail follows\n${tail}`,
    )
  }

  private onChildExit(child: MobilecliServerProcess, exit: { readonly code: number | null }): void {
    if (child !== this.child || this.closing || !this.ready) return
    this.markLost(new PhoneDevicesError(
      'PHONE_UNAVAILABLE', `the mobilecli server exited unexpectedly (code ${String(exit.code)})`,
    ))
  }

  /**
   * Wait until the spawned server answers its first readiness probe.
   * @param signal - Caller's optional cancellation signal.
   * @throws {@link PhoneDevicesError} per the class-documented failure modes.
   */
  private async whenReady(signal: AbortSignal | undefined): Promise<void> {
    this.startupOutcome ??= this.startup()
    const budget = deadline(signal, this.resolved.requestTimeoutMs, 'READY_WAIT')
    try {
      await Promise.race([
        this.startupOutcome,
        haltedOn(budget.signal),
      ])
    } finally {
      budget[Symbol.dispose]()
    }
  }

  /**
   * Run one JSON-RPC round trip under its fused cancellation and ceiling.
   * @param method - Upstream OpenRPC method name.
   * @param params - Params object exactly as the method documents them.
   * @param signal - Caller's optional cancellation signal.
   * @param ceilingMs - Validated ceiling bounding the round trip.
   * @returns the parsed upstream result value.
   */
  private async roundTrip(method: string, params: unknown, signal: AbortSignal | undefined, ceilingMs: number): Promise<unknown> {
    this.assertUsable()
    return await this.roundTripInGeneration(this.captureIoGeneration(), method, params, signal, ceilingMs)
  }

  /** Run one round trip against immutable references to a single generation. */
  private async roundTripInGeneration(
    generation: IoGeneration,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    ceilingMs: number,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'cancelled before the request was sent')
    }
    const budget = deadline(fuseCallerAndLifetime(signal, generation.lifetime.signal), ceilingMs, method)
    try {
      return await generation.client.call(method, params, budget.signal)
    } catch (error) {
      const normalized = normalizeOperationError(error)
      if (normalized.code === 'PHONE_TIMEOUT') {
        throw new PhoneDevicesError(
          'PHONE_TIMEOUT',
          `${JSON.stringify(method)} exceeded its ${String(ceilingMs)}ms ceiling`,
          { cause: normalized },
        )
      }
      throw normalized
    } finally {
      budget[Symbol.dispose]()
    }
  }

  /**
   * Fetch and publish one fresh grouped device listing. Online Android rows
   * may carry `logicalDisplay` from `dumpsys display` `logicalFrame`.
   * @param signal - Caller's optional cancellation signal.
   * @returns the current grouped listing.
   * @throws {@link PhoneDevicesError} per the class-documented failure modes.
   */
  async listDevices(signal?: AbortSignal): Promise<PhoneDeviceList> {
    this.assertAccepting()
    this.requireResolved()
    await this.whenReady(signal)
    this.assertAccepting()
    this.assertUsable()
    return await this.enqueueDeviceAcquisition(signal)
  }

  /**
   * Boot one iOS simulator or Android emulator, then refresh the listing.
   * @param id - Branded id of the simulator/emulator to boot.
   * @param signal - Caller's optional cancellation signal.
   * @throws {@link PhoneDevicesError} with `PHONE_REAL_DEVICE` for physical handsets,
   *   `PHONE_DEVICE_NOT_FOUND` for ids absent from the latest published listing,
   *   and otherwise per the class-documented failure modes.
   */
  async boot(id: DeviceId, signal?: AbortSignal): Promise<void> {
    this.requireResolved()
    this.requireVirtual(id, 'boot')
    await this.whenReady(signal)
    await this.roundTrip(METHOD_DEVICE_BOOT, { deviceId: id }, signal, this.resolved.bootTimeoutMs)
    this.enqueuePoll({ refreshOnly: true })
  }

  /**
   * Shut down one iOS simulator or Android emulator, then refresh the listing.
   * Physical handsets are refused locally before any upstream call because the
   * upstream spec restricts both lifecycle verbs to simulators/emulators.
   * @param id - Branded id of the simulator/emulator to shut down.
   * @param signal - Caller's optional cancellation signal.
   * @throws {@link PhoneDevicesError} with `PHONE_REAL_DEVICE` for physical handsets,
   *   `PHONE_DEVICE_NOT_FOUND` for ids absent from the latest published listing,
   *   and otherwise per the class-documented failure modes.
   */
  async shutdown(id: DeviceId, signal?: AbortSignal): Promise<void> {
    this.requireResolved()
    this.requireVirtual(id, 'shutdown')
    await this.whenReady(signal)
    await this.roundTrip(METHOD_DEVICE_SHUTDOWN, { deviceId: id }, signal, this.resolved.requestTimeoutMs)
    this.enqueuePoll({ refreshOnly: true })
  }

  /**
   * Execute one semantic tap, swipe, text, or button action. Android coordinate
   * actions retain their pixels. iOS obtains cached portrait `device.info`
   * bounds and projects every displayed endpoint through exact rotation;
   * browser actions bind current capture identity and model actions use a
   * bounded fresh MJPEG EXIF probe. Physical handsets are valid targets; only
   * ids absent from the latest published listing fail locally before any RPC.
   * @param request - Branded device id plus capture-pixel or non-coordinate input.
   * @param signal - Caller's optional cancellation signal.
   * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
   *   absent from the latest published listing, `PHONE_PROTOCOL` when an iOS
   *   `device.info` answer lacks a valid positive screen size, and otherwise
   *   per the class-documented failure modes.
   */
  async io(request: PhoneIoRequest, signal?: AbortSignal): Promise<void> {
    this.assertAccepting()
    this.requireResolved()
    this.assertUsable()
    await this.whenReady(signal)
    this.assertAccepting()
    this.assertUsable()
    const generation = this.captureIoGeneration()
    const known = this.requireKnown(request.deviceId, 'io')
    const incarnation = generation.deviceIncarnations.get(known.id)
    if (incarnation === undefined) throw new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', `cannot io: ${JSON.stringify(known.id)} has no active incarnation`)
    const coordinate = request.method === 'tap' || request.method === 'swipe'
    const admittedCaptureSource = coordinate && request.source.kind === 'capture' ? request.source : undefined
    const admittedCapture = admittedCaptureSource === undefined
      ? undefined
      : this.requireActiveCaptureSource(generation, known, admittedCaptureSource)
    const rotation = known.platform === 'ios' && coordinate
      ? await this.rotationFor(generation, known, request, signal)
      : undefined
    const screen = known.platform === 'ios' && coordinate
      ? await this.ioScreen(generation, known, incarnation, signal)
      : undefined
    const call = upstreamIo(request, known.platform, rotation, screen)
    if (generation.deviceIncarnations.get(known.id) !== incarnation) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'device incarnation changed before io dispatch')
    }
    if (admittedCapture !== undefined && admittedCaptureSource !== undefined
      && generation.activeCaptures.get(admittedCaptureSource.captureId) !== admittedCapture) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'capture authority changed before io dispatch')
    }
    await this.roundTripInGeneration(
      generation,
      call.method,
      call.params,
      signal,
      this.resolved.requestTimeoutMs,
    )
  }

  private requireActiveCaptureSource(
    generation: IoGeneration,
    known: PhoneDeviceRef,
    source: Extract<PhoneIoRequest, { method: 'tap' | 'swipe' }>['source'] & { readonly kind: 'capture' },
  ): ActiveCaptureObservation {
    const active = generation.activeCaptures.get(source.captureId)
    if (active === undefined || active.deviceId !== known.id || active.format !== source.captureFormat) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'trusted capture evidence is not active for this device and format')
    }
    return active
  }

  private async rotationFor(
    generation: IoGeneration,
    known: PhoneDeviceRef,
    request: Extract<PhoneIoRequest, { method: 'tap' | 'swipe' }>,
    signal?: AbortSignal,
  ): Promise<PhoneRotation> {
    switch (request.source.kind) {
      case 'capture': {
        const source = request.source
        if (source.captureFormat === 'mjpeg') {
          if (source.captureRotation !== undefined) throw new PhoneDevicesError('PHONE_PROTOCOL', 'MJPEG rotation is runtime-owned')
          const active = generation.activeCaptures.get(source.captureId)
          const observed = generation.rotations.get(source.captureId)
          if (active !== undefined && observed?.revision === active.revision) return observed.rotation
          throw new PhoneDevicesError('PHONE_PROTOCOL', 'the current MJPEG capture has not published exact rotation')
        }
        if (source.captureRotation === undefined) throw new PhoneDevicesError('PHONE_PROTOCOL', 'H264 capture evidence requires exact rotation')
        return source.captureRotation
      }
      case 'fresh-probe':
        break
      default:
        return assertNever(request.source)
    }
    let current = generation.rotationProbes.get(known.id)
    if (current === undefined) {
      const abort = new AbortController()
      const raw = this.probeRotation(generation, known, abort.signal)
      const published = {} as RotationProbe
      const promise = raw.then(
        (rotation) => {
          if (generation.rotationProbes.get(known.id) === published) generation.rotationProbes.delete(known.id)
          return rotation
        },
        (error: unknown) => {
          if (generation.rotationProbes.get(known.id) === published) generation.rotationProbes.delete(known.id)
          throw error
        },
      )
      const settled = promise.then(() => {}, () => {})
      Object.assign(published, { abort, promise, settled })
      current = published
      generation.rotationProbes.set(known.id, current)
    }
    return await awaitProbeForCaller(current.promise, signal)
  }

  private async probeRotation(
    generation: IoGeneration,
    known: PhoneDeviceRef,
    probeSignal: AbortSignal,
  ): Promise<PhoneRotation> {
    const window = deadline(
      AbortSignal.any([generation.lifetime.signal, probeSignal]),
      this.resolved.requestTimeoutMs,
      'IOS_ROTATION_PROBE',
    )
    const incarnation = generation.deviceIncarnations.get(known.id)
    if (incarnation === undefined) throw new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', `cannot probe rotation: ${JSON.stringify(known.id)} has no active incarnation`)
    let capture: PhoneCaptureStream
    try {
      capture = await generation.client.stream(
        METHOD_DEVICE_SCREENCAPTURE,
        { deviceId: known.id, format: 'mjpeg' },
        window.signal,
      )
      const rotation = await probeMjpegExifRotation(
        capture.body,
        window.signal,
        IOS_ROTATION_PROBE_MAX_BYTES,
        this.resolved.captureCleanupTimeoutMs,
        (error) => {
          this.ctx.logger.warn('phone-runtime: abandoned rotation probe cleanup failed')
          this.ctx.logger.warn(error)
        },
      )
      if (generation.identity !== this.generationIdentity
        || generation.deviceIncarnations.get(known.id) !== incarnation) {
        throw new PhoneDevicesError('PHONE_ABORTED', 'stale iOS rotation probe was discarded')
      }
      return rotation
    } catch (error) {
      throw normalizeOperationError(error)
    } finally {
      window[Symbol.dispose]()
    }
  }

  /** Resolve and cache the iOS portrait event bounds. */
  private async ioScreen(
    generation: IoGeneration,
    known: PhoneDeviceRef,
    incarnation: object,
    signal?: AbortSignal,
  ): Promise<IosScreenSize> {
    const cached = generation.iosScreenSizes.get(known.id)
    if (cached?.incarnation === incarnation) return cached.screen
    const result = await this.roundTripInGeneration(
      generation,
      METHOD_DEVICE_INFO,
      { deviceId: known.id },
      signal,
      this.resolved.requestTimeoutMs,
    )
    const screen = iosScreenSize(result)
    if (generation.deviceIncarnations.get(known.id) !== incarnation) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'device incarnation changed during screen observation')
    }
    generation.iosScreenSizes.set(known.id, { incarnation, screen })
    return screen
  }

  /** Capture the process, cancellation, and coordinate cache of the current generation. */
  private captureIoGeneration(): IoGeneration {
    // Callers enter only after resolution/readiness; teardown aborts the
    // captured lifetime before clearing the active client.
    return {
      identity: this.generationIdentity,
      client: this.rpcClient as MobilecliRpc,
      lifetime: this.lifetime,
      iosScreenSizes: this.iosScreenSizes,
      rotations: this.rotations,
      activeCaptures: this.activeCaptures,
      rotationProbes: this.rotationProbes,
      deviceIncarnations: this.deviceIncarnations,
      childEnvironment: this.childEnvironment,
    }
  }

  /**
   * Open one `device.screencapture` stream. `h264` maps onto upstream `avc`;
   * Android pre-reads and replays at most one bounded key-access-unit probe,
   * then replaces an invalid, failed, timed-out, or landscape-logical-display
   * source with the system `screenrecord` H264 stream (`--size` from
   * `dumpsys display` `logicalFrame` when known). Other bodies remain unread.
   * A generation or incarnation change after headers joins foreign body
   * cancellation for at most `captureCleanupTimeoutMs`.
   * @param request - Branded device id, encoding, and optional cancellation.
   * @returns the live capture content type and body; the caller owns cancellation.
   * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
   *   absent from the latest published listing, and otherwise per the
   *   class-documented failure modes.
   */
  async startCapture(request: PhoneCaptureRequest): Promise<PhoneCaptureStream> {
    this.assertAccepting()
    this.requireResolved()
    this.assertUsable()
    await this.whenReady(request.signal)
    this.assertAccepting()
    this.assertUsable()
    const known = this.requireKnown(request.deviceId, 'capture')
    const incarnation = this.deviceIncarnations.get(known.id)
    if (incarnation === undefined) throw new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', `cannot capture: ${JSON.stringify(known.id)} has no active incarnation`)
    const generation = this.captureIoGeneration()
    if (request.signal?.aborted === true) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'cancelled before the request was sent')
    }
    const fused = fuseCallerAndLifetime(request.signal, generation.lifetime.signal)
    const budget = deadline(fused, this.resolved.requestTimeoutMs, METHOD_DEVICE_SCREENCAPTURE)
    let capture: PhoneCaptureStream
    try {
      capture = await generation.client.stream(
        METHOD_DEVICE_SCREENCAPTURE,
        {
          deviceId: request.deviceId,
          format: request.format === 'h264' ? 'avc' : 'mjpeg',
        },
        budget.signal,
      )
    } catch (error) {
      const normalized = normalizeOperationError(error)
      if (normalized.code !== 'PHONE_TIMEOUT') throw normalized
      throw new PhoneDevicesError(
        'PHONE_TIMEOUT',
        `${JSON.stringify(METHOD_DEVICE_SCREENCAPTURE)} exceeded its ${String(this.resolved.requestTimeoutMs)}ms ceiling`,
        { cause: normalized },
      )
    } finally {
      budget[Symbol.dispose]()
    }
    if (request.format === 'h264' && known.platform === 'android') {
      capture = await this.preferAndroidH264(capture, known, generation, fused)
    }
    const staleGeneration = generation.lifetime.signal.aborted || this.generationIdentity !== generation.identity
    const staleIncarnation = this.deviceIncarnations.get(known.id) !== incarnation
    if (staleGeneration || staleIncarnation) {
      const stale = new PhoneDevicesError('PHONE_ABORTED', 'capture generation changed before publication')
      await joinForeignCleanup(
        Promise.resolve().then(() => capture.body.cancel(stale)),
        this.resolved.captureCleanupTimeoutMs,
        (error) => { this.ctx.logger.warn(error) },
      )
      throw stale
    }
    if (request.captureId === undefined) return Object.freeze({ contentType: capture.contentType, body: capture.body })
    const revision = Object.freeze({})
    generation.activeCaptures.set(request.captureId, { deviceId: known.id, format: request.format, revision })
    if (request.format === 'mjpeg' && known.platform === 'ios') {
      return Object.freeze({
        contentType: capture.contentType,
        body: this.observeIosMjpeg(capture.body, known.id, incarnation, request.captureId, revision),
      })
    }
    return Object.freeze({
      contentType: capture.contentType,
      body: this.observeCaptureLifetime(capture.body, generation.activeCaptures, request.captureId, revision),
    })
  }

  /** Pass every MJPEG byte through while observing each complete frame's EXIF rotation. */
  private observeIosMjpeg(
    body: ReadableStream<Uint8Array>,
    deviceId: DeviceId,
    incarnation: object,
    captureId: PhoneCaptureId,
    revision: object,
  ): ReadableStream<Uint8Array> {
    const generation = this.captureIoGeneration()
    const key = captureId
    const identity = generation.identity
    const reader = body.getReader()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (generation.rotations.get(key)?.revision === revision) generation.rotations.delete(key)
      if (generation.activeCaptures.get(key)?.revision === revision) generation.activeCaptures.delete(key)
    }
    const observer = new JpegFrameOrientationObserver((rotation) => {
      if (this.generationIdentity !== identity
        || generation.deviceIncarnations.get(deviceId) !== incarnation || released) return
      if (generation.activeCaptures.get(key)?.revision !== revision) return
      if (rotation === undefined) {
        if (generation.rotations.get(key)?.revision === revision) generation.rotations.delete(key)
      } else {
        generation.rotations.set(key, { rotation, revision })
      }
    }, IOS_ROTATION_PROBE_MAX_BYTES)
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const read = await reader.read()
          if (read.done) {
            release()
            controller.close()
            return
          }
          observer.push(read.value)
          controller.enqueue(read.value)
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        release()
        await reader.cancel(reason)
      },
    }, { highWaterMark: 0 })
  }

  /**
   * Capture one PNG still of a listed device through `mobilecli screenshot`.
   * Live MJPEG/H264 capture stays on `startCapture`.
   * @param id - Branded Android serial or iOS UDID whose screen to capture.
   * @param signal - Caller's optional cancellation signal.
   * @returns PNG media type and the absolute owner-only file path.
   * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
   *   absent from the latest published listing, and otherwise per the
   *   class-documented failure modes.
   */
  async screenshot(id: DeviceId, signal?: AbortSignal): Promise<PhoneScreenshot> {
    this.assertAccepting()
    this.requireResolved()
    await this.whenReady(signal)
    this.assertUsable()
    this.requireKnown(id, 'screenshot')
    const png = await runMobilecliScreenshot({
      executablePath: this.executable,
      deviceId: id,
      signal,
      timeoutMs: this.resolved.requestTimeoutMs,
      environment: this.childEnvironment,
    })
    const path = await persistPhoneScreenshot(id, png)
    return Object.freeze({ mediaType: 'image/png' as const, path })
  }

  private observeCaptureLifetime(
    body: ReadableStream<Uint8Array>,
    activeCaptures: Map<PhoneCaptureId, ActiveCaptureObservation>,
    captureId: PhoneCaptureId,
    revision: object,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader()
    const release = (): void => {
      if (activeCaptures.get(captureId)?.revision === revision) activeCaptures.delete(captureId)
    }
    return new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { release(); controller.close() } else controller.enqueue(next.value)
        } catch (error) { release(); controller.error(error) }
      },
      async cancel(reason) { release(); await reader.cancel(reason) },
    }, { highWaterMark: 0 })
  }

  /** Keep mobilecli AVC when valid, otherwise try Android system H264 before the renderer sees failure bytes. */
  private async preferAndroidH264(
    capture: PhoneCaptureStream,
    known: PhoneDeviceRef,
    generation: IoGeneration,
    signal: AbortSignal,
  ): Promise<PhoneCaptureStream> {
    const id = known.id
    let mobilecli: Awaited<ReturnType<typeof inspectAnnexBH264KeyAccessUnit>>
    try {
      mobilecli = await this.inspectAndroidH264(capture.body, signal)
    } catch (error) {
      if (signal.aborted) throw normalizeOperationError(signal.reason)
      mobilecli = Object.freeze({
        recognizable: false,
        body: failedCaptureBody(error),
        failure: errorValue(error),
      })
    }
    const size = this.readAndroidLogicalDisplay({
      deviceId: id,
      environment: generation.childEnvironment,
    }) ?? known.logicalDisplay
    const landscape = size !== undefined && size.width > size.height
    if (mobilecli.recognizable && !landscape) {
      return Object.freeze({ contentType: capture.contentType, body: mobilecli.body })
    }
    if (signal.aborted) {
      await mobilecli.body.cancel().catch(() => {})
      throw normalizeOperationError(signal.reason)
    }
    let nativeBody: ReadableStream<Uint8Array> | undefined
    try {
      nativeBody = this.openNativeAndroidH264({
        deviceId: id,
        environment: generation.childEnvironment,
        signal,
        ...(size === undefined ? {} : { size }),
      })
      const native = await this.inspectAndroidH264(nativeBody, signal)
      if (!native.recognizable) {
        await native.body.cancel().catch(() => {})
        throw native.failure ?? new Error('Android system H264 stream was not recognizable')
      }
      await mobilecli.body.cancel().catch(() => {})
      return Object.freeze({ contentType: 'video/h264', body: native.body })
    } catch (nativeFailure) {
      await nativeBody?.cancel().catch(() => {})
      if (isSignalAborted(signal)) {
        await mobilecli.body.cancel().catch(() => {})
        throw normalizeOperationError(signal.reason)
      }
      this.ctx.logger.warn(
        `[phone-runtime] Android H264 sources failed for ${JSON.stringify(id)}; renderer fallback remains available: ${failureText(mobilecli.failure)}; ${failureText(nativeFailure)}`,
      )
      return Object.freeze({ contentType: capture.contentType, body: mobilecli.body })
    }
  }

  /** Bound syntax recognition independently from the JSON-RPC header deadline. */
  private async inspectAndroidH264(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof inspectAnnexBH264KeyAccessUnit>>> {
    const budget = deadline(signal, this.resolved.h264ProbeTimeoutMs, 'Android H264 key access unit')
    try {
      return await inspectAnnexBH264KeyAccessUnit(body, {
        signal: budget.signal,
        maxBytes: ANDROID_H264_PROBE_MAX_BYTES,
      })
    } finally {
      budget[Symbol.dispose]()
    }
  }

  /**
   * Report the on-device agent installation state for one listed device by
   * running the upstream `agent status` command as a one-shot child of the
   * same executable the loopback server was spawned from. Answers about a
   * re-signed real handset carry the free-signing expiry reminder.
   * @param id - Branded id of the device to inspect.
   * @param signal - Caller's optional cancellation signal.
   * @returns the parsed installation state.
   * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
   *   absent from the latest published listing, `PHONE_REAL_DEVICE_ISSUE` when
   *   the command output names a structured real-device arm, and otherwise per
   *   the class-documented failure modes.
   */
  async agentStatus(id: DeviceId, signal?: AbortSignal): Promise<PhoneAgentStatus> {
    this.assertAccepting()
    this.requireResolved()
    await this.whenReady(signal)
    this.assertUsable()
    this.requireKnown(id, 'agent status')
    const answer = await runMobilecliAgent({
      executablePath: this.executable,
      args: ['agent', 'status', '--device', id],
      signal,
      timeoutMs: this.resolved.agentTimeoutMs,
      environment: this.childEnvironment,
    })
    return this.agentAnswer(id, answer)
  }

  /**
   * Keep the on-device agent installed for one listed device. Without `force`
   * the upstream `agent status` command runs first and an already-installed
   * agent answers without any install spawn, so repeated calls are idempotent;
   * `force` reinstalls and re-signs through the configured provisioning
   * profile, which real iOS installs require upstream.
   * @param id - Branded id of the device to install on.
   * @param options - Force reinstall switch and optional cancellation.
   * @returns the resulting installation state; `reinstalled` is true only when
   *   this call spawned an install.
   * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
   *   absent from the latest published listing, `PHONE_AGENT_PROFILE_REQUIRED`
   *   when a real-iOS install lacks `provisioningProfilePath`,
   *   `PHONE_REAL_DEVICE_ISSUE` when the command output names a structured
   *   real-device arm, and otherwise per the class-documented failure modes.
   */
  async installAgent(id: DeviceId, options: PhoneAgentInstallOptions = {}): Promise<PhoneAgentInstallResult> {
    this.assertAccepting()
    this.requireResolved()
    await this.whenReady(options.signal)
    this.assertUsable()
    const known = this.requireKnown(id, 'agent install')
    const reinstall = options.force === true
    if (!reinstall) {
      const current = await this.agentStatus(id, options.signal)
      if (current.installed) return Object.freeze({ ...current, reinstalled: false })
    }
    const iosReal = known.platform === 'ios' && known.kind === 'real'
    const profile = iosReal ? this.resolved.provisioningProfilePath : undefined
    if (iosReal && profile === undefined) {
      throw new PhoneDevicesError(
        'PHONE_AGENT_PROFILE_REQUIRED',
        'configure provisioningProfilePath before installing the iOS real-device control agent',
      )
    }
    const answer = await runMobilecliAgent({
      executablePath: this.executable,
      args: [
        'agent', 'install', '--device', id,
        ...(options.force === true ? ['--force'] : []),
        ...(profile !== undefined ? ['--provisioning-profile', profile] : []),
      ],
      signal: options.signal,
      timeoutMs: this.resolved.agentTimeoutMs,
      environment: this.childEnvironment,
    })
    if (!answer.ok) {
      throw new PhoneDevicesError('PHONE_UPSTREAM', `mobilecli agent install answered ${JSON.stringify(answer.message)}`)
    }
    return Object.freeze({ ...this.agentAnswer(id, answer), installed: true, reinstalled: reinstall })
  }

  /**
   * Map one parsed upstream agent answer onto the public status vocabulary,
   * attaching the free-signing reminder to answers about an installed,
   * re-signed real handset.
   * @param id - Branded id the answer is about.
   * @param answer - Parsed upstream answer.
   * @returns the frozen public status.
   */
  private agentAnswer(id: DeviceId, answer: MobilecliAgentAnswer): PhoneAgentStatus {
    const known = this.findKnown(id)
    const reminder = answer.ok && known?.platform === 'ios' && known.kind === 'real' && this.resolved.provisioningProfilePath !== undefined
      ? FREE_SIGNING_PROFILE_REMINDER
      : undefined
    return Object.freeze({
      deviceId: id,
      installed: answer.ok,
      ...(answer.agent !== undefined ? { version: answer.agent.version, bundleId: answer.agent.bundleId } : {}),
      ...(reminder !== undefined ? { profileReminder: reminder } : {}),
    })
  }

  private requireVirtual(id: DeviceId, operation: 'boot' | 'shutdown'): void {
    this.assertAccepting()
    const known = this.findKnown(id)
    if (known === undefined) {
      throw new PhoneDevicesError(
        'PHONE_DEVICE_NOT_FOUND',
        `cannot ${operation}: ${JSON.stringify(id)} is absent from the latest device listing (online or offline)`,
      )
    }
    if (known.kind === 'real') {
      throw new PhoneDevicesError(
        'PHONE_REAL_DEVICE',
        `cannot ${operation} ${JSON.stringify(id)}: physical handsets support neither operation; address a simulator or emulator`,
      )
    }
  }

  private requireKnown(id: DeviceId, operation: 'io' | 'capture' | 'agent status' | 'agent install' | 'screenshot'): PhoneDeviceRef {
    this.assertAccepting()
    const known = this.findKnown(id)
    if (known === undefined) {
      throw new PhoneDevicesError(
        'PHONE_DEVICE_NOT_FOUND',
        `cannot ${operation}: ${JSON.stringify(id)} is absent from the latest device listing (online or offline)`,
      )
    }
    return known
  }

  private findKnown(id: DeviceId): PhoneDeviceRef | undefined {
    if (this.publishedList === undefined) return undefined
    for (const ref of allRefsOf(this.publishedList)) {
      if (ref.id === id) return ref
    }
    return undefined
  }

  /**
   * Subscribe to committed device-set changes. Delivery happens synchronously
   * after each committing poll; a throwing subscriber is contained and logged.
   * @param sub - Observer receiving every committed {@link PhoneDeviceChange}.
   * @returns disposer removing exactly this subscription; subscriptions never outlive the Service.
   */
  onChanged(sub: (change: PhoneDeviceChange) => void): () => void {
    this.subscribers.add(sub)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.subscribers.delete(sub)
    }
  }

  /**
   * Append publication work to the serialized poll queue so listings stay
   * monotonic no matter who triggers them. Queue steps catch their own
   * bounded failures and never reject the shared tail.
   * @param options - Refresh-only attempts skip the automatic interval rearm.
   */
  private enqueuePoll(options: { readonly refreshOnly: boolean }): void {
    this.queueTail = this.queueTail.then(async () => {
      if (this.closing || this.disposed || this.lost !== undefined) return
      await this.pollAttempt()
      if (!options.refreshOnly) this.armPoll()
    })
  }

  private armPoll(): void {
    if (this.closing || this.disposed || this.lost !== undefined) return
    this.clearPollTimer()
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.enqueuePoll({ refreshOnly: false })
    }, this.resolved.pollIntervalMs)
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /**
   * Run one bounded devices.list attempt and publish it. Background misses stay
   * contained; the required startup attempt rejects every failure.
   * @param required - Whether this attempt must establish the startup baseline.
   * @param signal - Optional startup cancellation and readiness budget.
   */
  private async enqueueDeviceAcquisition(signal?: AbortSignal): Promise<PhoneDeviceList> {
    this.assertAccepting()
    const generation = this.captureIoGeneration()
    if (!this.ready || generation.lifetime.signal.aborted) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'device listing generation retired before admission')
    }
    const admissionIdentity = generation.identity
    const admitted = this.queueTail.then(async () => {
      this.assertAccepting()
      if (generation.lifetime.signal.aborted || this.generationIdentity !== admissionIdentity) throw new PhoneDevicesError('PHONE_ABORTED', 'device listing generation changed before admission')
      if (signal?.aborted === true) throw new PhoneDevicesError('PHONE_ABORTED', 'device listing acquisition was cancelled before admission')
      return await this.acquireAndPublishDevicesNow(generation, signal)
    })
    this.queueTail = admitted.then(() => {}, () => {})
    if (signal === undefined) return await admitted
    const abortRace = normalizedAbortWaiter(signal, 'device listing acquisition was cancelled while queued')
    try { return await Promise.race([admitted, abortRace.promise]) } finally { abortRace.dispose() }
  }

  private async acquireAndPublishDevicesNow(generation: IoGeneration, signal?: AbortSignal): Promise<PhoneDeviceList> {
    const result = await this.roundTripInGeneration(
      generation,
      METHOD_DEVICES_LIST,
      { includeOffline: true },
      signal,
      this.resolved.requestTimeoutMs,
    )
    if (generation.lifetime.signal.aborted || this.generationIdentity !== generation.identity) {
      throw new PhoneDevicesError('PHONE_ABORTED', 'device listing generation changed before publication')
    }
    const next = this.withAndroidLogicalDisplays(groupEntries(parseDeviceInfos(result)), generation.childEnvironment)
    const delta = changeSets(this.publishedList, next)
    if (delta.changed) {
      const published = this.publish(Object.freeze({
        list: next,
        added: Object.freeze(delta.added),
        removed: Object.freeze(delta.removed),
      }))
      if (!published) throw this.lost ?? new PhoneDevicesError('PHONE_PROTOCOL', 'the mobilecli device listing was rejected')
    }
    return this.publishedList ?? next
  }

  private async pollAttempt(required = false, signal?: AbortSignal): Promise<void> {
    let next: PhoneDeviceList
    try {
      next = await this.acquireAndPublishDevicesNow(this.captureIoGeneration(), signal)
    } catch (error) {
      const normalized = normalizeOperationError(error)
      if (required) throw normalized
      if (normalized.code === 'PHONE_UNAVAILABLE' || normalized.code === 'PHONE_PROTOCOL') {
        this.markLost(normalized)
        return
      }
      // Bounded misses (a busy server, a slow Android bridge) are retried by
      // the next poll; state stays at the last committed listing meanwhile.
      this.ctx.logger.warn(`phone-runtime: device poll missed (${normalized.code}); keeping the last listing`)
      return
    }
    void next
  }

  private publish(change: PhoneDeviceChange): boolean {
    const validator = phoneRuntimeStateValidator(this[PHONE_RUNTIME_STATE_OWNER])
    if (validator !== undefined && !this.guarded(validator, change)) return false
    const previous = this.publishedList
    this.publishedList = change.list
    const stale = new Set<DeviceId>(change.removed)
    const nextIncarnations = new Map<DeviceId, object>()
    for (const next of allRefsOf(change.list)) {
      const prior = previous === undefined ? undefined : allRefsOf(previous).find(candidate => candidate.id === next.id)
      const priorToken = this.deviceIncarnations.get(next.id)
      if (prior !== undefined && priorToken !== undefined && sameDeviceIncarnation(prior, next)) nextIncarnations.set(next.id, priorToken)
      else {
        nextIncarnations.set(next.id, Object.freeze({}))
        if (prior !== undefined) stale.add(next.id)
      }
    }
    this.deviceIncarnations.clear()
    for (const [id, token] of nextIncarnations) this.deviceIncarnations.set(id, token)
    for (const id of stale) {
      this.iosScreenSizes.delete(id)
      const probe = this.rotationProbes.get(id)
      probe?.abort.abort(new PhoneDevicesError('PHONE_ABORTED', 'the iOS rotation probe device incarnation changed'))
      this.rotationProbes.delete(id)
      for (const [captureId, active] of this.activeCaptures) {
        if (active.deviceId !== id) continue
        this.activeCaptures.delete(captureId)
        this.rotations.delete(captureId)
      }
    }
    for (const sub of [...this.subscribers]) {
      try {
        sub(change)
      } catch (error) {
        this.ctx.logger.warn('phone-runtime: a devices-changed observer failed')
        this.ctx.logger.warn(error)
      }
    }
    return true
  }

  /**
   * Run the pre-publication validator; a malformed candidate halts polling
   * loudly instead of ever reaching subscribers.
   * @param validator - Installed runtime-invariant validator.
   * @param change - Candidate awaiting publication.
   * @returns whether the candidate may be published.
   */
  private guarded(validator: (candidate: PhoneDeviceChange) => undefined, change: PhoneDeviceChange): boolean {
    try {
      validator(change)
      return true
    } catch (error) {
      this.markLost(new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `device publication failed its runtime-invariant check and polling halted\n${String(error)}`,
        { cause: error },
      ))
      return false
    }
  }

  private markLost(reason: PhoneDevicesError): void {
    if (this.lost !== undefined) return
    this.lost = reason
    this.ready = false
    this.publishReadiness(false)
    this.clearPollTimer()
    this.clearPublishedList()
    this.ctx.logger.error(reason.message)
    void this.child?.stop().catch((error: unknown) => {
      this.ctx.logger.warn('phone-runtime: failed to stop the lost mobilecli child')
      this.ctx.logger.warn(error)
    })
  }

  /**
   * Drain the publication queue, silence subscribers before killing the child,
   * and reach child-exit quiescence before returning.
   */
  private teardown(): Promise<void> {
    if (this.teardownPromise !== undefined) return this.teardownPromise
    let resolveTeardown!: () => void
    let rejectTeardown!: (error: unknown) => void
    this.teardownPromise = new Promise<void>((resolve, reject) => { resolveTeardown = resolve; rejectTeardown = reject })
    this.closing = true
    this.subscribers.clear()
    this.readinessSubscribers.clear()
    this.disposed = true
    const operation = this.activationTail.then(() => this.stopRuntime(
      new PhoneDevicesError('PHONE_DISPOSED', 'the phone runtime service is disposed'),
    ))
    this.activationTail = operation.catch(() => {})
    void operation.then(resolveTeardown, rejectTeardown)
    return this.teardownPromise
  }

  private publishReadiness(next: boolean): void {
    if (next === this.publishedReadiness) return
    this.publishedReadiness = next
    for (const listener of [...this.readinessSubscribers]) {
      try {
        listener(next)
      } catch (error) {
        this.ctx.logger.warn('phone-runtime: a readiness observer failed')
        this.ctx.logger.warn(error)
      }
    }
  }

  /** Abort, drain, and stop exactly the current child generation. */
  private async stopRuntime(reason: PhoneDevicesError): Promise<void> {
    this.clearPollTimer()
    this.lifetime.abort(reason)
    this.ready = false
    this.publishReadiness(false)
    this.iosScreenSizes.clear()
    this.rotations.clear()
    this.activeCaptures.clear()
    this.deviceIncarnations.clear()
    const activeProbes = [...this.rotationProbes.values()]
    for (const probe of activeProbes) probe.abort.abort(reason)
    const probes = activeProbes.map(probe => probe.settled)
    this.rotationProbes.clear()
    await this.startupOutcome?.catch(() => {})
    await this.queueTail
    const child = this.child
    const childStop = child?.stop() ?? Promise.resolve()
    await Promise.all([Promise.all(probes), childStop])
    this.clearPublishedList()
    if (child !== this.child) return
    this.child = undefined
    this.rpcClient = undefined
    this.startupOutcome = undefined
  }

  private clearPublishedList(): void {
    if (this.publishedList === undefined || allRefsOf(this.publishedList).length === 0) return
    const empty = emptyDeviceList()
    const delta = changeSets(this.publishedList, empty)
    this.publish(Object.freeze({
      list: empty,
      added: Object.freeze(delta.added),
      removed: Object.freeze(delta.removed),
    }))
  }

  /**
   * Attach current `dumpsys display` logicalFrame pixels to online Android
   * rows. Misses leave the field absent; never `device.info.screenSize`.
   */
  private withAndroidLogicalDisplays(
    list: PhoneDeviceList,
    environment: Readonly<Record<string, string>> = this.childEnvironment,
  ): PhoneDeviceList {
    const android = list.android.map((device) => {
      if (!device.online) return device
      const logicalDisplay = this.readAndroidLogicalDisplay({
        deviceId: device.id,
        environment,
      })
      if (logicalDisplay === undefined) return device
      return Object.freeze({ ...device, logicalDisplay })
    })
    return Object.freeze({
      android: Object.freeze(android),
      ios: list.ios,
    })
  }
}

function exitedBeforeReady(child: MobilecliServerProcess, exit: { readonly code: number | null }): PhoneDevicesError {
  const tail = tailOf(child.lastStderr)
  return new PhoneDevicesError(
    'PHONE_UNAVAILABLE',
    `the mobilecli server exited before becoming ready (code ${String(exit.code)}); stderr tail follows\n${tail}`,
  )
}

function assertNever(value: never): never {
  throw new PhoneDevicesError('PHONE_PROTOCOL', `unsupported coordinate source ${JSON.stringify(value)}`)
}

function sameDeviceIncarnation(left: PhoneDeviceRef, right: PhoneDeviceRef): boolean {
  return left.id === right.id && left.platform === right.platform && left.kind === right.kind
    && left.state === right.state
}

function allRefsOf(list: PhoneDeviceList): readonly PhoneDeviceRef[] {
  return [...list.android, ...list.ios.simulators, ...list.ios.reals]
}

function emptyDeviceList(): PhoneDeviceList {
  return Object.freeze({
    android: Object.freeze([]),
    ios: Object.freeze({ simulators: Object.freeze([]), reals: Object.freeze([]) }),
  })
}

function tailOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed.slice(-2000) : '(empty)'
}

function normalizedAbortWaiter(signal: AbortSignal, message: string): { readonly promise: Promise<never>; dispose(): void } {
  let rejectAbort!: (reason: PhoneDevicesError) => void
  const abort = (): void => { rejectAbort(new PhoneDevicesError('PHONE_ABORTED', message, { cause: signal.reason })) }
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  return { promise, dispose() { signal.removeEventListener('abort', abort) } }
}

async function awaitProbeForCaller(probe: Promise<PhoneRotation>, signal: AbortSignal | undefined): Promise<PhoneRotation> {
  if (signal === undefined) return await probe
  const abortRace = rejectWhenAborted(signal)
  try {
    return await Promise.race([probe, abortRace.promise])
  } finally {
    abortRace.dispose()
  }
}

function fuseCallerAndLifetime(caller: AbortSignal | undefined, lifetime: AbortSignal): AbortSignal {
  // The lifetime signal is always present, so the fused signal always exists.
  return caller === undefined ? lifetime : AbortSignal.any([caller, lifetime])
}

/**
 * Bound the local wait for one foreign cleanup while observing its settlement forever.
 * Prompt rejection is the operation failure; a rejection after abandonment is reported once.
 * @param cleanup - Foreign cancel/settlement promise; throw and thenable forms are admitted.
 * @param timeoutMs - Maximum local wait before abandonment.
 * @param reportLate - Exact-once sink for rejection after the wait is abandoned.
 */
async function joinForeignCleanup(
  cleanup: Promise<unknown>,
  timeoutMs: number,
  reportLate: (error: unknown) => void,
): Promise<void> {
  let abandoned = false
  let reported = false
  const observed = Promise.resolve(cleanup).then(
    () => undefined,
    (error: unknown) => {
      if (!abandoned) throw error
      if (reported) return
      reported = true
      try {
        reportLate(error)
      } catch {
        /* Only the injected diagnostic can fail; settlement remains authoritative. */
      }
    },
  )
  let expire!: () => void
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => { abandoned = true; resolve() }, timeoutMs)
    expire = () => { clearTimeout(timer); resolve() }
  })
  try {
    await Promise.race([observed, timeout])
  } finally {
    expire()
  }
}

/**
 * Reject when the fused signal aborts, translating the winner's reason onto
 * the public vocabulary.
 * @param signal - Budget signal whose abort ends the wait.
 */
function haltedOn(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(haltReason(signal))
  return new Promise((_, rejectHalt) => {
    signal.addEventListener('abort', () => {
      rejectHalt(haltReason(signal))
    }, { once: true })
  })
}

function haltReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof TimeoutReason) return normalizeOperationError(reason)
  return new PhoneDevicesError('PHONE_ABORTED', 'cancelled while waiting for the phone runtime')
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function readSettledExit<T>(read: () => T): T {
  return read()
}

async function pauseBeforeNextProbe(
  ms: number,
  window: AbortSignal,
  lifetime: AbortSignal,
  caller: AbortSignal | undefined,
  exitSeen: Promise<unknown>,
): Promise<void> {
  if (window.aborted || lifetime.aborted || caller?.aborted === true) return
  const slept = new Promise<'slept'>((resolveSleep) => {
    const timer = setTimeout(() => {
      resolveSleep('slept')
    }, ms)
    timer.unref()
  })
  const abortedOrExited = new Promise<'interrupted'>((resolveInterrupted) => {
    for (const signal of caller === undefined ? [window, lifetime] : [window, lifetime, caller]) {
      signal.addEventListener('abort', () => {
        resolveInterrupted('interrupted')
      }, { once: true })
    }
    void exitSeen.then(() => {
      resolveInterrupted('interrupted')
    })
  })
  await Promise.race([slept, abortedOrExited])
}

export default PhoneDevices
