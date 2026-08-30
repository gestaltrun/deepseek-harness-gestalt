#!/usr/bin/env node
/** Build and run the isolated Desktop Host phone-tab Electron e2e lane. */
import { spawn, spawnSync } from 'node:child_process'
import {
  access, appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const repoRoot = join(desktopRoot, '..', '..')
const e2eDir = join(desktopRoot, 'tests', 'e2e-electron')
const operatedPlatform = join(desktopRoot, 'tests', 'fixtures', 'operated-platform.json')
const fakeSource = join(repoRoot, 'packages', 'phone', 'phone-runtime', 'tests', 'fixtures', 'fakemobilecli.mjs')
const framesSource = join(repoRoot, 'packages', 'phone', 'phone-runtime', 'tests', 'fixtures', 'u3-visible-frames.ts')
const devicesSource = join(desktopRoot, 'tests', 'fixtures', 'phone-e2e-devices.json')
const wdioConfig = join(e2eDir, 'wdio.conf.ts')
const wdioBin = join(desktopRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js')

const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const artifactRoot = process.env.DSH_ELECTRON_E2E_ARTIFACTS
  ?? join(repoRoot, '.artifacts', 'e2e-electron', `${stamp}-${head}`)
await mkdir(artifactRoot, { recursive: true })

function scrubEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(name)) return false
    if (name.startsWith('DSH_PLATFORM_') || name.startsWith('DSH_REMOTE_RELAY_')) return false
    return ![
      'DSH_DESKTOP_SMOKE', 'DSH_DESKTOP_SMOKE_FILE', 'DSH_HOME', 'DSH_PHONE_MOBILECLI',
      'DSH_PHONE_REAL_UDID', 'DSH_PHONE_SERVER_PORT', 'DSH_ELECTRON_E2E_ARTIFACT_DIR',
      'DSH_ELECTRON_E2E_CDP_PORT', 'DSH_ELECTRON_E2E_FAKE_PORT', 'DSH_ELECTRON_E2E_USER_DATA',
      'DSH_ELECTRON_E2E_WORKSPACE',
    ].includes(name)
  }))
}

const cleanEnvironment = scrubEnvironment(process.env)

function listenZero(host) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close((error) => {
        if (error !== undefined) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('failed to allocate an ephemeral port'))
      })
    })
  })
}

