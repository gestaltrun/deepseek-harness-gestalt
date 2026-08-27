import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopSub2Api,
  DesktopSub2ApiController,
  parseSub2ApiDeleteData,
  PLACEHOLDER_ERROR,
  probeByProxySeam,
  ROLLBACK_ERROR_PREFIX,
  STARTUP_TIMEOUT_ERROR,
  sub2ApiPathsFromHome,
  uninstallSub2ApiFromIpc,
  UnavailableDesktopSub2ApiController,
  type DesktopSub2ApiActions,
  type Sub2ApiControllerOptions,
  type Sub2ApiHostControl,
} from '../src/sub2api.ts'
import { SUB2API_SOURCES_ENV } from '../src/sub2api-sources.ts'
import type { DesktopSub2ApiSnapshot } from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import { manifestListsBundle, SUB2API_BUNDLE_NAME } from '../src/sub2api-profile.ts'
import type { Sub2ApiInstall, Sub2ApiInstallInput, Sub2ApiInstallResult } from '../src/sub2api-install.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture(options?: { installed?: boolean; disabled?: boolean; noPackage?: boolean }): Promise<{
  profileDir: string
  runtimeDir: string
  dataDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'sub2api-controller-'))
  dirs.push(root)
  const profileDir = join(root, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  const bundles = options?.installed === true
    ? ['@deepseek-ai/dsh-base', SUB2API_BUNDLE_NAME]
    : ['@deepseek-ai/dsh-base']
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles } },
  }))
  if (options?.disabled === true) {
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: dsh-sub2api-sidecar\n  disabled: true\n')
  }
  if (options?.installed === true && options?.noPackage !== true) {
    const { mkdir: mkdirDir } = await import('node:fs/promises')
    const packageDir = join(profileDir, 'node_modules', SUB2API_BUNDLE_NAME)
    await mkdirDir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: SUB2API_BUNDLE_NAME, version: '0.9.9' }))
  }
  return { profileDir, runtimeDir: join(root, 'sub2api', 'runtime'), dataDir: join(root, 'sub2api', 'data') }
}

/** The real installer's on-disk effect, as the fake install performs it. */
async function fakeInstallWrites(dirs2: { profileDir: string; runtimeDir: string }): Promise<Sub2ApiInstallResult> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(join(dirs2.profileDir, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  manifest.dsh?.profile?.bundles?.push(SUB2API_BUNDLE_NAME)
  await writeFile(join(dirs2.profileDir, 'package.json'), JSON.stringify(manifest))
  const packageDir = join(dirs2.profileDir, 'node_modules', SUB2API_BUNDLE_NAME)
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: SUB2API_BUNDLE_NAME, version: '0.9.9' }))
  await mkdir(dirs2.runtimeDir, { recursive: true })
  return { bundleName: SUB2API_BUNDLE_NAME, bundleVersion: '0.9.9' }
}

interface Harness {
  controller: DesktopSub2ApiController
  events: DesktopSub2ApiSnapshot[]
  host: Sub2ApiHostControl & { restart: ReturnType<typeof vi.fn> }
  probe: ReturnType<typeof vi.fn<(origin: string) => Promise<boolean>>>
  install: Sub2ApiInstall
  installRuns: () => number
  dataDir: string
  profileDir: string
  runtimeDir: string
}

async function harness(overrides?: {
  sources?: Sub2ApiControllerOptions['sources']
  installed?: boolean
  disabled?: boolean
  noPackage?: boolean
  probe?: (origin: string) => Promise<boolean>
  restart?: () => Promise<string>
  origin?: string | undefined
  installGate?: (input: Sub2ApiInstallInput) => Promise<void>
}): Promise<Harness> {
  const paths = await fixture({ installed: overrides?.installed, disabled: overrides?.disabled, noPackage: overrides?.noPackage })
  const events: DesktopSub2ApiSnapshot[] = []
  let currentOrigin: string | undefined = overrides && 'origin' in overrides
    ? overrides.origin
    : 'http://127.0.0.1:9/'
  const host = {
    restart: overrides?.restart ?? vi.fn(async () => {
      currentOrigin = 'http://127.0.0.1:10/'
      return currentOrigin
    }),
    origin: () => currentOrigin,
  }
  const probeImpl: (origin: string) => Promise<boolean> = overrides?.probe ?? (async () => true)
  const probe = vi.fn(probeImpl)
  const installState = { runs: 0 }
  const installGate = overrides?.installGate
  const install: Sub2ApiInstall = async (input) => {
    installState.runs += 1
    await installGate?.(input)
    return await fakeInstallWrites(input.layout)
  }
  const controller = new DesktopSub2ApiController({
    sources: overrides && 'sources' in overrides
      ? overrides.sources
      : {
        bundleUrl: 'https://example.test/bundle.tgz',
        bundleSha256SumsUrl: 'https://example.test/bundle-SHA256SUMS',
        runtimePackUrl: 'https://example.test/pack.tar.gz',
        runtimePackSha256SumsUrl: 'https://example.test/pack-SHA256SUMS',
      },
    ...paths,
    host,
    fetchImpl: fetch,
    install,
    probe: (origin: string) => probe(origin),
    probeIntervalMs: 1,
    probeTimeoutMs: 50,
  })
  controller.subscribe((snapshot) => { events.push(snapshot) })
  await controller.start()
  return {
    controller,
    events,
    host,
    probe,
    install,
    installRuns: () => installState.runs,
    dataDir: paths.dataDir,
    profileDir: paths.profileDir,
    runtimeDir: paths.runtimeDir,
  }
}

