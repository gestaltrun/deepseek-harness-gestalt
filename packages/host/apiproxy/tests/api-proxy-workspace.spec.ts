import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import type {
  MemberQuestionSessionMaterializer,
  MemberQuestionWorkspaceBinding,
} from '@deepseek-ai/dsh-member-question-receiver'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { HostFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-'))),
  picker: DirectoryPickerCapability = { kind: 'native', pick: async () => null },
  extras: {
    openPath?: (path: string, signal: AbortSignal) => Promise<void>
    canOpenPath?: () => boolean
    workspaceGitCommand?: NativeCommandRunner
    useProductionGitRunner?: boolean
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  if (extras.useProductionGitRunner === true) new LocalSubprocessRuntime(ctx)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  // Structural picker fake: the gateway only reads capability(); a stable
  // object per harness mirrors the seam's stability contract.
  ctx.provide('directoryPicker', { capability: () => picker } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
    ...extras.openPath === undefined ? {} : { openPath: extras.openPath },
    ...extras.canOpenPath === undefined ? {} : { canOpenPath: extras.canOpenPath },
    ...extras.workspaceGitCommand === undefined ? {} : { workspaceGitCommand: extras.workspaceGitCommand },
  })
  return { api, ctx, storageDomain, root }
}

/** Stage one directory under the harness root for path adoption. */
function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  return path
}

describe('host.pickDirectory', () => {
  it('returns a selected path or explicit cancellation from the native capability', async () => {
    const selected = await harness(undefined, { kind: 'native', pick: async () => '/tmp/project' })
    expect((await selected.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: '/tmp/project' } })

    const cancelled = await harness(undefined, { kind: 'native', pick: async () => null })
    expect((await cancelled.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: null } })
  })

  it('propagates abort into the native capability as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, {
      kind: 'native',
      pick: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.pickDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('folds a non-abort native-chooser failure into an internal error', async () => {
    const { api } = await harness(undefined, { kind: 'native', pick: async () => { throw new Error('no chooser installed') } })
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('refuses the native RPC under a browse composition', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'directory-picker-unavailable', details: { capability: 'browse' } },
    })
  })
})

/** Canned browse capability: one listing, one created path, typed failures on demand. */
const BROWSE_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    if (path === '/denied') throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    const target = path ?? '/home/user'
    return {
      path: target,
      home: '/home/user',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
      truncated: false,
    }
  },
  createDirectory: async (path, name) => {
    if (name === 'taken') throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    if (name === 'unwritable') throw new Error('disk detached')
    return `${path}/${name}`
  },
}

