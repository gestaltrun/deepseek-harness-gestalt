/**
 * Shared inert `DesktopBridge` for assembled Desktop Web E2E.
 * Playwright serializes `installDesktopBridgeFixture` into the page, so the
 * function body must stay free of imported values.
 */

import type {
  DesktopAccountSnapshot,
  DesktopBridge,
  DesktopPairingSnapshot,
  UpdaterStatus,
} from '../src/protocol.ts'

/**
 * Install a complete inert Desktop Host preload on `globalThis`.
 * Account and Pairing subscriptions deliver the pre-answer `unavailable`
 * snapshot immediately; unsubscribe removes the listener so later inert
 * verbs do not notify it.
 * @param platform - Node `process.platform` projected into Window Chrome.
 * @returns the installed bridge, typed as the current `DesktopBridge`.
 */
export function installDesktopBridgeFixture(platform: 'darwin' | 'win32'): DesktopBridge {
  const updater: UpdaterStatus = { state: 'disabled', lastCheckedAt: null }
  const account: DesktopAccountSnapshot = { status: 'unavailable', privacyAccepted: false }
  const pairing: DesktopPairingSnapshot = { status: 'unavailable', enabled: false, pairings: [] }
  const statusListeners = new Set<(status: UpdaterStatus) => void>()
  const accountListeners = new Set<(snapshot: DesktopAccountSnapshot) => void>()
  const pairingListeners = new Set<(snapshot: DesktopPairingSnapshot) => void>()

  const notifyStatus = (status: UpdaterStatus): void => {
    for (const listener of statusListeners) listener(status)
  }
  const notifyAccount = (snapshot: DesktopAccountSnapshot): void => {
    for (const listener of accountListeners) listener(snapshot)
  }
  const notifyPairing = (snapshot: DesktopPairingSnapshot): void => {
    for (const listener of pairingListeners) listener(snapshot)
  }

  const bridge: DesktopBridge = {
    platform,
    getStatus: async () => updater,
    checkNow: () => { notifyStatus(updater) },
    downloadNow: () => {},
    quitAndInstall: () => {},
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => { statusListeners.delete(listener) }
    },
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    accountGetSnapshot: async () => account,
    accountAcceptPrivacy: async () => {
      notifyAccount(account)
      return account
    },
    accountBeginLogin: async () => {
      notifyAccount(account)
      return account
    },
    accountSignOut: async () => {
      notifyAccount(account)
      return account
    },
    onAccountSnapshot: (listener) => {
      accountListeners.add(listener)
      listener(account)
      return () => { accountListeners.delete(listener) }
    },
    pairingGetSnapshot: async () => pairing,
    pairingSetEnabled: async () => {
      notifyPairing(pairing)
      return pairing
    },
    pairingCreateChallenge: async () => {
      notifyPairing(pairing)
      return pairing
    },
    pairingCancelChallenge: async () => {
      notifyPairing(pairing)
      return pairing
    },
    pairingConfirm: async () => {
      notifyPairing(pairing)
      return pairing
    },
    pairingReject: async () => {
      notifyPairing(pairing)
      return pairing
    },
    pairingRevoke: async () => {
      notifyPairing(pairing)
      return pairing
    },
    onPairingSnapshot: (listener) => {
      pairingListeners.add(listener)
      listener(pairing)
      return () => { pairingListeners.delete(listener) }
    },
    chromeOverlayShow: async () => {},
    chromeOverlayHide: async () => {},
    chromeOverlayGetState: async () => null,
    chromeOverlayResult: () => {},
    onChromeOverlayState: () => () => {},
    onChromeOverlayResult: () => () => {},
  }

  Object.defineProperty(globalThis, 'dshDesktop', {
    configurable: true,
    value: bridge,
  })
  return bridge
}