async function rowPresent(profileDir: string): Promise<boolean> {
  const { readSub2ApiProfileManifest } = await import('../src/sub2api-profile.ts')
  return manifestListsBundle(await readSub2ApiProfileManifest(profileDir), SUB2API_BUNDLE_NAME)
}

describe('DesktopSub2ApiController', () => {
  it('starts missing and enables through install, restart, and probe', async () => {
    const h = await harness()
    expect(h.controller.getSnapshot().state).toBe('missing')
    expect(h.probe).not.toHaveBeenCalled()

    const final = await h.controller.enable()
    expect(final.state).toBe('running')
    expect(final.version).toBe('0.9.9')
    expect(h.installRuns()).toBe(1)
    expect(h.host.restart).toHaveBeenCalledOnce()
    expect(await rowPresent(h.profileDir)).toBe(true)
    expect(h.events.map(event => event.state)).toEqual([
      'missing', 'downloading', 'installed', 'starting', 'running',
    ])
  })

  it('reports the unpublished-source placeholder as an actionable error', async () => {
    const h = await harness({ sources: undefined })
    const final = await h.controller.enable()
    expect(final).toMatchObject({ state: 'error', error: PLACEHOLDER_ERROR })
    expect(h.installRuns()).toBe(0)
    expect(h.host.restart).not.toHaveBeenCalled()
  })

  it('rolls a fresh install back when the first restart fails, then retries once', async () => {
    let restarts = 0
    const h = await harness({
      restart: vi.fn(async () => {
        restarts += 1
        if (restarts === 1) throw new Error('dsh web exited before announcing a URL')
        return 'http://127.0.0.1:11/'
      }),
    })
    const final = await h.controller.enable()
    expect(restarts).toBe(2)
    expect(final.state).toBe('error')
    expect(final.error?.startsWith(ROLLBACK_ERROR_PREFIX)).toBe(true)
    expect(final.error).toContain('dsh web exited')
    // Half state removed: the row and the extracted files are gone again.
    expect(await rowPresent(h.profileDir)).toBe(false)
    await expect(stat(join(h.profileDir, 'node_modules', SUB2API_BUNDLE_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(h.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a restart failure on re-enable without rolling back', async () => {
    const h = await harness({
      installed: true,
      restart: vi.fn(async () => {
        throw 'restart refused' // non-Error rejection keeps its message via String()
      }),
    })
    const final = await h.controller.enable()
    expect(final.state).toBe('error')
    expect(final.error).toBe('restart refused')
    expect(final.error?.startsWith(ROLLBACK_ERROR_PREFIX)).toBe(false)
    expect(h.installRuns()).toBe(0)
    expect(await rowPresent(h.profileDir)).toBe(true)
  })

  it('lands in the timeout error with log pointers when the probe never turns healthy', async () => {
    const h = await harness({ installed: true, noPackage: true, probe: async () => false })
    const final = await h.controller.enable()
    expect(final).toMatchObject({ state: 'error', error: STARTUP_TIMEOUT_ERROR })
    expect(final.version).toBeUndefined()
  })

  it('disables through the patch row and a restart, then re-enables without reinstalling', async () => {
    const h = await harness({ installed: true })
    const disabled = await h.controller.disable()
    expect(disabled).toMatchObject({ state: 'installed', enabled: false })
    expect(h.host.restart).toHaveBeenCalledOnce()
    const patch = await readFile(join(h.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('disabled: true')

    const { isSub2ApiDisabled } = await import('../src/sub2api-profile.ts')
    expect(await isSub2ApiDisabled(h.profileDir)).toBe(true)

    h.probe.mockClear()
    h.host.restart.mockClear()
    const enabled = await h.controller.enable()
    expect(enabled).toMatchObject({ state: 'running', enabled: true })
    expect(h.installRuns()).toBe(0)
    expect(h.host.restart).toHaveBeenCalledOnce()
    const patchAfter = await readFile(join(h.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patchAfter).not.toContain('disabled: true')
  })

  it('uninstalls with and without account data, restoring the row when restart fails', async () => {
    const h = await harness({ installed: true })
    await mkdir(h.dataDir, { recursive: true })
    await writeFile(join(h.dataDir, 'accounts.sqlite'), 'data')

    const removed = await h.controller.uninstall(true)
    expect(removed.state).toBe('missing')
    expect(h.host.restart).toHaveBeenCalledOnce()
    expect(await rowPresent(h.profileDir)).toBe(false)
    await expect(stat(h.dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(h.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const h2 = await harness({ installed: true })
    await mkdir(h2.dataDir, { recursive: true })
    await h2.controller.uninstall(false)
    expect(await stat(h2.dataDir)).toBeTruthy() // kept

    const failing = await harness({
      installed: true,
      restart: vi.fn(async () => { throw new Error('no restart') }),
    })
    const failed = await failing.controller.uninstall(false)
    expect(failed.state).toBe('error')
    expect(await rowPresent(failing.profileDir)).toBe(true)
  })

  it('uninstalls without a restart while the Web Host is down', async () => {
    const h = await harness({ installed: true, origin: undefined })
    const removed = await h.controller.uninstall(false)
    expect(removed.state).toBe('missing')
    expect(h.host.restart).not.toHaveBeenCalled()
  })

  it('probes an installed enabled component at start and after host replacement', async () => {
    const h = await harness({ installed: true })
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('running') })
    expect(h.probe).toHaveBeenCalledOnce()

    h.probe.mockClear()
    h.controller.onHostOriginChanged()
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('running') })
    expect(h.probe).toHaveBeenCalledOnce()
  })

  it('ignores host-origin changes while busy and stops pushing after dispose', async () => {
    const h = await harness({ installed: true })
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('running') })
    expect(h.probe).toHaveBeenCalledOnce() // from start()
    h.controller.dispose()
    h.controller.onHostOriginChanged()
    expect(h.probe).toHaveBeenCalledOnce()
    expect(h.events.at(-1)?.state).toBe('running')
  })

  it('keeps one operation at a time', async () => {
    const h = await harness({
      installGate: async () => {
        await new Promise<void>((resolve) => { releaseInstall = resolve })
      },
    })
    let releaseInstall: (() => void) | undefined
    const first = h.controller.enable()
    // Wait until the first enable reaches its downloading snapshot.
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('downloading') })
    const second = await h.controller.enable()
    expect(second.state).toBe('downloading')
    releaseInstall?.()
    await first
    expect(h.installRuns()).toBe(1)
  })

  it('surfaces installer progress and keeps one operation at a time across verbs', async () => {
    const h = await harness({
      installGate: async (input) => {
        input.onProgress?.('downloading')
        input.onProgress?.('downloading', 60)
        input.onProgress?.('verifying')
        await new Promise<void>((resolve) => { releaseInstall = resolve })
      },
    })
    let releaseInstall: (() => void) | undefined
    const first = h.controller.enable()
    const enableStates: string[] = []
    const stop = h.controller.subscribe((snapshot) => { enableStates.push(snapshot.state) })
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('verifying') })
    // disable and uninstall while busy return the in-flight snapshot.
    expect((await h.controller.disable()).state).toBe('verifying')
    expect((await h.controller.uninstall(true)).state).toBe('verifying')
    releaseInstall?.()
    await first
    stop()
    expect(enableStates).toContain('downloading')
    expect(enableStates).toContain('verifying')
    expect(h.events.map(event => event.state)).toContain('downloading')
  })

  it('disables without a restart while the Web Host is down', async () => {
    const h = await harness({ installed: true, origin: undefined })
    const disabled = await h.controller.disable()
    expect(disabled).toMatchObject({ state: 'installed', enabled: false })
    expect(h.host.restart).not.toHaveBeenCalled()
    const { isSub2ApiDisabled } = await import('../src/sub2api-profile.ts')
    expect(await isSub2ApiDisabled(h.profileDir)).toBe(true)
  })

  it('stops a pending probe silently when disposed mid-poll', async () => {
    // The slow probe resolves true after disposal: the loop must return
    // without pushing running (post-probe abort check).
    const h = await harness({
      installed: true,
      probeTimeoutMs: 10,
      probe: async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return true
      },
    })
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('starting') })
    const eventsBefore = h.events.length
    h.controller.dispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h.events.length).toBe(eventsBefore)

    // A slow false probe that outlives the budget lands on the deadline abort
    // check (the deadline passed while the probe was in flight).
    const h2 = await harness({
      installed: true,
      probeTimeoutMs: 10,
      probe: async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return false
      },
    })
    await vi.waitFor(() => { expect(h2.controller.getSnapshot().state).toBe('starting') })
    const eventsBefore2 = h2.events.length
    h2.controller.dispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h2.events.length).toBe(eventsBefore2)
  })

  it('exercises disable/uninstall guards, the disable catch, and default install/probe seams', async () => {
    // disable while the Web Host is down: the row lands, no restart runs.
    const downHost = await harness({ installed: true, origin: undefined })
    const disabled = await downHost.controller.disable()
    expect(disabled).toMatchObject({ state: 'installed', enabled: false })
    expect(downHost.host.restart).not.toHaveBeenCalled()

    // A failing restart during disable lands in the error state, row kept.
    const failing = await harness({
      installed: true,
      restart: vi.fn(async () => { throw new Error('restart refused') }),
    })
    const failed = await failing.controller.disable()
    expect(failed).toMatchObject({ state: 'error', error: 'restart refused' })
    expect(await rowPresent(failing.profileDir)).toBe(true)

    // Default install seam: no injected install, so the real installer runs
    // and its first download fails on the refusing fetch.
    const fresh = await harness()
    fresh.controller.dispose()
    const defaultSeams = new DesktopSub2ApiController({
      sources: {
        bundleUrl: 'https://127.0.0.1:1/bundle.tgz',
        bundleSha256SumsUrl: 'https://127.0.0.1:1/sums',
        runtimePackUrl: 'https://127.0.0.1:1/pack.tar.gz',
        runtimePackSha256SumsUrl: 'https://127.0.0.1:1/pack-sums',
      },
      profileDir: fresh.profileDir,
      runtimeDir: fresh.runtimeDir,
      dataDir: fresh.dataDir,
      host: { restart: async () => 'http://127.0.0.1:13/', origin: () => 'http://127.0.0.1:9/' },
      fetchImpl: async () => { throw new Error('connection refused') },
      probeIntervalMs: 1,
      probeTimeoutMs: 10,
    })
    const failedEnable = await defaultSeams.enable()
    expect(failedEnable.state).toBe('error')
    expect(failedEnable.error).toContain('connection refused')

    // Default probe seam: an installed profile with no injected probe polls
    // the real proxy probe against an unreachable origin until the budget
    // expires into the timeout error with the log pointers.
    const installed = await harness({ installed: true })
    installed.controller.dispose()
    const defaultProbe = new DesktopSub2ApiController({
      sources: undefined,
      profileDir: installed.profileDir,
      runtimeDir: installed.runtimeDir,
      dataDir: installed.dataDir,
      host: { restart: async () => 'http://127.0.0.1:14/', origin: () => undefined },
      fetchImpl: async () => { throw new Error('connection refused') },
      probeIntervalMs: 1,
      probeTimeoutMs: 10,
    })
    const probeTimeout = await defaultProbe.enable()
    expect(probeTimeout).toMatchObject({ state: 'error', error: STARTUP_TIMEOUT_ERROR })

    const missing = await harness()
    const deleted = await missing.controller.uninstall(true)
    expect(deleted.state).toBe('missing')
  })

  it('survives an uninstall when nothing is installed', async () => {
    const h = await harness()
    const removed = await h.controller.uninstall(false)
    expect(removed.state).toBe('missing')
  })
})

