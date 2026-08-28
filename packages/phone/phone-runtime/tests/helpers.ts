/**
 * Test helpers: staging the fakemobilecli executable, its config knobs, test
 * device shapes, and ephemeral-port picking. POSIX-only; the vitest config
 * excludes this package's suites on Windows.
 */

import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

/** Knobs fakemobilecli reads from its sibling config file at startup. */
export interface FakeKnobs {
  devices?: Array<Record<string, unknown>>
  listDelayMs?: number
  hang?: boolean
  exitAfter?: number
  /** Exit before binding anything; simulates a binary that cannot start. */
  exitFast?: boolean
  /** Ignore SIGTERM to exercise the SIGKILL escape in stop(). */
  ignoreTerm?: boolean
}

/** One staged fake ready to be handed to PhoneDevices or spawned directly. */
export interface StagedFake {
  readonly port: number
  readonly executablePath: string
  readonly baseUrl: string
  /** Release the placeholder port reservation right before the child spawns. */
  claim(): void
  setDevices(devices: ReadonlyArray<Record<string, unknown>>): Promise<void>
  counters(): Promise<{ requests: number; bootCount: number; shutdownCount: number }>
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
  const port = await randomPort()
  const hold = holdPort(port)
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const facade: StagedFake = {
    port,
    executablePath,
    baseUrl,
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
    async counters(): Promise<{ requests: number; bootCount: number; shutdownCount: number }> {
      return await (await fetch(`${baseUrl}/__test/counters`)).json() as {
        requests: number
        bootCount: number
        shutdownCount: number
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
