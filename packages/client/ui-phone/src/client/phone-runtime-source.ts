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

/** Complete revisioned environment snapshot retained by the browser. */
export interface PhoneEnvironmentClientSnapshot {
  readonly revision: number
  readonly enabled: boolean
  readonly runtime: PhoneManagedRuntimeView
  readonly platforms: {
    readonly android: PhonePlatformView
    readonly ios: PhonePlatformView
  }
}

/** Browser source for full-snapshot refresh and trusted Host operations. */
export interface PhoneRuntimeSource {
  getSnapshot(): PhoneEnvironmentClientSnapshot
  refresh(): Promise<void>
  prepare(): Promise<void>
  cancel(): Promise<void>
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
  const prepare = (): Promise<void> => {
    if (active !== undefined) return active
    const operation = request(`${PATH}/prepare`, 'POST')
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
  return {
    getSnapshot: () => snapshot,
    refresh: () => run(`${PATH}/refresh`, 'POST'),
    prepare,
    cancel: () => request(`${PATH}/cancel`, 'POST'),
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
  const android = parsePlatform(value.platforms.android)
  const ios = parsePlatform(value.platforms.ios)
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

function parsePlatform(value: unknown): PhonePlatformView {
  if (!record(value)) throw new Error('phone environment snapshot carried an invalid platform state')
  if (value.kind === 'deferred') return Object.freeze({ kind: 'deferred' })
  if (value.kind === 'unsupported' && string(value.reason)) {
    return Object.freeze({ kind: 'unsupported', reason: value.reason })
  }
  throw new Error('phone environment snapshot carried an invalid platform state')
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
