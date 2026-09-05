import { spawnSync } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  quiesceRecordedProcesses, readOwnedFakeProcess, runLogged, runWithVerifiedPortHandoff, settleCleanupSteps,
} from '../../scripts/e2e-electron-runner-support.mjs'

const roots: string[] = []
const cleanupPids = new Set<number>()

afterEach(async () => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  cleanupPids.clear()
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-runner-test-'))
  roots.push(root)
  return root
}

function discard(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback() } })
}

async function waitForPids(file: string): Promise<{ parent: number; child: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as { parent: number; child: number }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }
  }
  throw new Error('child process tree did not publish its pids')
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function startHangingTcpServer(port: number): Promise<{
  readonly accepted: () => number
  readonly close: () => Promise<void>
}> {
  const sockets = new Set<Socket>()
  let accepted = 0
  const server = createTcpServer((socket) => {
    accepted += 1
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  let closure: Promise<void> | undefined
  return {
    accepted: () => accepted,
    close: () => {
      closure ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      return closure
    },
  }
}

describe('Desktop Electron runner ownership', () => {
  it('keeps the dedicated Electron e2e compiler face in the owning and top-level typecheck gates', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
    const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const desktopManifest = JSON.parse(await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(desktopManifest.scripts?.['typecheck:fake-policy'])
      .toBe('tsc -p tests/tsconfig.fake-policy.json')
    expect(desktopManifest.scripts?.['typecheck:source-e2e'])
      .toBe('tsc -p tests/tsconfig.source-e2e.json')
    expect(desktopManifest.scripts?.['typecheck:e2e-electron'])
      .toBe('pnpm run typecheck:fake-policy && pnpm run typecheck:source-e2e && tsc -p tests/e2e-electron/tsconfig.json')
    expect(desktopManifest.scripts?.['typecheck:e2e-electron']).not.toContain('tsc -p tsconfig.json')
    expect(rootManifest.scripts?.['typecheck:contracts-ready'])
      .toContain('pnpm --filter @deepseek-ai/dsh-desktop run typecheck:e2e-electron')
    const sourceE2E = JSON.parse(await readFile(join(repoRoot, 'apps', 'desktop', 'tests', 'tsconfig.source-e2e.json'), 'utf8')) as {
      compilerOptions?: {
        noEmit?: boolean
        rewriteRelativeImportExtensions?: boolean
        strict?: boolean
      }
      include?: readonly string[]
    }
    expect(sourceE2E.compilerOptions?.noEmit).toBe(true)
    expect(sourceE2E.compilerOptions?.strict).toBe(true)
    expect(sourceE2E.compilerOptions?.rewriteRelativeImportExtensions).toBe(false)
    expect(sourceE2E.include).toEqual(['../src/e2e-profile.ts', './e2e-profile.spec.ts'])
  })

  it('arms a source-only hidden window profile and does not treat CI as presentation', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
    const runner = await readFile(join(repoRoot, 'apps', 'desktop', 'scripts', 'run-e2e-electron.mjs'), 'utf8')
    const wdio = await readFile(join(repoRoot, 'apps', 'desktop', 'tests', 'e2e-electron', 'wdio.conf.ts'), 'utf8')
    const main = await readFile(join(repoRoot, 'apps', 'desktop', 'src', 'main.ts'), 'utf8')

    expect(runner).toContain("windowPresentation: 'hidden'")
    expect(runner).toContain("DSH_DESKTOP_E2E: '1'")
    expect(runner).toContain('DSH_DESKTOP_E2E_PROFILE: e2eProfile')
    expect(runner).toContain("CI: 'true'")
    expect(wdio).toContain('--dsh-e2e-profile=${process.env.DSH_DESKTOP_E2E_PROFILE')
    expect(main).toContain("desktopE2EProfile?.windowPresentation ?? 'visible'")
    expect(main).toContain('...desktopWindowConstructorOptions(windowPresentation)')
    expect(main).toContain('if (handleDesktopWindowActivate(windowPresentation, window) === \'handled\') return')
    expect(main).toContain("if (planDesktopWindowReopen(host !== undefined) === 'boot')")
    expect(main).toContain('await boot()')
    expect(main).toContain('const target = createWindow()')
    expect(main).not.toMatch(/if \(process\.env\.CI/)
  })

  it('returns only after stdout and stderr are fully persisted', async () => {
    const root = await temporaryRoot()
    const logFile = join(root, 'child.log')
    const code = await runLogged(process.execPath, [
      '-e',
      "setTimeout(() => { process.stdout.write('late stdout'); process.stderr.write('late stderr') }, 250)",
    ], {
      cwd: root,
      env: process.env,
      logFile,
      stdout: discard(),
      stderr: discard(),
    })

    expect(code).toBe(0)
    const logged = await readFile(logFile, 'utf8')
    expect(logged).toContain('late stdout')
    expect(logged).toContain('late stderr')
  })

  it.skipIf(process.platform === 'win32')('waits for inherited descendant pipes to close', async () => {
    const root = await temporaryRoot()
    const logFile = join(root, 'descendant.log')
    const parent = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write('descendant output'), 250)`], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()",
    ].join(';')
    const code = await runLogged(process.execPath, ['-e', parent], {
      cwd: root,
      env: process.env,
      logFile,
      stdout: discard(),
      stderr: discard(),
    })

    expect(code).toBe(0)
    expect(await readFile(logFile, 'utf8')).toContain('descendant output')
  })

  it('settles every cleanup step and retains every independent failure', async () => {
    const calls: string[] = []
    const settled = await settleCleanupSteps([
      { name: 'process tree', run: () => { calls.push('process tree'); throw new Error('tree survived') } },
      { name: 'runtime root', run: () => { calls.push('runtime root') } },
      { name: 'ports', run: async () => { calls.push('ports'); throw new Error('port open') } },
    ])

    expect(calls).toEqual(['process tree', 'runtime root', 'ports'])
    expect(settled.outcomes.map(outcome => ({ name: outcome.name, ok: outcome.ok }))).toEqual([
      { name: 'process tree', ok: false },
      { name: 'runtime root', ok: true },
      { name: 'ports', ok: false },
    ])
    expect(settled.errors.map(error => error.message)).toEqual(['tree survived', 'port open'])
  })

  it('aborts the owned child process tree and waits for every descendant to exit', async () => {
    const root = await temporaryRoot()
    const pidsFile = join(root, 'pids.json')
    const controller = new AbortController()
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 3000)`], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))`,
      "process.on('SIGTERM', () => {})",
      'setTimeout(() => process.exit(0), 1000)',
    ].join(';')
    const running = runLogged(process.execPath, ['-e', script], {
      cwd: root,
      env: process.env,
      logFile: join(root, 'tree.log'),
      stdout: discard(),
      stderr: discard(),
      signal: controller.signal,
      terminateGraceMs: 50,
    })
    const pids = await waitForPids(pidsFile)
    cleanupPids.add(pids.parent)
    cleanupPids.add(pids.child)
    controller.abort(new Error('test abort'))

    await expect(running).rejects.toThrow(/test abort/)
    expect(processExists(pids.parent)).toBe(false)
    expect(processExists(pids.child)).toBe(false)
    cleanupPids.delete(pids.parent)
    cleanupPids.delete(pids.child)
  })

  it.skipIf(process.platform === 'win32')('terminates the owned tree when the serial log writer fails', async () => {
    const root = await temporaryRoot()
    const fifo = join(root, 'runner.log')
    const pidsFile = join(root, 'writer-pid.json')
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    if (created.status !== 0) throw new Error(`mkfifo failed: ${created.stderr}`)
    const reader = await open(fifo, 'r+')
    const script = [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: process.pid }))`,
      "setInterval(() => process.stdout.write('log chunk'.repeat(1024)), 5)",
    ].join(';')
    const running = runLogged(process.execPath, ['-e', script], {
      cwd: root,
      env: process.env,
      logFile: fifo,
      stdout: discard(),
      stderr: discard(),
      terminateGraceMs: 50,
    })
    const pids = await waitForPids(pidsFile)
    cleanupPids.add(pids.parent)
    await reader.close()

    await expect(running).rejects.toThrow()
    expect(processExists(pids.parent)).toBe(false)
    cleanupPids.delete(pids.parent)
  })

  it('rejects missing process ownership evidence instead of treating it as clean', async () => {
    const root = await temporaryRoot()
    await expect(quiesceRecordedProcesses(join(root, 'missing.json'), ['electronPid', 'hostPid']))
      .rejects.toThrow(/owned process evidence or quiescence failed/)
  })

  it('retries a foreign fake owner through the runner classifier and uses a fresh port pair', async () => {
    const seen: Array<{ fakePort: number; cdpPort: number }> = []
    const servers: Server[] = []
    let value: string
    try {
      value = await runWithVerifiedPortHandoff('phone-live', async (ports, attempt) => {
        seen.push(ports)
        expect(ports.fakePort).not.toBe(ports.cdpPort)
        const expectedOwner = `expected-owner-${String(attempt)}`
        const servedOwner = attempt === 1 ? 'foreign-owner' : expectedOwner
        const collider = createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ pid: process.pid, ownerToken: servedOwner }))
        })
        await new Promise<void>((resolve, reject) => {
          collider.once('error', reject)
          collider.listen(ports.fakePort, '127.0.0.1', resolve)
        })
        servers.push(collider)
        let runnerLog = ''
        try {
          await readOwnedFakeProcess(ports.fakePort, expectedOwner)
        } catch (error) {
          runnerLog = error instanceof Error ? error.message : String(error)
        }
        return { value: attempt === 1 ? 'foreign' : 'owned', runnerLog }
      })
    } finally {
      await Promise.all(servers.map(closeServer))
    }

    expect(value).toBe('owned')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.fakePort).not.toBe(seen[0]?.fakePort)
    expect(seen[1]?.cdpPort).not.toBe(seen[0]?.cdpPort)
  })

  it('times out a foreign TCP listener that never answers HTTP and retries with fresh ports', async () => {
    const seen: Array<{ fakePort: number; cdpPort: number }> = []
    const servers: Server[] = []
    let hanging: Awaited<ReturnType<typeof startHangingTcpServer>> | undefined
    const watchdog = setTimeout(() => { void hanging?.close() }, 2_000)
    let value: string
    try {
      value = await runWithVerifiedPortHandoff('phone-live', async (ports, attempt) => {
        seen.push(ports)
        const ownerToken = `run-owner-${String(attempt)}`
        if (attempt === 1) {
          hanging = await startHangingTcpServer(ports.fakePort)
        } else {
          const owned = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ pid: process.pid, ownerToken }))
          })
          await new Promise<void>((resolve, reject) => {
            owned.once('error', reject)
            owned.listen(ports.fakePort, '127.0.0.1', resolve)
          })
          servers.push(owned)
        }
        let runnerLog = ''
        try {
          await readOwnedFakeProcess(ports.fakePort, ownerToken)
        } catch (error) {
          runnerLog = error instanceof Error ? error.message : String(error)
        }
        return { value: attempt === 1 ? 'hung' : 'owned', runnerLog }
      })
    } finally {
      clearTimeout(watchdog)
      await Promise.all([hanging?.close(), ...servers.map(closeServer)])
    }

    expect(value).toBe('owned')
    expect(hanging?.accepted()).toBeGreaterThan(0)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.fakePort).not.toBe(seen[0]?.fakePort)
    expect(seen[1]?.cdpPort).not.toBe(seen[0]?.cdpPort)
  })
})
