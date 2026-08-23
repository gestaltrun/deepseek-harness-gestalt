/** Deferred model-facing Consumer of the Browser Runtime capability. @module @deepseek-ai/dsh-tool-browser */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BrowserInstanceId,
  BrowserProfileId,
  BrowserProfileName,
  BrowserTabId,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser-runtime'
import type { BrowserCreateAttach, BrowserInputRequest, BrowserMutationRequest, BrowserTarget } from '@deepseek-ai/dsh-browser-runtime'
import type { BrowserWorkspaceBinder } from '@deepseek-ai/dsh-browser-workspace'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultBrowserCreateFromSettings } from './profile-default.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-browser'
/** Browser Runtime and tool registry required by this Consumer. */
export const inject = ['browserRuntime', 'tools']

const BROWSER_SETTINGS_NAMESPACE = 'ui-browser' as SettingsNamespace

/** Model-facing Browser tool configuration. */
export interface Config {
  /** Cooperative timeout budget in milliseconds for each Browser Runtime call. */
  readonly timeoutMs?: number
}

/** Runtime configuration schema for the Browser tool Consumer. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
})

const TARGET_PROPERTIES = {
  profileId: { type: 'string', required: true },
  workspaceId: { type: 'string', required: true },
  browserId: { type: 'string', required: true },
  tabId: { type: 'string', required: true },
} as const

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: TARGET_PROPERTIES,
} as const

const CHROME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['temporary', 'persistent', 'shared'] },
    name: { type: 'string' },
    partition: { type: 'string', required: true },
  },
} as const

const STORAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cookies: { type: 'string', required: true },
    localStorage: { type: 'string', required: true },
    indexedDb: { type: 'string', required: true },
    cache: { type: 'string', required: true },
    serviceWorker: { type: 'string', required: true },
  },
} as const

const OPEN_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'open' },
    target: { ...TARGET_SCHEMA, required: true },
    revision: { type: 'integer', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    text: { type: 'string', required: true },
    focused: { type: 'boolean', required: true },
    chrome: { ...CHROME_SCHEMA, required: true },
    storage: { ...STORAGE_SCHEMA, required: true },
  },
} as const

const CLOSED_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'closed' },
    target: { ...TARGET_SCHEMA, required: true },
    revision: { type: 'integer', required: true },
  },
} as const

const UNAVAILABLE_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'unavailable' },
    target: { ...TARGET_SCHEMA, required: true },
    revision: { type: 'integer', required: true },
    reason: { type: 'string', required: true, enum: ['crashed', 'unhealthy', 'reconnect-failed'] },
    reconnecting: { type: 'boolean', required: true },
  },
} as const

const STATE_SCHEMA = { oneOf: [OPEN_STATE_SCHEMA, UNAVAILABLE_STATE_SCHEMA, CLOSED_STATE_SCHEMA] } as const

const SCREENSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { ...TARGET_SCHEMA, required: true },
    revision: { type: 'integer', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    mediaType: { type: 'string', required: true, const: 'image/png' },
    data: { type: 'string', required: true },
  },
} as const

const TARGET_PARAMETER = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: TARGET_PROPERTIES,
} as const

/** Complete Browser facts are rendered into the durable ordinary tool result. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Convert an optional attach object into a branded Browser Runtime attach request. */
function attachFrom(raw: unknown): BrowserCreateAttach | undefined {
  if (raw === undefined) return undefined
  const value = raw as { kind: 'workspace' | 'browser'; workspaceId: string; browserId?: string }
  if (typeof value.workspaceId !== 'string' || value.workspaceId.trim().length === 0) {
    throw new Error('attach.workspaceId must be a non-empty Browser Workspace identity')
  }
  if (value.kind === 'workspace') {
    return { kind: 'workspace', workspaceId: BrowserWorkspaceId(value.workspaceId) }
  }
  if (typeof value.browserId !== 'string' || value.browserId.trim().length === 0) {
    throw new Error('attach.browserId must be a non-empty browser-instance identity')
  }
  return {
    kind: 'browser',
    workspaceId: BrowserWorkspaceId(value.workspaceId),
    browserId: BrowserInstanceId(value.browserId),
  }
}

