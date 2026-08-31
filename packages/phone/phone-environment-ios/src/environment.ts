import { homedir } from 'node:os'
import { deviceId, type DeviceId } from '@deepseek-ai/dsh-phone-runtime'
import type {
  IosDeviceType, IosInstallationProbe, IosPreparationPlan, IosRuntime, IosSimulator, PhoneIosState,
} from './types.ts'
import { IOS_SIMULATOR_NAME, planIosEnvironment } from './planner.ts'
import { nodeIosCommandRunner, type IosCommandResult, type IosCommandRunner } from './process.ts'

const COMMAND_TIMEOUT_MS = 15 * 60_000
const BOOT_TIMEOUT_MS = 5 * 60_000

/** Stable iOS preparation failure consumed by the Host snapshot. */
export class IosEnvironmentError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IosEnvironmentError'
  }
}

/** Injectable platform and process edges; production uses the current Host. */
export interface IosEnvironmentOptions {
  readonly platform?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly runner?: IosCommandRunner
  readonly reportError?: (error: unknown) => void
}

/** Xcode and default-Simulator lifecycle owner behind the iOS platform Provider. */
export class IosEnvironmentManager {
  private readonly platform: string
  private readonly ambient: NodeJS.ProcessEnv
  private readonly homeDirectory: string
  private readonly runner: IosCommandRunner
  private readonly reportError: (error: unknown) => void
  private current: PhoneIosState
  private readonly listeners = new Set<(state: PhoneIosState) => void>()
  private operation: { readonly controller: AbortController; readonly task: Promise<PhoneIosState> } | undefined
  private ownedDeviceId: DeviceId | undefined
  private lastActionable: PhoneIosState

  constructor(options: IosEnvironmentOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.ambient = options.environment ?? process.env
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.runner = options.runner ?? nodeIosCommandRunner
    this.reportError = options.reportError ?? (() => {})
    this.current = Object.freeze(planIosEnvironment(this.platform))
    this.lastActionable = this.current
  }

  /** @returns the latest committed iOS environment state. */
  snapshot(): PhoneIosState {
    return this.current
  }

