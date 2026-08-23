/**
 * Loopback HTTP adapter that exposes Tandem's operation vocabulary over the
 * in-process Electron Browser Runtime. The package root re-exports this
 * module; it has no subpath export of its own.
 * @module
 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertBrowserProfileName,
  BrowserRuntimeError,
  requireExpectedBrowserRevision,
  type BrowserCreateRequest,
  type BrowserPageState,
  type BrowserProfileName,
  type BrowserRuntime,
  type BrowserTarget,
} from '@deepseek-ai/dsh-browser-runtime'
import { TANDEM_UPSTREAM_VERSION } from './protocol.ts'

/** Bound loopback HTTP server that speaks Tandem's session/tab protocol. */
export interface ElectronBrowserHttpServer {
  /** Absolute loopback origin, including the assigned port. */
  readonly origin: string
  /** Local file that stores the generated bearer token. */
  readonly tokenFile: string
  /** Close the listener and remaining sockets. */
  close(): Promise<void>
}

interface TabRecord {
  readonly id: string
  readonly target: BrowserTarget
  revision: number
}

interface SessionRecord {
  readonly name: string
  readonly persistent: boolean
  readonly shared: boolean
  readonly profileName?: BrowserProfileName
  readonly tabs: Map<string, TabRecord>
}

/** JSON object decoded from one HTTP body. */
type JsonObject = Record<string, unknown>

/** Read one request body as UTF-8 JSON. */
async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrowserRuntimeError('HTTP request body must be an object', 'BROWSER_PROTOCOL')
  }
  return parsed as JsonObject
}

/** Write one JSON response. */
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

/** Inventory object matching Tandem's tab list fields. */
function inventoryTab(id: string, page: BrowserPageState, active: boolean) {
  return {
    id,
    webContentsId: 1,
    title: page.title,
    url: page.url,
    favicon: '',
    groupId: null,
    active,
    createdAt: 0,
    source: 'session',
    pinned: false,
    partition: page.chrome.partition,
    emoji: null,
    emojiFlash: null,
  }
}

/** True when the session name is this Provider's temporary Profile form. */
function isTemporarySessionName(sessionName: string, idPrefix: string): boolean {
  return sessionName.startsWith(`${idPrefix}-tmp-`) && /^.+-tmp-\d+$/.test(sessionName)
}

function isSharedSessionName(sessionName: string, idPrefix: string): boolean {
  return sessionName === `${idPrefix}-shared`
}

/**
 * Recover the persistent Profile name from a Provider-owned session name.
 * Named sessions are `${idPrefix}-${profileName}`; a name without the prefix
 * is the Profile name itself.
 */
function persistentNameFromSession(sessionName: string, idPrefix: string): BrowserProfileName {
  const prefix = `${idPrefix}-`
  const profileName = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : sessionName
  return assertBrowserProfileName(profileName)
}

/** Read a required safe-integer revision from one mutation body. */
function requiredRevision(input: JsonObject): number {
  const value = input.expectedRevision
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BrowserRuntimeError('expectedRevision must be a safe integer', 'BROWSER_PROTOCOL')
  }
  return value
}

/** Parse non-empty synthetic Agent input at the HTTP boundary. */
function inputFields(input: JsonObject):
  | { readonly url: string; readonly text?: string }
  | { readonly url?: string; readonly text: string } {
  const url = typeof input.url === 'string' && input.url.length > 0 ? input.url : undefined
  const text = typeof input.text === 'string' && input.text.length > 0 ? input.text : undefined
  if (url !== undefined) return { url, ...(text === undefined ? {} : { text }) }
  if (text !== undefined) return { text }
  throw new BrowserRuntimeError('input requires a non-empty url or text', 'BROWSER_PROTOCOL')
}

/** Read an optional safe-integer revision, or the HTTP tab's last committed value. */
function optionalRevision(input: JsonObject, fallback: number): number {
  const value = input.expectedRevision
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BrowserRuntimeError('expectedRevision must be a safe integer', 'BROWSER_PROTOCOL')
  }
  return value
}

/**
 * Drive one Electron mutation only when the client revision matches the
 * engine. The committed revision is the engine's, never a client-side +1.
 */
async function mutateOpenPage(
  runtime: BrowserRuntime,
  target: BrowserTarget,
  clientRevision: number,
  operate: (expectedRevision: number) => Promise<BrowserPageState>,
): Promise<BrowserPageState> {
  const current = await runtime.observe({ target })
  if (current.status !== 'open') {
    throw new BrowserRuntimeError('tab is not open', 'BROWSER_NOT_OPEN')
  }
  requireExpectedBrowserRevision(current, clientRevision)
  return operate(clientRevision)
}

/** Remember the engine revision as the HTTP tab's last committed value. */
function rememberRevision(tab: TabRecord, page: BrowserPageState): number {
  tab.revision = page.revision
  return page.revision
}