describe('host.listDirectory / host.createDirectory', () => {
  it('serves listings and creation through the browse capability, defaulting to home', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const home = await api.host.listDirectory(request({}), new AbortController().signal)
    expect(home.result).toMatchObject({ ok: true, value: { path: '/home/user', home: '/home/user' } })
    const listed = await api.host.listDirectory(request({ path: '/home/user/projects' }), new AbortController().signal)
    expect(listed.result).toMatchObject({ ok: true, value: { path: '/home/user/projects' } })
    const created = await api.host.createDirectory(request({ path: '/home/user', name: 'fresh' }))
    expect(created.result).toEqual({ ok: true, value: { path: '/home/user/fresh' } })
  })

  it('maps typed picker failures onto the wire error codes and folds unknown throws to internal', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    expect((await api.host.listDirectory(request({ path: '/denied' }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-unreadable', details: { path: '/denied' } },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'taken' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-exists' },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'unwritable' }))).result).toMatchObject({
      ok: false, error: { code: 'internal' },
    })
  })

  it('reports an aborted listing as cancelled, like the other signal-following RPCs', async () => {
    const { api } = await harness(undefined, {
      kind: 'browse',
      list: (_path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
      }),
      createDirectory: async () => '/never',
    })
    const abort = new AbortController()
    const pending = api.host.listDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('refuses the browse RPCs under a native composition', async () => {
    const { api } = await harness()
    expect((await api.host.listDirectory(request({}), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
    expect((await api.host.createDirectory(request({ path: '/x', name: 'y' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
  })
})

describe('host.openPath', () => {
  it('describes whether this deployment can reach a user-visible native desktop', async () => {
    const visible = await harness(undefined, undefined, { canOpenPath: () => true })
    const headless = await harness(undefined, undefined, { canOpenPath: () => false })
    expect(expectOk(await visible.api.host.describe(request({}))).canOpenPath).toBe(true)
    expect(expectOk(await headless.api.host.describe(request({}))).canOpenPath).toBe(false)
    expect(expectOk(await visible.api.host.describe(request({}))).home).toBe(homedir())
  })

  it('opens through the injected native boundary', async () => {
    const opened: string[] = []
    const { api } = await harness(undefined, undefined, {
      openPath: async (path) => { opened.push(path) },
    })
    expect((await api.host.openPath(request({ path: '/tmp/a.txt' }), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['/tmp/a.txt'])
  })

  it('propagates abort into the native boundary as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, undefined, {
      openPath: (_path, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.openPath(request({ path: '/tmp/a.txt' }), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('workspace.create', () => {
  it('serializes concurrent creates of one path into a single registration', async () => {
    const { api, root } = await harness()
    const target = stageDir(root, 'alpha')
    const responses = await Promise.all([
      api.workspace.create(request({ path: target })),
      api.workspace.create(request({ path: target })),
    ])
    const values = responses.map(response => expectOk(response))
    const created = values.find(value => value.created)
    const resolved = values.find(value => !value.created)

    expect(created).toMatchObject({ workspace: { path: target, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items).toHaveLength(1)
  })

  it('adopts only existing directories', async () => {
    const { api, root } = await harness()
    const existing = stageDir(root, 'existing')
    const first = expectOk(await api.workspace.create(request({ path: existing })))
    const repeated = expectOk(await api.workspace.create(request({ path: existing })))
    expect(first).toMatchObject({ created: true, workspace: { path: existing, title: 'existing' } })
    expect(repeated).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })

    expectOk(await api.workspace.rename(request({
      workspaceId: first.workspace.workspaceId,
      title: 'renamed-existing',
    })))
    const reopened = expectOk(await api.workspace.create(request({ path: existing })))
    expect(reopened.workspace.title).toBe('renamed-existing')

    const missing = join(root, 'missing')
    const missingResult = await api.workspace.create(request({ path: missing }))
    expect(missingResult.result).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })
    expect(existsSync(missing)).toBe(false)
  })

  it('adopts different paths that derive the same Workspace title', async () => {
    const { api, root } = await harness()
    const first = join(root, 'one', 'project')
    const second = join(root, 'two', 'project')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const firstResult = expectOk(await api.workspace.create(request({ path: first })))
    const secondResult = expectOk(await api.workspace.create(request({ path: second })))
    expect(firstResult).toMatchObject({
      created: true,
      workspace: { path: first, title: 'project' },
    })
    expect(secondResult).toMatchObject({
      created: true,
      workspace: { path: second, title: 'project' },
    })
    expect(secondResult.workspace.workspaceId).not.toBe(firstResult.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items.map(workspace => workspace.path))
      .toEqual([second, first])
  })
})

describe('workspace Git operations', () => {
  it('executes a keyless local Git clone and reads its origin through the production runner', async () => {
    const { api, root } = await harness(undefined, undefined, { useProductionGitRunner: true })
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
    const cloned = expectOk(await api.workspace.cloneGit(request({
      remoteUrl: remote, parentPath: root, directoryName: 'real-clone',
    }), new AbortController().signal)).workspace
    expect(cloned.path).toBe(join(root, 'real-clone'))
    expect(expectOk(await api.workspace.gitRemote(
      request({ workspaceId: cloned.workspaceId }),
      new AbortController().signal,
    ))).toEqual({ remoteUrl: remote })
  })

  it('reads origin without a shell and treats a non-Git Workspace as unbound', async () => {
    const command = vi.fn<NativeCommandRunner>()
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r.git\n', stderr: '' })
      .mockRejectedValueOnce(new Error('not a git repository'))
    const { api, root } = await harness(undefined, undefined, { workspaceGitCommand: command })
    const first = expectOk(await api.workspace.create(request({ path: stageDir(root, 'first') }))).workspace
    const second = expectOk(await api.workspace.create(request({ path: stageDir(root, 'second') }))).workspace
    const signal = new AbortController().signal

    expect(expectOk(await api.workspace.gitRemote(request({ workspaceId: first.workspaceId }), signal)))
      .toEqual({ remoteUrl: 'https://github.com/o/r.git' })
    expect(expectOk(await api.workspace.gitRemote(request({ workspaceId: second.workspaceId }), signal)))
      .toEqual({})
    expect(command.mock.calls[0]?.slice(0, 2)).toEqual([
      'git', ['-C', first.path, 'remote', 'get-url', 'origin'],
    ])
    expect((await api.workspace.gitRemote(request({ workspaceId: 'missing' as WorkspaceId }), signal)).result)
      .toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })

  it('clones into one selected parent and registers the resulting Workspace', async () => {
    const command = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    const { api, root } = await harness(undefined, undefined, { workspaceGitCommand: command })
    const response = await api.workspace.cloneGit(request({
      remoteUrl: 'https://github.com/o/r.git',
      parentPath: root,
      directoryName: 'cloned',
    }), new AbortController().signal)
    expect(expectOk(response).workspace).toMatchObject({
      path: join(root, 'cloned'), title: 'cloned',
    })
    expect(command.mock.calls[0]?.slice(0, 2)).toEqual([
      'git', ['clone', '--', 'https://github.com/o/r.git', join(root, 'cloned')],
    ])
    expect(expectOk(await api.workspace.list(request({}))).items).toHaveLength(1)
  })

  it('maps clone failures and caller aborts without registering a Workspace', async () => {
    const failed = await harness(undefined, undefined, {
      workspaceGitCommand: async () => { throw new Error('clone refused') },
    })
    expect((await failed.api.workspace.cloneGit(request({
      remoteUrl: 'https://github.com/o/r.git', parentPath: failed.root, directoryName: 'failed',
    }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'workspace-clone-failed' },
    })
    expect(expectOk(await failed.api.workspace.list(request({}))).items).toHaveLength(0)
    expect(existsSync(join(failed.root, 'failed'))).toBe(false)

    const preserved = join(failed.root, 'preserved')
    mkdirSync(preserved)
    expect((await failed.api.workspace.cloneGit(request({
      remoteUrl: 'https://github.com/o/r.git', parentPath: failed.root, directoryName: 'preserved',
    }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'workspace-clone-failed' },
    })
    expect(existsSync(preserved)).toBe(true)

    const abort = new AbortController()
    const aborted = await harness(undefined, undefined, {
      workspaceGitCommand: async () => {
        abort.abort()
        throw new Error('aborted')
      },
    })
    expect((await aborted.api.workspace.cloneGit(request({
      remoteUrl: 'https://github.com/o/r.git', parentPath: aborted.root, directoryName: 'aborted',
    }), abort.signal)).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('does not remove a directory owned by a concurrent clone of the same target', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve })
    const command = vi.fn<NativeCommandRunner>(async () => {
      firstStarted()
      await firstMayFinish
      return { stdout: '', stderr: '' }
    })
    const { api, root } = await harness(undefined, undefined, { workspaceGitCommand: command })
    const payload = { remoteUrl: 'https://github.com/o/r.git', parentPath: root, directoryName: 'shared' }
    const first = api.workspace.cloneGit(request(payload), new AbortController().signal)
    await firstDidStart
    const second = await api.workspace.cloneGit(request(payload), new AbortController().signal)
    expect(second.result).toMatchObject({ ok: false, error: { code: 'workspace-clone-failed' } })
    expect(existsSync(join(root, 'shared'))).toBe(true)
    releaseFirst()
    expect(expectOk(await first).workspace.path).toBe(join(root, 'shared'))
    expect(command).toHaveBeenCalledOnce()
  })

  it('maps an aborted origin read to cancelled', async () => {
    const abort = new AbortController()
    const { api, root } = await harness(undefined, undefined, {
      workspaceGitCommand: async () => {
        abort.abort()
        throw new Error('aborted')
      },
    })
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'origin') }))).workspace
    expect((await api.workspace.gitRemote(request({ workspaceId: workspace.workspaceId }), abort.signal)).result)
      .toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('memberQuestion Session materializer cache', () => {
  it('writes transferred bytes under a hidden receiver-owned path and leaves the same-named Workspace file unchanged', async () => {
    let materializer: MemberQuestionSessionMaterializer | undefined
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-cache-')))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.provide('storageDomain', storageDomain)
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    await ctx.plugin(WorkspaceRegistry)
    const factory: AgentFactory = {
      async createAgent(_ownerCtx, options) {
        const session = ctx.sessions.create(
          options.sessionId,
          options.meta === undefined ? {} : { meta: options.meta },
        )
        const agent = stubAgent(session)
        const unregister = ctx.agents.register(agent)
        return {
          agent,
          dispose: () => {
            unregister()
            return Promise.resolve()
          },
        }
      },
      async resume() {
        throw new Error('test harness has no persisted sessions')
      },
    }
    ctx.agents.setFactory(factory)
    ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) } as never)
    ctx.provide('memberQuestionReceiver', {
      registerSessionMaterializer: (next: MemberQuestionSessionMaterializer) => {
        materializer = next
        return () => { materializer = undefined }
      },
      registerHumanTurnAdmitter: () => () => {},
      changes: () => () => {},
      snapshot: async () => ({ revision: 0, pending: [], terminal: [] }),
      resumeReservedSessionMaterializations: async () => {},
      resumeReservedHumanTurns: async () => {},
    })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
      cwd: root,
    })
    if (materializer === undefined) throw new Error('member-question materializer was not registered')

    const workspace = expectOk(await api.workspace.create(request({
      path: stageDir(root, 'receiver-cache'),
    }))).workspace
    const localPath = join(workspace.path, 'docs', 'architecture.md')
    mkdirSync(join(workspace.path, 'docs'))
    writeFileSync(localPath, 'LOCAL WORKSPACE COPY\n')
    const sessionId = SessionId('receiving-cache-1')
    const receipt = await materializer({
      receivingSessionId: sessionId as never,
      revision: 1,
      questionId: 'question-cache' as never,
    }, {
      receivingAccountId: 'account-receiver' as never,
      projectId: 'project-1' as never,
      workspaceId: workspace.workspaceId,
      documents: [{ path: 'docs/architecture.md', bytes: Buffer.from('# transferred brief\n') }],
      questions: [{
        questionId: 'question-cache' as never,
        receivingSessionId: sessionId as never,
        receivingAccountId: 'account-receiver' as never,
        revision: 1,
        arrivedAt: 1_000,
        operation: {
          type: 'member-question',
          operationId: 'operation-cache' as never,
          questionId: 'question-cache' as never,
          projectId: 'project-1' as never,
          originSessionId: 'origin-cache' as never,
          expiresAt: 9_000,
          origin: {
            projectName: 'Atlas',
            originSessionTitle: 'Cache isolation',
            askerAccountId: 'account-alice',
            askerRole: 'owner',
            askerDisplayName: 'Alice',
            askerAvatarUrl: 'https://example.test/alice.png',
          },
          background: 'Keep the local file.',
          questions: [{ id: 'choice', question: 'Keep it?' }],
          references: [{ path: 'docs/architecture.md', reason: 'Current ownership map' }],
        },
      }],
    })
    expect(receipt).toMatchObject({
      accepted: true,
      cachedReferences: [{
        path: 'docs/architecture.md',
        reason: 'Current ownership map',
        cachedPath: '.dsh/member-questions/question-cache/architecture.md',
      }],
    })
    expect(readFileSync(localPath, 'utf8')).toBe('LOCAL WORKSPACE COPY\n')
    expect(readFileSync(join(workspace.path, '.dsh', 'member-questions', 'question-cache', 'architecture.md'), 'utf8'))
      .toBe('# transferred brief\n')
    const session = ctx.sessions.get(sessionId)
    expect(session?.events.find(event => event.type === 'member-question/received')?.data)
      .toMatchObject({
        cachedReferences: [{
          path: 'docs/architecture.md',
          cachedPath: '.dsh/member-questions/question-cache/architecture.md',
        }],
      })
  })
})

describe('memberQuestion.bindWorkspace', () => {
  it('fails closed without a provider and delegates exact local identities when composed', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'binding') }))).workspace
    const payload = {
      receivingAccountId: 'account-2' as never,
      projectId: 'project-1' as never,
      workspaceId: workspace.workspaceId,
    }
    expect((await api.memberQuestions.bindWorkspace(request(payload))).result)
      .toMatchObject({ ok: false, error: { code: 'internal' } })

    let currentWorkspaceId: WorkspaceId | undefined = workspace.workspaceId
    const bind = vi.fn(async () => {})
    const lookup = vi.fn(async () => currentWorkspaceId)
    const bindIfCurrent = vi.fn<MemberQuestionWorkspaceBinding['bindIfCurrent']>(async (
      _accountId, _projectId, expected, replacement,
    ) => {
      if (currentWorkspaceId !== expected) return false
      currentWorkspaceId = replacement
      return true
    })
    ctx.provide('memberQuestionWorkspaceBinding', { bind, lookup, bindIfCurrent, resolve: vi.fn() })
    expect((await api.memberQuestions.workspaceBinding(request({
      receivingAccountId: payload.receivingAccountId,
      projectId: payload.projectId,
    }))).result).toEqual({ ok: true, value: { state: 'live', workspaceId: workspace.workspaceId } })

    const other = expectOk(await api.workspace.create(request({ path: stageDir(root, 'binding-other') }))).workspace
    expect((await api.memberQuestions.ensureWorkspaceBinding(request({
      ...payload, workspaceId: other.workspaceId,
    }))).result).toEqual({ ok: true, value: { state: 'existing', workspaceId: workspace.workspaceId } })
    expect(bindIfCurrent).not.toHaveBeenCalled()

    currentWorkspaceId = 'deleted-workspace' as WorkspaceId
    expect((await api.memberQuestions.workspaceBinding(request({
      receivingAccountId: payload.receivingAccountId,
      projectId: payload.projectId,
    }))).result).toEqual({
      ok: true, value: { state: 'stale', workspaceId: 'deleted-workspace' },
    })
    expect((await api.memberQuestions.ensureWorkspaceBinding(request({
      ...payload, workspaceId: other.workspaceId,
    }))).result).toEqual({ ok: true, value: { state: 'repaired', workspaceId: other.workspaceId } })

    currentWorkspaceId = undefined
    expect((await api.memberQuestions.ensureWorkspaceBinding(request(payload))).result)
      .toEqual({ ok: true, value: { state: 'created', workspaceId: workspace.workspaceId } })
    expect((await api.memberQuestions.bindWorkspace(request(payload))).result)
      .toEqual({ ok: true, value: { bound: true } })
    expect(bind).toHaveBeenCalledWith('account-2', 'project-1', workspace.workspaceId)

    expect((await api.memberQuestions.bindWorkspace(request({
      ...payload, workspaceId: 'missing-workspace' as never,
    }))).result).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })

    await ctx.fiber.dispose()
    const rejected = await harness()
    const rejectedWorkspace = expectOk(await rejected.api.workspace.create(request({
      path: stageDir(rejected.root, 'binding'),
    }))).workspace
    rejected.ctx.provide('memberQuestionWorkspaceBinding', {
      bind: async () => { throw new Error('disk full') },
      lookup: vi.fn(),
      bindIfCurrent: vi.fn(),
      resolve: vi.fn(),
    })
    const failed = (await rejected.api.memberQuestions.bindWorkspace(request({
      ...payload, workspaceId: rejectedWorkspace.workspaceId,
    }))).result
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('unreachable')
    expect(failed.error).toMatchObject({ code: 'internal' })
    expect(failed.error.message).toContain('disk full')
  })

  it('serializes binding ensure with deletion of the candidate Workspace', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({
      path: stageDir(root, 'binding-delete-race'),
    }))).workspace
    let currentWorkspaceId: WorkspaceId | undefined
    let entered!: () => void
    const bindEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const mayCommit = new Promise<void>((resolve) => { release = resolve })
    const bindIfCurrent: MemberQuestionWorkspaceBinding['bindIfCurrent'] = async (
      _accountId, _projectId, expected, replacement,
    ) => {
      entered()
      await mayCommit
      if (currentWorkspaceId !== expected) return false
      currentWorkspaceId = replacement
      return true
    }
    ctx.provide('memberQuestionWorkspaceBinding', {
      bind: vi.fn(),
      lookup: async () => currentWorkspaceId,
      bindIfCurrent,
      resolve: async () => {
        if (currentWorkspaceId === undefined) throw new Error('missing')
        return currentWorkspaceId
      },
    })
    const ensured = api.memberQuestions.ensureWorkspaceBinding(request({
      receivingAccountId: 'account-2' as never,
      projectId: 'project-1' as never,
      workspaceId: workspace.workspaceId,
    }))
    await bindEntered
    const deleted = api.workspace.delete(request({ workspaceId: workspace.workspaceId }))
    release()
    expect((await ensured).result).toEqual({
      ok: true, value: { state: 'created', workspaceId: workspace.workspaceId },
    })
    expect((await deleted).result).toEqual({ ok: true, value: { deleted: true } })
    expect((await api.memberQuestions.workspaceBinding(request({
      receivingAccountId: 'account-2' as never,
      projectId: 'project-1' as never,
    }))).result).toEqual({
      ok: true, value: { state: 'stale', workspaceId: workspace.workspaceId },
    })
  })
})

