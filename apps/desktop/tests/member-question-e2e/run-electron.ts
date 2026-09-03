#!/usr/bin/env node
/** Build the current source and run the visible A1/B1/B2 Electron acceptance. */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  access, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises'
import { platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { startKeylessModelProvider } from './electron-keyless-model.ts'
import {
  assertProcessesExited,
  cleanEnvironment,
  createCertificate,
  localIpv4,
  reservePort,
  runLogged,
  startHttpsProxy,
} from './electron-runner-infrastructure.ts'
import { startKeylessMemberQuestionBroker } from './keyless-broker.ts'
import { startLocalKeylessPlatform } from './local-platform.ts'
import { encodeProtocolBase64Url } from '@deepseek-ai/dsh-remote-protocol'

const execute = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..', '..')
const repoRoot = resolve(desktopRoot, '..', '..')
const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
const shortHead = head.slice(0, 12)
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const artifactRoot = process.env.DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACTS
  ?? join(repoRoot, '.artifacts', 'project-members-electron', `${stamp}-${shortHead}`)
await mkdir(artifactRoot, { recursive: true })

if (process.platform === 'linux' && process.env.DISPLAY === undefined) {
  throw new Error('Project Members Electron acceptance requires a visible DISPLAY on Linux')
}

let runtimeRoot: string | undefined
const resourceDisposers: Array<() => Promise<void>> = []
let exitCode = 1
try {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'dsh-project-members-electron-'))
  runtimeRoot = runtimeDirectory
  const operatedConfig = join(runtimeDirectory, 'operated-platform.json')
  const hostPlugin = join(runtimeDirectory, 'member-question-e2e-host.mjs')
  const certificate = await createCertificate(runtimeDirectory, localIpv4())
  const proxyPort = await reservePort()
  const publicOrigin = `https://${certificate.host}:${String(proxyPort)}`
  const platformService = await startLocalKeylessPlatform([
    { providerSubject: 101, login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
    { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
    { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
    { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
  ], { heartbeatMs: 1_000, ttlMs: 5_000 }, {
    publicOrigin,
    automaticAuthorization: true,
  })
  resourceDisposers.push(() => platformService.close())
  const platformProxy = await startHttpsProxy(
    certificate.host,
    proxyPort,
    certificate.key,
    certificate.cert,
    platformService.origin,
  )
  resourceDisposers.push(() => platformProxy.close())
  const broker = await startKeylessMemberQuestionBroker({ presenceTtlMs: 10_000 })
  resourceDisposers.push(() => broker.close())
  const model = await startKeylessModelProvider()
  resourceDisposers.push(() => model.close())
  const endpointKey = encodeProtocolBase64Url(randomBytes(32))
  const installations = await Promise.all((['a1', 'b1', 'b2'] as const).map(async (name) => {
    const root = join(runtimeDirectory, name)
    const dshHome = join(root, 'dsh-home')
    const userData = join(root, 'user-data')
    const workspace = join(root, 'workspace')
    const smokeFile = join(artifactRoot, name, 'desktop.log')
    const profile = join(root, 'profile.json')
    await Promise.all([
      mkdir(dshHome, { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(join(artifactRoot, name), { recursive: true }),
    ])
    await writeFile(smokeFile, '')
    await initializeWorkspace(workspace, name)
    await writeHarnessHome(dshHome, name, hostPlugin)
    const accountId = name === 'a1' ? 'account-a' : 'account-b'
    await writeFile(profile, JSON.stringify({
      DSH_HOME: dshHome,
      DSH_DESKTOP_SMOKE_FILE: smokeFile,
      DSH_MEMBER_QUESTION_KEYLESS_ORIGIN: broker.origin,
      DSH_MEMBER_QUESTION_ACCOUNT_ID: accountId,
      DSH_MEMBER_QUESTION_INSTALLATION_ID: `installation-${name}`,
      DSH_MEMBER_QUESTION_KEY: endpointKey,
      DSH_MEMBER_QUESTION_HEARTBEAT_MS: '500',
      DSH_MEMBER_QUESTION_POLL_MS: '25',
      DSH_MEMBER_QUESTION_SHUTDOWN_MS: '2000',
      DSH_MEMBER_QUESTION_TTL_MS: '30000',
      DSH_PROJECT_MEMBERS_PROJECT_ID: 'project-electron',
      DSH_PROJECT_MEMBERS_PROJECT_NAME: 'Atlas',
      DSH_PROJECT_MEMBERS_REMOTE_ACCOUNT_ID: 'account-b',
      DSH_PROJECT_MEMBERS_ASKER_NAME: 'Ada',
      DSH_PROJECT_MEMBERS_ASKER_ROLE: 'owner',
      DSH_PROJECT_MEMBERS_WORKSPACE: workspace,
    }, undefined, 2) + '\n', { mode: 0o600 })
    return { name, root, dshHome, userData, workspace, smokeFile, profile, accountId }
  }))

  await writeFile(operatedConfig, JSON.stringify({
    environment: 'production',
    origin: publicOrigin,
    callbackUrl: `${publicOrigin}/v1/account/oauth/github/callback`,
    githubClientId: 'project-members-electron',
    credentialReference: 'credentials://project-members-electron',
    databaseIdentity: 'project-members-electron',
    identityNamespace: 'project-members-electron',
    companionAttachmentHostTimeoutMs: 120_000,
    remoteRelay: {
      url: `wss://${certificate.host}:${String(proxyPort)}/v1/remote-access/relay`,
      attachTimeoutMs: 10_000,
      negotiationTimeoutMs: 10_000,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1_000,
      inboundMaxBytes: 1_048_576,
      inboundMaxMessages: 16,
    },
  }, undefined, 2) + '\n', { mode: 0o600 })

  const buildSkipped = process.env.DSH_PROJECT_MEMBERS_ELECTRON_SKIP_BUILD === '1'
  if (buildSkipped) await buildDesktopMain(operatedConfig)
  else await buildCurrentSource(operatedConfig)
  await buildMemberQuestionHost(hostPlugin)
  await writeFile(join(artifactRoot, 'build-source.json'), JSON.stringify({
    head,
    builtAt: new Date().toISOString(),
    buildSkipped,
  }, undefined, 2) + '\n')
  const env = {
    ...cleanEnvironment(process.env),
    DSH_DESKTOP_E2E: '1',
    DSH_DESKTOP_E2E_AUTO_AUTHORIZE: '1',
    DSH_DESKTOP_E2E_DIRECT_NETWORK: '1',
    DSH_NODE: process.execPath,
    TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
    DSH_DESKTOP_OPERATED_PLATFORM_CONFIG: operatedConfig,
    DSH_PLATFORM_ENVIRONMENT: 'production',
    DEEPSEEK_API_KEY: 'keyless-project-members-electron',
    DEEPSEEK_BASE_URL: model.origin,
    DSH_MEMBER_QUESTION_KEYLESS_ORIGIN: broker.origin,
    NODE_EXTRA_CA_CERTS: certificate.cert,
    NO_PROXY: `${certificate.host},127.0.0.1,localhost`,
    no_proxy: `${certificate.host},127.0.0.1,localhost`,
    DSH_PROJECT_MEMBERS_ELECTRON_ARTIFACT_DIR: artifactRoot,
    ...Object.fromEntries(installations.flatMap((item) => {
      const prefix = `DSH_PROJECT_MEMBERS_${item.name.toUpperCase()}`
      return [
        [`${prefix}_PROFILE`, item.profile],
        [`${prefix}_USER_DATA`, item.userData],
        [`${prefix}_DSH_HOME`, item.dshHome],
        [`${prefix}_WORKSPACE`, item.workspace],
        [`${prefix}_SMOKE_FILE`, item.smokeFile],
      ]
    })),
  }
  const wdioBin = join(desktopRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js')
  await access(wdioBin)
  exitCode = await runLogged(process.execPath, [wdioBin, 'run', join(here, 'wdio.conf.ts')], {
    cwd: desktopRoot,
    env,
    logFile: join(artifactRoot, 'runner.log'),
  })
  const processes = JSON.parse(await readFile(join(artifactRoot, 'processes.json'), 'utf8')) as Record<
    string,
    { electronPid: number; hostPid: number }
  >
  await assertProcessesExited(Object.values(processes).flatMap(value => [value.electronPid, value.hostPid]))
  const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>
  }
  const forbiddenPlaintext = [
    'Approve the guarded rollout?',
    'Review the Markdown, HTML, and plain-text materials',
    'A1 authoritative guarded rollout',
    'A1 authoritative guarded preview',
    'A1 authoritative plain-text acceptance material.',
    'approve',
  ]
  assertPlaintextAbsent('keyless broker audit', JSON.stringify(broker.audit), forbiddenPlaintext)
  assertPlaintextAbsent('Platform retained state', await platformService.retainedState(), forbiddenPlaintext)
  await writeFile(join(artifactRoot, 'result.json'), JSON.stringify({
    passed: exitCode === 0,
    head,
    os: `${platform()} ${release()}`,
    electron: packageJson.devDependencies.electron,
    webdriverio: packageJson.devDependencies.webdriverio,
    installations: installations.map(({ name, dshHome, userData, workspace, accountId }) => ({
      name, dshHome, userData, workspace, accountId, installationId: `installation-${name}`,
    })),
    tests: 3,
    skipped: 0,
    brokerAudit: broker.audit,
    plaintextRetention: { brokerAudit: 'absent', platformState: 'absent' },
  }, undefined, 2) + '\n')
} finally {
  const cleanup = await Promise.allSettled(resourceDisposers.toReversed().map(dispose => (
    Promise.resolve().then(dispose)
  )))
  if (runtimeRoot !== undefined) {
    cleanup.push(...await Promise.allSettled([rm(runtimeRoot, { recursive: true, force: true })]))
  }
  process.stdout.write(`Project Members Electron artifacts: ${artifactRoot}\n`)
  const failures: unknown[] = []
  for (const result of cleanup) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Project Members Electron cleanup failed')
}
process.exitCode = exitCode

function assertPlaintextAbsent(name: string, retained: string, forbidden: readonly string[]): void {
  const leaked = forbidden.find(marker => retained.includes(marker))
  if (leaked !== undefined) throw new Error(`${name} retained forbidden business plaintext ${JSON.stringify(leaked)}`)
}

async function writeHarnessHome(
  dshHome: string,
  name: 'a1' | 'b1' | 'b2',
  hostPlugin: string,
): Promise<void> {
  const pluginUrl = pathToFileURL(hostPlugin).href
  await writeFile(join(dshHome, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: member-question-keyless-host',
    `      name: '${pluginUrl}'`,
    '- id: api-gateway',
    '  config:',
    `    memberQuestionInstallationId: 'installation-${name}'`,
    `    memberQuestionDeviceName: '${name.toUpperCase()} Electron'`,
    '',
  ].join('\n'), { mode: 0o600 })
  await mkdir(join(dshHome, '.agent-presets', 'project-members-e2e'), { recursive: true, mode: 0o700 })
  await writeFile(join(dshHome, '.agent-presets', 'project-members-e2e', 'agent.cordis.yml'), [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    "    text: 'You are the Project Members Electron acceptance agent.'",
    '- id: tool-ask-user',
    "  name: '@deepseek-ai/dsh-tool-ask-user'",
    '  config:',
    '    boundProjectResolver: !!js "async () => process.env.DSH_PROJECT_MEMBERS_PROJECT_ID"',
    '    routeResolver: !!js "async () => ({ projectId: process.env.DSH_PROJECT_MEMBERS_PROJECT_ID, toProjectMember: process.env.DSH_PROJECT_MEMBERS_REMOTE_ACCOUNT_ID, origin: { projectName: process.env.DSH_PROJECT_MEMBERS_PROJECT_NAME, originSessionTitle: \'Electron A1 acceptance\', askerAccountId: process.env.DSH_MEMBER_QUESTION_ACCOUNT_ID, askerRole: process.env.DSH_PROJECT_MEMBERS_ASKER_ROLE, askerDisplayName: process.env.DSH_PROJECT_MEMBERS_ASKER_NAME, askerAvatarUrl: \'https://avatars.example/ada.png\' } })"',
    '',
  ].join('\n'), { mode: 0o600 })
  await writeFile(join(dshHome, 'settings.yaml'), [
    'agent-presets:',
    '  default: project-members-e2e',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-flash',
    'ui-onboarding:',
    '  welcomeNoticeVersion: "2026-08-13.1"',
    '',
  ].join('\n'), { mode: 0o600 })
}

async function buildMemberQuestionHost(outfile: string): Promise<void> {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(here, 'host-plugin.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'info',
  })
}

async function initializeWorkspace(workspace: string, name: 'a1' | 'b1' | 'b2'): Promise<void> {
  await execute('git', ['init'], { cwd: workspace })
  await execute('git', ['remote', 'add', 'origin', 'https://github.com/gestaltrun/atlas'], { cwd: workspace })
  const marker = name === 'a1' ? 'A1 authoritative' : `${name.toUpperCase()} local decoy`
  await writeFile(join(workspace, 'decision.md'), [
    `# ${marker} guarded rollout`,
    name === 'a1' ? 'Use the reversible path.' : 'This local copy must not replace transferred Markdown.',
    'markdown-chunk '.repeat(3_000),
    '',
  ].join('\n'))
  await writeFile(join(workspace, 'preview.html'), [
    `<p>${marker} guarded preview</p>`,
    `<p>${'html-chunk '.repeat(3_000)}</p>`,
    '',
  ].join('\n'))
  await writeFile(join(workspace, 'notes.txt'), [
    name === 'a1' ? 'A1 authoritative plain-text acceptance material.' : `${name.toUpperCase()} local plain-text decoy.`,
    'plain-chunk '.repeat(3_000),
    '',
  ].join('\n'))
}

async function buildCurrentSource(configPath: string): Promise<void> {
  const commands: Array<[string, string[], string]> = [
    ['pnpm', ['run', 'build:lib:host'], repoRoot],
    ['pnpm', ['run', 'build:lib:client'], repoRoot],
    ['pnpm', ['run', 'build:web'], repoRoot],
    [process.execPath, [join(desktopRoot, 'scripts', 'build-main.mjs'), configPath], desktopRoot],
  ]
  for (const [index, [command, args, cwd]] of commands.entries()) {
    const code = await runLogged(command, args, {
      cwd,
      env: cleanEnvironment(process.env),
      logFile: join(artifactRoot, `build-${String(index)}.log`),
    })
    if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(code)}`)
  }
}

async function buildDesktopMain(configPath: string): Promise<void> {
  const code = await runLogged(process.execPath, [join(desktopRoot, 'scripts', 'build-main.mjs'), configPath], {
    cwd: desktopRoot,
    env: cleanEnvironment(process.env),
    logFile: join(artifactRoot, 'build-main.log'),
  })
  if (code !== 0) throw new Error(`Desktop main build exited ${String(code)}`)
}
