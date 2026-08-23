/**
 * Resolve a `browser_*` tool call's page and focus it from the Session
 * listing revision.
 */
import type { ConversationSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { findToolCall } from './tool-node-reader.ts'

/** Opaque Browser Runtime identities carried on tool args and results. */
export interface BrowserTabIdentity {
  readonly profileId: string
  readonly workspaceId: string
  readonly browserId: string
  readonly tabId: string
}

/** Focus one listed tab. Implementations close over Session and Remote. */
export type ListedBrowserTabFocus = (
  target: BrowserTabIdentity,
  expectedRevision: number,
) => Promise<unknown>

/**
 * True when the wire tool name is a Browser Runtime Consumer.
 * @param name - tool name from the call or settled result.
 * @returns whether the name uses the `browser_` prefix.
 */
export function isBrowserToolName(name: string): boolean {
  return name.startsWith('browser_')
}

/**
 * Read the Browser tab identity from a `browser_*` call's args or result.
 * Args win when they already name a complete target (`browser_navigate`);
 * `browser_create` carries the minted target only on the settled result.
 * @param block - running call or settled result.
 * @returns the four identities, or undefined when the call is not a Browser
 * tool or the payload does not yet name a complete target.
 */
export function browserTabIdentityFromTool(block: ToolCallBlock): BrowserTabIdentity | undefined {
  const name = 'kind' in block ? block.call?.name ?? '' : block.name
  if (!isBrowserToolName(name)) return undefined
  const argsRaw = 'kind' in block ? block.call?.argsRaw ?? null : block.argsRaw
  const fromArgs = argsRaw === null ? undefined : identityFrom(parseJson(argsRaw))
  if (fromArgs !== undefined) return fromArgs
  if (!('kind' in block)) return undefined
  for (const item of block.content) {
    if (item.type !== 'text') continue
    const fromResult = identityFrom(parseJson(item.text))
    if (fromResult !== undefined) return fromResult
  }
  return undefined
}

/**
 * Read the listing revision for one complete tab identity.
 * @param listing - `browserWorkspace` projection value, or absent.
 * @param target - complete tab identity from the tool payload.
 * @returns the listed revision, or undefined when that tab is gone.
 */
export function listedBrowserTabRevision(
  listing: unknown,
  target: BrowserTabIdentity,
): number | undefined {
  if (listing === null || typeof listing !== 'object') return undefined
  const workspaces = (listing as { workspaces?: unknown }).workspaces
  if (!Array.isArray(workspaces)) return undefined
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== 'object') continue
    const record = workspace as Record<string, unknown>
    if (record.workspaceId !== target.workspaceId || record.profileId !== target.profileId) continue
    const browsers = record.browsers
    if (!Array.isArray(browsers)) continue
    for (const browser of browsers) {
      if (browser === null || typeof browser !== 'object') continue
      const instance = browser as Record<string, unknown>
      if (instance.browserId !== target.browserId) continue
      const tabs = instance.tabs
      if (!Array.isArray(tabs)) continue
      for (const tab of tabs) {
        if (tab === null || typeof tab !== 'object') continue
        const row = tab as Record<string, unknown>
        if (row.tabId !== target.tabId) continue
        return typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0
          ? row.revision
          : undefined
      }
    }
  }
  return undefined
}

/**
 * Focus the listed Browser tab for a selected `browser_*` call when that tab
 * still exists. Does not call focus when the tab is gone, the Remote is
 * absent, or the payload names no target.
 * @param input.snapshot - current Conversation snapshot.
 * @param input.listing - `browserWorkspace` projection value.
 * @param input.callId - selected tool call, when the selection names one.
 * @param input.focus - Remote focus closed over the current Session.
 */
export function focusListedBrowserTab(input: {
  snapshot: ConversationSnapshot
  listing: unknown
  callId: string | undefined
  focus: ListedBrowserTabFocus | undefined
}): void {
  if (input.callId === undefined || input.focus === undefined) return
  const block = findToolCall(input.snapshot, input.callId)
  if (block === undefined) return
  const target = browserTabIdentityFromTool(block)
  if (target === undefined) return
  const revision = listedBrowserTabRevision(input.listing, target)
  if (revision === undefined) return
  const focus = input.focus
  void Promise.resolve(focus(target, revision)).catch(() => {
    // Remote conflict or transport failure: details already opened; no second chrome.
  })
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Streaming fragment or non-JSON tool text: no target to resolve.
    return undefined
  }
}

function identityFrom(value: unknown): BrowserTabIdentity | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const nested = record.target
  const source = nested !== undefined && typeof nested === 'object' && nested !== null
    ? nested as Record<string, unknown>
    : record
  const profileId = source.profileId
  const workspaceId = source.workspaceId
  const browserId = source.browserId
  const tabId = source.tabId
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined
  if (typeof browserId !== 'string' || browserId.length === 0) return undefined
  if (typeof tabId !== 'string' || tabId.length === 0) return undefined
  return { profileId, workspaceId, browserId, tabId }
}
