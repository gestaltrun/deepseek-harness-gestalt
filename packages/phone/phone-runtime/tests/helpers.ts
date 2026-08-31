/**
 * Test helpers: staging the fakemobilecli executable, its config knobs, test
 * device shapes, ephemeral-port picking, and capture-frame assertions.
 * The staged launcher follows the host's native executable form.
 */

import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { FRAME_HEIGHT, FRAME_WIDTH, decodeFirstIpcmIdr, lumaAt } from './fixtures/u3-visible-frames.ts'

/** Behavior knobs the fake agent CLI mode reads from its config file per invocation. */
interface FakeAgentKnobs {
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
  /** Makes the POSIX agent child ignore SIGTERM so the caller's SIGKILL escape runs. */
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
  /** Ignore SIGTERM on POSIX to exercise the SIGKILL escape in stop(). */
  ignoreTerm?: boolean
  /** One-shot `agent` CLI behavior; state lives in a sibling state file. */
  agent?: FakeAgentKnobs
  /** Makes the named RPC method answer this JSON-RPC error verbatim. */
  failArm?: { method: string; code?: number; message: string }
  /** Wraps the devices.list result in the real mobilecli 1.0.5 `{ devices: [...] }` envelope. */
  listEnvelope?: boolean
  /** Answers device.screencapture with the 1.0.5 `{ format, sessionUrl }` envelope; the stream moves to GET /stream?s=. */
  captureEnvelope?: boolean
  /** MJPEG frames per capture body (default 1); larger values keep the body open for mid-stream teardown tests. */
  streamFrameCount?: number
}

