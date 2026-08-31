#!/usr/bin/env node
/** Build and run the isolated Desktop Host phone-tab Electron e2e lane. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access, appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import {
  PortHandoffCollision, quiesceRecordedProcesses, runLogged, runWithVerifiedPortHandoff, settleCleanupSteps,
} from './e2e-electron-runner-support.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const repoRoot = join(desktopRoot, '..', '..')
const e2eDir = join(desktopRoot, 'tests', 'e2e-electron')
const operatedPlatform = join(desktopRoot, 'tests', 'fixtures', 'operated-platform.json')
const fakeSource = join(repoRoot, 'packages', 'phone', 'phone-runtime', 'tests', 'fixtures', 'fakemobilecli.mjs')
const framesSource = join(repoRoot, 'packages', 'phone', 'phone-runtime', 'tests', 'fixtures', 'u3-visible-frames.ts')
const devicesSource = join(desktopRoot, 'tests', 'fixtures', 'phone-e2e-devices.json')
const managedEnvironmentFixture = join(e2eDir, 'managed-phone-environment.mjs')
const wdioConfig = join(e2eDir, 'wdio.conf.ts')
const wdioBin = join(desktopRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js')

if (process.platform === 'win32') {
  throw new Error('Desktop phone Electron e2e uses POSIX fakemobilecli launchers; Windows asset selection is covered separately')
}
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
      'DSH_ELECTRON_E2E_FAKE_OWNER', 'DSH_ELECTRON_E2E_WORKSPACE',
      'DSH_PHONE_MANAGED_FIXTURE_BYTES', 'DSH_PHONE_MANAGED_FIXTURE_SHA256',
      'DSH_PHONE_MANAGED_FIXTURE_URL',
      'DSH_ANDROID_E2E_PID_FILE', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME',
    ].includes(name)
  }))
}

const cleanEnvironment = scrubEnvironment(process.env)
const lifetime = new AbortController()
const interrupt = signal => { lifetime.abort(new Error(`Desktop Electron e2e interrupted by ${signal}`)) }
const onSigint = () => { interrupt('SIGINT') }
const onSigterm = () => { interrupt('SIGTERM') }
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

function asError(value) {
  return value instanceof Error ? value : new Error(String(value))
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
      signal: lifetime.signal,
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
  try {
    const fixtures = join(root, 'fixtures')
    await mkdir(fixtures, { recursive: true })
    const executable = join(fixtures, 'fakemobilecli')
    const ownerToken = randomUUID()
    await copyFile(fakeSource, executable)
    await chmod(executable, 0o755)
    await copyFile(framesSource, join(fixtures, 'u3-visible-frames.ts'))
    const devices = JSON.parse(await readFile(devicesSource, 'utf8'))
    await writeFile(join(fixtures, 'fakemobilecli.config.json'), JSON.stringify({
      devices,
      listEnvelope: true,
      captureEnvelope: true,
      streamFrameCount: 8,
      ownerToken,
    }))
    return { root, executable, ownerToken }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function startManagedArchiveFixture(fakeExecutable) {
  const wrapper = new TextEncoder().encode([
    '#!/usr/bin/env node',
    `await import(${JSON.stringify(pathToFileURL(fakeExecutable).href)})`,
    '',
  ].join('\n'))
  const executableName = process.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli'
  const archive = zipSync({ [executableName]: wrapper })
  let requests = 0
  const server = createServer((request, response) => {
    if (request.url !== '/mobilecli.zip') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(archive.byteLength),
    })
    const cut = Math.max(1, Math.floor(archive.byteLength / 2))
    response.write(archive.subarray(0, cut))
    setTimeout(() => { response.end(archive.subarray(cut)) }, 250)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('managed archive fixture exposed no TCP address')
  return {
    url: `http://127.0.0.1:${String(address.port)}/mobilecli.zip`,
    bytes: archive.byteLength,
    sha256: createHash('sha256').update(archive).digest('hex'),
    requests: () => requests,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

async function runSpec(name, spec, provider, mobilecli, fakeOwnerToken, managedFixture) {
  const artifactDir = join(artifactRoot, name)
  try {
    return await runWithVerifiedPortHandoff(name, async ({ fakePort, cdpPort }, attempt) => {
      await rm(artifactDir, { recursive: true, force: true })
      return await runSpecAttempt({
        name, spec, provider, mobilecli, fakeOwnerToken, managedFixture,
        androidFixture: name === 'phone-android', artifactDir, fakePort, cdpPort, attempt,
      })
    })
  } catch (error) {
    return { code: 1, errors: [asError(error).message], cleanup: [], portCollision: error instanceof PortHandoffCollision }
  }
}

async function runSpecAttempt({
  name, spec, provider, mobilecli, fakeOwnerToken, managedFixture, androidFixture,
  artifactDir, fakePort, cdpPort, attempt,
}) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), `dsh-desktop-e2e-${name}-`))
  const dshHome = join(runtimeRoot, 'dsh-home')
  const userData = join(runtimeRoot, 'electron-user-data')
  const workspace = join(runtimeRoot, 'workspace')
  const managedHome = join(runtimeRoot, 'managed-home')
  const managedBin = join(runtimeRoot, 'managed-bin')
  const smokeFile = join(artifactDir, 'main-smoke.log')
  let code = 1
  const errors = []
  try {
    await mkdir(artifactDir, { recursive: true })
    await mkdir(dshHome, { recursive: true, mode: 0o700 })
    await mkdir(userData, { recursive: true, mode: 0o700 })
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const android = androidFixture ? await stageAndroidSdkFixture(runtimeRoot, dshHome) : undefined
    if (managedFixture !== undefined) {
      await mkdir(managedHome, { recursive: true, mode: 0o700 })
      await mkdir(managedBin, { recursive: true, mode: 0o700 })
      const node = join(managedBin, process.platform === 'win32' ? 'node.exe' : 'node')
      if (process.platform === 'win32') await copyFile(process.execPath, node)
      else await symlink(process.execPath, node)
    }
    await writeFile(smokeFile, '')
    await writeFile(join(dshHome, 'settings.yaml'), [
      'ui-phone:',
      '  enabled: true',
      'ui-onboarding:',
      '  welcomeNoticeVersion: "2026-08-13.1"',
      '',
    ].join('\n'), { mode: 0o600 })
    if (managedFixture !== undefined) {
      await writeFile(join(dshHome, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: phone-environment-managed-fixture',
        `      name: ${JSON.stringify(managedEnvironmentFixture)}`,
        '',
      ].join('\n'), { mode: 0o600 })
    }
    const env = {
      ...cleanEnvironment,
      ...(managedFixture === undefined ? {} : {
        // The managed lane admits one test-owned Node entry and no user tool roots.
        PATH: managedBin,
        HOME: managedHome,
        USERPROFILE: managedHome,
      }),
      CI: 'true',
      LANG: 'zh_CN.UTF-8',
      LANGUAGE: 'zh_CN',
      DSH_HOME: dshHome,
      DSH_NODE: process.execPath,
      DSH_DESKTOP_OPERATED_PLATFORM_CONFIG: operatedPlatform,
      DSH_DESKTOP_SMOKE_FILE: smokeFile,
      ...(mobilecli === undefined ? {} : { DSH_PHONE_MOBILECLI: mobilecli }),
      DSH_PHONE_SERVER_PORT: String(fakePort),
      DSH_ELECTRON_E2E_ARTIFACT_DIR: artifactDir,
      DSH_ELECTRON_E2E_CDP_PORT: String(cdpPort),
      DSH_ELECTRON_E2E_FAKE_PORT: String(fakePort),
      DSH_ELECTRON_E2E_FAKE_OWNER: fakeOwnerToken ?? '',
      DSH_ELECTRON_E2E_USER_DATA: userData,
      DSH_ELECTRON_E2E_WORKSPACE: workspace,
      ...(android === undefined ? {} : {
        ANDROID_HOME: android.sdkRoot,
        ANDROID_SDK_ROOT: android.sdkRoot,
        DSH_ANDROID_E2E_PID_FILE: android.pidFile,
      }),
      ...(managedFixture === undefined ? {} : {
        DSH_PHONE_MANAGED_FIXTURE_URL: managedFixture.url,
        DSH_PHONE_MANAGED_FIXTURE_BYTES: String(managedFixture.bytes),
        DSH_PHONE_MANAGED_FIXTURE_SHA256: managedFixture.sha256,
      }),
      DEEPSEEK_API_KEY: 'keyless-desktop-electron-e2e',
      DEEPSEEK_BASE_URL: provider.origin,
      ELECTRON_ENABLE_LOGGING: '1',
    }
    if (managedFixture !== undefined) {
      delete env.npm_config_prefix
      delete env.NPM_CONFIG_PREFIX
    }
    code = await runLogged(process.execPath, [wdioBin, 'run', wdioConfig, '--spec', join(e2eDir, spec)], {
      cwd: desktopRoot,
      env,
      logFile: join(artifactDir, 'runner.log'),
      signal: lifetime.signal,
    })
  } catch (error) {
    errors.push(asError(error))
  }
  let ownership
  const requiredPids = fakeOwnerToken === undefined
    ? ['electronPid', 'hostPid']
    : ['electronPid', 'hostPid', 'fakePid', ...(androidFixture ? ['androidEmulatorPid'] : [])]
  const settled = await settleCleanupSteps([
    {
      name: 'owned process trees',
      run: async () => {
        ownership = await quiesceRecordedProcesses(join(artifactDir, 'owned-processes.json'), requiredPids)
        if (ownership.forced.length > 0) {
          throw new Error(`owned processes survived WDIO teardown and required termination: ${ownership.forced.join(', ')}`)
        }
      },
    },
    { name: 'runtime root removal', run: async () => { await rm(runtimeRoot, { recursive: true, force: true }) } },
    { name: 'runtime root absence', run: async () => { await assertMissing(runtimeRoot) } },
    { name: 'fake port closure', run: async () => { await assertPortClosed(fakePort) } },
    { name: 'CDP port closure', run: async () => { await assertPortClosed(cdpPort) } },
  ])
  errors.push(...settled.errors)
  try {
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'cleanup.json'), JSON.stringify({
      attempt,
      ports: { fakePort, cdpPort },
      processOwnership: ownership,
      steps: settled.outcomes,
    }, undefined, 2) + '\n')
  } catch (error) {
    errors.push(asError(error))
  }
  const runnerLog = await readFile(join(artifactDir, 'runner.log'), 'utf8').catch(() => '')
  return {
    value: {
      code: code === 0 && errors.length === 0 ? 0 : 1,
      errors: errors.map(error => error.message),
      cleanup: settled.outcomes,
      portCollision: false,
    },
    runnerLog,
  }
}

async function stageAndroidSdkFixture(runtimeRoot, dshHome) {
  const sdkRoot = join(runtimeRoot, 'android-sdk')
  const avdHome = join(dshHome, 'phone', 'android', 'avd')
  const bin = join(sdkRoot, 'cmdline-tools', 'latest', 'bin')
  const platformTools = join(sdkRoot, 'platform-tools')
  const emulatorDir = join(sdkRoot, 'emulator')
  const image = join(sdkRoot, 'system-images', 'android-35', 'google_apis', 'arm64-v8a')
  const avd = join(avdHome, 'Pixel_6_API_35_Gestalt.avd')
  const pidFile = join(runtimeRoot, 'android-emulator.pid')
  await Promise.all([
    mkdir(bin, { recursive: true, mode: 0o700 }),
    mkdir(platformTools, { recursive: true, mode: 0o700 }),
    mkdir(emulatorDir, { recursive: true, mode: 0o700 }),
    mkdir(image, { recursive: true, mode: 0o700 }),
    mkdir(avd, { recursive: true, mode: 0o700 }),
  ])
  await writeFile(join(bin, 'sdkmanager'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(join(bin, 'avdmanager'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(join(platformTools, 'adb'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "devices") printf "List of devices attached\\nemulator-5554\\tdevice\\n" ;;',
    '  *"emu avd name"*) printf "Pixel_6_API_35_Gestalt\\nOK\\n" ;;',
    '  *"getprop sys.boot_completed"*) printf "1\\n" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 })
  await writeFile(join(emulatorDir, 'emulator'), [
    '#!/bin/sh',
    'if [ "$1" = "-accel-check" ]; then',
    '  printf "accel:\\n0\\nfixture hypervisor\\n"',
    '  exit 0',
    'fi',
    'printf "%s\\n" "$$" > "$DSH_ANDROID_E2E_PID_FILE"',
    'trap "exit 0" TERM INT',
    'while :; do /bin/sleep 1; done',
    '',
  ].join('\n'), { mode: 0o700 })
  await writeFile(join(image, 'package.xml'), '<localPackage path="system-images;android-35;google_apis;arm64-v8a" />\n')
  await writeFile(join(avd, 'config.ini'), 'image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n')
  return { sdkRoot, pidFile }
}

async function assertMissing(path) {
  try {
    await access(path)
    throw new Error(`temporary path survived cleanup: ${path}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('temporary path survived')) throw error
    if (error?.code !== 'ENOENT') throw error
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
let managedFixture
let exitCode = 1
const fatalErrors = []
try {
  await buildCurrentSource()
  lifetime.signal.throwIfAborted()
  provider = await startKeylessProvider()
  fake = await stageFake()
  managedFixture = await startManagedArchiveFixture(fake.executable)
  const missing = join(tmpdir(), `dsh-no-such-mobilecli-${process.pid}`)
  const unresolved = await runSpec('phone-unresolved', 'phone-tab-unresolved.e2e.ts', provider, missing)
  const managed = unresolved.code === 0
    ? await runSpec('phone-managed', 'phone-managed-environment.e2e.ts', provider, undefined, fake.ownerToken, managedFixture)
    : { code: 1, errors: ['phone-managed skipped because phone-unresolved failed'], cleanup: [], portCollision: false }
  const android = managed.code === 0
    ? await runSpec('phone-android', 'phone-android-environment.e2e.ts', provider, undefined, fake.ownerToken, managedFixture)
    : { code: 1, errors: ['phone-android skipped because phone-managed failed'], cleanup: [], portCollision: false }
  const live = android.code === 0
    ? await runSpec('phone-live', 'phone-tab.e2e.ts', provider, fake.executable, fake.ownerToken)
    : { code: 1, errors: ['phone-live skipped because phone-android failed'], cleanup: [], portCollision: false }
  const findings = await auditLogs()
  await writeFile(join(artifactRoot, 'result.json'), JSON.stringify({
    head,
    unresolved,
    managed: { ...managed, fixtureRequests: managedFixture.requests() },
    android,
    live,
    unexplainedLogFindings: findings,
  }, undefined, 2) + '\n')
  exitCode = unresolved.code === 0 && managed.code === 0 && android.code === 0 && live.code === 0
    && managedFixture.requests() === 2 && findings.length === 0 ? 0 : 1
} catch (error) {
  fatalErrors.push(asError(error))
} finally {
  const shutdown = await settleCleanupSteps([
    { name: 'keyless provider close', run: async () => { await provider?.close() } },
    { name: 'managed archive fixture close', run: async () => { await managedFixture?.close() } },
    {
      name: 'staged fake removal',
      run: async () => {
        if (fake === undefined) return
        await rm(fake.root, { recursive: true, force: true })
        await assertMissing(fake.root)
      },
    },
    {
      name: 'keyless provider port closure',
      run: async () => { if (provider !== undefined) await assertPortClosed(provider.port) },
    },
    {
      name: 'managed archive fixture port closure',
      run: async () => { if (managedFixture !== undefined) await assertPortClosed(managedFixture.port) },
    },
  ])
  fatalErrors.push(...shutdown.errors)
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  process.stdout.write(`Desktop Electron e2e artifacts: ${artifactRoot}\n`)
}
if (fatalErrors.length > 0) {
  process.stderr.write(`${new AggregateError(fatalErrors, 'Desktop Electron e2e runner failed').stack ?? ''}\n`)
  exitCode = 1
}
process.exitCode = exitCode