async function runLogged(command, args, options) {
  const logFile = options.logFile
  await writeFile(logFile, '')
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (stream, chunk) => {
      const text = chunk.toString()
      stream.write(text)
      void appendFile(logFile, text)
    }
    child.stdout?.on('data', chunk => { onData(process.stdout, chunk) })
    child.stderr?.on('data', chunk => { onData(process.stderr, chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`${command} exited on ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

async function buildCurrentSource() {
  const buildLog = join(artifactRoot, 'build.log')
  await writeFile(buildLog, '')
  for (const [command, args, cwd] of [
    ['pnpm', ['run', 'build:lib:host'], repoRoot],
    ['pnpm', ['run', 'build:lib:client'], repoRoot],
    ['pnpm', ['run', 'build:web'], repoRoot],
    [process.execPath, [join(desktopRoot, 'scripts', 'build-main.mjs'), operatedPlatform], desktopRoot],
  ]) {
    const code = await runLogged(command, args, {
      cwd,
      env: cleanEnvironment,
      logFile: join(artifactRoot, `build-${String(args.at(-1)).replaceAll(/[^a-z0-9]+/gi, '-')}.log`),
    })
    const commandLog = await readFile(join(artifactRoot, `build-${String(args.at(-1)).replaceAll(/[^a-z0-9]+/gi, '-')}.log`))
    await appendFile(buildLog, commandLog)
    if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(code)}`)
  }
  await writeFile(join(artifactRoot, 'build-source.json'), JSON.stringify({ head, builtAt: new Date().toISOString() }, undefined, 2) + '\n')
}

async function startKeylessProvider() {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"desktop electron e2e response"}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('keyless provider exposed no TCP address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

async function stageFake() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-fake-'))
  const fixtures = join(root, 'fixtures')
  await mkdir(fixtures, { recursive: true })
  const executable = join(fixtures, 'fakemobilecli')
  await copyFile(fakeSource, executable)
  await chmod(executable, 0o755)
  await copyFile(framesSource, join(fixtures, 'u3-visible-frames.ts'))
  const devices = JSON.parse(await readFile(devicesSource, 'utf8'))
  await writeFile(join(fixtures, 'fakemobilecli.config.json'), JSON.stringify({
    devices,
    listEnvelope: true,
    captureEnvelope: true,
    streamFrameCount: 8,
  }))
  return { root, executable }
}

async function runSpec(name, spec, provider, mobilecli) {
  const artifactDir = join(artifactRoot, name)
  const runtimeRoot = await mkdtemp(join(tmpdir(), `dsh-desktop-e2e-${name}-`))
  const dshHome = join(runtimeRoot, 'dsh-home')
  const userData = join(runtimeRoot, 'electron-user-data')
  const workspace = join(runtimeRoot, 'workspace')
  const smokeFile = join(artifactDir, 'main-smoke.log')
  const fakePort = await listenZero('127.0.0.1')
  const cdpPort = await listenZero('127.0.0.1')
  await mkdir(artifactDir, { recursive: true })
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await writeFile(smokeFile, '')
  await writeFile(join(dshHome, 'settings.yaml'), [
    'ui-phone:',
    '  enabled: true',
    'ui-onboarding:',
    '  welcomeNoticeVersion: "2026-08-13.1"',
    '',
  ].join('\n'), { mode: 0o600 })
  const env = {
    ...cleanEnvironment,
    CI: 'true',
    LANG: 'zh_CN.UTF-8',
    LANGUAGE: 'zh_CN',
    DSH_HOME: dshHome,
    DSH_NODE: process.execPath,
    DSH_DESKTOP_OPERATED_PLATFORM_CONFIG: operatedPlatform,
    DSH_DESKTOP_SMOKE_FILE: smokeFile,
    DSH_PHONE_MOBILECLI: mobilecli,
    DSH_PHONE_SERVER_PORT: String(fakePort),
    DSH_ELECTRON_E2E_ARTIFACT_DIR: artifactDir,
    DSH_ELECTRON_E2E_CDP_PORT: String(cdpPort),
    DSH_ELECTRON_E2E_FAKE_PORT: String(fakePort),
    DSH_ELECTRON_E2E_USER_DATA: userData,
    DSH_ELECTRON_E2E_WORKSPACE: workspace,
    DEEPSEEK_API_KEY: 'keyless-desktop-electron-e2e',
    DEEPSEEK_BASE_URL: provider.origin,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  let code = 1
  try {
    code = await runLogged(process.execPath, [wdioBin, 'run', wdioConfig, '--spec', join(e2eDir, spec)], {
      cwd: desktopRoot,
      env,
      logFile: join(artifactDir, 'runner.log'),
    })
    return code
  } finally {
    await verifyOwnedProcessesStopped(artifactDir)
    await rm(runtimeRoot, { recursive: true, force: true })
    await assertMissing(runtimeRoot)
    await assertPortClosed(fakePort)
    await assertPortClosed(cdpPort)
    await writeFile(join(artifactDir, 'cleanup.json'), JSON.stringify({
      runtimeRootRemoved: true,
      fakePortClosed: true,
      cdpPortClosed: true,
    }, undefined, 2) + '\n')
  }
}

async function verifyOwnedProcessesStopped(artifactDir) {
  const file = join(artifactDir, 'owned-processes.json')
  let owned
  try {
    owned = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return
  }
  for (const pid of [owned.electronPid, owned.hostPid, owned.fakePid]) {
    if (!Number.isSafeInteger(pid)) continue
    const deadline = Date.now() + 10_000
    while (processExists(pid) && Date.now() < deadline) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    if (processExists(pid)) throw new Error(`owned process ${String(pid)} survived the WDIO run`)
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function assertMissing(path) {
  try {
    await access(path)
    throw new Error(`temporary path survived cleanup: ${path}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('temporary path survived')) throw error
  }
}

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`temporary port ${String(port)} still accepts connections`))
    })
    socket.once('error', () => { resolve() })
    socket.setTimeout(1_000, () => {
      socket.destroy()
      resolve()
    })
  })
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if ((await stat(path)).isFile()) files.push(path)
  }
  return files
}

async function auditLogs() {
  const files = (await listFiles(artifactRoot)).filter(file => /\.(?:log|txt)$/i.test(file))
  const findings = []
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      const smokeError = file.endsWith('main-smoke.log') && /^error /i.test(line)
      const processError = /\[Electron:(?:MainProcess|Renderer)\]/.test(line)
        && /\b(?:uncaught|unhandled|error|ERR_[A-Z_]+)\b/i.test(line)
      if (smokeError || processError) {
        findings.push({ file: file.slice(artifactRoot.length + 1), line: index + 1, text: line.slice(0, 500) })
      }
    }
  }
  await writeFile(join(artifactRoot, 'log-audit.json'), JSON.stringify({ files, findings }, undefined, 2) + '\n')
  return findings
}

let provider
let fake
let exitCode = 1
try {
  await buildCurrentSource()
  provider = await startKeylessProvider()
  fake = await stageFake()
  const missing = join(tmpdir(), `dsh-no-such-mobilecli-${process.pid}`)
  const unresolvedCode = await runSpec('phone-unresolved', 'phone-tab-unresolved.e2e.ts', provider, missing)
  const liveCode = unresolvedCode === 0
    ? await runSpec('phone-live', 'phone-tab.e2e.ts', provider, fake.executable)
    : 1
  const findings = await auditLogs()
  const unexplained = findings
  await writeFile(join(artifactRoot, 'result.json'), JSON.stringify({
    head,
    unresolvedCode,
    liveCode,
    unexplainedLogFindings: unexplained,
  }, undefined, 2) + '\n')
  exitCode = unresolvedCode === 0 && liveCode === 0 && unexplained.length === 0 ? 0 : 1
} finally {
  await provider?.close()
  if (fake !== undefined) {
    await rm(fake.root, { recursive: true, force: true })
    await assertMissing(fake.root)
  }
  if (provider !== undefined) await assertPortClosed(provider.port)
  process.stdout.write(`Desktop Electron e2e artifacts: ${artifactRoot}\n`)
}
process.exit(exitCode)
