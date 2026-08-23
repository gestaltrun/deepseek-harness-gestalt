// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import {
  apply as applySettingsBase,
  inject as settingsBaseInject,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  apply as applySettings,
  inject as settingsInject,
} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { SettingsRootInjected } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/shell-contract.ts'
import { apply as applyDesktop, inject as desktopInject } from '@deepseek-ai/dsh-client-ui-desktop/client'
import { AccountControl } from '../src/client/AccountControl.tsx'
import type { AccountControlInjected } from '../src/client/AccountControl.tsx'
import type { DesktopAccountSnapshot, DesktopBridge, DesktopPairingSnapshot } from '../src/protocol.ts'

usePinnedBrowserLanguages('zh-CN')

afterEach(() => {
  cleanup()
  delete window.dshDesktop
})

describe('Desktop Settings shell Mobile Access placement', () => {
  it('places Mobile Access only in the 手机配对 Settings section', async () => {
    const assembled = await assemble()
    const sections = assembled.slots.entries('settings.section')
    expect(sections.map(entry => entry.options.id)).toEqual(['general', 'mobile-pairing'])
    expect(resolveSlotLabel(sections[0]!.options.label)).toBe('通用设置')
    expect(resolveSlotLabel(sections[1]!.options.label)).toBe('手机配对')
    expect(sections.find(entry => entry.options.id === 'mobile-pairing')?.component).toBe(AccountControl)
    expect(assembled.slots.entries('sidebar.brand').length).toBeGreaterThan(0)
    expect(assembled.slots.entries('sidebar.footer.action').map(entry => entry.options.id)).toContain('desktop-update')

    await vi.waitFor(() => {
      expect(assembled.pairingInject().hooks.account.getSnapshot().status).toBe('signed-in')
      expect(assembled.pairingInject().hooks.pairing.getSnapshot().enabled).toBe(false)
    })

    const unused = (() => { throw new Error('unused by SettingsRoot') }) as never
    const shell = assembled.slots.entries('sidebar.settings')[0]
    if (shell === undefined) throw new Error('Settings shell was not registered')
    const Shell = shell.component as ComponentType<Record<string, unknown>>
    const injected = assembled.shellInject()
    // This assertion exercises section placement in the in-page shell. The
    // Desktop overlay transport has separate Host/overlay integration specs.
    delete (window.dshDesktop as unknown as Record<string, unknown>).chromeOverlayShow
    render(
      <Shell
        wide
        useSessions={(select: (state: unknown) => unknown) => select({
          phase: 'ready',
          current: 'active-session',
          byId: { 'active-session': { blank: false } },
        })}
        useWorkspaces={unused}
        useOnboardingSteps={(select: (rows: unknown) => unknown) => select(injected.hooks.onboardingSteps.getSnapshot())}
        useSections={(select: (rows: unknown) => unknown) => select(injected.hooks.sections.getSnapshot())}
        renderSlot={(key: string, owner: object, opts?: { only?: string }) =>
          renderRegistered(assembled.slots, assembled.locale, unused, key, owner, opts)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('button', { name: '手机配对' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBe('true')
    expect(screen.queryByRole('switch', { name: 'Mobile Access' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '手机配对' }))
    const access = screen.getByRole('switch', { name: 'Mobile Access' })
    expect(access.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(access)
    expect(assembled.desktop.pairingSetEnabled).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: '通用设置' }))
    expect(screen.queryByRole('switch', { name: 'Mobile Access' })).toBeNull()
    await assembled.fiber.dispose()
  })
})

function snapshotSource(
  injected: Record<string, unknown> | undefined,
  name: string,
): { getSnapshot: () => unknown } | undefined {
  if (injected === undefined || !('hooks' in injected) || typeof injected.hooks !== 'object' || injected.hooks === null) {
    return undefined
  }
  const source = (injected.hooks as Record<string, { getSnapshot?: () => unknown } | undefined>)[name]
  if (typeof source?.getSnapshot !== 'function') return undefined
  return { getSnapshot: source.getSnapshot }
}

function renderRegistered(
  slots: SlotRegistry,
  locale: LocaleRuntime,
  unused: never,
  key: string,
  owner: object,
  opts?: { only?: string },
): ReactNode {
  if (key === 'settings.action') return null
  const entries = slots.entries(key as never)
  const entry = opts?.only === undefined
    ? entries[0]
    : entries.find(item => item.options.id === opts.only)
  if (entry === undefined) return null
  const Component = entry.component as ComponentType<Record<string, unknown>>
  const injected = entry.inject?.()
  const t = entry.locale !== undefined ? locale.bind(entry.locale) : undefined
  const useHook = (name: string) => {
    const source = snapshotSource(injected, name)
    if (source === undefined) return undefined
    return (select: (snapshot: unknown) => unknown) => select(source.getSnapshot())
  }
  return (
    <Component
      t={t}
      useSessions={unused}
      useWorkspaces={unused}
      useAccount={useHook('account')}
      usePairing={useHook('pairing')}
      renderSlot={() => null}
      {...owner}
    />
  )
}

async function assemble() {
  const account: DesktopAccountSnapshot = {
    status: 'signed-in',
    privacyAccepted: true,
    account: {
      id: 'account-1',
      githubId: 1,
      githubLogin: 'octocat',
      avatarUrl: 'https://avatars.example/octocat',
    },
  }
  const pairing: DesktopPairingSnapshot = { status: 'ready', enabled: false, pairings: [] }
  const desktop = bridge(account, pairing)
  window.dshDesktop = desktop
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('connection', {
    api: {
      settings: {
        describe: vi.fn(async () => ({
          rpcId: 'settings-general',
          result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } },
        })),
        openDocument: vi.fn(async () => ({
          rpcId: 'settings-open',
          result: { ok: true, value: { opened: true } },
        })),
      },
    },
    isLoopback: true,
  } as never)
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsBaseInject], apply: applySettingsBase }).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    {
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
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
  await ctx.plugin({ inject: [...settingsInject], apply: applySettings }).await()
  const fiber = ctx.plugin({ inject: [...desktopInject], apply: applyDesktop })
  await fiber.await()
  return {
    desktop,
    locale,
    slots,
    fiber,
    shellInject: () => (slots.entries('sidebar.settings')[0]!.inject as () => SettingsRootInjected)(),
    pairingInject: () => (
      slots.entries('settings.section').find(entry => entry.options.id === 'mobile-pairing')!.inject as () => AccountControlInjected
    )(),
  }
}

