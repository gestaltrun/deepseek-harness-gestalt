/** Web subagent catalog, navigation, and addressed-session composer owner. */
import type {
  ClientContext, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  SubagentHeaderAction, SubagentHeaderLineage, type SubagentCatalogInjected,
} from './SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type SubagentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent catalog and read-only composer copy. */
    'subagent': SubagentKey
  }
}

export type {
  SubagentCatalogInjected, SubagentHeaderLineageProps,
} from './SubagentHeaderLineage.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/** Required services for conversation slots and session navigation. */
export const inject = ['sessions', 'slots', 'locale']

/** Durable Side Chat label prefix; catalog rows with this title open as sidebar tabs. */
const SIDE_LABEL_PREFIX = 'Side: '

/** Optional Better Sidebar face used to open Side Chat rows without changing shell selection. */
interface SidebarOpenFace {
  isTabEnabled?(id: string): boolean
  setPanelOpen?(open: boolean): void
  openTab?(
    seed: { type: string; id?: string; title?: string; meta?: unknown },
    scope?: { sessionId: SessionId },
  ): void
}

/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  if (subagent.parentAvailable) return null
  // A RUNNING parent-offline continuable child keeps the default composer:
  // its input is disabled there, but the same primary Stop stays available so
  // the child can be interrupted. Once it stops, this takeover returns.
  return owner.session?.running === true ? null : { reason: 'parent-unavailable' }
}

/**
 * Client plugin body: register the subagent catalog and read-only composer seats.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent: dictionaries')
  const sessions = ctx.sessions
  const openCatalogChild = (address: SubagentAddress): void => {
    const list = sessions.list.getSnapshot()
    const summary = list.byId[address.childSessionId]
    const catalogLabel = list.subagentsByParent?.[address.parentSessionId]?.entries
      .find(entry => entry.kind === 'child' && entry.id === address.childSessionId)
    const label = summary?.displayTitle
      ?? (catalogLabel?.kind === 'child' ? catalogLabel.label : undefined)
    if (label?.startsWith(SIDE_LABEL_PREFIX)) {
      // Optional at gesture time: this package does not inject betterSidebar.
      const sidebar = ctx.get('betterSidebar') as SidebarOpenFace | undefined
      if (sidebar?.openTab !== undefined && sidebar.isTabEnabled?.('sidechat') !== false) {
        const title = label.slice(SIDE_LABEL_PREFIX.length)
        if (list.current !== address.parentSessionId) sessions.open(address.parentSessionId)
        sidebar.setPanelOpen?.(true)
        sidebar.openTab({
          type: 'sidechat',
          id: `sidechat:${address.childSessionId}`,
          title,
          meta: { threadId: address.childSessionId },
        }, { sessionId: address.parentSessionId })
        return
      }
    }
    sessions.openSubagent(address)
  }
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild(address: SubagentAddress) {
      openCatalogChild(address)
    },
    refresh(parentSessionId: SessionId) {
      void sessions.refreshSubagents(parentSessionId)
    },
    setCatalogOpen(parentSessionId: SessionId, open: boolean) {
      sessions.setSubagentCatalogOpen(parentSessionId, open)
    },
  })
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => ctx.slots.register({
      name: 'conversation.session.header.lineage',
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderLineage),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'subagent-descendants',
      order: 10,
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderAction),
  )
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}
