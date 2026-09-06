import type { InstallationId } from '@deepseek-ai/dsh-platform-account'

/** Browser-safe protected storage fixture for the built real-entry snapshot. */
export class CapacitorMobileProtectedStorage {
  get(): Promise<string | null> { return Promise.resolve(null) }
  set(): Promise<void> { return Promise.resolve() }
  remove(): Promise<void> { return Promise.resolve() }
}

/** Supply a stable installation id after the real entry has acquired packaged identity. */
export function loadProtectedInstallationId(): Promise<InstallationId> {
  return Promise.resolve('installation-real-entry' as InstallationId)
}
