// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-desktop/client'
import type {} from '@deepseek-ai/dsh-project-membership-client'
import type { DesktopAccountSnapshot, DesktopBridge, UpdaterStatus } from '../src/protocol.ts'

afterEach(() => {
  delete window.dshDesktop
  document.documentElement.removeAttribute('data-dsh-desktop-overlay')
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    {
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  slots.register(
    {
      name: 'sidebar',
      children: {
        'sidebar.brand': { kind: 'chain', scope: 'root' },
        'sidebar.chrome.drag': { kind: 'list', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  return { ctx, slots }
}

describe('ui-desktop apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('occupies brand, drag, update, and Mobile Pairing Settings seats', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.brand')).not.toHaveLength(0)
    expect(b.slots.entries('sidebar.chrome.drag')).not.toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).not.toHaveLength(0)
    expect(b.slots.entries('settings.section').map(entry => entry.options.id)).toContain('mobile-pairing')
  })

  it('registers native menu chrome only in the Desktop overlay document', async () => {
    const regular = await bench()
    await regular.ctx.plugin({ inject: [...inject], apply }).await()
    expect(regular.slots.entries('shell.overlay')).toHaveLength(0)

    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    const overlay = await bench()
    await overlay.ctx.plugin({ inject: [...inject], apply }).await()
    expect(overlay.slots.entries('shell.overlay').map(entry => entry.options.id))
      .toEqual(['desktop-chrome-overlay'])
  })

  it('subscribes to the Desktop updater bridge when present', async () => {
    let accountListener: ((snapshot: Awaited<ReturnType<DesktopBridge['accountGetSnapshot']>>) => void) | undefined
    const desktop: DesktopBridge = {
      platform: 'darwin',
      getStatus: vi.fn(() => Promise.resolve({ state: 'idle', lastCheckedAt: 1 } satisfies UpdaterStatus)),
      checkNow: vi.fn(),
      downloadNow: vi.fn(),
      quitAndInstall: vi.fn(),
      onStatus: vi.fn((listener: (status: UpdaterStatus) => void) => {
        listener({ state: 'available', lastCheckedAt: 2, newVersion: '0.1.1' })
        return () => {}
      }),
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
      windowClose: vi.fn(),
      accountGetSnapshot: vi.fn().mockResolvedValue({ status: 'unavailable', privacyAccepted: false }),
      accountAcceptPrivacy: vi.fn(),
      accountBeginLogin: vi.fn(),
      accountSignOut: vi.fn(),
      onAccountSnapshot: vi.fn((listener: (snapshot: DesktopAccountSnapshot) => void) => {
        accountListener = listener
        return () => {}
      }),
      pairingGetSnapshot: vi.fn().mockResolvedValue({ status: 'unavailable', enabled: false, pairings: [] }),
      pairingSetEnabled: vi.fn(),
      pairingCreateChallenge: vi.fn(),
      pairingCancelChallenge: vi.fn(),
      pairingConfirm: vi.fn(),
      pairingReject: vi.fn(),
      pairingRevoke: vi.fn(),
      onPairingSnapshot: vi.fn(() => () => {}),
      chromeOverlayShow: vi.fn(async () => {}),
      chromeOverlayHide: async () => {},
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayState: () => () => {},
      onChromeOverlayResult: () => () => {},
      projectMembership: {
        createProject: vi.fn(),
        projectByRemote: vi.fn(),
        roster: vi.fn(),
        invite: vi.fn(),
        decideInvitation: vi.fn(),
        retractInvitation: vi.fn(),
        pendingInvitations: vi.fn(),
        issuedInvitations: vi.fn(),
        changeRole: vi.fn(),
        setMemberTags: vi.fn(),
        removeMember: vi.fn(),
      },
    }
    window.dshDesktop = desktop
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(desktop.getStatus).toHaveBeenCalledOnce()
    expect(desktop.onStatus).toHaveBeenCalledOnce()
    expect(desktop.accountGetSnapshot).toHaveBeenCalledOnce()
    expect(desktop.onAccountSnapshot).toHaveBeenCalledOnce()
    expect(desktop.pairingGetSnapshot).toHaveBeenCalledOnce()
    expect(desktop.onPairingSnapshot).toHaveBeenCalledOnce()
    expect(b.ctx.get('projectMembershipClient')).toBe(desktop.projectMembership)
    const membershipAccess = b.ctx.get('projectMembershipAccess')
    expect(membershipAccess?.getSnapshot()).toEqual({ status: 'unavailable' })
    const accessListener = vi.fn()
    const disposeAccessListener = membershipAccess?.subscribe(accessListener)
    for (const [snapshot, expected] of [
      [{ status: 'idle', privacyAccepted: false }, { status: 'signed-out' }],
      [{ status: 'failed', privacyAccepted: true, error: 'login failed' }, { status: 'signed-out', error: 'login failed' }],
      [{ status: 'authorizing', privacyAccepted: true }, { status: 'signing-in' }],
      [{ status: 'polling', privacyAccepted: true }, { status: 'signing-in' }],
      [{ status: 'signed-in', privacyAccepted: true, account: {
        id: 'account-1', githubId: 1, githubLogin: 'mona', avatarUrl: 'https://avatars.example/mona.png',
      } }, { status: 'signed-in' }],
      [{ status: 'signing-out', privacyAccepted: true, account: {
        id: 'account-1', githubId: 1, githubLogin: 'mona', avatarUrl: 'https://avatars.example/mona.png',
      } }, { status: 'signing-out' }],
    ] as const) {
      accountListener?.(snapshot)
      expect(membershipAccess?.getSnapshot()).toEqual(expected)
    }
    expect(accessListener).toHaveBeenCalledTimes(6)
    disposeAccessListener?.()
    membershipAccess?.openSignIn()
    expect(desktop.chromeOverlayShow).toHaveBeenCalledOnce()
    const overlayRequest = vi.mocked(desktop.chromeOverlayShow).mock.calls[0]?.[0]
    expect(overlayRequest?.kind).toBe('settings')
    if (overlayRequest?.kind !== 'settings') throw new Error('expected Settings overlay request')
    expect(overlayRequest.sectionId).toBe('mobile-pairing')
    expect(overlayRequest?.requestId).toEqual(expect.any(String))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(desktop.chromeOverlayShow).mockRejectedValueOnce(new Error('overlay unavailable'))
    membershipAccess?.openSignIn()
    await Promise.resolve()
    await Promise.resolve()
    expect(consoleError).toHaveBeenCalledWith('failed to open Platform Account settings', expect.any(Error))
    consoleError.mockRestore()
    const brand = b.slots.entries('sidebar.brand')[0]
    expect(brand?.select?.({} as never)).toEqual({})
    const footer = b.slots.entries('sidebar.footer.action').find(entry => entry.options.id === 'desktop-update')
    expect((footer?.inject as () => { hooks: { updater: unknown } } | undefined)?.()?.hooks.updater).toBeDefined()
    const pairing = b.slots.entries('settings.section').find(entry => entry.options.id === 'mobile-pairing')
    expect((pairing?.options.label as (() => string) | undefined)?.()).toBe('Mobile pairing')
    expect((pairing?.inject as () => { hooks: { pairing: unknown } } | undefined)?.()?.hooks.pairing).toBeDefined()
    await Promise.resolve()
    await Promise.resolve()
    await fiber.dispose()
    expect(b.ctx.get('projectMembershipClient')).toBeUndefined()
    expect(b.ctx.get('projectMembershipAccess')).toBeUndefined()

    const desktopWithoutMembership = { ...desktop }
    delete desktopWithoutMembership.projectMembership
    window.dshDesktop = desktopWithoutMembership
    const accessOnly = await bench()
    const accessOnlyFiber = accessOnly.ctx.plugin({ inject: [...inject], apply })
    await accessOnlyFiber.await()
    expect(accessOnly.ctx.get('projectMembershipAccess')).toBeDefined()
    expect(accessOnly.ctx.get('projectMembershipClient')).toBeUndefined()
    await accessOnlyFiber.dispose()
  })
})