  /**
   * Subscribe to committed state replacements.
   * @param listener - callback receiving each replacement.
   * @returns the disposer for this subscription.
   */
  onChanged(listener: (state: PhoneIosState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Detect Xcode, authorization prerequisites, runtimes, and Simulator inventory.
   * @param signal - optional owner cancellation.
   * @returns the committed detection state.
   */
  refresh(signal?: AbortSignal): Promise<PhoneIosState> {
    return this.startOperation(async operationSignal => await this.detect(operationSignal), signal)
  }

  /**
   * Download the iOS runtime when needed and create the product Simulator.
   * @param signal - optional owner cancellation.
   * @returns the committed prepared state without starting a stopped Simulator.
   */
  prepare(signal?: AbortSignal): Promise<PhoneIosState> {
    if (this.platform !== 'darwin') {
      const state = planIosEnvironment(this.platform)
      return Promise.reject(new IosEnvironmentError(
        'PHONE_IOS_UNSUPPORTED', state.kind === 'unsupported'
          ? state.reason
          : 'iOS preparation requires macOS and Xcode',
      ))
    }
    return this.startOperation(async operationSignal => await this.prepareCurrent(operationSignal), signal)
  }

  /**
   * Boot the prepared product Simulator without installing Apple components.
   * @param signal - optional owner cancellation.
   * @returns the committed running state before Host picture verification.
   */
  start(signal?: AbortSignal): Promise<PhoneIosState> {
    if (this.platform !== 'darwin') {
      return Promise.reject(new IosEnvironmentError(
        'PHONE_IOS_UNSUPPORTED', 'iOS Simulator requires macOS and a complete Xcode installation.',
      ))
    }
    return this.startOperation(async operationSignal => await this.startCurrent(operationSignal), signal)
  }

  /** Abort the current command sequence; the operation publishes no successful terminal state. */
  cancel(): void {
    this.operation?.controller.abort(new IosEnvironmentError('PHONE_IOS_ABORTED', 'iOS environment operation cancelled'))
  }

  /**
   * Cancel active work, join it, and shut down only the Simulator booted by this Provider.
   * @returns completion after child commands and the owned Simulator have settled.
   */
  async deactivate(): Promise<void> {
    const active = this.operation
    active?.controller.abort(new IosEnvironmentError('PHONE_IOS_ABORTED', 'iOS environment operation cancelled'))
    await active?.task.catch(() => {})
    await this.stopOwnedSimulator()
    if (this.current.kind === 'ready') this.publish({ ...this.current, running: false })
  }

  private startOperation(
    work: (signal: AbortSignal) => Promise<PhoneIosState>,
    ownerSignal?: AbortSignal,
  ): Promise<PhoneIosState> {
    if (this.operation !== undefined) {
      return Promise.reject(new IosEnvironmentError('PHONE_IOS_BUSY', 'an iOS environment operation is already running'))
    }
    const controller = new AbortController()
    const signal = ownerSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, ownerSignal])
    const task = work(signal).catch(async (error: unknown) => {
      let failure = signal.aborted
        ? signal.reason instanceof IosEnvironmentError
          ? signal.reason
          : new IosEnvironmentError('PHONE_IOS_ABORTED', 'iOS environment operation cancelled', { cause: error })
        : iosFailure(error)
      try {
        await this.stopOwnedSimulator()
      } catch (cleanupError) {
        failure = iosFailure(cleanupError)
      }
      if (failure.code === 'PHONE_IOS_ABORTED') this.publish(this.lastActionable)
      else {
        const plan = planOf(this.current)
        this.publish(plan === undefined
          ? { kind: 'failed', code: failure.code, message: failure.message, retryable: retryable(failure.code) }
          : { kind: 'failed', plan, code: failure.code, message: failure.message, retryable: retryable(failure.code) })
      }
      throw failure
    }).finally(() => {
      if (this.operation?.controller === controller) this.operation = undefined
    })
    this.operation = { controller, task }
    return task
  }

  private async prepareCurrent(signal: AbortSignal): Promise<PhoneIosState> {
    let state = await this.detect(signal)
    if (state.kind === 'xcode-missing') throw new IosEnvironmentError('PHONE_IOS_XCODE_MISSING', state.message)
    if (state.kind === 'license-required') throw new IosEnvironmentError('PHONE_IOS_LICENSE_REQUIRED', state.message)
    if (state.kind === 'manual-required') throw new IosEnvironmentError(`PHONE_IOS_${state.code.toUpperCase().replace('-', '_')}`, state.message)
    if (state.kind === 'unsupported') throw new IosEnvironmentError('PHONE_IOS_UNSUPPORTED', state.reason)
    if (state.kind === 'failed' || state.kind === 'checking' || state.kind === 'preparing') {
      throw new IosEnvironmentError('PHONE_IOS_STATE', `iOS preparation cannot start from ${state.kind}`)
    }
    if (state.kind === 'runtime-missing') {
      this.publish({ kind: 'preparing', plan: state.plan, step: 'downloading-runtime' })
      await this.requireSuccess(
        'xcodebuild', ['-downloadPlatform', 'iOS'], signal,
        'PHONE_IOS_RUNTIME_DOWNLOAD', 'xcodebuild -downloadPlatform iOS',
      )
      state = await this.detect(signal)
      if (state.kind === 'runtime-missing') {
        throw new IosEnvironmentError('PHONE_IOS_RUNTIME_DOWNLOAD', 'Xcode completed without installing an available iOS Simulator runtime')
      }
    }
    if (state.kind === 'no-simulator') {
      const runtime = requireRuntime(state.plan)
      const deviceType = requireDeviceType(state.plan)
      this.publish({ kind: 'preparing', plan: state.plan, step: 'creating-simulator' })
      const created = await this.requireSuccess(
        'xcrun', ['simctl', 'create', IOS_SIMULATOR_NAME, deviceType.identifier, runtime.identifier], signal,
        'PHONE_IOS_SIMULATOR_CREATE', 'simctl create',
      )
      const createdId = created.stdout.trim()
      if (!deviceIdPattern.test(createdId)) {
        throw new IosEnvironmentError('PHONE_IOS_SIMULATOR_CREATE', 'simctl create returned no Simulator UDID')
      }
      state = { kind: 'ready', plan: state.plan, deviceId: deviceId(createdId), running: false }
      this.publish(state)
    }
    if (state.kind !== 'ready') {
      throw new IosEnvironmentError('PHONE_IOS_STATE', `iOS preparation ended in ${state.kind}`)
    }
    return state
  }

