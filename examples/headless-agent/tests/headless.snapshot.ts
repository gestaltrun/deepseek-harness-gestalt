import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeStdout,
  refreshFixtureReplacements,
  scrubRequestHeaders,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke, runLoaderSmokeSequence } from '@deepseek-ai/dsh-loader-smoke'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const advancedScenarioDir = join(snapshotsDir, 'advanced-toolchain')
const advancedSessionFixture = join(advancedScenarioDir, 'session.jsonl')
const advancedStreamExpected = join(advancedScenarioDir, 'stream-json.expected.jsonl')
const advancedConfigPath = fileURLToPath(new URL('../advanced.cordis.snapshot.yml', import.meta.url))
const ptyScenarioDir = join(snapshotsDir, 'pty-tools')
const ptySessionFixture = join(ptyScenarioDir, 'session.jsonl')
const ptyStreamExpected = join(ptyScenarioDir, 'stream-json.expected.jsonl')
const ptyConfigPath = fileURLToPath(new URL('../pty.cordis.snapshot.yml', import.meta.url))
const goalScenarioDir = join(snapshotsDir, 'goal-tools')
const goalConfigPath = fileURLToPath(new URL('../goal.cordis.snapshot.yml', import.meta.url))
const retryScenarioDir = join(snapshotsDir, 'provider-retry')
const retryConfigPath = fileURLToPath(new URL('../retry.cordis.snapshot.yml', import.meta.url))
const compactionScenarioDir = join(snapshotsDir, 'compaction-recovery')
const compactionSessionFixture = join(compactionScenarioDir, 'session.jsonl')
const compactionStreamExpected = join(compactionScenarioDir, 'stream-json.expected.jsonl')
const compactionConfigPath = fileURLToPath(new URL('../compaction.cordis.snapshot.yml', import.meta.url))
const credentialsScenarioDir = join(snapshotsDir, 'missing-credential')
const credentialsConfigPath = fileURLToPath(new URL('../credentials.cordis.snapshot.yml', import.meta.url))
// Same keyless composition as the missing-credential scenario: the endpoint is
// never dialed either way, because a supplied-but-unusable key fails credential
// resolution exactly where an absent one does.
const invalidCredentialScenarioDir = join(snapshotsDir, 'invalid-credential')
const deferredToolSearchScenarioDir = join(snapshotsDir, 'deferred-tool-search')
const deferredToolSearchSessionFixture = join(deferredToolSearchScenarioDir, 'session.jsonl')
const deferredToolSearchResumeFixture = join(deferredToolSearchScenarioDir, 'resume.jsonl')
const deferredToolSearchStreamExpected = join(deferredToolSearchScenarioDir, 'stream-json.expected.jsonl')
const deferredToolSearchConfigPath = fileURLToPath(new URL('../deferred-tool-search.cordis.snapshot.yml', import.meta.url))
const deferredToolSearchDisabledConfigPath = fileURLToPath(
  new URL('./fixtures/deferred-tool-search-disabled.cordis.yml', import.meta.url),
)
const deferredToolSearchRunnerPath = fileURLToPath(new URL('./fixtures/deferred-tool-search-runner.ts', import.meta.url))
const browserRuntimeScenarioDir = join(snapshotsDir, 'browser-runtime')
const browserRuntimeSessionFixture = join(browserRuntimeScenarioDir, 'session.jsonl')
const browserRuntimeResumeFixture = join(browserRuntimeScenarioDir, 'resume.jsonl')
const browserRuntimeStreamExpected = join(browserRuntimeScenarioDir, 'stream-json.expected.jsonl')
const browserRuntimeConfigPath = fileURLToPath(new URL('../browser-runtime.cordis.snapshot.yml', import.meta.url))
const browserRuntimeTandemScenarioDir = join(snapshotsDir, 'browser-runtime-tandem')
const browserRuntimeTandemSessionFixture = join(browserRuntimeTandemScenarioDir, 'session.jsonl')
const browserRuntimeTandemResumeFixture = join(browserRuntimeTandemScenarioDir, 'resume.jsonl')
const browserRuntimeTandemStreamExpected = join(browserRuntimeTandemScenarioDir, 'stream-json.expected.jsonl')
const browserRuntimeTandemConfigPath = fileURLToPath(new URL('../browser-runtime-tandem.cordis.snapshot.yml', import.meta.url))
const tandemHttpFixturePath = fileURLToPath(new URL(
  '../../../packages/browser/browser-runtime-tandem/tests/fixtures/tandem-http-fixture.mjs',
  import.meta.url,
))
const mcpServerEverythingEntry = fileURLToPath(new URL(
  './dist/index.js',
  import.meta.resolve('@modelcontextprotocol/server-everything/package.json'),
))
const llmReplayEntry = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? fileURLToPath(new URL(import.meta.resolve('@deepseek-ai/dsh-llm-replay')))
  : fileURLToPath(new URL('../../../packages/test-support/llm-replay/src/index.ts', import.meta.url))
const browserRuntimeDeterministicEntry = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? fileURLToPath(new URL(import.meta.resolve('@deepseek-ai/dsh-browser-runtime-deterministic')))
  : fileURLToPath(new URL('../../../packages/browser/browser-runtime-deterministic/src/index.ts', import.meta.url))
const browserRuntimeTandemEntry = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? fileURLToPath(new URL(import.meta.resolve('@deepseek-ai/dsh-browser-runtime-tandem')))
  : fileURLToPath(new URL('../../../packages/browser/browser-runtime-tandem/src/index.ts', import.meta.url))
const toolBrowserEntry = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? fileURLToPath(new URL(import.meta.resolve('@deepseek-ai/dsh-tool-browser')))
  : fileURLToPath(new URL('../../../packages/browser/tool-browser/src/index.ts', import.meta.url))