/** Convert schema-validated model strings into the Service Definition's opaque identities. */
function targetFrom(raw: {
  profileId: string
  workspaceId: string
  browserId: string
  tabId: string
}): BrowserTarget {
  for (const [key, value] of Object.entries(raw)) {
    if (value.trim().length === 0) throw new Error(`${key} must be a non-empty Browser Runtime identity`)
  }
  return {
    profileId: BrowserProfileId(raw.profileId),
    workspaceId: BrowserWorkspaceId(raw.workspaceId),
    browserId: BrowserInstanceId(raw.browserId),
    tabId: BrowserTabId(raw.tabId),
  }
}

/** Reject revisions outside the Provider's non-negative safe-integer sequence. */
function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer')
  }
  return value
}

/**
 * Convert validated tool arguments into a branded mutation request.
 * @param args - Target identities and expected revision from the model.
 * @param signal - Cooperative cancellation from the tool execution.
 * @returns the Runtime mutation request.
 */
function mutationFrom(
  args: {
    target: { profileId: string; workspaceId: string; browserId: string; tabId: string }
    expectedRevision: number
  },
  signal: AbortSignal,
): BrowserMutationRequest {
  return {
    target: targetFrom(args.target),
    expectedRevision: revision(args.expectedRevision),
    signal,
  }
}

/** Build one non-empty synthetic input request after Consumer validation. */
/**
 * Route one Browser Runtime call through the Session binder when both are present.
 * @param ctx - Consumer context that may compose `browserWorkspace`.
 * @param exec - Tool execution carrying an optional calling Agent Session.
 * @param bound - Binder method to invoke when a Session is present.
 * @param unbound - Runtime method to invoke otherwise.
 * @param request - Operation request shared by both paths.
 * @returns the Runtime or Binder result.
 */
function routeBrowserCall<TRequest, TResult>(
  ctx: Context,
  exec: { agent?: { session?: Session } },
  bound: (workspace: BrowserWorkspaceBinder, request: TRequest & { session: Session }) => Promise<TResult>,
  unbound: (request: TRequest) => Promise<TResult>,
  request: TRequest,
): Promise<TResult> {
  const workspace = ctx.get('browserWorkspace')
  const session = workspace === undefined ? undefined : exec.agent?.session
  if (workspace === undefined || session === undefined) return unbound(request)
  return bound(workspace, { ...request, session })
}

