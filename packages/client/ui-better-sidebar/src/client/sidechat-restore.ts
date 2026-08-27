/** Apply-world reconciliation of durable Side Chat threads into sidebar state. */
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { restorableSideThreads } from './subagent-detect.ts'

/**
 * Subscribe to the Session and Workspace projections that jointly authorize restoration.
 * @param ctx - Client services owning the two projection sources.
 * @param store - Per-session sidebar state owner.
 * @returns Disposer for both projection subscriptions.
 */
export function subscribeSideThreadRestoration(ctx: Context, store: SidebarStore): () => void {
  const reconcile = (): void => {
    const sessions = ctx.sessions.list.getSnapshot()
    const sessionId = sessions.current
    if (sessionId === undefined) return
    store.restoreSideThreadsFor(sessionId, restorableSideThreads(
      sessions.byId,
      sessionId,
      ctx.workspaces.list.getSnapshot(),
    ))
  }
  const unsubscribeSessions = ctx.sessions.list.subscribe(reconcile)
  const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(reconcile)
  reconcile()
  return () => {
    unsubscribeWorkspaces()
    unsubscribeSessions()
  }
}
