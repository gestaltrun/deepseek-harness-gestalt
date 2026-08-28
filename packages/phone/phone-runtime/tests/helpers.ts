/**
 * Test helpers: staging the fakemobilecli executable, its config knobs, test
 * device shapes, and ephemeral-port picking. POSIX-only; the vitest config
 * excludes this package's suites on Windows.
 */

import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

/** Behavior knobs the fake agent CLI mode reads from its config file per invocation. */
export interface FakeAgentKnobs {
  /** Seeds the persistent agent state as already installed. */
  installed?: boolean
  statusDelayMs?: number
  installDelayMs?: number
  /** When set, the subcommand writes this text to stderr and exits non-zero. */
  statusText?: string
  installText?: string
  statusExitCode?: number
  installExitCode?: number
  /** When set, a successful install prints this JSON answer verbatim. */
  installAnswer?: string
  /** Makes the agent child ignore SIGTERM so the caller's SIGKILL escape runs. */
  ignoreTerm?: boolean
}

/** Knobs fakemobilecli reads from its sibling config file at startup. */
export interface FakeKnobs {
  devices?: Array<Record<string, unknown>>
  listDelayMs?: number
  screencaptureDelayMs?: number
  hang?: boolean
  exitAfter?: number
  /** Exit before binding anything; simulates a binary that cannot start. */
  exitFast?: boolean
  /** Ignore SIGTERM to exercise the SIGKILL escape in stop(). */
  ignoreTerm?: boolean
  /** One-shot `agent` CLI behavior; state lives in a sibling state file. */
  agent?: FakeAgentKnobs
  /** Makes the named RPC method answer this JSON-RPC error verbatim. */
  failArm?: { method: string; code?: number; message: string }
}

/** Persistent agent state the fake CLI mode records across invocations. */
export interface FakeAgentState {
  installed: boolean
  installCount: number
  statusCount: number
  lastInstallArgv: string[] | null
}

/** One staged fake ready to be handed to PhoneDevices or spawned directly. */
export interface StagedFake {
  readonly port: number
  readonly executablePath: string
  readonly baseUrl: string
  /** Staged dummy provisioning profile that satisfies composition validation. */
  readonly profilePath: string
  /** Release the placeholder port reservation right before the child spawns. */
  claim(): void
  setDevices(devices: ReadonlyArray<Record<string, unknown>>): Promise<void>
  /** Rewrite the `agent` behavior knobs the next CLI invocation reads. */
  setAgent(agent: FakeAgentKnobs): Promise<void>
  /** Read the persistent agent state the fake CLI invocations record. */
  agentState(): Promise<FakeAgentState>
  counters(): Promise<{ requests: number; bootCount: number; shutdownCount: number; io: unknown[] }>
  /** Resolves when the RPC endpoint answers or rejects when the fake is gone. */
  awaitOnline(timeoutMs?: number): Promise<void>
  dispose(): Promise<void>
}

function randomPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolvePort(port)
        else rejectPort(new Error('no ephemeral port'))
      })
    })
  })
}

/**
 * Hold one staged port until {@link StagedFake.claim}, so parallel vitest
 * workers cannot steal the ephemeral slot between staging and spawning.
 */
function holdPort(port: number): { release(): void } {
  const placeholder = net.createServer()
  placeholder.listen(port, '127.0.0.1')
  return {
    release(): void {
      placeholder.close()
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

/**
 * Stage one fakemobilecli executable plus its knob config in a fresh temp dir.
 * @param knobs - Devices seed and behavioral knobs baked into the config file.
 * @returns endpoints and handles for driving and observing the fake.
 */
export async function stageFake(knobs: FakeKnobs = {}): Promise<StagedFake> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-fake-'))
  const fixturesDir = join(root, 'fixtures')
  await mkdir(fixturesDir, { recursive: true })
  const executablePath = join(fixturesDir, 'fakemobilecli')
  await copyFile(new URL('./fixtures/fakemobilecli.mjs', import.meta.url), executablePath)
  await chmod(executablePath, 0o755)
  await writeFile(join(fixturesDir, 'fakemobilecli.config.json'), JSON.stringify(knobs))
  if (knobs.agent !== undefined) {
    await writeFile(join(fixturesDir, 'fakemobilecli.agent-state.json'), JSON.stringify({
      installed: knobs.agent.installed === true,
      installCount: 0,
      statusCount: 0,
      lastInstallArgv: null,
    }))
  }
  const port = await randomPort()
  const hold = holdPort(port)
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const profilePath = join(fixturesDir, 'profile.mobileprovision')
  await writeFile(profilePath, 'fake provisioning profile payload')
  const facade: StagedFake = {
    port,
    executablePath,
    baseUrl,
    profilePath,
    claim(): void {
      hold.release()
    },
    async setDevices(devices): Promise<void> {
      const response = await fetch(`${baseUrl}/__test/set-devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ devices }),
      })
      if (!response.ok) throw new Error(`set-devices failed: HTTP ${String(response.status)}`)
    },
    async setAgent(agent): Promise<void> {
      const configPath = join(fixturesDir, 'fakemobilecli.config.json')
      const current = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      await writeFile(configPath, JSON.stringify({ ...current, agent }))
    },
    async agentState(): Promise<FakeAgentState> {
      try {
        return JSON.parse(await readFile(join(fixturesDir, 'fakemobilecli.agent-state.json'), 'utf8')) as FakeAgentState
      } catch {
        return { installed: false, installCount: 0, statusCount: 0, lastInstallArgv: null }
      }
    },
    async counters(): Promise<{ requests: number; bootCount: number; shutdownCount: number; io: unknown[] }> {
      return await (await fetch(`${baseUrl}/__test/counters`)).json() as {
        requests: number
        bootCount: number
        shutdownCount: number
        io: unknown[]
      }
    },
    async awaitOnline(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try {
          await fetch(`${baseUrl}/__test/counters`)
          return
        } catch {
          if (Date.now() > deadline) throw new Error('fakemobilecli never came online')
          await wait(10)
        }
      }
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true })
    },
  }
  return facade
}

/** Canonical wire-shape factory for device entries. */
export function wireDevice(
  id: string,
  platform: 'ios' | 'android',
  kind: 'simulator' | 'real' | 'emulator',
  state: string,
  name = `${id}-name`,
): Record<string, unknown> {
  return { id, name, platform, type: kind, state, model: `${name}-model`, provider: { type: 'local' } }
}