/**
 * Register seven deferred Browser Runtime operations without presentation-specific cards.
 * @param ctx - Consumer context with Browser Runtime and tool registry services.
 * @param config - Per-call timeout configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tool-browser: config.timeoutMs must be a positive safe integer')
  }

  ctx.tools.register({
    ...defineTool({
      name: 'browser_create',
      description: 'Create one shared, temporary, or named persistent Browser Profile, Browser Workspace, browser instance, and tab. Omit profile to use the Browser settings default (shared unless that page changes it).',
      timeoutMs,
      parameters: {
        profile: { type: 'string', enum: ['temporary', 'persistent', 'shared'], description: 'Omit or shared reuses one identity across Sessions. persistent restores a named isolated Profile. temporary discards identity.' },
        name: { type: 'string', description: 'Named persistent Browser Profile. Required when profile is persistent.' },
        attach: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['workspace', 'browser'], description: 'workspace starts another instance; browser starts another tab.' },
            workspaceId: { type: 'string', description: 'Existing Browser Workspace to reuse.' },
            browserId: { type: 'string', description: 'Existing browser instance to reuse when kind is browser.' },
          },
          description: 'Attach a new instance or tab to an existing Session-owned hierarchy.',
        },
      },
      output: { schema: OPEN_STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const settingsDefault = defaultBrowserCreateFromSettings(
          ctx.get('settings')?.get(BROWSER_SETTINGS_NAMESPACE),
        )
        const profile = args.profile ?? settingsDefault.kind
        const attach = attachFrom(args.attach)
        if (profile === 'persistent') {
          const name = typeof args.name === 'string' && args.name.trim().length > 0
            ? args.name
            : settingsDefault.name
          if (name === undefined || name.trim().length === 0) {
            throw new Error('name must be a non-empty Browser Profile name')
          }
          return routeBrowserCall(
            ctx,
            exec,
            (workspace, request) => workspace.create(request),
            request => ctx.browserRuntime.create(request),
            {
              profile: 'persistent' as const,
              name: BrowserProfileName(name),
              ...attach === undefined ? {} : { attach },
              signal: exec.signal,
            },
          )
        }
        if (profile === 'temporary') {
          return routeBrowserCall(
            ctx,
            exec,
            (workspace, request) => workspace.create(request),
            request => ctx.browserRuntime.create(request),
            {
              profile: 'temporary' as const,
              ...attach === undefined ? {} : { attach },
              signal: exec.signal,
            },
          )
        }
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.create(request),
          request => ctx.browserRuntime.create(request),
          {
            profile: 'shared' as const,
            ...attach === undefined ? {} : { attach },
            signal: exec.signal,
          },
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_navigate',
      description: 'Navigate one browser tab to a URL using its latest revision.',
      timeoutMs,
      parameters: {
        target: TARGET_PARAMETER,
        expectedRevision: { type: 'integer', required: true, description: 'Latest revision returned by a browser operation.' },
        url: { type: 'string', required: true, description: 'URL to open in the browser tab.' },
      },
      output: { schema: OPEN_STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        if (args.url.trim().length === 0) throw new Error('url must be non-empty')
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.navigate(request),
          request => ctx.browserRuntime.navigate(request),
          {
            target: targetFrom(args.target),
            expectedRevision: revision(args.expectedRevision),
            url: args.url,
            signal: exec.signal,
          },
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_observe',
      description: 'Observe the latest facts for one browser tab, including a closed receipt.',
      timeoutMs,
      parameters: { target: TARGET_PARAMETER },
      output: { schema: STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.observe(request),
          request => ctx.browserRuntime.observe(request),
          { target: targetFrom(args.target), signal: exec.signal },
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_screenshot',
      description: 'Capture the deterministic PNG screenshot facts for one browser tab.',
      timeoutMs,
      parameters: { target: TARGET_PARAMETER },
      output: { schema: SCREENSHOT_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.screenshot(request),
          request => ctx.browserRuntime.screenshot(request),
          { target: targetFrom(args.target), signal: exec.signal },
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_focus',
      description: 'Focus one browser tab using its latest revision.',
      timeoutMs,
      parameters: {
        target: TARGET_PARAMETER,
        expectedRevision: { type: 'integer', required: true, description: 'Latest revision returned by a browser operation.' },
      },
      output: { schema: OPEN_STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.focus(request),
          request => ctx.browserRuntime.focus(request),
          mutationFrom(args, exec.signal),
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_input',
      description: 'Send synthetic Agent input to a browser tab using its latest revision.',
      timeoutMs,
      parameters: {
        target: TARGET_PARAMETER,
        expectedRevision: { type: 'integer', required: true, description: 'Latest revision returned by a browser operation.' },
        url: { type: 'string', description: 'Optional URL for the synthetic input.' },
        text: { type: 'string', description: 'Optional text for the synthetic input.' },
      },
      output: { schema: OPEN_STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        if (args.url !== undefined && args.url.trim().length === 0) throw new Error('url must be non-empty')
        if (args.text !== undefined && args.text.trim().length === 0) throw new Error('text must be non-empty')
        const base = mutationFrom(args, exec.signal)
        let request: BrowserInputRequest
        if (args.url === undefined) {
          if (args.text === undefined) throw new Error('browser_input requires url or text')
          request = { ...base, text: args.text }
        } else {
          request = {
            ...base,
            url: args.url,
            ...args.text === undefined ? {} : { text: args.text },
          }
        }
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.input(request),
          request => ctx.browserRuntime.input(request),
          request,
        )
      },
    }),
    deferLoading: true,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'browser_close',
      description: 'Close one browser tab using the latest revision. Temporary Profiles discard identity; named Profiles keep the persist partition.',
      timeoutMs,
      parameters: {
        target: TARGET_PARAMETER,
        expectedRevision: { type: 'integer', required: true, description: 'Latest revision returned by a browser operation.' },
      },
      output: { schema: CLOSED_STATE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        return routeBrowserCall(
          ctx,
          exec,
          (workspace, request) => workspace.close(request),
          request => ctx.browserRuntime.close(request),
          mutationFrom(args, exec.signal),
        )
      },
    }),
    deferLoading: true,
  })
}