  private async startCurrent(signal: AbortSignal): Promise<PhoneIosState> {
    const state = await this.detect(signal)
    if (state.kind !== 'ready') {
      const message = state.kind === 'unsupported' ? state.reason
        : 'message' in state ? state.message
          : 'Prepare an iOS Simulator runtime and the DSH Gestalt iPhone before starting it.'
      throw new IosEnvironmentError('PHONE_IOS_NOT_PREPARED', message)
    }
    if (state.running) return state
    this.publish({ kind: 'preparing', plan: state.plan, step: 'booting' })
    const boot = await this.runner.run('xcrun', ['simctl', 'boot', state.deviceId], {
      env: this.commandEnvironment(state.plan.developerDir), signal, timeoutMs: COMMAND_TIMEOUT_MS,
    })
    signal.throwIfAborted()
    if (boot.code !== 0 && !/current state:\s*Booted/iu.test(`${boot.stdout}\n${boot.stderr}`)) {
      throw commandFailure('PHONE_IOS_SIMULATOR_BOOT', 'simctl boot', boot)
    }
    this.ownedDeviceId = state.deviceId
    await this.requireSuccess(
      'xcrun', ['simctl', 'bootstatus', state.deviceId, '-b'], signal,
      'PHONE_IOS_SIMULATOR_BOOT', 'simctl bootstatus', BOOT_TIMEOUT_MS,
      state.plan.developerDir,
    )
    this.publish({ ...state, running: true })
    return this.current
  }

  private async detect(signal: AbortSignal): Promise<PhoneIosState> {
    if (this.platform !== 'darwin') {
      const unsupported = planIosEnvironment(this.platform)
      this.publish(unsupported)
      return this.current
    }
    this.publish({ kind: 'checking' })
    const selected = await this.runner.run('xcode-select', ['-p'], {
      env: this.commandEnvironment(), signal, timeoutMs: COMMAND_TIMEOUT_MS,
    })
    signal.throwIfAborted()
    const developerDir = selected.stdout.trim()
    if (selected.code !== 0 || !/\.app\/Contents\/Developer\/?$/u.test(developerDir)) {
      const missing = planIosEnvironment('darwin')
      this.publish(missing)
      return this.current
    }
    const version = await this.runner.run('xcodebuild', ['-version'], {
      env: this.commandEnvironment(developerDir), signal, timeoutMs: COMMAND_TIMEOUT_MS,
    })
    signal.throwIfAborted()
    const xcodeVersion = /^Xcode\s+(.+)$/mu.exec(version.stdout)?.[1]?.trim()
    if (version.code !== 0 || xcodeVersion === undefined) {
      this.publish({
        kind: 'manual-required', code: 'xcode-update', developerDir,
        message: 'Install or update the complete Xcode application, then select it in Xcode Settings.',
      })
      return this.current
    }
    const license = await this.runner.run('xcodebuild', ['-license', 'check'], {
      env: this.commandEnvironment(developerDir), signal, timeoutMs: COMMAND_TIMEOUT_MS,
    })
    signal.throwIfAborted()
    const firstLaunch = license.code === 0
      ? await this.runner.run('xcodebuild', ['-checkFirstLaunchStatus'], {
        env: this.commandEnvironment(developerDir), signal, timeoutMs: COMMAND_TIMEOUT_MS,
      })
      : undefined
    signal.throwIfAborted()
    const probeBase = {
      developerDir, xcodeVersion, licenseAccepted: license.code === 0,
      firstLaunchComplete: firstLaunch?.code === 0,
    }
    if (!probeBase.licenseAccepted || !probeBase.firstLaunchComplete) {
      const planned = planIosEnvironment('darwin', {
        ...probeBase, runtimes: [], deviceTypes: [], devices: [],
      })
      this.publish(planned)
      return this.current
    }
    const runtimes = await this.readRuntimes(developerDir, signal)
    const deviceTypes = await this.readDeviceTypes(developerDir, signal)
    const devices = await this.readDevices(developerDir, signal)
    const probe: IosInstallationProbe = { ...probeBase, runtimes, deviceTypes, devices }
    const planned = planIosEnvironment('darwin', probe)
    this.publish(planned)
    return this.current
  }

