/** Browser projection of the Host-owned phone environment full snapshot. */

/** Shared mobilecli runtime state rendered above Android and iOS sections. */
export type PhoneManagedRuntimeView =
  | { readonly kind: 'missing'; readonly targetVersion: string; readonly assetBytes?: number }
  | { readonly kind: 'downloading'; readonly targetVersion: string; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'verifying'; readonly targetVersion: string }
  | { readonly kind: 'activating'; readonly targetVersion: string; readonly source: 'override' | 'managed' | 'system' }
  | { readonly kind: 'ready'; readonly version: string; readonly source: 'override' | 'managed' | 'system' }
  | { readonly kind: 'failed'; readonly targetVersion: string; readonly code: string; readonly message: string }

/** Host capability state for one platform-specific preparation lane. */
export type PhonePlatformView =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** Xcode and product-Simulator facts displayed by the iOS preparation lane. */
export interface IosPreparationPlanView {
  readonly developerDir: string
  readonly xcodeVersion: string
  readonly simulatorName: string
  readonly runtime?: { readonly identifier: string; readonly name: string; readonly version: string; readonly available: true }
  readonly deviceType?: { readonly identifier: string; readonly name: string }
}

/** iOS platform state projected from the Host full snapshot. */
export type PhoneIosView =
  | PhonePlatformView
  | { readonly kind: 'checking' }
  | { readonly kind: 'xcode-missing'; readonly message: string }
  | { readonly kind: 'license-required'; readonly developerDir: string; readonly message: string }
  | { readonly kind: 'manual-required'; readonly code: 'first-launch' | 'xcode-update'; readonly message: string; readonly developerDir?: string }
  | { readonly kind: 'runtime-missing' | 'no-simulator'; readonly plan: IosPreparationPlanView }
  | { readonly kind: 'preparing'; readonly plan: IosPreparationPlanView; readonly step: 'downloading-runtime' | 'creating-simulator' | 'booting' }
  | { readonly kind: 'ready'; readonly plan: IosPreparationPlanView; readonly deviceId: string; readonly running: boolean }
  | { readonly kind: 'failed'; readonly plan?: IosPreparationPlanView; readonly code: string; readonly message: string; readonly retryable: boolean }

interface AndroidComponentView {
  readonly commandLineTools: boolean
  readonly platformTools: boolean
  readonly emulator: boolean
  readonly systemImage: boolean
  readonly avd: boolean
}

/** Immutable Android SDK plan displayed before the user accepts Google's terms. */
export interface AndroidPreparationPlanView {
  readonly sdkRoot: string
  readonly sdkSource: 'existing' | 'managed'
  readonly avdHome: string
  readonly avdName: string
  readonly abi: 'arm64-v8a' | 'x86_64'
  readonly commandLineToolsVersion: string
  readonly commandLineToolsBytes: number
  readonly packageIds: readonly string[]
  readonly minimumFreeBytes: number
  readonly licenseUrl: string
  readonly components: AndroidComponentView
}

/** Android platform state projected from the Host full snapshot. */
export type PhoneAndroidView =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'missing' | 'awaiting-license'; readonly plan: AndroidPreparationPlanView }
  | {
    readonly kind: 'downloading'
    readonly plan: AndroidPreparationPlanView
    readonly receivedBytes: number
    readonly totalBytes: number
  }
  | {
    readonly kind: 'installing'
    readonly plan: AndroidPreparationPlanView
    readonly step: 'licenses' | 'packages'
  }
  | { readonly kind: 'creating-avd' | 'checking-acceleration' | 'booting'; readonly plan: AndroidPreparationPlanView }
  | {
    readonly kind: 'manual-required'
    readonly plan: AndroidPreparationPlanView
    readonly code: 'disk-space' | 'windows-hypervisor' | 'linux-kvm' | 'virtualization'
    readonly message: string
  }
  | {
    readonly kind: 'ready'
    readonly plan: AndroidPreparationPlanView
    readonly deviceId?: string
    readonly running: boolean
  }
  | {
    readonly kind: 'failed'
    readonly plan?: AndroidPreparationPlanView
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }

/** Complete revisioned environment snapshot retained by the browser. */
export interface PhoneEnvironmentClientSnapshot {
  readonly revision: number
  readonly enabled: boolean
  readonly runtime: PhoneManagedRuntimeView
  readonly platforms: {
    readonly android: PhoneAndroidView
    readonly ios: PhoneIosView
  }
}

/** Browser source for full-snapshot refresh and trusted Host operations. */
export interface PhoneRuntimeSource {
  getSnapshot(): PhoneEnvironmentClientSnapshot
  refresh(): Promise<void>
  prepare(): Promise<void>
  cancel(): Promise<void>
  prepareAndroid(): Promise<void>
  cancelAndroid(): Promise<void>
  refreshAndroid(): Promise<void>
  startAndroid(): Promise<void>
  prepareIos(): Promise<void>
  cancelIos(): Promise<void>
  refreshIos(): Promise<void>
  startIos(): Promise<void>
  ensureDetected(): void
  subscribe(listener: () => void): () => void
}