const llmReplayProxy = [
  'const entry = process.env.DSH_LLM_REPLAY_ENTRY',
  'if (!entry) throw new Error(\'deferred snapshot requires DSH_LLM_REPLAY_ENTRY\')',
  'const replay = await import(entry)',
  'export const inject = replay.inject',
  'export const apply = replay.apply',
  '',
].join('\n')
const browserRuntimeDeterministicProxy = [
  'const entry = process.env.DSH_BROWSER_RUNTIME_DETERMINISTIC_ENTRY',
  'if (!entry) throw new Error(\'browser snapshot requires DSH_BROWSER_RUNTIME_DETERMINISTIC_ENTRY\')',
  'const plugin = await import(entry)',
  'export default plugin.default',
  '',
].join('\n')
const browserRuntimeTandemProxy = [
  'const entry = process.env.DSH_BROWSER_RUNTIME_TANDEM_ENTRY',
  'if (!entry) throw new Error(\'browser snapshot requires DSH_BROWSER_RUNTIME_TANDEM_ENTRY\')',
  'const plugin = await import(entry)',
  'export default plugin.default',
  '',
].join('\n')
const toolBrowserProxy = [
  'const entry = process.env.DSH_TOOL_BROWSER_ENTRY',
  'if (!entry) throw new Error(\'browser snapshot requires DSH_TOOL_BROWSER_ENTRY\')',
  'const plugin = await import(entry)',
  'export const name = plugin.name',
  'export const inject = plugin.inject',
  'export const Config = plugin.Config',
  'export const apply = plugin.apply',
  '',
].join('\n')
const ralphScenarioDir = join(snapshotsDir, 'ralph-loop')
const ralphConfigPath = fileURLToPath(new URL('../ralph.cordis.snapshot.yml', import.meta.url))
const settlementScenarioDir = join(snapshotsDir, 'subagent-settlement')
const settlementConfigPath = fileURLToPath(new URL('../subagent-settlement.cordis.snapshot.yml', import.meta.url))
const teamConfigPath = fileURLToPath(new URL('../team.cordis.snapshot.yml', import.meta.url))
const startupFailureConfigPath = fileURLToPath(new URL('./fixtures/startup-activation-error/cordis.yml', import.meta.url))
const startupFailureExpected = join(snapshotsDir, 'startup-activation-error', 'stderr.expected.txt')
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const dshBinScript = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const reasoningConfigPath = fileURLToPath(new URL('./fixtures/cli.cordis.yml', import.meta.url))
const deepseekDefaultsConfigPath = fileURLToPath(new URL('./fixtures/deepseek-defaults.cordis.yml', import.meta.url))
const headlessOverlayPath = fileURLToPath(new URL('./fixtures/headless-profile.cordis.yml', import.meta.url))
const headlessSessionExpected = join(snapshotsDir, 'headless-profile', 'session.expected.jsonl')
const headlessFailureExpected = join(snapshotsDir, 'headless-profile', 'stderr.expected.txt')
const cliMockLlmPluginPath = fileURLToPath(new URL('./fixtures/cli-mock-llm.ts', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

interface JsonObject {
  [key: string]: unknown
}

interface PersistedLog {
  readonly content: string
  readonly header: JsonObject
}

interface DeepSeekDefaultsServer {
  readonly url: string
  readonly requests: JsonObject[]
  close(): Promise<void>
}

/** Idle budget SSE comments must rearm. Must match `streamIdleTimeoutMs` in deepseek-defaults.cordis.yml. */
const DEEPSEEK_DEFAULTS_STREAM_IDLE_TIMEOUT_MS = 5_000
/** Gap between keep-alive comments. Stays well below the idle budget under CI scheduling jitter. */
const DEEPSEEK_DEFAULTS_COMMENT_INTERVAL_MS = 2_000
/** Payload arrives after more than one idle budget, so a missing comment pulse would TIMEOUT. */
const DEEPSEEK_DEFAULTS_PAYLOAD_AFTER_MS =
  DEEPSEEK_DEFAULTS_STREAM_IDLE_TIMEOUT_MS + DEEPSEEK_DEFAULTS_COMMENT_INTERVAL_MS

const DEEPSEEK_DEFAULTS_SSE_PAYLOAD = [
  'data: {"choices":[{"delta":{"content":"DEFAULTS_OK"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  'data: [DONE]',
  '',
].join('\n\n')

/** Serve one deterministic DeepSeek-compatible response while retaining its request body. */
async function deepseekDefaultsServer(): Promise<DeepSeekDefaultsServer> {
  const requests: JsonObject[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // First comment leaves with the headers so `fetch` unblocks inside the
    // idle budget. Later comments rearm the watchdog; the payload is delayed
    // past one full idle budget so keep-alive is the assembled one-shot path,
    // not only the fake-clock adapter unit test.
    const opened = Date.now()
    const at = (ms: number, write: () => void): void => {
      setTimeout(write, Math.max(0, ms - (Date.now() - opened)))
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': keep-alive\n\n')
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as JsonObject)
      at(DEEPSEEK_DEFAULTS_COMMENT_INTERVAL_MS, () => { response.write(': keep-alive\n\n') })
      at(DEEPSEEK_DEFAULTS_COMMENT_INTERVAL_MS * 2, () => { response.write(': keep-alive\n\n') })
      at(DEEPSEEK_DEFAULTS_PAYLOAD_AFTER_MS, () => { response.end(DEEPSEEK_DEFAULTS_SSE_PAYLOAD) })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('DeepSeek defaults snapshot server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
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

function normalizeHeadlessStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  if (records.length === 0) throw new Error('headless snapshot emitted no stream-json records')
  const final = records.at(-1)
  if (final?.type !== 'result') throw new Error('headless snapshot did not end with a result record')
  if (records.slice(0, -1).some(record => record.type !== 'session_event')) {
    throw new Error('headless snapshot emitted a non-event record before its result')
  }

  const sessionIds = [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))]
  if (sessionIds.length !== 1) throw new Error(`headless snapshot streamed ${sessionIds.length} main session ids`)
  const context: NormalizeContext = { sessionIds, cwd }
  const events = records.slice(0, -1).map((record) => {
    if (record.event === null || typeof record.event !== 'object' || Array.isArray(record.event)) {
      throw new Error('headless snapshot emitted an invalid session event')
    }
    return record.event as JsonObject
  })
  const normalizedEvents = parseJsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    context,
  )))
  const normalizedRecords = records.map((record, index) => index < normalizedEvents.length
    ? { ...record, event: normalizedEvents[index] }
    : record)
  return normalizeStdout(`${normalizedRecords.map(record => JSON.stringify(record)).join('\n')}\n`, context)
}

/** Zero durable goal timestamps inside both metadata records and rendered XML JSON. */
function normalizeGoalTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/("(?:createdAt|updatedAt|clearedAt)":)\d+/g, '$10')
  }
  if (Array.isArray(value)) return value.map(normalizeGoalTimestamps)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      ['createdAt', 'updatedAt', 'clearedAt'].includes(key) && typeof item === 'number'
        ? 0
        : normalizeGoalTimestamps(item),
    ]))
  }
  return value
}

/** Normalize the stream's durable goal timestamps after the shared scrubbers. */
function normalizeGoalStream(rawStdout: string, cwd: string): string {
  return parseJsonl(normalizeHeadlessStream(rawStdout, cwd))
    .map(record => JSON.stringify(normalizeGoalTimestamps(record)))
    .join('\n') + '\n'
}

async function scenarioPrompt(dir: string, label: string): Promise<string> {
  const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error(`${label} input has no prompt step`)
  return prompt
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

async function persistedLogs(cwd: string, root: string = join(cwd, '.sessions')): Promise<PersistedLog[]> {
  const files = (await readdir(root, { recursive: true }))
    .filter(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
  return Promise.all(files.map(async (file) => {
    const content = await readPersistedLog(join(root, file))
    return { content, header: parseJsonl(content)[0] ?? {} }
  }))
}

/** Install the keyless product-CLI adapter into the temporary headless profile. */
async function prepareCliMockFixture(cwd: string): Promise<void> {
  const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'snapshot-fixtures')
  await mkdir(fixtureDir, { recursive: true })
  await Promise.all([
    copyFile(cliMockLlmPluginPath, join(fixtureDir, 'cli-mock-llm.ts')),
    writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
  ])
}

/** Install the restart driver into the real temporary headless profile. */
async function prepareDeferredToolSearchFixture(cwd: string): Promise<void> {
  const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'snapshot-fixtures')
  await mkdir(fixtureDir, { recursive: true })
  await Promise.all([
    copyFile(deferredToolSearchRunnerPath, join(fixtureDir, 'deferred-tool-search-runner.ts')),
    writeFile(join(fixtureDir, 'llm-replay-proxy.mjs'), llmReplayProxy),
    writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
  ])
}

