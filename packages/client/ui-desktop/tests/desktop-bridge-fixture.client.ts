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
import type { ProjectMembershipClient } from '@deepseek-ai/dsh-project-membership-client'

/**
 * Install a complete inert Desktop Host preload on `globalThis`.
 * Account and Pairing subscriptions deliver the selected pre-answer snapshot
 * immediately; unsubscribe removes the listener so later inert verbs do not
 * notify it.
 * @param input - Node platform and optional inert Account state required by the assembled scenario.
 * @returns the installed bridge, typed as the current `DesktopBridge`.
 */
export function installDesktopBridgeFixture(
  input: 'darwin' | 'win32' | {
    platform: 'darwin' | 'win32'
    accountStatus: 'unavailable' | 'idle'
  },
): DesktopBridge {
  const platform = typeof input === 'string' ? input : input.platform
  const accountStatus = typeof input === 'string' ? 'unavailable' : input.accountStatus
  const updater: UpdaterStatus = { state: 'disabled', lastCheckedAt: null }
  const account: DesktopAccountSnapshot = {
    status: accountStatus,
    privacyAccepted: accountStatus === 'idle',
  }
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
  const projectMembership: ProjectMembershipClient = {
    createProject: async () => { throw new Error('inert Desktop bridge cannot create a Project') },
    projectByRemote: async () => undefined,
    roster: async () => { throw new Error('inert Desktop bridge cannot read a roster') },
    invite: async () => { throw new Error('inert Desktop bridge cannot invite a member') },
    decideInvitation: async () => { throw new Error('inert Desktop bridge cannot decide an invitation') },
    retractInvitation: async () => {},
    pendingInvitations: async () => [],
    issuedInvitations: async () => [],
    changeRole: async () => {},
    setMemberTags: async () => {},
    removeMember: async () => {},
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
    projectMembership,
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