/** Initial state before the first Host pull. */
export const MISSING_PHONE_RUNTIME: PhoneManagedRuntimeView = Object.freeze({
  kind: 'missing', targetVersion: '1.0.5',
})

/** Initial browser snapshot before the first trusted Host response. */
export const MISSING_PHONE_ENVIRONMENT: PhoneEnvironmentClientSnapshot = Object.freeze({
  revision: -1,
  enabled: false,
  runtime: MISSING_PHONE_RUNTIME,
  platforms: Object.freeze({
    android: Object.freeze({ kind: 'deferred' }),
    ios: Object.freeze({ kind: 'deferred' }),
  }),
})

const PATH = '/phone/environment'
const PREPARE_POLL_MS = 100

/**
 * Create the production source over the Host's trusted phone-environment routes.
 * @param onListenerError - Reporter for subscriber failures contained during notification.
 * @returns the full-snapshot runtime source.
 */
export function createHttpPhoneRuntimeSource(
  onListenerError: (error: unknown) => void = (error) => { console.error('phone runtime subscriber failed', error) },
): PhoneRuntimeSource {
  let snapshot = MISSING_PHONE_ENVIRONMENT
  let detected = false
  let active: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        onListenerError(error)
      }
    }
  }
  const request = async (path: string, method: 'GET' | 'POST'): Promise<void> => {
    const response = await fetch(path, { method, headers: { accept: 'application/json' } })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(errorMessage(body, response.status))
    const next = parseSnapshot(body)
    detected = true
    if (next.revision > snapshot.revision) {
      snapshot = next
      notify()
    }
  }
  const run = (path: string, method: 'GET' | 'POST'): Promise<void> => {
    if (active !== undefined) return active
    const operation = request(path, method)
    active = operation
    void operation.then(
      () => { active = undefined },
      () => { active = undefined },
    )
    return operation
  }
  const pollOperation = (operation: Promise<void>): Promise<void> => {
    active = operation
    let timer: ReturnType<typeof setTimeout>
    const poll = (): void => {
      if (active !== operation) return
      void request(PATH, 'GET').catch(() => {})
      timer = setTimeout(poll, PREPARE_POLL_MS)
    }
    timer = setTimeout(poll, 0)
    void operation.then(
      () => {
        active = undefined
        clearTimeout(timer)
      },
      () => {
        active = undefined
        clearTimeout(timer)
      },
    )
    return operation
  }
  const prepare = (): Promise<void> => active ?? pollOperation(request(`${PATH}/prepare`, 'POST'))
  const runPolled = (path: string, body?: unknown): Promise<void> => {
    if (active !== undefined) return active
    return pollOperation(requestWithBody(path, body))
  }
  const requestWithBody = async (path: string, body?: unknown): Promise<void> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(errorMessage(value, response.status))
    const next = parseSnapshot(value)
    detected = true
    if (next.revision > snapshot.revision) { snapshot = next; notify() }
  }
  return {
    getSnapshot: () => snapshot,
    refresh: () => run(`${PATH}/refresh`, 'POST'),
    prepare,
    cancel: () => request(`${PATH}/cancel`, 'POST'),
    prepareAndroid: () => runPolled(`${PATH}/android/prepare`, { licenseAccepted: true }),
    cancelAndroid: () => requestWithBody(`${PATH}/android/cancel`),
    refreshAndroid: () => runPolled(`${PATH}/android/refresh`),
    startAndroid: () => runPolled(`${PATH}/android/start`),
    prepareIos: () => runPolled(`${PATH}/ios/prepare`),
    cancelIos: () => requestWithBody(`${PATH}/ios/cancel`),
    refreshIos: () => runPolled(`${PATH}/ios/refresh`),
    startIos: () => runPolled(`${PATH}/ios/start`),
    ensureDetected: () => { if (!detected && active === undefined) void run(PATH, 'GET') },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function parseSnapshot(value: unknown): PhoneEnvironmentClientSnapshot {
  if (!record(value) || !number(value.revision) || typeof value.enabled !== 'boolean'
    || !record(value.runtime) || !record(value.platforms)) {
    throw new Error('phone environment response was not a full revisioned snapshot')
  }
  const android = parseAndroid(value.platforms.android)
  const ios = parseIos(value.platforms.ios)
  return Object.freeze({
    revision: value.revision,
    enabled: value.enabled,
    runtime: parseRuntime(value.runtime),
    platforms: Object.freeze({ android, ios }),
  })
}

function parseRuntime(runtime: Record<string, unknown>): PhoneManagedRuntimeView {
  const kind = runtime.kind
  if (kind === 'missing' && string(runtime.targetVersion)) {
    return {
      kind, targetVersion: runtime.targetVersion,
      ...(number(runtime.assetBytes) ? { assetBytes: runtime.assetBytes } : {}),
    }
  }
  if (kind === 'downloading' && string(runtime.targetVersion)
    && number(runtime.receivedBytes) && number(runtime.totalBytes)) {
    return { kind, targetVersion: runtime.targetVersion, receivedBytes: runtime.receivedBytes, totalBytes: runtime.totalBytes }
  }
  if (kind === 'verifying' && string(runtime.targetVersion)) return { kind, targetVersion: runtime.targetVersion }
  if (kind === 'activating' && string(runtime.targetVersion) && source(runtime.source)) {
    return { kind, targetVersion: runtime.targetVersion, source: runtime.source }
  }
  if (kind === 'ready' && string(runtime.version) && source(runtime.source)) {
    return { kind, version: runtime.version, source: runtime.source }
  }
  if (kind === 'failed' && string(runtime.targetVersion) && string(runtime.code) && string(runtime.message)) {
    return { kind, targetVersion: runtime.targetVersion, code: runtime.code, message: runtime.message }
  }
  throw new Error('phone environment snapshot carried an invalid runtime state')
}

function parsePlatform(value: Record<string, unknown>): PhonePlatformView {
  if (value.kind === 'deferred') return Object.freeze({ kind: 'deferred' })
  if (value.kind === 'unsupported' && string(value.reason)) {
    return Object.freeze({ kind: 'unsupported', reason: value.reason })
  }
  throw new Error('phone environment snapshot carried an invalid platform state')
}

function parseIos(value: unknown): PhoneIosView {
  if (!record(value) || !string(value.kind)) throw new Error('phone environment snapshot carried an invalid iOS state')
  if (value.kind === 'deferred' || value.kind === 'unsupported') return parsePlatform(value)
  if (value.kind === 'checking') return Object.freeze({ kind: 'checking' })
  if (value.kind === 'xcode-missing' && string(value.message)) return Object.freeze({ kind: value.kind, message: value.message })
  if (value.kind === 'license-required' && string(value.developerDir) && string(value.message)) {
    return Object.freeze({ kind: value.kind, developerDir: value.developerDir, message: value.message })
  }
  if (value.kind === 'manual-required' && (value.code === 'first-launch' || value.code === 'xcode-update')
    && string(value.message) && (value.developerDir === undefined || string(value.developerDir))) {
    return Object.freeze({
      kind: value.kind, code: value.code, message: value.message,
      ...(value.developerDir === undefined ? {} : { developerDir: value.developerDir }),
    })
  }
  if (value.kind === 'failed' && string(value.code) && string(value.message) && typeof value.retryable === 'boolean') {
    return Object.freeze({
      kind: value.kind, code: value.code, message: value.message, retryable: value.retryable,
      ...(value.plan === undefined ? {} : { plan: parseIosPlan(value.plan) }),
    })
  }
  const plan = parseIosPlan(value.plan)
  if (value.kind === 'runtime-missing' || value.kind === 'no-simulator') return Object.freeze({ kind: value.kind, plan })
  if (value.kind === 'preparing' && ['downloading-runtime', 'creating-simulator', 'booting'].includes(String(value.step))) {
    return Object.freeze({ kind: value.kind, plan, step: value.step as 'downloading-runtime' | 'creating-simulator' | 'booting' })
  }
  if (value.kind === 'ready' && string(value.deviceId) && typeof value.running === 'boolean') {
    return Object.freeze({ kind: value.kind, plan, deviceId: value.deviceId, running: value.running })
  }
  throw new Error('phone environment snapshot carried an invalid iOS state')
}

function parseIosPlan(value: unknown): IosPreparationPlanView {
  if (!record(value) || !string(value.developerDir) || !string(value.xcodeVersion) || !string(value.simulatorName)) {
    throw new Error('phone environment snapshot carried an invalid iOS plan')
  }
  const runtime = value.runtime
  const deviceType = value.deviceType
  if (runtime !== undefined && (!record(runtime) || !string(runtime.identifier) || !string(runtime.name)
    || !string(runtime.version) || runtime.available !== true)) {
    throw new Error('phone environment snapshot carried an invalid iOS runtime')
  }
  if (deviceType !== undefined && (!record(deviceType) || !string(deviceType.identifier) || !string(deviceType.name))) {
    throw new Error('phone environment snapshot carried an invalid iOS device type')
  }
  return Object.freeze({
    developerDir: value.developerDir, xcodeVersion: value.xcodeVersion, simulatorName: value.simulatorName,
    ...(runtime === undefined ? {} : { runtime: Object.freeze({
      identifier: runtime.identifier as string, name: runtime.name as string,
      version: runtime.version as string, available: true as const,
    }) }),
    ...(deviceType === undefined ? {} : { deviceType: Object.freeze({
      identifier: deviceType.identifier as string, name: deviceType.name as string,
    }) }),
  })
}

function parseAndroid(value: unknown): PhoneAndroidView {
  if (!record(value) || !string(value.kind)) throw new Error('phone environment snapshot carried an invalid Android state')
  if (value.kind === 'deferred') return Object.freeze({ kind: 'deferred' })
  if (value.kind === 'unsupported' && string(value.reason)) return Object.freeze({ kind: 'unsupported', reason: value.reason })
  if (value.kind === 'checking') return Object.freeze({ kind: 'checking' })
  if (value.kind === 'failed' && string(value.code) && string(value.message) && typeof value.retryable === 'boolean') {
    return Object.freeze({
      kind: 'failed', code: value.code, message: value.message, retryable: value.retryable,
      ...(value.plan === undefined ? {} : { plan: parseAndroidPlan(value.plan) }),
    })
  }
  const plan = parseAndroidPlan(value.plan)
  if (value.kind === 'missing' || value.kind === 'awaiting-license') return Object.freeze({ kind: value.kind, plan })
  if (value.kind === 'downloading' && number(value.receivedBytes) && number(value.totalBytes)) {
    return Object.freeze({ kind: value.kind, plan, receivedBytes: value.receivedBytes, totalBytes: value.totalBytes })
  }
  if (value.kind === 'installing' && (value.step === 'licenses' || value.step === 'packages')) {
    return Object.freeze({ kind: value.kind, plan, step: value.step })
  }
  if (value.kind === 'creating-avd' || value.kind === 'checking-acceleration' || value.kind === 'booting') {
    return Object.freeze({ kind: value.kind, plan })
  }
  if (value.kind === 'manual-required' && string(value.code) && manualCode(value.code) && string(value.message)) {
    return Object.freeze({ kind: value.kind, plan, code: value.code, message: value.message })
  }
  if (value.kind === 'ready' && typeof value.running === 'boolean'
    && (value.deviceId === undefined || string(value.deviceId))) {
    return Object.freeze({
      kind: value.kind, plan, running: value.running,
      ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }),
    })
  }
  throw new Error('phone environment snapshot carried an invalid Android state')
}

