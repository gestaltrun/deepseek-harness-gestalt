/** Authenticated loopback projection of Desktop-owned Project Membership reads for the Web Host agent plane. */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import {
  localWorkspaceRemoteUrl, normalizeGitRemoteUrl, type ProjectId, type ProjectMembershipClient,
} from '@deepseek-ai/dsh-project-membership-client'
import type { DesktopAccountActions } from './platform-account.ts'

const MAX_REQUEST_BYTES = 16 * 1_024

/** Running read-only Desktop Project Membership bridge. */
export interface DesktopProjectMembershipAgentRuntime {
  /** Loopback origin consumed only by the child Web Host. */
  readonly origin: string
  /** Owner-only bearer-token file read by the child Web Host. */
  readonly tokenFile: string
  /** Stop admission, await active reads, close the listener, and remove the token. */
  dispose(): Promise<void>
}

/** Dependencies retained behind the Desktop Host process boundary. */
export interface DesktopProjectMembershipAgentRuntimeOptions {
  /** Electron userData root that owns the private token directory. */
  readonly userData: string
  /** Current Desktop Account controller lookup, sampled once per request. */
  readonly account: () => DesktopAccountActions
  /** Bind an authenticated membership client to the sampled Account and bridge lifecycle. */
  readonly membership: (expectedAccountId: string, signal: AbortSignal) => ProjectMembershipClient
  /** Injectable Workspace Git remote lookup. */
  readonly gitRemote?: (cwd: string, signal: AbortSignal) => Promise<string | undefined>
}

/**
 * Publish the minimum authenticated read face required by `project_members` and routed-ask origin construction.
 * @param options - Desktop-owned Account, membership client, storage root, and optional Git adapter.
 * @returns loopback origin, token file, and quiescent disposer.
 */
export async function startDesktopProjectMembershipAgentRuntime(
  options: DesktopProjectMembershipAgentRuntimeOptions,
): Promise<DesktopProjectMembershipAgentRuntime> {
  const tokenDir = join(options.userData, 'project-membership-agent-runtime')
  const tokenFile = join(tokenDir, 'api-token')
  const token = randomBytes(32).toString('base64url')
  await mkdir(tokenDir, { recursive: true, mode: 0o700 })
  const tokenDirectory = await lstat(tokenDir)
  if (!tokenDirectory.isDirectory() || tokenDirectory.isSymbolicLink()) {
    throw new Error('Desktop Project Membership agent token path must be a directory')
  }
  await chmod(tokenDir, 0o700)
  await rm(tokenFile, { force: true })
  await writeFile(tokenFile, `${token}\n`, { flag: 'wx', mode: 0o600 })
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const requestController = new AbortController()
    const abortRequest = (): void => {
      if (!response.writableEnded) requestController.abort(new Error('Desktop Project Membership client disconnected'))
    }
    response.once('close', abortRequest)
    const requestSignal = AbortSignal.any([lifecycle.signal, requestController.signal])
    const task = handleRequest(request, response, token, options, requestSignal).catch((error: unknown) => {
      if (lifecycle.signal.aborted) {
        response.destroy()
        return
      }
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    })
    active.add(task)
    void task.then(
      () => {
        response.off('close', abortRequest)
        active.delete(task)
      },
      () => {
        response.off('close', abortRequest)
        active.delete(task)
      },
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await rm(tokenFile, { force: true })
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    await rm(tokenFile, { force: true })
    throw new Error('Desktop Project Membership agent runtime exposed no TCP address')
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    tokenFile,
    dispose: async () => {
      lifecycle.abort()
      server.closeAllConnections()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      const results = await Promise.allSettled([closed, ...active])
      await rm(tokenFile, { force: true })
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Desktop Project Membership agent shutdown failed')
    },
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  options: DesktopProjectMembershipAgentRuntimeOptions,
  lifecycleSignal: AbortSignal,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: 'unauthorized' })
    return
  }
  if (request.method !== 'POST') {
    json(response, 405, { error: 'method-not-allowed' })
    return
  }
  const body = await readJson(request)
  const account = options.account().getSnapshot().account
  if (account === undefined) {
    json(response, 401, { error: 'account-unavailable' })
    return
  }
  if (request.url === '/v1/account') {
    json(response, 200, { account })
    return
  }
  const membership = options.membership(account.id, lifecycleSignal)
  if (request.url === '/v1/context') {
    const cwd = requiredString(body, 'cwd')
    if (!isAbsolute(cwd)) throw new Error('cwd must be absolute')
    const remote = await (options.gitRemote ?? defaultGitRemote)(
      cwd,
      AbortSignal.any([lifecycleSignal, AbortSignal.timeout(10_000)]),
    )
    const workspaceId = optionalString(body, 'workspaceId')
    let lookup: string | undefined
    if (remote !== undefined) {
      lookup = normalizeGitRemoteUrl(remote)
    } else if (workspaceId !== undefined) {
      lookup = localWorkspaceRemoteUrl(workspaceId)
    }
    if (lookup === undefined) {
      assertCurrentAccount(options, account.id)
      json(response, 200, { account })
      return
    }
    const project = await membership.projectByRemote(lookup)
    assertCurrentAccount(options, account.id)
    json(response, 200, { account, ...(project === undefined ? {} : { project }) })
    return
  }
  if (request.url === '/v1/roster') {
    const actorAccountId = requiredString(body, 'actorAccountId')
    if (actorAccountId !== account.id) {
      json(response, 403, { error: 'actor-mismatch' })
      return
    }
    const roster = await membership.roster(requiredString(body, 'projectId') as ProjectId)
    assertCurrentAccount(options, account.id)
    json(response, 200, roster)
    return
  }
  json(response, 404, { error: 'not-found' })
}

function assertCurrentAccount(options: DesktopProjectMembershipAgentRuntimeOptions, expectedAccountId: string): void {
  if (options.account().getSnapshot().account?.id !== expectedAccountId) {
    throw new Error('Desktop Project Membership account changed during the request')
  }
}

async function defaultGitRemote(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const { runNativeCommand } = await import('@deepseek-ai/dsh-native-command')
  try {
    const { stdout } = await runNativeCommand('git', ['-C', cwd, 'remote', 'get-url', 'origin'], signal)
    const remote = stdout.trim()
    return remote === '' ? undefined : remote
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw new Error(`request exceeds ${String(MAX_REQUEST_BYTES)} bytes`)
    chunks.push(buffer)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
