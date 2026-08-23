/** Native-only protected persistence for long-lived Mobile Companion authority. */

import { Capacitor, registerPlugin } from '@capacitor/core'

interface ProtectedStoragePlugin {
  get(options: { key: string }): Promise<{ value?: string }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

const plugin = registerPlugin<ProtectedStoragePlugin>('GestaltProtectedStorage')

/** Narrow storage interface used by product composition and deterministic tests. */
export interface MobileProtectedStorage {
  /** Read one protected UTF-8 value. */
  get(key: string): Promise<string | undefined>
  /** Replace one protected UTF-8 value atomically. */
  set(key: string, value: string): Promise<void>
  /** Delete one protected value. */
  remove(key: string): Promise<void>
}

/** Keychain/Android-Keystore-backed storage exposed by the checked-in native shells. */
export class CapacitorMobileProtectedStorage implements MobileProtectedStorage {
  constructor(private readonly nativePlugin: ProtectedStoragePlugin = plugin) {
    if (!Capacitor.isNativePlatform()) {
      throw new Error('Mobile protected storage requires the packaged iOS or Android application')
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.nativePlugin.get({ key: requireStorageKey(key) })).value
  }

  async set(key: string, value: string): Promise<void> {
    await this.nativePlugin.set({ key: requireStorageKey(key), value })
  }

  async remove(key: string): Promise<void> {
    await this.nativePlugin.remove({ key: requireStorageKey(key) })
  }
}

function requireStorageKey(key: string): string {
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(key)) throw new TypeError('Mobile protected-storage key is invalid')
  return key
}

/** Load or create the Installation id without placing it in Web storage. */
export async function loadProtectedInstallationId(
  storage: MobileProtectedStorage,
  identityNamespace: string,
): Promise<string> {
  const key = `installation:${identityNamespace}`
  const retained = await storage.get(key)
  if (retained !== undefined) return retained
  if (typeof crypto.randomUUID !== 'function') {
    throw new TypeError('Mobile requires system cryptography to create an Installation id')
  }
  const installationId = crypto.randomUUID()
  await storage.set(key, installationId)
  return installationId
}