  private async readRuntimes(developerDir: string, signal: AbortSignal): Promise<readonly IosRuntime[]> {
    const result = await this.requireSuccess(
      'xcrun', ['simctl', 'list', 'runtimes', '--json'], signal,
      'PHONE_IOS_SIMCTL', 'simctl list runtimes', COMMAND_TIMEOUT_MS, developerDir,
    )
    const root = jsonRecord(result.stdout, 'simctl runtimes')
    if (!Array.isArray(root.runtimes)) throw protocolError('simctl runtimes omitted runtimes')
    return root.runtimes.map((value, index) => {
      const runtime = objectAt(value, `runtimes[${String(index)}]`)
      return {
        identifier: stringAt(runtime.identifier, 'runtime.identifier'),
        name: stringAt(runtime.name, 'runtime.name'),
        version: stringAt(runtime.version, 'runtime.version'),
        available: booleanAt(runtime.isAvailable, 'runtime.isAvailable'),
      }
    })
  }

  private async readDeviceTypes(developerDir: string, signal: AbortSignal): Promise<readonly IosDeviceType[]> {
    const result = await this.requireSuccess(
      'xcrun', ['simctl', 'list', 'devicetypes', '--json'], signal,
      'PHONE_IOS_SIMCTL', 'simctl list devicetypes', COMMAND_TIMEOUT_MS, developerDir,
    )
    const root = jsonRecord(result.stdout, 'simctl device types')
    if (!Array.isArray(root.devicetypes)) throw protocolError('simctl device types omitted devicetypes')
    return root.devicetypes.map((value, index) => {
      const type = objectAt(value, `devicetypes[${String(index)}]`)
      return {
        identifier: stringAt(type.identifier, 'deviceType.identifier'),
        name: stringAt(type.name, 'deviceType.name'),
      }
    })
  }

  private async readDevices(developerDir: string, signal: AbortSignal): Promise<readonly IosSimulator[]> {
    const result = await this.requireSuccess(
      'xcrun', ['simctl', 'list', 'devices', 'available', '--json'], signal,
      'PHONE_IOS_SIMCTL', 'simctl list devices', COMMAND_TIMEOUT_MS, developerDir,
    )
    const root = jsonRecord(result.stdout, 'simctl devices')
    const groups = objectAt(root.devices, 'devices')
    const devices: IosSimulator[] = []
    for (const [runtimeIdentifier, values] of Object.entries(groups)) {
      if (!Array.isArray(values)) throw protocolError(`devices.${runtimeIdentifier} is not an array`)
      for (const [index, value] of values.entries()) {
        const device = objectAt(value, `devices.${runtimeIdentifier}[${String(index)}]`)
        devices.push({
          udid: deviceId(stringAt(device.udid, 'device.udid')),
          name: stringAt(device.name, 'device.name'),
          state: stringAt(device.state, 'device.state'),
          available: booleanAt(device.isAvailable, 'device.isAvailable'),
          runtimeIdentifier,
        })
      }
    }
    return devices
  }

  private async requireSuccess(
    command: string,
    args: readonly string[],
    signal: AbortSignal,
    code: string,
    subject: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
    developerDir?: string,
  ): Promise<IosCommandResult> {
    const result = await this.runner.run(command, args, {
      env: this.commandEnvironment(developerDir), signal, timeoutMs,
    })
    signal.throwIfAborted()
    if (result.code !== 0) throw commandFailure(code, subject, result)
    return result
  }