describe('workspace.insertBefore', () => {
  it('commits the complete order, streams one order frame, and maps unknown ids', async () => {
    const { api, ctx, root } = await harness()
    const first = expectOk(await api.workspace.create(request({ path: stageDir(root, 'first') }))).workspace
    const second = expectOk(await api.workspace.create(request({ path: stageDir(root, 'second') }))).workspace
    const third = expectOk(await api.workspace.create(request({ path: stageDir(root, 'third') }))).workspace

    const abort = new AbortController()
    const listWorkspaces = vi.spyOn(ctx.workspaceRegistry, 'list')
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    const changed = nextHostFrame(stream)
    const reordered = expectOk(await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: second.workspaceId,
    })))
    expect(reordered.workspaceIds).toEqual([third.workspaceId, first.workspaceId, second.workspaceId])
    expect(await changed).toMatchObject({
      payload: {
        type: 'host/workspace-order-changed',
        workspaceIds: [third.workspaceId, first.workspaceId, second.workspaceId],
      },
    })
    expect(expectOk(await api.workspace.list(request({}))).items.map(item => item.workspaceId))
      .toEqual(reordered.workspaceIds)

    const missingSource = await api.workspace.insertBefore(request({
      workspaceId: 'missing' as WorkspaceId,
    }))
    expect(missingSource.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing' } },
    })
    const missingAnchor = await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: 'missing-anchor' as WorkspaceId,
    }))
    expect(missingAnchor.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing-anchor' } },
    })
    abort.abort()
  })
})

