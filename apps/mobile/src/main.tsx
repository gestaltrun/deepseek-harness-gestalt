import {
  IndexedDbInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
} from '@deepseek-ai/dsh-platform-account-client'
import { parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import {
  bindCompanionProcessVisibility,
  CompanionForegroundRuntime,
  installCompanionRuntime,
} from './companion-lifecycle.ts'
import { mountMobileEntry } from './mobile-entry.tsx'
import type { MobilePairingActions } from './MobilePairing.tsx'
import { mobileSystemBrowser } from './system-browser.ts'
import { loadMobilePlatformEnvironment } from './platform-environment.ts'
import './root.css'

const environment = loadMobilePlatformEnvironment(import.meta.env)
const installationIdKey = `deepseek-gestalt:${environment.identityNamespace}:mobile-installation-id`
let installationId = localStorage.getItem(installationIdKey)
if (installationId === null) {
  if (typeof crypto.randomUUID !== 'function') {
    throw new TypeError('Mobile requires a secure browsing context (HTTPS or http://127.0.0.1) to create an Installation id')
  }
  installationId = crypto.randomUUID()
  localStorage.setItem(installationIdKey, installationId)
}
const parsedInstallationId = parseInstallationId(installationId)
const installation = new PlatformAccountInstallation({
  environment,
  installationId: parsedInstallationId,
  installationKind: 'mobile',
  transport: new PlatformAccountHttpTransport({ environment }),
  store: new IndexedDbInstallationAccountStore(`deepseek-gestalt-platform-account:${environment.databaseIdentity}`),
  systemBrowser: mobileSystemBrowser,
})
const companion = new CompanionForegroundRuntime()
installCompanionRuntime(companion)
const companionVisibilityDisposer = bindCompanionProcessVisibility(companion)

/**
 * Remove the process-lifetime visibility listeners bound by the Mobile entry.
 * @returns settled after document listeners and a pending Capacitor handle are removed.
 */
export function disposeCompanionVisibility(): Promise<void> {
  return companionVisibilityDisposer()
}

const unavailablePairing = {
  status: 'unavailable',
  error: 'Personal Pairing waits for the independent Noise security review.',
} as const
const pairingUnavailable = (): Promise<never> => Promise.reject(new Error(unavailablePairing.error))
const pairing: MobilePairingActions = {
  getSnapshot: () => unavailablePairing,
  subscribe: () => () => {},
  completeLink: pairingUnavailable,
  scanQr: pairingUnavailable,
  retryPairing: pairingUnavailable,
  activate: () => Promise.resolve(),
  deactivate: () => Promise.resolve(),
  unpair: pairingUnavailable,
}
const root = document.getElementById('root')
if (root === null) throw new Error('mobile app: missing #root')
mountMobileEntry(root, { installation, pairing, companion })