/** Persistent agent state the fake CLI mode records across invocations. */
interface FakeAgentState {
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
  /** Release the placeholder port reservation and wait until the child can bind it. */
  claim(): Promise<void>
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
async function holdPort(port: number): Promise<{ release(): Promise<void> }> {
  const placeholder = net.createServer()
  await new Promise<void>((resolve, reject) => {
    placeholder.once('error', reject)
    placeholder.listen(port, '127.0.0.1', resolve)
  })
  let releasePromise: Promise<void> | undefined
  return {
    release(): Promise<void> {
      releasePromise ??= new Promise<void>((resolve, reject) => {
        placeholder.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      return releasePromise
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

const WINDOWS_BOOTSTRAP_OPTION = `--import=${new URL('./fixtures/fakemobilecli-bootstrap.mjs', import.meta.url).href}`
let windowsLauncherUsers = 0
let previousNodeOptions: string | undefined

/** Retain the test-only Node preload while staged Windows launchers may spawn. */
function retainWindowsLauncher(): () => void {
  if (windowsLauncherUsers === 0) {
    previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = previousNodeOptions === undefined || previousNodeOptions.length === 0
      ? WINDOWS_BOOTSTRAP_OPTION
      : `${previousNodeOptions} ${WINDOWS_BOOTSTRAP_OPTION}`
  }
  windowsLauncherUsers += 1
  let released = false
  return () => {
    if (released) return
    released = true
    windowsLauncherUsers -= 1
    if (windowsLauncherUsers > 0) return
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    previousNodeOptions = undefined
  }
}

/** Symlink the current native Node executable under the fake's stable basename. */
async function stageWindowsLauncher(executablePath: string): Promise<void> {
  await symlink(process.execPath, executablePath, 'file')
}

/**
 * Stage one fakemobilecli executable plus its knob config in a fresh temp dir.
 * @param knobs - Devices seed and behavioral knobs baked into the config file.
 * @param platform - Native launcher form; defaults to the current host.
 * @returns endpoints and handles for driving and observing the fake.
 */
export async function stageFake(
  knobs: FakeKnobs = {},
  platform: NodeJS.Platform = process.platform,
): Promise<StagedFake> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-fake-'))
  const releaseLauncher = platform === 'win32' ? retainWindowsLauncher() : undefined
  try {
    const fixturesDir = join(root, 'fixtures')
    await mkdir(fixturesDir, { recursive: true })
    const fakeSource = new URL('./fixtures/fakemobilecli.mjs', import.meta.url)
    const executablePath = platform === 'win32'
      ? join(fixturesDir, 'fakemobilecli.exe')
      : join(fixturesDir, 'fakemobilecli')
    if (platform === 'win32') {
      await copyFile(fakeSource, join(fixturesDir, 'fakemobilecli.mjs'))
      await stageWindowsLauncher(executablePath)
    } else {
      await copyFile(fakeSource, executablePath)
      await chmod(executablePath, 0o755)
    }
    await copyFile(new URL('./fixtures/u3-visible-frames.ts', import.meta.url), join(fixturesDir, 'u3-visible-frames.ts'))
    await writeFile(join(fixturesDir, 'fakemobilecli.config.json'), JSON.stringify(knobs))
    if (knobs.agent !== undefined) {
      await writeFile(join(fixturesDir, 'fakemobilecli.agent-state.json'), JSON.stringify({
        installed: knobs.agent.installed === true,
        installCount: 0,
        statusCount: 0,
        lastInstallArgv: null,
      }))
    }
    const profilePath = join(fixturesDir, 'profile.mobileprovision')
    await writeFile(profilePath, 'fake provisioning profile payload')
    const port = await randomPort()
    const hold = await holdPort(port)
    const baseUrl = `http://127.0.0.1:${String(port)}`
    let disposal: Promise<void> | undefined
    const facade: StagedFake = {
      port,
      executablePath,
      baseUrl,
      profilePath,
      claim(): Promise<void> {
        return hold.release()
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
      dispose(): Promise<void> {
        disposal ??= (async () => {
          const settled = await Promise.allSettled([
            hold.release(),
            rm(root, { recursive: true, force: true }),
          ])
          releaseLauncher?.()
          const errors: Error[] = []
          for (const result of settled) {
            if (result.status !== 'rejected') continue
            const reason: unknown = result.reason
            errors.push(reason instanceof Error ? reason : new Error(String(reason)))
          }
          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) throw new AggregateError(errors, 'staged fake cleanup failed')
        })()
        return disposal
      },
    }
    return facade
  } catch (error) {
    releaseLauncher?.()
    await rm(root, { recursive: true, force: true })
    throw error
  }
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

/** One extracted MJPEG frame: its part headers and the raw JPEG payload. */
export interface MjpegFrame {
  readonly headers: Map<string, string>
  readonly payload: Buffer
}

/**
 * Drain one MJPEG capture body until the first complete frame (up to its
 * boundary terminator) arrived, so assertions never depend on how the HTTP
 * layer chunked the writes.
 */
export async function firstMjpegFrame(
  body: ReadableStream<Uint8Array>,
  boundary = 'frame',
): Promise<MjpegFrame> {
  const reader = body.getReader()
  let acc = Buffer.alloc(0)
  const terminator = `\r\n--${boundary}`
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('capture ended before one complete frame arrived')
    acc = Buffer.concat([acc, Buffer.from(value)])
    const end = acc.indexOf(terminator)
    if (end < 0) continue
    await reader.cancel()
    const headerEnd = acc.indexOf('\r\n\r\n')
    if (headerEnd < 0 || headerEnd + 4 > end) throw new Error('frame carries no headers before its payload')
    const headers = new Map<string, string>()
    for (const line of acc.subarray(0, headerEnd).toString('utf8').split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
    }
    return { headers, payload: acc.subarray(headerEnd + 4, end) }
  }
}

/**
 * Dependency-free structural decode: walk every JPEG marker from SOI to the
 * closing EOI, requiring a baseline SOF0 (real dimensions) and a SOS scan, so
 * a bare SOI+EOI marker pair cannot pass for a decodable frame.
 * @param payload - One complete JPEG payload, boundaries already stripped.
 */
export function assertStructurallyDecodableJpeg(payload: Buffer): void {
  if (payload[0] !== 0xff || payload[1] !== 0xd8) throw new Error('payload does not start with the JPEG SOI marker')
  let cursor = 2
  let sawSof0 = false
  let sawSos = false
  while (cursor < payload.length - 1) {
    if ((payload[cursor] ?? 0) !== 0xff) throw new Error(`marker desync at byte ${String(cursor)}`)
    const marker = payload[cursor + 1] ?? -1
    if (marker === 0xd9) {
      cursor += 2
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      cursor += 2
      continue
    }
    if (marker === 0xc0) {
      sawSof0 = true
      if (payload.readUInt16BE(cursor + 5) < 1 || payload.readUInt16BE(cursor + 7) < 1) {
        throw new Error('SOF0 names no real pixel dimensions')
      }
    }
    if (marker === 0xda) sawSos = true
    const segmentLength = payload.readUInt16BE(cursor + 2)
    if (marker === 0xda) {
      // Entropy-coded data is byte-stuffed; scan to the next real marker.
      cursor += 2 + segmentLength
      for (;;) {
        if (cursor >= payload.length - 1) break
        const next = payload[cursor + 1] ?? -1
        const stuffedOrRestart = next === 0x00 || (next >= 0xd0 && next <= 0xd7)
        if (payload[cursor] === 0xff && !stuffedOrRestart) break
        cursor += 1
      }
      continue
    }
    cursor += 2 + segmentLength
  }
  if (!sawSof0) throw new Error('payload carries no SOF0 frame header')
  if (!sawSos) throw new Error('payload carries no SOS scan header')
  if (cursor !== payload.length) throw new Error(`payload carries ${String(payload.length - cursor)} trailing bytes after EOI`)
}

/**
 * Dependency-free Annex-B structural check: walk every NAL unit start code
 * (four-byte then three-byte forms) and require the capture stream's header
 * and picture NALs — SPS (7), PPS (8), and an IDR slice (5) — so a bare
 * prefix or parameter sets alone cannot pass for a decodable stream.
 * @param payload - One complete H264 Annex-B byte stream.
 */
function assertAnnexBH264Stream(payload: Buffer): void {
  const nalTypes = new Set<number>()
  let cursor = 0
  let sawNal = false
  while (cursor < payload.length - 3) {
    const fourByte = payload[cursor] === 0x00 && payload[cursor + 1] === 0x00
      && payload[cursor + 2] === 0x00 && payload[cursor + 3] === 0x01
    const threeByte = !fourByte && payload[cursor] === 0x00 && payload[cursor + 1] === 0x00
      && payload[cursor + 2] === 0x01
    if (!fourByte && !threeByte) {
      cursor += 1
      continue
    }
    const nalStart = cursor + (fourByte ? 4 : 3)
    if (nalStart >= payload.length) break
    sawNal = true
    const nalType = (payload[nalStart] ?? 0) & 0x1f
    nalTypes.add(nalType)
    cursor = nalStart
  }
  if (!sawNal) throw new Error('payload carries no Annex-B NAL start code')
  if (!nalTypes.has(7)) throw new Error('capture stream carries no SPS NAL')
  if (!nalTypes.has(8)) throw new Error('capture stream carries no PPS NAL')
  if (!nalTypes.has(5)) throw new Error('capture stream carries no IDR picture NAL')
}

/**
 * Reconstruct luma of the first I_PCM IDR and require a 390×844 picture whose
 * sampled pixels match the fixture gradient, so a six-byte prefix or
 * parameter-set-only stream cannot pass as a visible frame.
 * @param payload - One complete H264 Annex-B byte stream.
 */
export function assertRecognizableH264Picture(payload: Buffer): void {
  assertAnnexBH264Stream(payload)
  const picture = decodeFirstIpcmIdr(payload)
  if (picture.width !== FRAME_WIDTH || picture.height !== FRAME_HEIGHT) {
    throw new Error(`IDR luma is ${String(picture.width)}x${String(picture.height)}, not ${String(FRAME_WIDTH)}x${String(FRAME_HEIGHT)}`)
  }
  const samples: Array<readonly [number, number]> = [
    [0, 0],
    [48, 0],
    [195, FRAME_HEIGHT >> 1],
    [244, FRAME_HEIGHT - 1],
    [389, 0],
  ]
  for (const [x, y] of samples) {
    const actual = picture.y[y * FRAME_WIDTH + x] ?? -1
    const expected = lumaAt(x, y, 0)
    if (Math.abs(actual - expected) > 1) {
      throw new Error(`IDR luma at ${String(x)},${String(y)} is ${String(actual)}, expected ${String(expected)}`)
    }
  }
}

/**
 * Read the picture dimensions a structurally decodable JPEG declares in its
 * SOF0 segment (must be walked first).
 * @param payload - One complete JPEG payload, boundaries already stripped.
 * @returns the SOF0-declared width and height in pixels.
 */
export function jpegDimensions(payload: Buffer): { width: number; height: number } {
  let cursor = 2
  while (cursor < payload.length - 1) {
    if ((payload[cursor] ?? 0) !== 0xff) throw new Error(`marker desync at byte ${String(cursor)}`)
    const marker = payload[cursor + 1] ?? -1
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) break
    const segmentLength = payload.readUInt16BE(cursor + 2)
    if (marker === 0xc0 || (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      return { width: payload.readUInt16BE(cursor + 7), height: payload.readUInt16BE(cursor + 5) }
    }
    cursor += 2 + segmentLength
  }
  throw new Error('payload carries no SOF frame header')
}