/** Install Browser Runtime source/lib proxies and the restart driver into the temporary profile. */
async function prepareBrowserRuntimeFixture(cwd: string): Promise<void> {
  const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'snapshot-fixtures')
  await mkdir(fixtureDir, { recursive: true })
  await Promise.all([
    copyFile(deferredToolSearchRunnerPath, join(fixtureDir, 'deferred-tool-search-runner.ts')),
    writeFile(join(fixtureDir, 'browser-runtime-deterministic-proxy.mjs'), browserRuntimeDeterministicProxy),
    writeFile(join(fixtureDir, 'tool-browser-proxy.mjs'), toolBrowserProxy),
    writeFile(join(fixtureDir, 'llm-replay-proxy.mjs'), llmReplayProxy),
    writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
  ])
}

/**
 * Reserve one loopback TCP port for the spawned Tandem fixture child.
 *
 * @returns A port number the kernel reported free at reservation time.
 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('tandem snapshot has no TCP test port')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

/** Install the Tandem-shaped HTTP provider proxy and driver into the temporary profile. */
async function prepareBrowserRuntimeTandemFixture(cwd: string): Promise<void> {
  const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'snapshot-fixtures')
  await mkdir(fixtureDir, { recursive: true })
  await Promise.all([
    copyFile(deferredToolSearchRunnerPath, join(fixtureDir, 'deferred-tool-search-runner.ts')),
    writeFile(join(fixtureDir, 'browser-runtime-tandem-proxy.mjs'), browserRuntimeTandemProxy),
    writeFile(join(fixtureDir, 'tool-browser-proxy.mjs'), toolBrowserProxy),
    writeFile(join(fixtureDir, 'llm-replay-proxy.mjs'), llmReplayProxy),
    writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
  ])
}