function parseAndroidPlan(value: unknown): AndroidPreparationPlanView {
  if (!record(value) || !string(value.sdkRoot) || (value.sdkSource !== 'existing' && value.sdkSource !== 'managed')
    || !string(value.avdHome) || !string(value.avdName) || (value.abi !== 'arm64-v8a' && value.abi !== 'x86_64')
    || !string(value.commandLineToolsVersion) || !number(value.commandLineToolsBytes)
    || !Array.isArray(value.packageIds) || !value.packageIds.every(string) || !number(value.minimumFreeBytes)
    || !string(value.licenseUrl) || !record(value.components)) {
    throw new Error('phone environment snapshot carried an invalid Android plan')
  }
  const components = value.components
  if (![components.commandLineTools, components.platformTools, components.emulator, components.systemImage, components.avd]
    .every(item => typeof item === 'boolean')) {
    throw new Error('phone environment snapshot carried invalid Android components')
  }
  return Object.freeze({
    sdkRoot: value.sdkRoot, sdkSource: value.sdkSource, avdHome: value.avdHome, avdName: value.avdName,
    abi: value.abi, commandLineToolsVersion: value.commandLineToolsVersion,
    commandLineToolsBytes: value.commandLineToolsBytes, packageIds: Object.freeze([...value.packageIds]),
    minimumFreeBytes: value.minimumFreeBytes, licenseUrl: value.licenseUrl,
    components: Object.freeze({
      commandLineTools: components.commandLineTools as boolean,
      platformTools: components.platformTools as boolean,
      emulator: components.emulator as boolean,
      systemImage: components.systemImage as boolean,
      avd: components.avd as boolean,
    }),
  })
}

function manualCode(value: string): value is 'disk-space' | 'windows-hypervisor' | 'linux-kvm' | 'virtualization' {
  return value === 'disk-space' || value === 'windows-hypervisor' || value === 'linux-kvm' || value === 'virtualization'
}

function errorMessage(value: unknown, status: number): string {
  if (record(value) && record(value.error) && string(value.error.message)) return value.error.message
  return `phone environment request failed with HTTP ${String(status)}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown): value is string {
  return typeof value === 'string'
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function source(value: unknown): value is 'override' | 'managed' | 'system' {
  return value === 'override' || value === 'managed' || value === 'system'
}
