/**
 * Desktop-only chrome plus Platform Account state in Mobile Pairing Settings.
 * Mounted only through the Desktop `--patch` overlay.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  ProjectMembershipAccess, ProjectMembershipAccessSnapshot,
} from '@deepseek-ai/dsh-project-membership-client'
import { BrandSeat } from './BrandSeat.tsx'
import { DragStrip } from './DragStrip.tsx'
import { UpdateControl } from './UpdateControl.tsx'
import { AccountControl } from './AccountControl.tsx'
import { DesktopChromeOverlay } from './DesktopChromeOverlay.tsx'
import { bindDesktopUpdater, createUpdaterSource } from './status-source.ts'
import { bindDesktopAccount, createDesktopAccountSource } from './account-source.ts'
import { bindDesktopPairing, createDesktopPairingSource } from './pairing-source.ts'
import { en, zh, type DesktopKey } from './locales.ts'
import type { DesktopAccountSnapshot, DesktopBridge } from '../protocol.ts'

export type { DesktopBridge, UpdaterPhase, UpdaterStatus } from '../protocol.ts'
export type { DesktopKey } from './locales.ts'
export type { UpdateControlProps } from './UpdateControl.tsx'
export { bindDesktopUpdater, createUpdaterSource, INITIAL_UPDATER_STATUS } from './status-source.ts'
export { bindDesktopAccount, createDesktopAccountSource, INITIAL_ACCOUNT_SNAPSHOT } from './account-source.ts'
export type { AccountControlProps } from './AccountControl.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop chrome copy. */
    desktop: DesktopKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'desktop'

/** Required services: slots plus desktop copy. */
export const inject = ['slots', 'locale']

/* v8 ignore next -- TypeScript closes the Desktop Account status union. */
function assertNever(value: never): never { throw new TypeError(`unknown Desktop Account status: ${String(value)}`) }

function membershipAccessStatus(
  status: DesktopAccountSnapshot['status'],
): ProjectMembershipAccessSnapshot['status'] {
  switch (status) {
    case 'unavailable': return 'unavailable'
    case 'authorizing':
    case 'polling': return 'signing-in'
    case 'signed-in': return 'signed-in'
    case 'signing-out': return 'signing-out'
    case 'idle':
    case 'failed': return 'signed-out'
    default: return assertNever(status)
  }
}

function membershipAccessSnapshot(snapshot: DesktopAccountSnapshot): ProjectMembershipAccessSnapshot {
  return {
    status: membershipAccessStatus(snapshot.status),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  }
}

function projectMembershipAccess(
  account: ReturnType<typeof createDesktopAccountSource>,
  desktop: DesktopBridge,
): ProjectMembershipAccess {
  let sourceSnapshot = account.getSnapshot()
  let projectedSnapshot = membershipAccessSnapshot(sourceSnapshot)
  const refresh = () => {
    const next = account.getSnapshot()
    if (next === sourceSnapshot) return
    sourceSnapshot = next
    projectedSnapshot = membershipAccessSnapshot(next)
  }
  return {
    getSnapshot: () => {
      refresh()
      return projectedSnapshot
    },
    subscribe: listener => account.subscribe(() => {
      refresh()
      listener()
    }),
    openSignIn: () => {
      void desktop.chromeOverlayShow({
        kind: 'settings', requestId: crypto.randomUUID(), sectionId: 'mobile-pairing',
      }).catch((error: unknown) => { console.error('failed to open Platform Account settings', error) })
    },
  }
}

/**
 * Register Desktop chrome into sidebar holes declared by ui-sidebar.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop: dictionaries')

  const updater = createUpdaterSource()
  const account = createDesktopAccountSource()
  const pairing = createDesktopPairingSource()
  /* v8 ignore next -- the client half always has window */
  const desktop = typeof window === 'undefined' ? undefined : window.dshDesktop
  if (desktop !== undefined) {
    ctx.effect(() => bindDesktopUpdater(updater, desktop), 'ui-desktop: updater status')
    ctx.effect(() => bindDesktopAccount(account, desktop), 'ui-desktop: account status')
    ctx.effect(() => bindDesktopPairing(pairing, desktop), 'ui-desktop: pairing status')
    ctx.provide('projectMembershipAccess', projectMembershipAccess(account, desktop))
    if (desktop.projectMembership !== undefined) {
      ctx.provide('projectMembershipClient', desktop.projectMembership)
    }
  }

  ctx.slots.inject('sidebar.brand', () => ctx.slots.register(
    { name: 'sidebar.brand', select: () => ({}), locale: NS },
    BrandSeat,
  ))
  ctx.slots.inject('sidebar.chrome.drag', () => ctx.slots.register(
    { name: 'sidebar.chrome.drag', id: 'desktop-drag', locale: NS },
    DragStrip,
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'mobile-pairing',
      order: 50,
      label: () => ctx.locale.bind(NS)('account.settingsNav'),
      locale: NS,
      inject: () => ({ hooks: { account, pairing } }),
    },
    AccountControl,
  ))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'desktop-update',
      locale: NS,
      inject: () => ({ hooks: { updater } }),
    },
    UpdateControl,
  ))
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dsh-desktop-overlay')) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'desktop-chrome-overlay' },
      DesktopChromeOverlay,
    ))
  }
}