function bridge(account: DesktopAccountSnapshot, pairing: DesktopPairingSnapshot): DesktopBridge {
  return {
    platform: 'darwin',
    getStatus: async () => ({ state: 'idle', lastCheckedAt: null }),
    checkNow: vi.fn(),
    downloadNow: vi.fn(),
    quitAndInstall: vi.fn(),
    onStatus: () => () => {},
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    accountGetSnapshot: vi.fn().mockResolvedValue(account),
    accountAcceptPrivacy: vi.fn(),
    accountBeginLogin: vi.fn(),
    accountSignOut: vi.fn(),
    onAccountSnapshot: vi.fn(() => () => {}),
    pairingGetSnapshot: vi.fn().mockResolvedValue(pairing),
    pairingSetEnabled: vi.fn(),
    pairingCreateChallenge: vi.fn(),
    pairingCancelChallenge: vi.fn(),
    pairingConfirm: vi.fn(),
    pairingReject: vi.fn(),
    pairingRevoke: vi.fn(),
    onPairingSnapshot: vi.fn(() => () => {}),
    chromeOverlayShow: async () => {},
    chromeOverlayHide: async () => {},
    chromeOverlayGetState: async () => null,
    chromeOverlayResult: () => {},
    onChromeOverlayState: () => () => {},
    onChromeOverlayResult: () => () => {},
  }
}
