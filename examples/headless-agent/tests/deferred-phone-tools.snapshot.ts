import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const scenarioDir = join(snapshotsDir, 'deferred-phone-tools')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../deferred-phone-tools.cordis.snapshot.yml', import.meta.url))
const phoneMockLlmPath = fileURLToPath(new URL('./fixtures/phone-mock-llm.ts', import.meta.url))
const fakePhoneFleetPath = fileURLToPath(new URL('./fixtures/fake-phone-fleet.ts', import.meta.url))
const dshBinScript = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

const TASK =
  'Load the deferred phone device tools, list the phone fleet, attempt one tap on the Android emulator, and report the runtime outcome.'
const FINAL_TEXT = 'PHONE_TOOL_ACT_ALLOWED_KEYLESS'
const ACT_OK_MARKER = '"status": "ok"'
const DEVICE_TOOLS = [
  'device_act',
  'device_close',
  'device_list',
  'device_observe',
  'device_open',
  'device_screenshot',
]

interface JsonObject {
  [key: string]: unknown
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

function contextFromLogs(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => parseJsonl(content)[0])
  return {
    sessionIds: headers.flatMap(header => typeof header?.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

async function readPersistedLog(file: string): Promise<string> {
  const content = await readFile(file)
  if (!file.endsWith('.zstd')) return content.toString('utf8')
  const scan = scanZstdFrames(content)
  if (scan.tornStart !== undefined) throw new Error(`persisted snapshot log has a torn Zstandard frame: ${file}`)
  const decoded: Buffer[] = []
  for (const frame of scan.frames) {
    decoded.push(await decompressZstdFrame(content.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

async function persistedLog(cwd: string): Promise<string> {
  const root = join(cwd, '.dsh', 'sessions')
  const files = (await readdir(root, { recursive: true }))
    .filter(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
  if (files.length !== 1) throw new Error(`deferred phone snapshot expected one persisted session log, found ${files.length}`)
  return readPersistedLog(join(root, files[0] ?? ''))
}

/** Install the scripted adapter and the recording fleet into the real temporary headless profile. */
async function prepareFixture(cwd: string): Promise<void> {
  const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'snapshot-fixtures')
  await mkdir(fixtureDir, { recursive: true })
  await Promise.all([
    copyFile(phoneMockLlmPath, join(fixtureDir, 'phone-mock-llm.ts')),
    copyFile(fakePhoneFleetPath, join(fixtureDir, 'fake-phone-fleet.ts')),
    writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
  ])
}

describe('deferred phone tools assembled snapshot', () => {
  it('revalidates durable deferred schemas after runtime readiness is lost', async () => {
    const result = await runLoaderSmoke({
      label: 'deferred phone tools headless assembled snapshot',
      tempDirPrefix: 'headless-snapshot-deferred-phone-tools-',
      binScript: dshBinScript,
      configPath,
      binArgs: ['--profile', 'headless', '--patch', configPath, TASK],
      tsconfigPath,
      env: {
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: prepareFixture,
      inspect: async (cwd) => {
        // The journal proves the fake fleet listed once and then received the
        // closed tap: an ask that still rejected would leave io off the log.
        const journal: unknown = JSON.parse(await readFile(join(cwd, 'phone-fleet-journal.json'), 'utf8'))
        expect(journal).toEqual([{ op: 'listDevices' }, { op: 'io' }])

        const log = await persistedLog(cwd)
        const records = parseJsonl(log)
        const calls = records
          .filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual(['tool_search', 'device_list', 'device_act'])

        const headers = records
          .filter(record => record.type === 'request/header')
          .map((record) => {
            const data = record.data as JsonObject
            const header = data.header as JsonObject
            const tools = Array.isArray(header.tools) ? header.tools as JsonObject[] : []
            return { reason: data.reason, tools: tools.map(tool => tool.name) }
          })
        expect(headers.length).toBeGreaterThan(1)
        expect(headers[0]?.reason).toBe('initial')
        expect(headers[0]?.tools).toContain('tool_search')
        expect(headers[0]?.tools.filter(name => typeof name === 'string' && DEVICE_TOOLS.includes(name)))
          .toEqual([])
        expect(headers[1]?.reason).toBe('change')
        expect(headers[1]?.tools).toContain('device_act')
        for (const header of headers.slice(2)) {
          expect(header.reason).toBe('change')
          expect(header.tools?.filter(name => typeof name === 'string' && DEVICE_TOOLS.includes(name)))
            .toEqual([])
        }

        const resultTexts = records
          .filter(record => record.type === 'tool/result')
          .flatMap((record) => {
            const data = record.data as JsonObject | undefined
            const message = data?.message as JsonObject | undefined
            if (!Array.isArray(message?.content)) return []
            return (message.content as JsonObject[]).flatMap((block) => {
              if (!Array.isArray(block.content)) return []
              return (block.content as JsonObject[])
                .map(inner => typeof inner.text === 'string' ? inner.text : '')
            })
          })
        expect(resultTexts.filter(text => text.includes(ACT_OK_MARKER))).toHaveLength(1)
        expect(resultTexts.some(text => text.includes(FINAL_TEXT))).toBe(false)
        expect(records.some(record => record.type === 'approval/asked'
          && (record.data as JsonObject | undefined)?.toolName === 'device_act')).toBe(false)

        const session = normalizeSessionSnapshot(log, contextFromLogs([log]))
        if (refreshing) await writeFile(sessionExpected, session)
        await expect(session).toMatchFileSnapshot(sessionExpected)
        expect(session).toContain(TASK)
        expect(session).toContain(FINAL_TEXT)
      },
    })

    expect(result.stdout).toBe(`${FINAL_TEXT}\n`)
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