describe('subscribe and guard edges', () => {
  it('stops notifying after unsubscribe and ignores host changes while busy or disabled', async () => {
    let releaseInstall: (() => void) | undefined
    const h = await harness({
      installGate: async () => {
        await new Promise<void>((resolve) => { releaseInstall = resolve })
      },
    })
    const stop = h.controller.subscribe(() => {})
    stop()
    stop()
    const first = h.controller.enable()
    await vi.waitFor(() => { expect(h.controller.getSnapshot().state).toBe('downloading') })
    const probeCalls = h.probe.mock.calls.length
    h.controller.onHostOriginChanged() // busy: ignored
    expect(h.probe.mock.calls.length).toBe(probeCalls)
    releaseInstall?.()
    await first

    // Disabled: ignored. Missing: ignored.
    const disabled = await harness({ installed: true })
    await vi.waitFor(() => { expect(disabled.controller.getSnapshot().state).toBe('running') })
    await disabled.controller.disable()
    const callsBefore = disabled.probe.mock.calls.length
    disabled.controller.onHostOriginChanged()
    expect(disabled.probe.mock.calls.length).toBe(callsBefore)
    const missing = await harness()
    missing.controller.onHostOriginChanged()
    expect(missing.probe.mock.calls.length).toBe(0)
  })

  it('lands on missing for disable and uninstall of an absent component', async () => {
    const h = await harness()
    expect((await h.controller.disable()).state).toBe('missing')
    const root = await mkdtemp(join(tmpdir(), 'sub2api-data-'))
    dirs.push(root)
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const h2 = await harness()
    await mkdir(h2.dataDir, { recursive: true })
    await writeFile(join(h2.dataDir, 'accounts.sqlite'), 'data')
    await h2.controller.uninstall(true)
    await expect(stat(h2.dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('probe and IPC validation helpers', () => {
  it('treats a 2xx proxy-seam response as healthy and anything else as not yet', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(input instanceof URL ? input.href : new Request(input).url)
      if (calls.length === 1) return new Response(null, { status: 200 })
      if (calls.length === 2) return new Response(null, { status: 404 })
      throw new Error('connection refused')
    })
    expect(await probeByProxySeam('http://127.0.0.1:9/', fetchImpl)).toBe(true)
    expect(await probeByProxySeam('http://127.0.0.1:9/', fetchImpl)).toBe(false)
    expect(await probeByProxySeam('http://127.0.0.1:9/', fetchImpl)).toBe(false)
    expect(calls[0]).toBe('http://127.0.0.1:9/plugins/dsh-sub2api/quota-snapshot')
  })

  it('validates the renderer delete-data choice at the IPC boundary', async () => {
    expect(() => parseSub2ApiDeleteData('yes')).toThrow('must be boolean')
    const uninstall = vi.fn<(deleteData: boolean) => Promise<DesktopSub2ApiSnapshot>>()
      .mockResolvedValue({ state: 'missing', enabled: true })
    await uninstallSub2ApiFromIpc({ uninstall }, true)
    expect(uninstall).toHaveBeenCalledWith(true)
  })
})

describe('createDesktopSub2Api', () => {
  it('builds the real controller over the resolved home and degrades to unavailable on a broken sources file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-factory-'))
    dirs.push(root)
    const profileDir = join(root, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    const originalHome = process.env['DSH_HOME']
    const originalSources = process.env[SUB2API_SOURCES_ENV]
    try {
      process.env['DSH_HOME'] = root
      process.env[SUB2API_SOURCES_ENV] = undefined
      const host: Sub2ApiHostControl = { restart: async () => 'http://127.0.0.1:12/', origin: () => undefined }
      const actions = await createDesktopSub2Api({ fetch, host })
      expect(actions.getSnapshot().state).toBe('missing')
      expect(sub2ApiPathsFromHome(root).profileDir).toBe(join(root, 'profiles', 'web'))
      expect(sub2ApiPathsFromHome(root).dataDir).toBe(join(root, 'sub2api', 'data'))

      process.env[SUB2API_SOURCES_ENV] = join(root, 'broken.json')
      await writeFile(join(root, 'broken.json'), '{nope')
      const degraded = await createDesktopSub2Api({ fetch, host })
      expect(degraded.getSnapshot().error).toContain('not valid JSON')
    } finally {
      if (originalHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = originalHome
      if (originalSources === undefined) process.env[SUB2API_SOURCES_ENV] = undefined
      else process.env[SUB2API_SOURCES_ENV] = originalSources
    }
  })
})

describe('UnavailableDesktopSub2ApiController', () => {
  it('reports the reason on every verb', async () => {
    const actions: DesktopSub2ApiActions = new UnavailableDesktopSub2ApiController('sources invalid')
    expect(actions.getSnapshot()).toEqual({ state: 'error', enabled: false, error: 'sources invalid' })
    await expect(actions.enable()).resolves.toMatchObject({ error: 'sources invalid' })
    await expect(actions.disable()).resolves.toMatchObject({ error: 'sources invalid' })
    await expect(actions.uninstall(true)).resolves.toMatchObject({ error: 'sources invalid' })
    let disposerRan = false
    const stop = actions.subscribe(() => {
      disposerRan = true
    })
    stop()
    expect(disposerRan).toBe(false)
    expect(() => { actions.onHostOriginChanged() }).not.toThrow()
    actions.dispose()
  })
})