/** Map a Browser Runtime failure onto an HTTP status. */
function failureStatus(error: BrowserRuntimeError): number {
  switch (error.code) {
    case 'BROWSER_PROFILE_NAME':
    case 'BROWSER_PROTOCOL':
      return 400
    case 'BROWSER_NOT_FOUND':
    case 'BROWSER_NOT_OPEN':
      return 404
    case 'BROWSER_PROFILE_BUSY':
    case 'BROWSER_REVISION_CONFLICT':
      return 409
    default:
      return 500
  }
}

/**
 * Bind one loopback HTTP server over an in-process Electron Browser Runtime.
 * @param options - Runtime, token file, identity prefix, and optional bind host and port.
 * @returns origin, token file, and closer for the bound listener.
 */
export async function listenElectronBrowserHttp(options: {
  readonly runtime: BrowserRuntime
  readonly tokenFile: string
  readonly idPrefix?: string
  readonly host?: string
  readonly port?: number
}): Promise<ElectronBrowserHttpServer> {
  const token = randomBytes(24).toString('hex')
  const idPrefix = options.idPrefix ?? 'electron'
  await mkdir(dirname(options.tokenFile), { recursive: true })
  await writeFile(options.tokenFile, `${token}\n`, { mode: 0o600 })
  const sessions = new Map<string, SessionRecord>()
  let tabSeq = 0

  const findTab = (tabId: string): { session: SessionRecord; tab: TabRecord } | undefined => {
    for (const session of sessions.values()) {
      const tab = session.tabs.get(tabId)
      if (tab !== undefined) return { session, tab }
    }
    return undefined
  }

  const listedTabs = async () => {
    const tabs = []
    for (const session of sessions.values()) {
      for (const tab of session.tabs.values()) {
        const state = await options.runtime.observe({ target: tab.target })
        if (state.status === 'open') tabs.push(inventoryTab(tab.id, state, true))
      }
    }
    return tabs
  }

  const createOrAttach = async (sessionName: string, url: string | undefined): Promise<{
    session: SessionRecord
    tab: TabRecord
    page: BrowserPageState
  }> => {
    const existing = sessions.get(sessionName)
    const firstTab = existing === undefined ? undefined : [...existing.tabs.values()][0]
    let request: BrowserCreateRequest
    if (existing !== undefined && firstTab !== undefined) {
      request = existing.shared
        ? {
          profile: 'shared',
          attach: { kind: 'workspace', workspaceId: firstTab.target.workspaceId },
        }
        : existing.persistent && existing.profileName !== undefined
          ? {
            profile: 'persistent',
            name: existing.profileName,
            attach: { kind: 'workspace', workspaceId: firstTab.target.workspaceId },
          }
          : {
            profile: 'temporary',
            attach: { kind: 'workspace', workspaceId: firstTab.target.workspaceId },
          }
    } else if (isTemporarySessionName(sessionName, idPrefix)) {
      request = { profile: 'temporary' }
    } else if (isSharedSessionName(sessionName, idPrefix)) {
      request = { profile: 'shared' }
    } else {
      request = { profile: 'persistent', name: persistentNameFromSession(sessionName, idPrefix) }
    }
    let page = await options.runtime.create(request)
    if (url !== undefined && url !== page.url) {
      page = await options.runtime.navigate({
        target: page.target,
        expectedRevision: page.revision,
        url,
      })
    }
    tabSeq += 1
    const tabId = `electron-tab-${String(tabSeq)}`
    const tab: TabRecord = { id: tabId, target: page.target, revision: page.revision }
    const session = existing ?? {
      name: sessionName,
      persistent: request.profile !== 'temporary',
      shared: request.profile === 'shared',
      ...(request.profile === 'persistent' ? { profileName: request.name } : {}),
      tabs: new Map<string, TabRecord>(),
    }
    session.tabs.set(tabId, tab)
    sessions.set(sessionName, session)
    return { session, tab, page }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url as string, 'http://127.0.0.1')
    if (url.pathname === '/agent/version') {
      json(response, 200, {
        name: 'tandem-browser',
        version: TANDEM_UPSTREAM_VERSION,
        capabilityFamilies: ['tabs', 'sessions'],
        transports: ['http'],
      })
      return
    }
    if (url.pathname === '/status') {
      const tabs = await listedTabs()
      json(response, 200, {
        ready: true,
        url: tabs.at(-1)?.url ?? 'about:blank',
        title: tabs.at(-1)?.title ?? 'New Tab',
        loading: false,
        activeTab: tabs.at(-1) ?? null,
        tabs,
        version: TANDEM_UPSTREAM_VERSION,
      })
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: 'Unauthorized' })
      return
    }
    if (request.method === 'POST' && url.pathname === '/sessions/create') {
      const input = await readJson(request)
      const name = typeof input.name === 'string' ? input.name : ''
      if (name.length === 0) {
        json(response, 400, { error: 'name is required' })
        return
      }
      const requestedUrl = typeof input.url === 'string' && input.url.length > 0 ? input.url : undefined
      const created = await createOrAttach(name, requestedUrl)
      json(response, 200, {
        ok: true,
        name,
        partition: created.page.chrome.partition,
        revision: created.page.revision,
        tab: inventoryTab(created.tab.id, created.page, true),
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/navigate') {
      const input = await readJson(request)
      const tabId = typeof input.tabId === 'string' ? input.tabId : ''
      const nextUrl = typeof input.url === 'string' ? input.url : ''
      const found = findTab(tabId)
      if (found === undefined) {
        json(response, 404, { error: `tab ${tabId} does not exist` })
        return
      }
      const clientRevision = optionalRevision(input, found.tab.revision)
      const navigated = await mutateOpenPage(options.runtime, found.tab.target, clientRevision, expectedRevision => (
        options.runtime.navigate({
          target: found.tab.target,
          expectedRevision,
          url: nextUrl,
        })
      ))
      json(response, 200, {
        ok: true,
        url: navigated.url,
        tab: found.tab.id,
        revision: rememberRevision(found.tab, navigated),
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/input') {
      const input = await readJson(request)
      const tabId = typeof input.tabId === 'string' ? input.tabId : ''
      const found = findTab(tabId)
      if (found === undefined) {
        json(response, 404, { error: `tab ${tabId} does not exist` })
        return
      }
      const clientRevision = requiredRevision(input)
      const fields = inputFields(input)
      const typed = await mutateOpenPage(options.runtime, found.tab.target, clientRevision, expectedRevision => (
        options.runtime.input({
          target: found.tab.target,
          expectedRevision,
          ...fields,
        })
      ))
      json(response, 200, {
        ok: true,
        revision: rememberRevision(found.tab, typed),
        url: typed.url,
        title: typed.title,
        text: typed.text,
        tab: found.tab.id,
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/tabs/list') {
      json(response, 200, { tabs: await listedTabs(), groups: [] })
      return
    }
    if (request.method === 'GET' && url.pathname === '/page-content') {
      const tabId = request.headers['x-tab-id']
      const found = typeof tabId === 'string' ? findTab(tabId) : undefined
      if (found === undefined) {
        json(response, 404, { error: 'tab does not exist' })
        return
      }
      const state = await options.runtime.observe({ target: found.tab.target })
      if (state.status !== 'open') {
        json(response, 404, { error: 'tab is not open' })
        return
      }
      rememberRevision(found.tab, state)
      json(response, 200, {
        title: state.title,
        url: state.url,
        description: '',
        text: state.text,
        length: state.text.length,
        storage: state.storage,
        revision: state.revision,
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/screenshot') {
      const tabId = request.headers['x-tab-id']
      const found = typeof tabId === 'string' ? findTab(tabId) : undefined
      if (found === undefined) {
        json(response, 404, { error: 'tab does not exist' })
        return
      }
      const shot = await options.runtime.screenshot({ target: found.tab.target })
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.from(shot.data, 'base64'))
      return
    }
    if (request.method === 'POST' && url.pathname === '/tabs/focus') {
      const input = await readJson(request)
      const tabId = typeof input.tabId === 'string' ? input.tabId : ''
      const found = findTab(tabId)
      if (found === undefined) {
        json(response, 404, { error: `tab ${tabId} does not exist` })
        return
      }
      const clientRevision = optionalRevision(input, found.tab.revision)
      const focused = await mutateOpenPage(options.runtime, found.tab.target, clientRevision, expectedRevision => (
        options.runtime.focus({
          target: found.tab.target,
          expectedRevision,
        })
      ))
      json(response, 200, { ok: true, revision: rememberRevision(found.tab, focused) })
      return
    }
    if (request.method === 'POST' && url.pathname === '/sessions/destroy') {
      const input = await readJson(request)
      const name = typeof input.name === 'string' ? input.name : ''
      const session = sessions.get(name)
      if (session === undefined) {
        json(response, 404, { error: `Session ${name} does not exist` })
        return
      }
      for (const tab of session.tabs.values()) {
        const state = await options.runtime.observe({ target: tab.target })
        if (state.status !== 'closed') {
          await options.runtime.close({ target: tab.target, expectedRevision: state.revision })
        }
      }
      sessions.delete(name)
      json(response, 200, { ok: true, name })
      return
    }
    json(response, 404, { error: `route not found: ${String(request.method)} ${url.pathname}` })
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof BrowserRuntimeError) {
        json(response, failureStatus(error), { error: error.message, code: error.code })
        return
      }
      json(response, 500, { error: (error as Error).message })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    tokenFile: options.tokenFile,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    }),
  }
}
