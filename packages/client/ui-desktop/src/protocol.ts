/**
 * Desktop Host bridge: preload `contextBridge` surface and updater phases.
 * The page never imports Electron; it only reads `window.dshDesktop`.
 * @module @deepseek-ai/dsh-client-ui-desktop/protocol
 */

import type {
  PairingChallengeId,
  PendingPairingId,
  PersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import type { ProjectMembershipClient } from '@deepseek-ai/dsh-project-membership-client'

/** IPC / preload channel for the current updater snapshot. */
export const UPDATER_GET_STATUS = 'updater:getStatus'
/** IPC / preload channel: start a check. */
export const UPDATER_CHECK_NOW = 'updater:checkNow'
/** IPC / preload channel: start a download after the user confirms. */
export const UPDATER_DOWNLOAD_NOW = 'updater:downloadNow'
/** IPC / preload channel: quit and install a downloaded bundle. */
export const UPDATER_QUIT_AND_INSTALL = 'updater:quitAndInstall'
/** IPC event the Desktop Host pushes on every phase change. */
export const UPDATER_STATUS_CHANGED = 'updater:status-changed'
/** IPC / preload channel: minimize the window. */
export const WINDOW_MINIMIZE = 'window:minimize'
/** IPC / preload channel: toggle maximize. */
export const WINDOW_MAXIMIZE = 'window:maximize'
/** IPC / preload channel: close the window. */
export const WINDOW_CLOSE = 'window:close'
/** IPC / preload channel for the current installation Account snapshot. */
export const ACCOUNT_GET_SNAPSHOT = 'account:getSnapshot'
/** IPC / preload channel accepting the bilingual privacy notice. */
export const ACCOUNT_ACCEPT_PRIVACY = 'account:acceptPrivacy'
/** IPC / preload channel starting GitHub authorization in the system browser. */
export const ACCOUNT_BEGIN_LOGIN = 'account:beginLogin'
/** IPC / preload channel cancelling an in-flight GitHub authorization. */
export const ACCOUNT_CANCEL_LOGIN = 'account:cancelLogin'
/** IPC / preload channel revoking the current installation Account Session. */
export const ACCOUNT_SIGN_OUT = 'account:signOut'
/** IPC event pushed for every current-installation Account transition. */
export const ACCOUNT_SNAPSHOT_CHANGED = 'account:snapshot-changed'
/** IPC / preload channel creating one Cloud Project. */
export const PROJECT_MEMBERSHIP_CREATE = 'projectMembership:create'
/** IPC / preload channel resolving the current Account's Project by Workspace remote. */
export const PROJECT_MEMBERSHIP_BY_REMOTE = 'projectMembership:byRemote'
/** IPC / preload channel reading one Project roster. */
export const PROJECT_MEMBERSHIP_ROSTER = 'projectMembership:roster'
/** IPC / preload channel inviting one public GitHub login. */
export const PROJECT_MEMBERSHIP_INVITE = 'projectMembership:invite'
/** IPC / preload channel deciding one pending invitation. */
export const PROJECT_MEMBERSHIP_DECIDE = 'projectMembership:decide'
/** IPC / preload channel retracting one issued invitation. */
export const PROJECT_MEMBERSHIP_RETRACT = 'projectMembership:retract'
/** IPC / preload channel reading invitations addressed to the current Account. */
export const PROJECT_MEMBERSHIP_PENDING = 'projectMembership:pending'
/** IPC / preload channel reading pending invitations issued from one Project. */
export const PROJECT_MEMBERSHIP_ISSUED = 'projectMembership:issued'
/** IPC / preload channel changing one member role. */
export const PROJECT_MEMBERSHIP_CHANGE_ROLE = 'projectMembership:changeRole'
/** IPC / preload channel replacing one member's function tags. */
export const PROJECT_MEMBERSHIP_SET_TAGS = 'projectMembership:setTags'
/** IPC / preload channel removing one Project member. */
export const PROJECT_MEMBERSHIP_REMOVE = 'projectMembership:remove'
/** IPC / preload channel for Mobile Access and Personal Pairing state. */
export const PAIRING_GET_SNAPSHOT = 'pairing:getSnapshot'
/** IPC / preload channel changing Settings-owned Mobile Access. */
export const PAIRING_SET_ENABLED = 'pairing:setEnabled'
/** IPC / preload channel creating one high-entropy invitation. */
export const PAIRING_CREATE_CHALLENGE = 'pairing:createChallenge'
/** IPC / preload channel cancelling the current invitation. */
export const PAIRING_CANCEL_CHALLENGE = 'pairing:cancelChallenge'
/** IPC / preload channel confirming matching authentication words. */
export const PAIRING_CONFIRM = 'pairing:confirm'
/** IPC / preload channel rejecting a pending handshake. */
export const PAIRING_REJECT = 'pairing:reject'
/** IPC / preload channel revoking one confirmed pairing. */
export const PAIRING_REVOKE = 'pairing:revoke'
/** IPC event pushed for every Mobile Access or pairing transition. */
export const PAIRING_SNAPSHOT_CHANGED = 'pairing:snapshot-changed'
/** IPC / preload channel for the optional Sub2API component state. */
export const SUB2API_GET_SNAPSHOT = 'sub2api:getSnapshot'
/** IPC / preload channel enabling (download, install, restart) the component. */
export const SUB2API_ENABLE = 'sub2api:enable'
/** IPC / preload channel disabling the component for future boots. */
export const SUB2API_DISABLE = 'sub2api:disable'
/** IPC / preload channel uninstalling the component; payload deletes data when true. */
export const SUB2API_UNINSTALL = 'sub2api:uninstall'
/** IPC event pushed for every Sub2API component transition. */
export const SUB2API_SNAPSHOT_CHANGED = 'sub2api:snapshot-changed'
/** IPC / preload channel: place one official page over the sidebar viewport. */
export const BROWSER_PRESENT = 'browser:present'
/** IPC / preload channel: hide one official page when its tab is not visible. */
export const BROWSER_CONCEAL = 'browser:conceal'
/** IPC / preload channel: show Settings or the sidebar + menu in the native overlay view. */
export const CHROME_OVERLAY_SHOW = 'chrome:overlayShow'
/** IPC / preload channel: hide the native overlay view. */
export const CHROME_OVERLAY_HIDE = 'chrome:overlayHide'
/** IPC / preload channel: read the overlay request the Host last accepted. */
export const CHROME_OVERLAY_GET_STATE = 'chrome:overlayGetState'
/** IPC event the Host pushes into the overlay document. */
export const CHROME_OVERLAY_STATE = 'chrome:overlay-state'
/** IPC event the overlay document sends after select or dismiss. */
export const CHROME_OVERLAY_RESULT = 'chrome:overlay-result'
/** Query parameter that boots the Session Surface as the native overlay document. */
export const DESKTOP_OVERLAY_PARAM = 'dsh-desktop-overlay'

/** Official page identity sent with present and conceal. */
export interface DesktopBrowserPresentTarget {
  readonly profileId: string
  readonly workspaceId: string
  readonly browserId: string
  readonly tabId: string
}

/** Chrome viewport rectangle in CSS pixels relative to the Host content. */
export interface DesktopBrowserPresentBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Renderer request to show one official page in the sidebar viewport. */
export interface DesktopBrowserPresentRequest {
  readonly target: DesktopBrowserPresentTarget
  readonly bounds: DesktopBrowserPresentBounds
}

/** One row in a native overlay menu. Icons are tab-descriptor ids. */
export interface ChromeOverlayMenuItem {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly icon?: string
}

/** Content-relative rectangle for a native overlay menu anchor. */
export interface ChromeOverlayAnchor {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Host-chrome request that the overlay document paints. */
export type ChromeOverlayShowRequest =
  | {
    readonly kind: 'menu'
    readonly requestId: string
    readonly items: readonly ChromeOverlayMenuItem[]
    readonly anchor: ChromeOverlayAnchor
    readonly align?: 'start' | 'end'
    readonly side?: 'bottom' | 'top' | 'right'
  }
  | {
    readonly kind: 'settings'
    readonly requestId: string
    readonly sectionId?: string
  }

/** Overlay document reply after the user picks a row or dismisses. */
export type ChromeOverlayResult =
  | { readonly type: 'close'; readonly requestId: string }
  | { readonly type: 'select'; readonly requestId: string; readonly id: string }

/** Updater lifecycle the Update Control renders. */
export type UpdaterPhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'preparing'
  | 'downloaded'
  | 'installing'
  | 'error'

/** Immutable updater snapshot pushed to the page. */
export interface UpdaterStatus {
  /** Current phase. */
  readonly state: UpdaterPhase
  /** Epoch ms of the last completed check, or null. */
  readonly lastCheckedAt: number | null
  /** Version string when a newer Desktop Bundle exists. */
  readonly newVersion?: string
  /** 0–100 while downloading. */
  readonly downloadPercent?: number
  /** Human-readable failure when state is error. */
  readonly errorMessage?: string
}

/** Public Account fields shown on Desktop after Platform confirms the session. */
export interface DesktopPlatformAccount {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly avatarUrl: string
}

/** Desktop Host-owned current-installation Account lifecycle. */
export interface DesktopAccountSnapshot {
  readonly status: 'unavailable' | 'idle' | 'authorizing' | 'polling' | 'signed-in' | 'signing-out' | 'failed'
  readonly privacyAccepted: boolean
  readonly account?: DesktopPlatformAccount
  readonly error?: string
}

/** High-entropy invitation shown as both QR and a complete one-time link. */
export interface DesktopPairingChallenge {
  readonly id: PairingChallengeId
  readonly expiresAt: number
  readonly oneTimeLink: string
  readonly qrPayload: string
}

/** Same-account handshake awaiting explicit Desktop confirmation. */
export interface DesktopPendingPairing {
  readonly id: PendingPairingId
  readonly deviceName: string
  readonly authenticationWords: readonly [string, string, string, string, string, string]
}

/** Confirmed Companion-only device listed in Mobile Pairing Settings. */
export interface DesktopPersonalPairing {
  readonly id: PersonalPairingId
  readonly deviceName: string
  readonly platform: 'ios' | 'android'
  readonly pairedAt: number
  readonly lastAccessAt: number
  readonly online: boolean
}

/** Desktop Host-owned Mobile Access and Personal Pairing lifecycle. */
export interface DesktopPairingSnapshot {
  readonly status: 'unavailable' | 'ready' | 'challenge' | 'pending' | 'failed'
  readonly enabled: boolean
  readonly challenge?: DesktopPairingChallenge
  readonly pending?: DesktopPendingPairing
  readonly pairings: readonly DesktopPersonalPairing[]
  readonly error?: string
}

/** Lifecycle the Desktop-only Sub2API offer card renders. */
export type Sub2ApiPhase =
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'starting'
  | 'running'
  | 'error'

/** Immutable Sub2API component snapshot pushed to the page. */
export interface DesktopSub2ApiSnapshot {
  /** Current phase. */
  readonly state: Sub2ApiPhase
  /** false while the installer-owned disable row sits in the profile patch layer. */
  readonly enabled: boolean
  /** Installed bundle package version, when present on disk. */
  readonly version?: string
  /** 0–100 while downloading the runtime pack (Content-Length permitting). */
  readonly downloadPercent?: number
  /** Human-readable actionable failure when state is error. */
  readonly error?: string
}

/** Preload API exposed as `window.dshDesktop`. Absent in browser `dsh web`. */
export interface DesktopBridge {
  /** Node `process.platform` of the Desktop Host. */
  readonly platform: string
  /** Current updater snapshot. */
  readonly getStatus: () => Promise<UpdaterStatus>
  /** Ask Desktop Host to check the GitHub feed. */
  readonly checkNow: () => void
  /** Ask Desktop Host to download after the user confirms. */
  readonly downloadNow: () => void
  /** Ask Desktop Host to quit and install. */
  readonly quitAndInstall: () => void
  /**
   * Subscribe to updater snapshots.
   * @param listener - called on every phase change.
   * @returns unsubscribe.
   */
  readonly onStatus: (listener: (status: UpdaterStatus) => void) => () => void
  /** Minimize the Desktop Host window. */
  readonly windowMinimize: () => void
  /** Toggle maximize on the Desktop Host window. */
  readonly windowMaximize: () => void
  /** Close the Desktop Host window. */
  readonly windowClose: () => void
  /** Read the Desktop Host-owned current-installation Account state. */
  readonly accountGetSnapshot: () => Promise<DesktopAccountSnapshot>
  /** Accept the bilingual privacy notice for this application run. */
  readonly accountAcceptPrivacy: () => Promise<DesktopAccountSnapshot>
  /** Start GitHub authorization in the operating system browser. */
  readonly accountBeginLogin: () => Promise<DesktopAccountSnapshot>
  /**
   * Cancel GitHub authorization while the Host is authorizing or polling.
   * Idle, signed-in, signing-out, failed, and unavailable snapshots are unchanged.
   */
  readonly accountCancelLogin: () => Promise<DesktopAccountSnapshot>
  /** Revoke only this installation's Account Session. */
  readonly accountSignOut: () => Promise<DesktopAccountSnapshot>
  /** Subscribe to current-installation Account transitions. */
  readonly onAccountSnapshot: (listener: (snapshot: DesktopAccountSnapshot) => void) => () => void
  /** Authenticated Project Membership operations owned by the Desktop Host. */
  readonly projectMembership?: ProjectMembershipClient
  /** Read Settings-owned Mobile Access and Personal Pairing state. */
  readonly pairingGetSnapshot: () => Promise<DesktopPairingSnapshot>
  /** Enable or disable Mobile Access for this Desktop Installation. */
  readonly pairingSetEnabled: (enabled: boolean) => Promise<DesktopPairingSnapshot>
  /** Create one two-minute QR/full-link challenge. */
  readonly pairingCreateChallenge: () => Promise<DesktopPairingSnapshot>
  /** Cancel the current challenge and destroy its invitation capability. */
  readonly pairingCancelChallenge: () => Promise<DesktopPairingSnapshot>
  /** Confirm matching authentication words and activate one Device Principal. */
  readonly pairingConfirm: (pendingPairingId: PendingPairingId) => Promise<DesktopPairingSnapshot>
  /** Reject a pending handshake and destroy its pending key. */
  readonly pairingReject: (pendingPairingId: PendingPairingId) => Promise<DesktopPairingSnapshot>
  /** Revoke one confirmed pairing and drop its Relay authority. */
  readonly pairingRevoke: (pairingId: PersonalPairingId) => Promise<DesktopPairingSnapshot>
  /** Subscribe to Mobile Access and Personal Pairing transitions. */
  readonly onPairingSnapshot: (listener: (snapshot: DesktopPairingSnapshot) => void) => () => void
  /** Read the optional Sub2API component state. */
  readonly sub2ApiGetSnapshot: () => Promise<DesktopSub2ApiSnapshot>
  /** Download, verify, install, restart the Web Host, and wait for health. */
  readonly sub2ApiEnable: () => Promise<DesktopSub2ApiSnapshot>
  /** Disable the component for future Web Host boots and restart now. */
  readonly sub2ApiDisable: () => Promise<DesktopSub2ApiSnapshot>
  /**
   * Uninstall the component and delete the extracted files.
   * @param deleteData - also delete `$DSH_HOME/sub2api/data` (accounts, keys).
   */
  readonly sub2ApiUninstall: (deleteData: boolean) => Promise<DesktopSub2ApiSnapshot>
  /** Subscribe to Sub2API component transitions. */
  readonly onSub2ApiSnapshot: (listener: (snapshot: DesktopSub2ApiSnapshot) => void) => () => void
  /** Place one official Runtime page over the sidebar viewport. */
  readonly browserPresent?: (request: DesktopBrowserPresentRequest) => Promise<void>
  /** Hide one official Runtime page when its tab is not visible. */
  readonly browserConceal?: (target: DesktopBrowserPresentTarget) => Promise<void>
  /** Paint Settings or the sidebar + menu in the native overlay view. */
  readonly chromeOverlayShow: (request: ChromeOverlayShowRequest) => Promise<void>
  /** Hide the native overlay view. */
  readonly chromeOverlayHide: () => Promise<void>
  /** Read the overlay request the Host last accepted. */
  readonly chromeOverlayGetState: () => Promise<ChromeOverlayShowRequest | null>
  /** Tell the Host chrome document the overlay closed or selected a row. */
  readonly chromeOverlayResult: (result: ChromeOverlayResult) => void
  /**
   * Subscribe to overlay paint requests (overlay document).
   * @param listener - called with the live request, or null when hidden.
   * @returns unsubscribe.
   */
  readonly onChromeOverlayState: (
    listener: (state: ChromeOverlayShowRequest | null) => void,
  ) => () => void
  /**
   * Subscribe to overlay replies (Host chrome document).
   * @param listener - called after select or dismiss.
   * @returns unsubscribe.
   */
  readonly onChromeOverlayResult: (listener: (result: ChromeOverlayResult) => void) => () => void
}

declare global {
  interface Window {
    /** Desktop Host bridge; missing in browser `dsh web`. */
    dshDesktop?: DesktopBridge
  }
}
