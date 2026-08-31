/** Browser projection of the Host-owned phone environment full snapshot. */

/** Shared mobilecli runtime state rendered above Android and iOS sections. */
export type PhoneManagedRuntimeView =
  | { readonly kind: 'missing'; readonly targetVersion: string; readonly assetBytes?: number }
  | { readonly kind: 'downloading'; readonly targetVersion: string; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'verifying'; readonly targetVersion: string }
  | { readonly kind: 'activating'; readonly targetVersion: string; readonly source: 'override' | 'managed' | 'system' }
  | { readonly kind: 'ready'; readonly version: string; readonly source: 'override' | 'managed' | 'system' }
  | { readonly kind: 'failed'; readonly targetVersion: string; readonly code: string; readonly message: string }

/** Browser source for full-snapshot refresh and trusted Host operations. */
export interface PhoneRuntimeSource {
  getRuntime(): PhoneManagedRuntimeView
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

const PATH = '/phone/environment'

/** Create the production source over the Host's trusted phone-environment routes. */
export function createHttpPhoneRuntimeSource(): PhoneRuntimeSource {
  let runtime = MISSING_PHONE_RUNTIME
  let detected = false
  let active: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const request = async (path: string, method: 'GET' | 'POST'): Promise<void> => {
    const response = await fetch(path, { method, headers: { accept: 'application/json' } })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(errorMessage(body, response.status))
    runtime = parseRuntime(body)
    detected = true
    notify()
  }
  const run = (path: string, method: 'GET' | 'POST'): Promise<void> => {
    if (active !== undefined) return active
    const operation = request(path, method)
    active = operation
    void operation.then(
      () => { if (active === operation) active = undefined },
      () => { if (active === operation) active = undefined },
    )
    return operation
  }
  return {
    getRuntime: () => runtime,
    refresh: () => run(PATH, 'GET'),
    prepare: () => run(`${PATH}/prepare`, 'POST'),
    cancel: () => request(`${PATH}/cancel`, 'POST'),
    ensureDetected: () => { if (!detected && active === undefined) void run(PATH, 'GET') },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function parseRuntime(value: unknown): PhoneManagedRuntimeView {
  if (!record(value) || !record(value.runtime)) throw new Error('phone environment snapshot omitted runtime')
  const runtime = value.runtime
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