describe('session creation and Workspace membership', () => {
  it('attaches a preallocated idempotent session while cwd-only sessions stay ungrouped', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const sessionId = SessionId('session-workspace-preallocated')

    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(ctx.agents.list().filter(agent => agent.id === sessionId)).toHaveLength(1)

    const ungrouped = SessionId('session-cwd-only')
    expectOk(await api.sessions.create(request({ cwd: workspace.path, sessionId: ungrouped })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(ungrouped)

    const conflict = await api.sessions.create(request({ cwd: join(workspace.path, 'other'), sessionId }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { sessionId, existingCwd: workspace.path } },
    })
    const missing = await api.sessions.create(request({
      workspaceId: 'missing-workspace' as WorkspaceId,
      sessionId: SessionId('session-missing-workspace'),
    }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })

  it('retains a published session when attachment fails and repairs it on retry', async () => {
    const { api, ctx, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const workspace = ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('workspace missing from registry')
    vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('simulated write failure'))
    const sessionId = SessionId('session-attach-retry')

    const failed = await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId }))
    expect(failed.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed', details: { sessionId, workspaceId: created.workspaceId } },
    })
    expect(ctx.agents.get(sessionId)).toBeDefined()

    expectOk(await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
  })
})

describe('Host Workspace increments', () => {
  it('projects subagent origin in attached summaries and creation increments', async () => {
    const { api, ctx } = await harness()
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const pending = nextHostFrame(stream)
    const childId = SessionId('session-subagent-child')

    ctx.sessions.create(childId, {
      meta: {
        cwd: '/tmp',
        parentSession: SessionId('session-parent'),
        origin: 'subagent',
      },
    })

    expect(await pending).toMatchObject({
      payload: {
        type: 'host/session-added',
        sessionId: childId,
        parentSessionId: 'session-parent',
        origin: 'subagent',
      },
    })
    expect(expectOk(await api.sessions.list(request({}))).items).toContainEqual(
      expect.objectContaining({ sessionId: childId, origin: 'subagent' }),
    )
    abort.abort()
  })

  it('streams committed Workspace and Session increments after empty baselines', async () => {
    const { api, root } = await harness()
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const workspaceIncrement = nextHostFrame(stream)
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    expect(await workspaceIncrement).toMatchObject({
      payload: { type: 'host/workspace-changed', workspace: { workspaceId: workspace.workspaceId } },
    })

    const sessionId = SessionId('session-streamed-workspace')
    const pending = nextHostFrame(stream)
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    const increments: HostFrame[] = []
    increments.push((await pending).payload)
    while (increments.length < 2) {
      const next = await stream.next()
      if (next.done === true) throw new Error('Host stream ended before both increments')
      increments.push(next.value.payload)
    }
    expect(increments.find(increment => increment.type === 'host/session-added')).toMatchObject({
      // A just-created session has no events: the frame constantly carries blank:true.
      type: 'host/session-added', sessionId, blank: true, cwd: workspace.path,
    })
    const workspaceChanged = increments.find(
      (increment): increment is Extract<HostFrame, { type: 'host/workspace-changed' }> =>
        increment.type === 'host/workspace-changed',
    )
    expect(workspaceChanged?.workspace.sessionIds).toEqual([sessionId])
    abort.abort()
  })

  it('does not publish a Workspace whose registry-order commit fails', async () => {
    const { api, storageDomain, root } = await harness()
    const domain = storageDomain.get('workspace')
    if (domain === undefined) throw new Error('workspace domain is not open')
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('simulated registry order failure'))
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()

    const failed = await api.workspace.create(request({ path: stageDir(root, 'ghost') }))
    expect(failed.result.ok).toBe(false)
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })

  it('deletes the registration, keeps its session and folder, and streams one removal', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'delete-me') }))).workspace
    const sessionId = SessionId('session-kept-after-workspace-delete')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const removed = nextHostFrame(stream)
    expectOk(await api.workspace.delete(request({ workspaceId: workspace.workspaceId })))
    expect(await removed).toMatchObject({
      payload: { type: 'host/workspace-removed', workspaceId: workspace.workspaceId },
    })
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)
    expect(ctx.agents.get(sessionId)).toBeDefined()
    expect(existsSync(workspace.path)).toBe(true)

    const missing = await api.workspace.delete(request({ workspaceId: workspace.workspaceId }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-not-found', details: { workspaceId: workspace.workspaceId } },
    })

    const reregistered = expectOk(await api.workspace.create(request({ path: workspace.path }))).workspace
    expect(reregistered.workspaceId).not.toBe(workspace.workspaceId)
    expect(reregistered.path).toBe(workspace.path)
    expect(reregistered.sessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)
    abort.abort()
  })

  it('archives a session into the global set, keeps its accounting, and streams the set once', async () => {
    const { api, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'archive-home') }))).workspace
    const sessionId = SessionId('session-to-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const changed = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    expect(await changed).toMatchObject({
      payload: { type: 'host/archived-sessions-changed', archivedSessionIds: [sessionId] },
    })

    // Accounting and the session itself are untouched; list re-baselines the set.
    const listed = expectOk(await api.workspace.list(request({})))
    expect(listed.archivedSessionIds).toEqual([sessionId])
    expect(listed.items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)

    // The idempotent repeat emits no second frame: the next observed frame is
    // the workspace-changed of a later attach, not another archive snapshot.
    const after = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    const otherSession = SessionId('session-after-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId: otherSession })))
    expect((await after).payload.type).not.toBe('host/archived-sessions-changed')

    const missing = await api.workspace.archiveSession(request({ sessionId: SessionId('session-ghost') }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: 'session-ghost' } },
    })
    abort.abort()
  })
})