describe('headless stream-json snapshots', () => {
  it('runs one task through the product headless profile command', async () => {
    const task = 'Prove the product headless profile path with one real tool round trip.'
    const result = await runLoaderSmoke({
      label: 'product headless profile snapshot',
      tempDirPrefix: 'headless-snapshot-profile-',
      binScript: dshBinScript,
      configPath: headlessOverlayPath,
      binArgs: ['--profile', 'headless', '--patch', headlessOverlayPath, task],
      tsconfigPath,
      env: {
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: prepareCliMockFixture,
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd, join(cwd, '.dsh', 'sessions'))
        expect(logs).toHaveLength(1)
        const actual = logs[0]
        if (actual === undefined) throw new Error('the headless profile did not persist its session')
        const context = contextFromLogs([actual.content])
        const session = scrubRequestHeaders(normalizeSessionLog(actual.content, context))
        if (refreshing) await writeFile(headlessSessionExpected, session)
        expect(session).toBe(await readFile(headlessSessionExpected, 'utf8'))
        expect(session).toContain(task)
        expect(session).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      },
    })

    expect(result.stdout).toBe('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP\n')
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints a terminal model failure through the product headless profile command', async () => {
    const result = await runLoaderSmoke({
      label: 'product headless profile model failure snapshot',
      tempDirPrefix: 'headless-snapshot-profile-failure-',
      binScript: dshBinScript,
      configPath: headlessOverlayPath,
      binArgs: ['--profile', 'headless', '--patch', headlessOverlayPath, 'Trigger the keyless model failure.'],
      tsconfigPath,
      expectedExitCode: 1,
      env: {
        DSH_CLI_MOCK_FAILURE: '1',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: prepareCliMockFixture,
    })

    expect(result.stdout).toBe('\n')
    await expect(result.stderr).toMatchFileSnapshot(headlessFailureExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints the original Loader activation error through the assembled one-shot app', async () => {
    const result = await runLoaderSmoke({
      label: 'headless startup activation error snapshot',
      tempDirPrefix: 'headless-snapshot-startup-error-',
      binScript,
      libBinScript: binScript,
      configPath: startupFailureConfigPath,
      binArgs: [startupFailureConfigPath, 'unreachable task'],
      tsconfigPath,
      expectedExitCode: 1,
    })
    expect(result.stdout).toBe('')
    await expect(result.stderr).toMatchFileSnapshot(startupFailureExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('retries a transient provider failure through the one-shot app', async () => {
    const prompt = await scenarioPrompt(retryScenarioDir, 'provider-retry')
    const streamExpected = join(retryScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'provider retry headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-provider-retry-',
      binScript,
      libBinScript: binScript,
      configPath: retryConfigPath,
      binArgs: [retryConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const retries = records.filter(record => record.type === 'llm/retry')
        expect(retries).toHaveLength(1)
        expect(retries[0]?.data).toMatchObject({
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: '["normal",1,["RATE_LIMIT"],1,1,0]',
          retry: 1,
          maxRetries: 1,
          delayMs: 1,
          failure: { message: 'snapshot transient failure', code: 'RATE_LIMIT', status: 429 },
        })
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('recovers from context overflow through an assembled compaction', async () => {
    const prompt = await scenarioPrompt(compactionScenarioDir, 'compaction-recovery')
    let expectedSession = await readFile(compactionSessionFixture, 'utf8')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'compaction recovery headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-compaction-recovery-',
      binScript,
      libBinScript: binScript,
      configPath: compactionConfigPath,
      binArgs: [compactionConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: compactionSessionFixture,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const actual = logs[0]
        if (actual === undefined) throw new Error('compaction snapshot did not persist its session')
        const records = parseJsonl(actual.content)
        const types = records.map(record => record.type)
        expect(types.filter(type => type === 'compaction/start')).toHaveLength(1)
        expect(types.filter(type => type === 'compaction/summary')).toHaveLength(1)
        expect(types.filter(type => type === 'compaction/end')).toHaveLength(1)
        const start = types.indexOf('compaction/start')
        const summary = types.indexOf('compaction/summary')
        const replacement = records.findIndex((record) => {
          if (record.type !== 'user/message') return false
          const surfaceOp = record.surfaceOp as JsonObject | undefined
          return surfaceOp?.op === 'replace'
        })
        const end = types.indexOf('compaction/end')
        expect(start).toBeLessThan(summary)
        expect(summary).toBeLessThan(replacement)
        expect(replacement).toBeLessThan(end)
        const summaryRecord = records[summary]
        const summaryData = summaryRecord?.data as JsonObject | undefined
        expect(summaryData?.shadowedSeqs).toEqual(expect.arrayContaining([expect.any(Number)]))
        const final = [...records].reverse().find(record => record.type === 'assistant/message')
        expect(JSON.stringify(final)).toContain('COMPACTION RECOVERED')

        const actualContext = contextFromLogs([actual.content])
        if (refreshing) {
          const harvested: HarvestedLog = {
            id: String(actual.header.id),
            createdAt: Number(actual.header.createdAt),
            content: actual.content,
          }
          const replacements = refreshFixtureReplacements([harvested], [expectedSession])
          expectedSession = tokenizeSessionFixtureCwd(
            stabilizeRefreshLog(actual.content, expectedSession, replacements, actualContext),
          )
          await writeFile(compactionSessionFixture, expectedSession)
        }
        const expectedContext = contextFromLogs([expectedSession])
        expect(scrubRequestHeaders(normalizeSessionLog(actual.content, actualContext)))
          .toBe(scrubRequestHeaders(normalizeSessionLog(expectedSession, expectedContext)))
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(compactionStreamExpected, normalized)
    expect(normalized).toBe(await readFile(compactionStreamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs actionable missing-credential guidance through the one-shot app', async () => {
    const streamExpected = join(credentialsScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'missing-credential headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-missing-credential-',
      binScript,
      libBinScript: binScript,
      configPath: credentialsConfigPath,
      binArgs: [credentialsConfigPath, 'say pong'],
      tsconfigPath,
      env: {
        // First-run posture: no key in the environment, none under ./.dsh.
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
    })

    // The failure reaches the caller through the stream, not stderr; the
    // recorded transcript below pins the guidance text itself, which names
    // both places a credential can come from and nothing else.
    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
    // The durable failure leads with the credential store — the path that
    // keeps the secret out of configuration files — then names the launching
    // environment, and stops there: configuration carries the reference, so
    // there is no literal-key escape hatch left to offer.
    expect(normalized).toContain(
      'store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),',
    )
    expect(normalized).toContain('or export DEEPSEEK_API_KEY in the launching environment')
    expect(normalized).not.toContain('as a last resort')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs actionable invalid-credential guidance through the one-shot app', async () => {
    const streamExpected = join(invalidCredentialScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'invalid-credential headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-invalid-credential-',
      binScript,
      libBinScript: binScript,
      configPath: credentialsConfigPath,
      binArgs: [credentialsConfigPath, 'say pong'],
      tsconfigPath,
      env: {
        // A key that exists but no HTTP header can carry — the paste the
        // credential guard exists for: without it, `fetch` refuses to build
        // the header and the turn ends on a retried ByteString TypeError.
        DEEPSEEK_API_KEY: 'sk-\u{1F600}pasted-from-a-chat-window',
        DEEPSEEK_BASE_URL: '',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
    // The durable failure names the reference to correct and the writer that
    // usually owns it, and stays true in a composition that mounts no Models
    // page at all.
    expect(normalized).toContain('the API key resolved from DEEPSEEK_API_KEY contains characters')
    expect(normalized).toContain('the web Models page writes it')
    // Neither the key nor its transport-level symptom (the ByteString error)
    // may reach the user: the code point of one character is still the key.
    expect(normalized).not.toContain('pasted-from-a-chat-window')
    expect(normalized).not.toContain('ByteString')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs the model default and a dynamic next-step reasoning effort', async () => {
    const result = await runLoaderSmoke({
      label: 'reasoning effort headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-reasoning-effort-',
      binScript,
      libBinScript: binScript,
      configPath: reasoningConfigPath,
      binArgs: [reasoningConfigPath, 'prove dynamic reasoning effort'],
      tsconfigPath,
    })

    expect(result.stderr).toBe('')
    const headers = parseJsonl(result.stdout)
      .map(record => record.event)
      .filter((event): event is JsonObject => (
        event !== null
        && typeof event === 'object'
        && !Array.isArray(event)
        && 'type' in event
        && event.type === 'request/header'
      ))
      .map((event) => {
        const data = event.data as JsonObject
        return (data.header as JsonObject).config
      })
    expect(headers).toMatchInlineSnapshot(`
      [
        {
          "model": "cli-mock",
          "provider": "cli-mock",
          "reasoningEffort": "high",
        },
        {
          "model": "cli-mock",
          "provider": "cli-mock",
          "reasoningEffort": "off",
        },
      ]
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('discovers and reloads a deferred MCP tool through the shipped headless composition', async () => {
    const prompt = await scenarioPrompt(deferredToolSearchScenarioDir, 'deferred-tool-search')
    let runCwd = ''
    const results = await runLoaderSmokeSequence({
      label: 'deferred tool search headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-deferred-tool-search-',
      binScript: dshBinScript,
      configPath: deferredToolSearchConfigPath,
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_LLM_REPLAY_ENTRY: llmReplayEntry,
        DSH_MCP_SERVER_EVERYTHING_ENTRY: mcpServerEverythingEntry,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      invocations: [
        {
          binArgs: ['--profile', 'headless', '--patch', deferredToolSearchConfigPath, prompt],
          env: { DSH_SNAPSHOT_FILE: deferredToolSearchSessionFixture },
        },
        {
          binArgs: [
            '--profile', 'headless', '--patch', deferredToolSearchConfigPath,
            'Confirm that the echo schema was reconstructed from the persisted discovery result.',
          ],
          env: { DSH_SNAPSHOT_FILE: deferredToolSearchResumeFixture },
        },
      ],
      prepare: async (cwd) => {
        runCwd = cwd
        await prepareDeferredToolSearchFixture(cwd)
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd, join(cwd, '.dsh', 'sessions'))
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records
          .filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual(['tool_search', 'mcp__everything__echo'])

        const resultBlocks = records
          .filter(record => record.type === 'tool/result')
          .flatMap((record) => {
            const data = record.data as JsonObject | undefined
            const message = data?.message as JsonObject | undefined
            return Array.isArray(message?.content) ? message.content as JsonObject[] : []
          })
        const discovery = resultBlocks.find(block => Array.isArray(block.loadedTools))
        expect((discovery?.loadedTools as JsonObject[] | undefined)?.map(schema => schema.name))
          .toEqual(['mcp__everything__echo'])
        expect(JSON.stringify(resultBlocks)).toContain('Echo: deferred-loaded')

        const headers = records
          .filter(record => record.type === 'request/header')
          .map((record) => {
            const data = record.data as JsonObject
            const header = data.header as JsonObject
            const tools = Array.isArray(header.tools) ? header.tools as JsonObject[] : []
            return { reason: data.reason, tools: tools.map(tool => tool.name) }
          })
        expect(headers.map(header => header.reason)).toEqual(['initial', 'change', 'resume'])
        expect(headers[0]?.tools).toContain('tool_search')
        expect(headers[0]?.tools).not.toContain('mcp__everything__echo')
        expect(headers[1]?.tools).toContain('mcp__everything__echo')
        expect(headers[2]?.tools).toContain('mcp__everything__echo')
      },
    })

    expect(results.map(result => result.stderr)).toEqual([
      'Starting default (STDIO) server...\n',
      'Starting default (STDIO) server...\n',
    ])
    const normalized = results.map(result => normalizeHeadlessStream(result.stdout, runCwd)).join('')
    if (refreshing) await writeFile(deferredToolSearchStreamExpected, normalized)
    expect(normalized).toBe(await readFile(deferredToolSearchStreamExpected, 'utf8'))
    expect(JSON.parse(results[1]?.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      type: 'result',
      output: 'DEFERRED_TOOL_SEARCH_RESUMED',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs one temporary Browser Profile through deferred discovery and reload', async () => {
    const prompt = await scenarioPrompt(browserRuntimeScenarioDir, 'browser-runtime')
    let runCwd = ''
    const results = await runLoaderSmokeSequence({
      label: 'browser runtime headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-browser-runtime-',
      binScript: dshBinScript,
      configPath: browserRuntimeConfigPath,
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_LLM_REPLAY_ENTRY: llmReplayEntry,
        DSH_BROWSER_RUNTIME_DETERMINISTIC_ENTRY: browserRuntimeDeterministicEntry,
        DSH_TOOL_BROWSER_ENTRY: toolBrowserEntry,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      invocations: [
        {
          binArgs: ['--profile', 'headless', '--patch', browserRuntimeConfigPath, prompt],
          env: { DSH_SNAPSHOT_FILE: browserRuntimeSessionFixture },
        },
        {
          binArgs: [
            '--profile', 'headless', '--patch', browserRuntimeConfigPath,
            'Confirm that the browser schemas were reconstructed from the persisted discovery result.',
          ],
          env: { DSH_SNAPSHOT_FILE: browserRuntimeResumeFixture },
        },
      ],
      prepare: async (cwd) => {
        runCwd = cwd
        await prepareBrowserRuntimeFixture(cwd)
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd, join(cwd, '.dsh', 'sessions'))
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records
          .filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual([
          'tool_search',
          'browser_create',
          'browser_navigate',
          'browser_observe',
          'browser_screenshot',
          'browser_focus',
          'browser_input',
          'browser_close',
        ])

        const resultBlocks = records
          .filter(record => record.type === 'tool/result')
          .flatMap((record) => {
            const data = record.data as JsonObject | undefined
            const message = data?.message as JsonObject | undefined
            return Array.isArray(message?.content) ? message.content as JsonObject[] : []
          })
        const discovery = resultBlocks.find(block => Array.isArray(block.loadedTools))
        expect((discovery?.loadedTools as JsonObject[] | undefined)?.map(schema => schema.name).sort()).toEqual([
          'browser_close',
          'browser_create',
          'browser_focus',
          'browser_input',
          'browser_navigate',
          'browser_observe',
          'browser_screenshot',
        ])
        const browserValues = resultBlocks.slice(1).map((block) => {
          const content = Array.isArray(block.content) ? block.content as JsonObject[] : []
          const text = content.find(item => item.type === 'text')?.text
          if (typeof text !== 'string') throw new Error('browser result did not retain rendered text')
          return JSON.parse(text) as JsonObject
        })
        expect(browserValues.map(value => value.revision)).toEqual([0, 1, 1, 1, 2, 3, 4])
        expect(browserValues[0]).toMatchObject({
          chrome: { kind: 'temporary', partition: 'session-trace-tmp-1' },
        })
        expect(browserValues[0]).not.toHaveProperty('chrome.name')
        expect(browserValues[1]).toMatchObject({
          url: 'https://example.test/',
          title: 'Example Domain',
          text: 'A deterministic browser page.',
          chrome: { kind: 'temporary' },
        })
        expect(browserValues[3]).toMatchObject({ mediaType: 'image/png' })
        expect(browserValues[4]).toMatchObject({ focused: true })
        expect(browserValues[5]).toMatchObject({ text: 'human typed' })
        expect(browserValues[6]).toMatchObject({ status: 'closed' })
        const renderedFacts = JSON.stringify(browserValues)
        for (const identity of ['trace-tmp-1', 'trace-tmp-1-workspace', 'trace-tmp-1-browser-1', 'trace-tmp-1-tab-1']) {
          expect(renderedFacts).toContain(identity)
        }

        const headers = records
          .filter(record => record.type === 'request/header')
          .map((record) => {
            const data = record.data as JsonObject
            const header = data.header as JsonObject
            const tools = Array.isArray(header.tools) ? header.tools as JsonObject[] : []
            return { reason: data.reason, tools: tools.map(tool => tool.name) }
          })
        expect(headers.map(header => header.reason)).toEqual(['initial', 'change', 'resume'])
        expect(headers[0]?.tools).toContain('tool_search')
        expect(headers[0]?.tools.some(name => typeof name === 'string' && name.startsWith('browser_'))).toBe(false)
        for (const header of headers.slice(1)) {
          expect(header.tools).toEqual(expect.arrayContaining([
            'browser_create',
            'browser_navigate',
            'browser_observe',
            'browser_screenshot',
            'browser_focus',
            'browser_input',
            'browser_close',
          ]))
        }
      },
    })

    expect(results.map(result => result.stderr)).toEqual(['', ''])
    const normalized = results.map(result => normalizeHeadlessStream(result.stdout, runCwd)).join('')
    if (refreshing) await writeFile(browserRuntimeStreamExpected, normalized)
    expect(normalized).toBe(await readFile(browserRuntimeStreamExpected, 'utf8'))
    expect(JSON.parse(results[1]?.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      type: 'result',
      output: 'BROWSER_RUNTIME_RESUMED',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs one temporary Tandem Browser Profile through deferred discovery and reload', async () => {
    const prompt = await scenarioPrompt(browserRuntimeTandemScenarioDir, 'browser-runtime-tandem')
    const port = await freePort()
    let runCwd = ''
    const results = await runLoaderSmokeSequence({
      label: 'tandem browser runtime headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-browser-runtime-tandem-',
      binScript: dshBinScript,
      configPath: browserRuntimeTandemConfigPath,
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_LLM_REPLAY_ENTRY: llmReplayEntry,
        DSH_BROWSER_RUNTIME_TANDEM_ENTRY: browserRuntimeTandemEntry,
        DSH_TOOL_BROWSER_ENTRY: toolBrowserEntry,
        DSH_TANDEM_FIXTURE_PORT: String(port),
        DSH_TANDEM_TOKEN_FILE: 'tandem-api-token',
        DSH_TANDEM_FIXTURE_PATH: tandemHttpFixturePath,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      invocations: [
        {
          binArgs: ['--profile', 'headless', '--patch', browserRuntimeTandemConfigPath, prompt],
          env: { DSH_SNAPSHOT_FILE: browserRuntimeTandemSessionFixture },
        },
        {
          binArgs: [
            '--profile', 'headless', '--patch', browserRuntimeTandemConfigPath,
            'Confirm that the browser schemas were reconstructed from the persisted discovery result.',
          ],
          env: { DSH_SNAPSHOT_FILE: browserRuntimeTandemResumeFixture },
        },
      ],
      prepare: async (cwd) => {
        runCwd = cwd
        await prepareBrowserRuntimeTandemFixture(cwd)
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd, join(cwd, '.dsh', 'sessions'))
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records
          .filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual([
          'tool_search',
          'browser_create',
          'browser_navigate',
          'browser_observe',
          'browser_screenshot',
          'browser_focus',
          'browser_input',
          'browser_close',
        ])

        const resultBlocks = records
          .filter(record => record.type === 'tool/result')
          .flatMap((record) => {
            const data = record.data as JsonObject | undefined
            const message = data?.message as JsonObject | undefined
            return Array.isArray(message?.content) ? message.content as JsonObject[] : []
          })
        const discovery = resultBlocks.find(block => Array.isArray(block.loadedTools))
        expect((discovery?.loadedTools as JsonObject[] | undefined)?.map(schema => schema.name).sort()).toEqual([
          'browser_close',
          'browser_create',
          'browser_focus',
          'browser_input',
          'browser_navigate',
          'browser_observe',
          'browser_screenshot',
        ])
        const browserValues = resultBlocks.slice(1).map((block) => {
          const content = Array.isArray(block.content) ? block.content as JsonObject[] : []
          const text = content.find(item => item.type === 'text')?.text
          if (typeof text !== 'string') throw new Error('browser result did not retain rendered text')
          return JSON.parse(text) as JsonObject
        })
        expect(browserValues.map(value => value.revision)).toEqual([0, 1, 1, 1, 2, 3, 4])
        expect(browserValues[0]).toMatchObject({
          chrome: { kind: 'temporary', partition: 'session-tandem-tmp-1' },
        })
        expect(browserValues[1]).toMatchObject({
          url: 'https://example.test/',
          title: 'Example Domain',
          text: 'A real Tandem protocol page.',
          chrome: { kind: 'temporary' },
        })
        expect(browserValues[3]).toMatchObject({ mediaType: 'image/png' })
        expect(browserValues[4]).toMatchObject({ focused: true })
        expect(browserValues[5]).toMatchObject({ text: 'human typed' })
        expect(browserValues[6]).toMatchObject({ status: 'closed' })
        const renderedFacts = JSON.stringify(browserValues)
        for (const identity of ['tandem-tmp-1', 'tandem-tmp-1-workspace', 'tandem-tmp-1-browser-1', 'tandem-tmp-1-tab-1']) {
          expect(renderedFacts).toContain(identity)
        }

        const headers = records
          .filter(record => record.type === 'request/header')
          .map((record) => {
            const data = record.data as JsonObject
            const header = data.header as JsonObject
            const tools = Array.isArray(header.tools) ? header.tools as JsonObject[] : []
            return { reason: data.reason, tools: tools.map(tool => tool.name) }
          })
        expect(headers.map(header => header.reason)).toEqual(['initial', 'change', 'resume'])
        expect(headers[0]?.tools).toContain('tool_search')
        expect(headers[0]?.tools.some(name => typeof name === 'string' && name.startsWith('browser_'))).toBe(false)
        for (const header of headers.slice(1)) {
          expect(header.tools).toEqual(expect.arrayContaining([
            'browser_create',
            'browser_navigate',
            'browser_observe',
            'browser_screenshot',
            'browser_focus',
            'browser_input',
            'browser_close',
          ]))
        }
      },
    })

    expect(results.map(result => result.stderr)).toEqual(['', ''])
    const normalized = results.map(result => normalizeHeadlessStream(result.stdout, runCwd)).join('')
    if (refreshing) await writeFile(browserRuntimeTandemStreamExpected, normalized)
    expect(normalized).toBe(await readFile(browserRuntimeTandemStreamExpected, 'utf8'))
    expect(JSON.parse(results[1]?.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      type: 'result',
      output: 'TANDEM_BROWSER_RESUMED',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('fails the shipped-profile scenario when the bundle no longer enables toolSearch', async () => {
    const result = await runLoaderSmoke({
      label: 'deferred tool search shipped-wiring negative control',
      tempDirPrefix: 'headless-snapshot-deferred-tool-search-disabled-',
      binScript: dshBinScript,
      configPath: deferredToolSearchConfigPath,
      binArgs: [
        '--profile', 'headless',
        '--patch', deferredToolSearchConfigPath,
        '--patch', deferredToolSearchDisabledConfigPath,
        'This launch must fail before the deferred scenario can run.',
      ],
      tsconfigPath,
      expectedExitCode: 1,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: deferredToolSearchSessionFixture,
        DSH_LLM_REPLAY_ENTRY: llmReplayEntry,
        DSH_MCP_SERVER_EVERYTHING_ENTRY: mcpServerEverythingEntry,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: prepareDeferredToolSearchFixture,
    })

    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('deferLoading requires dsh-tools toolSearch configuration')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps provider comments alive and sends DeepSeek defaults through the one-shot app', async () => {
    const server = await deepseekDefaultsServer()
    try {
      const result = await runLoaderSmoke({
        label: 'DeepSeek adapter defaults headless stream-json snapshot',
        tempDirPrefix: 'headless-snapshot-deepseek-defaults-',
        binScript,
        libBinScript: binScript,
        configPath: deepseekDefaultsConfigPath,
        binArgs: [
          deepseekDefaultsConfigPath,
          'return the deterministic response',
        ],
        tsconfigPath,
        env: {
          // Configuration carries only the reference; the key rides the
          // launching environment, which is the whole credential plane here.
          DEEPSEEK_API_KEY: 'snapshot-key',
          DSH_SNAPSHOT_BASE_URL: server.url,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        },
      })

      expect(result.stderr).toBe('')
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.max_tokens).toBe(256_000)
      expect(server.requests[0]?.reasoning_effort).toBe('low')
      const header = (parseJsonl(result.stdout)
        .map(record => record.event)
        .find((event): event is JsonObject => (
          event !== null
          && typeof event === 'object'
          && !Array.isArray(event)
          && 'type' in event
          && event.type === 'request/header'
        ))?.data as JsonObject | undefined)?.header as JsonObject | undefined
      expect(header?.config).toMatchInlineSnapshot(`
        {
          "maxTokens": 256000,
          "model": "deepseek-v4-flash",
          "provider": "deepseek-official",
          "reasoningEffort": "low",
        }
      `)
      expect(header?.adapterDefaults).toEqual({
        maxTokens: true,
        reasoningEffort: true,
      })
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('replays the advanced toolchain through the one-shot app', async () => {
    const prompt = await scenarioPrompt(advancedScenarioDir, 'advanced-toolchain')
    const fixtureFiles = [
      advancedSessionFixture,
      join(advancedScenarioDir, 'session.1.jsonl'),
      join(advancedScenarioDir, 'session.2.jsonl'),
    ]
    let expectedSessions = await Promise.all(fixtureFiles.map(file => readFile(file, 'utf8')))
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'advanced headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-advanced-',
      binScript,
      libBinScript: binScript,
      configPath: advancedConfigPath,
      binArgs: [advancedConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: advancedSessionFixture,
        DSH_SNAPSHOT_CHILD_FILES: [
          join(advancedScenarioDir, 'session.1.jsonl'),
          join(advancedScenarioDir, 'session.2.jsonl'),
        ].join(delimiter),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(3)
        const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
        expect(parents).toHaveLength(1)
        const parent = parents[0]
        if (parent === undefined) throw new Error('headless snapshot did not persist its main session')
        const children = logs.filter(log => typeof log.header.parentSession === 'string')
          .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
        const actualSessions = [parent, ...children]
        const actualContext = contextFromLogs(actualSessions.map(log => log.content))
        if (refreshing) {
          const harvested = actualSessions.map((log): HarvestedLog => ({
            id: String(log.header.id),
            createdAt: Number(log.header.createdAt),
            ...typeof log.header.parentSession === 'string'
              ? { parentSession: log.header.parentSession }
              : {},
            content: log.content,
          }))
          const replacements = refreshFixtureReplacements(harvested, expectedSessions)
          expectedSessions = await Promise.all(actualSessions.map(async (actual, index) => {
            const existing = expectedSessions[index]
            const file = fixtureFiles[index]
            if (existing === undefined || file === undefined) {
              throw new Error(`headless snapshot has no fixture for persisted log ${index}`)
            }
            const stable = tokenizeSessionFixtureCwd(
              stabilizeRefreshLog(actual.content, existing, replacements, actualContext),
            )
            await writeFile(file, stable)
            return stable
          }))
        }
        const expectedContext = contextFromLogs(expectedSessions)
        for (const [index, actual] of actualSessions.entries()) {
          const expected = expectedSessions[index]
          if (expected === undefined) throw new Error(`headless snapshot has no fixture for persisted log ${index}`)
          expect(scrubRequestHeaders(normalizeSessionLog(actual.content, actualContext)))
            .toBe(scrubRequestHeaders(normalizeSessionLog(expected, expectedContext)))
        }
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(advancedStreamExpected, normalized)
    expect(normalized).toBe(await readFile(advancedStreamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs a keyless Agent Team with peer mail, dependent tasks, waiting, and Lead aggregation', async () => {
    let projection: unknown
    const result = await runLoaderSmoke({
      label: 'Agent Teams headless snapshot',
      tempDirPrefix: 'headless-snapshot-agent-team-',
      binScript,
      libBinScript: binScript,
      configPath: teamConfigPath,
      binArgs: [
        teamConfigPath,
        '请明确使用 Agent Teams，把调研和实现拆给两个 teammate，等待完成后汇总。',
      ],
      tsconfigPath,
      processTimeoutMs: 60_000,
      env: {
        DSH_SNAPSHOT: 'team',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        const parent = logs.find(log => typeof log.header.parentSession !== 'string')
        if (parent === undefined) throw new Error('Agent Teams snapshot did not persist its Lead')
        const rows = parseJsonl(parent.content)
        const members = rows.filter(row => row.type === 'team/member')
          .map(row => ((row.data as JsonObject).member as JsonObject))
        const tasks = rows.filter(row => row.type === 'team/task')
          .map(row => ((row.data as JsonObject).task as JsonObject))
        const latestTasks = Object.values(Object.fromEntries(tasks.map(task => [String(task.subject), task])))
        projection = {
          sessions: logs.length,
          memberEdges: members.length,
          activeMembers: members.filter(member => member.phase === 'active').map(member => member.name).sort(),
          tasks: latestTasks.map(task => ({
            subject: task.subject,
            revision: task.revision,
            status: task.status,
          })).sort((left, right) => String(left.subject).localeCompare(String(right.subject))),
          queuedMessages: rows.filter(row => row.type === 'team/message/queued').length,
          deliveredMessages: rows.filter(row => row.type === 'team/message/delivered').length,
          waited: rows.some(row => row.type === 'tool/call'
            && (row.data as JsonObject).name === 'wait_agent'),
          checkedRoster: rows.some(row => row.type === 'tool/call'
            && (row.data as JsonObject).name === 'list_agents'),
        }
      },
    })
    expect(result.stderr).toBe('')
    expect(parseJsonl(result.stdout).at(-1)).toMatchObject({
      type: 'result',
      output: 'TEAM_WORKFLOW_OK: both teammates and dependent tasks completed.',
    })
    expect(projection).toMatchInlineSnapshot(`
      {
        "activeMembers": [
          "implementer",
          "researcher",
        ],
        "checkedRoster": true,
        "deliveredMessages": 2,
        "memberEdges": 4,
        "queuedMessages": 2,
        "sessions": 3,
        "tasks": [
          {
            "revision": 3,
            "status": "completed",
            "subject": "Implementation",
          },
          {
            "revision": 3,
            "status": "completed",
            "subject": "Research",
          },
        ],
        "waited": true,
      }
    `)
  }, 75_000)

  it('replays persisted goal tools through the one-shot app', async () => {
    const prompt = await scenarioPrompt(goalScenarioDir, 'goal-tools')
    const streamExpected = join(goalScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'goal tools headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-goal-tools-',
      binScript,
      libBinScript: binScript,
      configPath: goalConfigPath,
      binArgs: [goalConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(goalScenarioDir, 'session.jsonl'),
        DSH_SNAPSHOT_OVERRIDE: join(goalScenarioDir, 'replay.override.json'),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records.filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual(['update_goal', 'create_goal', 'get_goal'])
        const probeResult = records.find((record) => {
          if (record.type !== 'tool/result') return false
          const data = record.data as JsonObject | undefined
          const message = data?.message as JsonObject | undefined
          const source = message?.source as JsonObject | undefined
          return source?.callId === 'call_goal_probe'
        })
        const probeData = probeResult?.data as JsonObject | undefined
        const probeMessage = probeData?.message as JsonObject | undefined
        const probeContent = probeMessage?.content as JsonObject[] | undefined
        expect(probeContent?.[0]?.isError).toBe(true)
        expect((probeData?.error as JsonObject | undefined)?.code).toBe('GOAL_NOT_FOUND')
        const goalChanges = records.filter(record => record.type === 'goal/change')
        expect(goalChanges).toHaveLength(1)
        const data = goalChanges[0]?.data as JsonObject | undefined
        const goal = data?.goal as JsonObject | undefined
        expect(data?.operation).toBe('create')
        expect(goal).toMatchObject({
          objective: 'Finish the headless goal-tool snapshot proof',
          phase: 'active',
          maxGoalRounds: 7,
        })
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeGoalStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('replays two fresh Ralph rounds through the one-shot app', async () => {
    const prompt = await scenarioPrompt(ralphScenarioDir, 'ralph-loop')
    const streamExpected = join(ralphScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'Ralph loop headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-ralph-loop-',
      binScript,
      libBinScript: binScript,
      configPath: ralphConfigPath,
      binArgs: [ralphConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(ralphScenarioDir, 'session.jsonl'),
        DSH_SNAPSHOT_OVERRIDE: join(ralphScenarioDir, 'replay.override.json'),
        DSH_SNAPSHOT_CHILD_FILES: [
          join(ralphScenarioDir, 'session.1.jsonl'),
          join(ralphScenarioDir, 'session.2.jsonl'),
        ].join(delimiter),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(3)
        const parent = logs.find(log => typeof log.header.parentSession !== 'string')
        if (parent === undefined) throw new Error('Ralph snapshot did not persist its parent session')
        const parentId = parent.header.id
        expect(typeof parentId).toBe('string')
        const children = logs.filter(log => typeof log.header.parentSession === 'string')
          .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
        expect(children).toHaveLength(2)
        expect(children.map(child => child.header.parentSession)).toEqual([parentId, parentId])
        expect(children.map(child => child.header.cwd)).toEqual([parent.header.cwd, parent.header.cwd])
        expect(parent.header.delegationDepth).toBe(0)
        expect(children.map(child => child.header.delegationDepth)).toEqual([1, 1])
        expect(children.map(child => child.header.seedLength)).toEqual([undefined, undefined])
        expect(new Set(children.map(child => child.header.id)).size).toBe(2)

        const parentRecords = parseJsonl(parent.content)
        const parentCalls = parentRecords.filter(record => record.type === 'tool/call')
        expect(parentCalls.map(record => (record.data as JsonObject | undefined)?.name)).toEqual(['ralph'])
        const parentResult = parentRecords.find(record => record.type === 'tool/result')
        const parentResultData = parentResult?.data as JsonObject | undefined
        const parentMessage = parentResultData?.message as JsonObject | undefined
        const parentContent = parentMessage?.content as JsonObject[] | undefined
        expect(parentContent?.[0]?.isError).toBe(false)
        expect(JSON.stringify(parentContent?.[0]?.content)).toContain('reported completion after 2 rounds')

        const childRecords = children.map(child => parseJsonl(child.content))
        const childPrompts = childRecords.map((records) => {
          const message = records.find(record => record.type === 'user/message')
          return JSON.stringify((message?.data as JsonObject | undefined)?.content)
        })
        expect(childPrompts[0]).toContain('Ralph round: 1 of 2.')
        expect(childPrompts[0]).toContain('(none — this is the first round)')
        expect(childPrompts[0]).not.toContain('ROUND_ONE_HANDOFF')
        expect(childPrompts[1]).toContain('Ralph round: 2 of 2.')
        expect(childPrompts[1]).toContain('ROUND_ONE_HANDOFF')
        for (const childPrompt of childPrompts) {
          expect(childPrompt).toContain('Prove two fresh Ralph rounds through the shipped headless app.')
          expect(childPrompt).not.toContain('Run a two-round fresh-agent Ralph loop')
        }
        for (const records of childRecords) {
          const calls = records.filter(record => record.type === 'tool/call')
          expect(calls.map(record => (record.data as JsonObject | undefined)?.name))
            .toEqual(['structured_output'])
        }
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('delivers a continuable child result without parent polling', async () => {
    const parentReplay = join(settlementScenarioDir, 'parent.replay.jsonl')
    const parentOverride = join(settlementScenarioDir, 'parent.override.json')
    const childReplay = join(settlementScenarioDir, 'child.replay.jsonl')
    const childExpected = join(settlementScenarioDir, 'child.expected.jsonl')
    const streamExpected = join(settlementScenarioDir, 'stream-json.expected.jsonl')
    const task = 'Start one continuable background subagent and answer from its completion notice. Do not call list_agents, send_message, job_output, or job_list.'
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'continuable settlement headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-subagent-settlement-',
      binScript,
      libBinScript: binScript,
      configPath: settlementConfigPath,
      binArgs: [settlementConfigPath, task],
      tsconfigPath,
      env: {
        // The override fully supplies the parent script; the child fixture
        // remains separate so replay binds it to the fresh child Session.
        DSH_SNAPSHOT_FILE: parentReplay,
        DSH_SNAPSHOT_OVERRIDE: parentOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(2)
        const parent = logs.find(log => typeof log.header.parentSession !== 'string')
        const child = logs.find(log => typeof log.header.parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')

        const parentRecords = parseJsonl(parent.content)
        const calls = parentRecords.filter(record => record.type === 'tool/call')
        expect(calls.map(record => (record.data as JsonObject | undefined)?.name)).toEqual(['subagent'])
        const callArguments = (calls[0]?.data as JsonObject | undefined)?.arguments
        if (typeof callArguments !== 'string') throw new Error('subagent call did not persist its arguments')
        expect(JSON.parse(callArguments)).not.toHaveProperty('run_in_background')

        const notices = parentRecords.flatMap((record) => {
          if (record.type !== 'agent/inbox/spliced') return []
          const inserted = (record.data as JsonObject | undefined)?.inserted
          if (!Array.isArray(inserted)) return []
          return (inserted as JsonObject[]).filter((message) => {
            const source = message.source as JsonObject | undefined
            return source?.kind === 'subagent-settled'
          })
        })
        expect(notices).toHaveLength(1)
        expect(JSON.stringify(notices[0])).toContain('CHILD_RESULT')

        const context = contextFromLogs([parent.content, child.content])
        const normalizedChild = scrubRequestHeaders(normalizeSessionLog(child.content, context))
        if (refreshing) await writeFile(childExpected, normalizedChild)
        expect(normalizedChild).toBe(await readFile(childExpected, 'utf8'))
        expect(normalizedChild).toContain('CHILD_RESULT')
        expect(normalizedChild).not.toContain('"name":"report"')
      },
    })

    expect(result.stderr).toBe('')
    const records = parseJsonl(result.stdout)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      output: 'PARENT_RECEIVED_CHILD_RESULT',
    })
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('replays persistent PTY tools through the one-shot app', async () => {
    const input = JSON.parse(await readFile(join(ptyScenarioDir, 'input.json'), 'utf8')) as {
      steps?: { op?: unknown; text?: unknown }[]
    }
    const prompt = input.steps?.find(step => step.op === 'prompt')?.text
    if (typeof prompt !== 'string') throw new Error('pty-tools input has no prompt step')
    let expectedSession = await readFile(ptySessionFixture, 'utf8')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'headless persistent PTY snapshot',
      tempDirPrefix: 'headless-snapshot-pty-',
      binScript,
      libBinScript: binScript,
      configPath: ptyConfigPath,
      binArgs: [ptyConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: ptySessionFixture,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const actual = logs[0]
        if (actual === undefined) throw new Error('headless PTY snapshot did not persist its session')
        const actualContext = contextFromLogs([actual.content])
        if (refreshing) {
          const harvested: HarvestedLog = {
            id: String(actual.header.id),
            createdAt: Number(actual.header.createdAt),
            content: actual.content,
          }
          const replacements = refreshFixtureReplacements([harvested], [expectedSession])
          expectedSession = tokenizeSessionFixtureCwd(
            stabilizeRefreshLog(actual.content, expectedSession, replacements, actualContext),
          )
          await writeFile(ptySessionFixture, expectedSession)
        }
        const expectedContext = contextFromLogs([expectedSession])
        expect(scrubRequestHeaders(normalizeSessionLog(actual.content, actualContext)))
          .toBe(scrubRequestHeaders(normalizeSessionLog(expectedSession, expectedContext)))
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(ptyStreamExpected, normalized)
    expect(normalized).toBe(await readFile(ptyStreamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