  private commandEnvironment(developerDir?: string): Readonly<Record<string, string>> {
    return Object.freeze({
      HOME: this.homeDirectory,
      PATH: this.ambient.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      ...(developerDir === undefined ? {} : { DEVELOPER_DIR: developerDir }),
    })
  }

  private publish(state: PhoneIosState): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return
    this.current = Object.freeze(state)
    if (state.kind !== 'checking' && state.kind !== 'preparing' && state.kind !== 'failed') {
      this.lastActionable = this.current
    }
    for (const listener of [...this.listeners]) {
      try { listener(this.current) } catch (error) { this.reportError(error) }
    }
  }

  private async stopOwnedSimulator(): Promise<void> {
    const ownedDeviceId = this.ownedDeviceId
    this.ownedDeviceId = undefined
    if (ownedDeviceId === undefined || this.platform !== 'darwin') return
    const outcome = await this.runner.run('xcrun', ['simctl', 'shutdown', ownedDeviceId], {
      env: this.commandEnvironment(), timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (outcome.code !== 0 && !/current state:\s*Shutdown/iu.test(`${outcome.stdout}\n${outcome.stderr}`)) {
      throw commandFailure('PHONE_IOS_SHUTDOWN', 'simctl shutdown', outcome)
    }
  }
}

const deviceIdPattern = /^[0-9A-Fa-f-]{8,}$/u

function requireRuntime(plan: IosPreparationPlan): IosRuntime {
  if (plan.runtime !== undefined) return plan.runtime
  throw new IosEnvironmentError('PHONE_IOS_RUNTIME_MISSING', 'no available iOS Simulator runtime was selected')
}

function requireDeviceType(plan: IosPreparationPlan): IosDeviceType {
  if (plan.deviceType !== undefined) return plan.deviceType
  throw new IosEnvironmentError('PHONE_IOS_DEVICE_TYPE', 'no iPhone Simulator device type was selected')
}

function jsonRecord(output: string, subject: string): Record<string, unknown> {
  try { return objectAt(JSON.parse(output) as unknown, subject) } catch (error) {
    if (error instanceof IosEnvironmentError) throw error
    throw protocolError(`${subject} returned invalid JSON`, error)
  }
}

function objectAt(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw protocolError(`${subject} is not an object`)
  return value as Record<string, unknown>
}

function stringAt(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) throw protocolError(`${subject} is not a non-empty string`)
  return value
}

function booleanAt(value: unknown, subject: string): boolean {
  if (typeof value !== 'boolean') throw protocolError(`${subject} is not a boolean`)
  return value
}

function protocolError(message: string, cause?: unknown): IosEnvironmentError {
  return new IosEnvironmentError('PHONE_IOS_PROTOCOL', message, cause === undefined ? undefined : { cause })
}

function commandFailure(code: string, subject: string, result: IosCommandResult): IosEnvironmentError {
  const detail = tail(result.stderr || result.stdout)
  const reason = result.timedOut ? 'timed out' : result.signal !== null
    ? `exited by ${result.signal}`
    : `failed with code ${String(result.code)}`
  return new IosEnvironmentError(code, `${subject} ${reason}${detail.length === 0 ? '' : `: ${detail}`}`)
}

function planOf(state: PhoneIosState): IosPreparationPlan | undefined {
  return 'plan' in state ? state.plan : undefined
}

function retryable(code: string): boolean {
  return !['PHONE_IOS_LICENSE_REQUIRED', 'PHONE_IOS_FIRST_LAUNCH', 'PHONE_IOS_UNSUPPORTED'].includes(code)
}

function iosFailure(error: unknown): IosEnvironmentError {
  if (error instanceof IosEnvironmentError) return error
  return new IosEnvironmentError(
    'PHONE_IOS_PREPARE', error instanceof Error ? error.message : String(error), { cause: error },
  )
}

function tail(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 1_000 ? trimmed.slice(-1_000) : trimmed
}
