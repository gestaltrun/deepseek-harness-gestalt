/**
 * Browser plugin, browser half: official page chrome is mounted by the
 * workbench adapter inside the snapshot `browser` tab. This half keeps the
 * collapsed preview, Profile settings, and Remote unwrap helpers.
 * Live Workspace facts arrive through `useProjection('browserWorkspace')`.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-browser-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserPreview } from './BrowserPreview.tsx'
import { BrowserSettingsSection } from './BrowserSettingsSection.tsx'
import type { BrowserSettingsInjected } from './BrowserSettingsSection.tsx'
import { en, NS, zh, type BrowserKey } from './locales.ts'
import { unwrapRemote, type BrowserPreviewActions } from './slots.ts'
import {
  BROWSER_SETTINGS_NAMESPACE,
  DEFAULT_BROWSER_SETTINGS,
  isBrowserProfileName,
  type BrowserSettings,
} from '../browser-settings.ts'

export type { BrowserPageChromeActions, BrowserPreviewActions } from './slots.ts'
export { unwrapRemote } from './slots.ts'
export { BrowserPageChrome } from './BrowserPageChrome.tsx'
export type { BrowserPageChromeProps } from './BrowserPageChrome.tsx'
export type { BrowserKey } from './locales.ts'
export { listBrowserWorkspacePages } from '@deepseek-ai/dsh-browser-workspace/client'
export type { BrowserWorkspacePage } from '@deepseek-ai/dsh-browser-workspace/client'
export {
  BROWSER_SETTINGS_NAMESPACE,
  DEFAULT_BROWSER_SETTINGS,
  browserCreateRequestFromSettings,
} from '../browser-settings.ts'
export type { BrowserSettings } from '../browser-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser chrome and collapsed preview copy. */
    browser: BrowserKey
  }
}

/** Face the workbench adapter may publish for preview reveal. */
interface WorkbenchBrowserReveal {
  /** Expand the workbench and focus the active official page's sidebar tab. */
  reveal: (sessionId: string) => void
}

/** Required services for preview, Remote mutations, copy, and Profile settings. */
export const inject = [
  'slots', 'sessions', 'remote', 'remote.browserWorkspace', 'locale', 'settingsScope',
]

/**
 * Client plugin body: collapsed preview and Profile settings.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  const scope = ctx.settingsScope.bind<BrowserSettings>({ namespace: BROWSER_SETTINGS_NAMESPACE })
  const preferences = createSnapshotStore<BrowserSettings>({ ...DEFAULT_BROWSER_SETTINGS })
  const sync = (): void => {
    preferences.set({
      ...DEFAULT_BROWSER_SETTINGS,
      ...scope.getSnapshot().value,
    })
  }
  sync()
  ctx.effect(() => scope.subscribe(sync), 'ui-browser: settings sync')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'browser',
    order: 35,
    label: () => ctx.locale.bind(NS)('settings.nav'),
    locale: NS,
    inject: (): BrowserSettingsInjected => ({
      hooks: { settings: preferences },
      setDefaultKind: (kind) => { void scope.set('defaultKind', kind) },
      setDefaultPersistentName: (name) => { void scope.set('defaultPersistentName', name) },
      addNamedProfile: (name) => {
        if (!isBrowserProfileName(name)) return
        const current = preferences.getSnapshot()
        if (current.namedProfiles.includes(name)) return
        void scope.set('namedProfiles', [...current.namedProfiles, name])
      },
      removeNamedProfile: (name) => {
        const current = preferences.getSnapshot()
        void scope.set('namedProfiles', current.namedProfiles.filter(entry => entry !== name))
        if (current.defaultPersistentName === name) void scope.set('defaultPersistentName', '')
      },
    }),
  }, BrowserSettingsSection))

  ctx.slots.inject('conversation.browser.preview', () => ctx.slots.register({
    name: 'conversation.browser.preview',
    locale: NS,
    inject: (sessionId: SessionId): BrowserPreviewActions => ({
      reveal: () => {
        const workbench = ctx.get('workbenchBrowser') as WorkbenchBrowserReveal | undefined
        workbench?.reveal(sessionId)
      },
      focus: (target, expectedRevision) =>
        unwrapRemote(ctx.remote.browserWorkspace.focus(sessionId, target, expectedRevision)),
      observe: target => unwrapRemote(ctx.remote.browserWorkspace.observe(sessionId, target)),
      screenshot: target => unwrapRemote(ctx.remote.browserWorkspace.screenshot(sessionId, target)),
    }),
  }, BrowserPreview))
}
