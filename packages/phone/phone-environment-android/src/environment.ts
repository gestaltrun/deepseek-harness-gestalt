import { createHash } from 'node:crypto'
import {
  access, chmod, mkdir, mkdtemp, readFile, rename, rm, statfs, writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { unzipSync } from 'fflate'
import type {
  AndroidEnvironmentProvider, AndroidPreparationPlan, AndroidPrepareRequest, PhoneAndroidState,
} from '@deepseek-ai/dsh-phone-environment'
import { planAndroidEnvironment } from './planner.ts'
import type { AndroidCommandLineToolsAsset, AndroidInstallationProbe } from './types.ts'
import {
  nodeAndroidCommandRunner, type AndroidCommandRunner, type AndroidOwnedProcess,
} from './process.ts'

const COMMAND_TIMEOUT_MS = 15 * 60_000
const BOOT_TIMEOUT_MS = 180_000
const POLL_MS = 1_000

/** Stable Android preparation failure consumed by the Host snapshot. */
export class AndroidEnvironmentError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AndroidEnvironmentError'
  }
}

/** Injectable nondeterministic edges; production uses the current Host. */
export interface AndroidEnvironmentOptions {
  readonly phoneRoot: string
  readonly platform?: string
  readonly architecture?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly fetch?: typeof fetch
  readonly runner?: AndroidCommandRunner
  readonly freeBytes?: (path: string) => Promise<number>
  /** Test-only pinned asset replacement; production never supplies it. */
  readonly commandLineToolsAsset?: AndroidCommandLineToolsAsset
}

/** Deep Android environment module behind the stable platform Provider interface. */
export class AndroidEnvironmentManager implements AndroidEnvironmentProvider {
  private readonly platform: string
  private readonly architecture: string
  private readonly ambient: NodeJS.ProcessEnv
  private readonly homeDirectory: string
  private readonly fetcher: typeof fetch
  private readonly runner: AndroidCommandRunner
  private readonly freeBytes: (path: string) => Promise<number>
  private current: PhoneAndroidState = Object.freeze({ kind: 'checking' })
  private readonly listeners = new Set<(state: PhoneAndroidState) => void>()
  private operation: AbortController | undefined
  private emulator: AndroidOwnedProcess | undefined
  private plan: AndroidPreparationPlan | undefined
  private asset: AndroidCommandLineToolsAsset | undefined

  constructor(private readonly options: AndroidEnvironmentOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.ambient = options.environment ?? process.env
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.fetcher = options.fetch ?? fetch
    this.runner = options.runner ?? nodeAndroidCommandRunner
    this.freeBytes = options.freeBytes ?? availableBytes
  }

  snapshot(): PhoneAndroidState {
    return this.current
  }

  onChanged(listener: (state: PhoneAndroidState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(signal?: AbortSignal): Promise<PhoneAndroidState> {
    this.publish({ kind: 'checking' })
    const root = await this.discoverExistingSdkRoot()
    const probe = root === undefined ? undefined : await this.probe(root, 'existing')
    const planned = planAndroidEnvironment(
      this.platform,
      this.architecture,
      this.options.phoneRoot,
      probe,
    )
    signal?.throwIfAborted()
    if (planned.kind === 'unsupported') {
      this.plan = undefined
      this.asset = undefined
      this.publish({ kind: 'unsupported', reason: planned.reason })
      return this.current
    }
    this.plan = planned.plan
    this.asset = this.options.commandLineToolsAsset ?? planned.asset
    const complete = Object.values(planned.plan.components).every(Boolean)
    this.publish(complete
      ? { kind: 'ready', plan: planned.plan, running: false }
      : { kind: 'missing', plan: planned.plan })
    return this.current
  }

  async prepare(request: AndroidPrepareRequest, signal?: AbortSignal): Promise<PhoneAndroidState> {
    if ((request as { readonly licenseAccepted?: boolean }).licenseAccepted !== true) {
      throw new AndroidEnvironmentError('PHONE_ANDROID_LICENSE_REQUIRED', 'Android SDK license acceptance is required')
    }
    if (this.operation !== undefined) throw new AndroidEnvironmentError('PHONE_ANDROID_BUSY', 'Android preparation is already running')
    if (this.plan === undefined || this.asset === undefined) await this.refresh(signal)
    const plan = this.requirePlan()
    const asset = this.asset as AndroidCommandLineToolsAsset
    const free = await this.freeBytes(plan.sdkRoot)
    if (free < plan.minimumFreeBytes) {
      this.publish({
        kind: 'manual-required', plan, code: 'disk-space',
        message: `Android preparation requires 16 GB free; this volume has ${formatGiB(free)} GB.`,
      })
      return this.current
    }
    const controller = new AbortController()
    this.operation = controller
    const operationSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      await mkdir(dirname(plan.sdkRoot), { recursive: true, mode: 0o700 })
      if (!plan.components.commandLineTools) await this.installCommandLineTools(plan, asset, operationSignal)
      const env = this.environmentFor(plan)
      this.publish({ kind: 'installing', plan, step: 'licenses' })
      await this.requireSuccess(
        this.sdkmanager(plan), ['--sdk_root=' + plan.sdkRoot, '--licenses'], env, operationSignal, 'y\n'.repeat(64),
        'PHONE_ANDROID_LICENSES',
      )
      this.publish({ kind: 'installing', plan, step: 'packages' })
      await this.requireSuccess(
        this.sdkmanager(plan), ['--sdk_root=' + plan.sdkRoot, '--install', ...plan.packageIds], env,
        operationSignal, undefined, 'PHONE_ANDROID_PACKAGES',
      )
      if (!plan.components.avd) {
        if (await exists(this.avdConfig(plan))) {
          throw new AndroidEnvironmentError(
            'PHONE_ANDROID_AVD_CONFLICT',
            `the private ${plan.avdName} AVD does not use the pinned API 35 ${plan.abi} image`,
          )
        }
        this.publish({ kind: 'creating-avd', plan })
        await mkdir(plan.avdHome, { recursive: true, mode: 0o700 })
        await this.requireSuccess(
          this.avdmanager(plan), [
            '--silent', 'create', 'avd', '--name', plan.avdName,
            '--package', plan.packageIds[2] as string, '--device', 'pixel_6',
          ], env, operationSignal, 'no\n', 'PHONE_ANDROID_AVD',
        )
      }
      const installedProbe = await this.probe(plan.sdkRoot, plan.sdkSource)
      const installed = planAndroidEnvironment(
        this.platform, this.architecture, this.options.phoneRoot, installedProbe,
      )
      if (installed.kind !== 'supported') throw new AndroidEnvironmentError('PHONE_ANDROID_UNSUPPORTED', installed.reason)
      this.plan = installed.plan
      return await this.startEmulator(operationSignal)
    } catch (error) {
      if (operationSignal.aborted) {
        await this.stopOwnedEmulator()
        this.publish({ kind: 'missing', plan })
        throw new AndroidEnvironmentError('PHONE_ANDROID_ABORTED', 'Android preparation was cancelled', { cause: error })
      }
      const failure = androidFailure(error)
      this.publish({ kind: 'failed', plan, code: failure.code, message: failure.message, retryable: true })
      throw failure
    } finally {
      if (this.operation === controller) this.operation = undefined
    }
  }

  async start(signal?: AbortSignal): Promise<PhoneAndroidState> {
    if (this.operation !== undefined) throw new AndroidEnvironmentError('PHONE_ANDROID_BUSY', 'an Android operation is already running')
    const controller = new AbortController()
    this.operation = controller
    const operationSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      return await this.startEmulator(operationSignal)
    } catch (error) {
      await this.stopOwnedEmulator()
      if (operationSignal.aborted) {
        const plan = this.requirePlan()
        this.publish({ kind: 'ready', plan, running: false })
        throw new AndroidEnvironmentError('PHONE_ANDROID_ABORTED', 'Android Emulator start was cancelled', { cause: error })
      }
      const failure = androidFailure(error)
      this.publish({
        kind: 'failed', ...(this.plan === undefined ? {} : { plan: this.plan }),
        code: failure.code, message: failure.message, retryable: true,
      })
      throw failure
    } finally {
      if (this.operation === controller) this.operation = undefined
    }
  }

  private async startEmulator(signal?: AbortSignal): Promise<PhoneAndroidState> {
    const plan = this.requirePlan()
    if (!Object.values(plan.components).every(Boolean) && !await exists(this.avdConfig(plan))) {
      throw new AndroidEnvironmentError('PHONE_ANDROID_NOT_PREPARED', 'the default Android emulator is not prepared')
    }
    await this.stopOwnedEmulator()
    const env = this.environmentFor(plan)
    this.publish({ kind: 'checking-acceleration', plan })
    const acceleration = await this.runner.run(this.emulatorPath(plan), ['-accel-check'], {
      env, ...(signal === undefined ? {} : { signal }), timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (acceleration.code !== 0) {
      this.publish(manualAcceleration(plan, this.platform, `${acceleration.stdout}\n${acceleration.stderr}`))
      return this.current
    }
    this.publish({ kind: 'booting', plan })
    const emulator = this.runner.spawn(this.emulatorPath(plan), [
      `@${plan.avdName}`, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save', '-gpu', 'auto',
    ], { env, ...(signal === undefined ? {} : { signal }) })
    this.emulator = emulator
    void emulator.exit.then((outcome) => {
      if (this.emulator !== emulator) return
      this.emulator = undefined
      if (this.current.kind === 'ready' && outcome.code !== null) {
        this.publish({
          kind: 'failed', plan, code: 'PHONE_ANDROID_EMULATOR_EXIT',
          message: `Android Emulator exited with code ${String(outcome.code)}`, retryable: true,
        })
      }
    }, () => {})
    const deviceId = await this.waitForBoot(plan, env, signal)
    this.publish({ kind: 'ready', plan, deviceId, running: true })
    return this.current
  }

  cancel(): void {
    const active = this.operation
    active?.abort(new AndroidEnvironmentError('PHONE_ANDROID_ABORTED', 'Android operation cancelled'))
    void this.stopOwnedEmulator().then(() => {
      if (active === undefined) this.publishStopped()
    })
  }

  async deactivate(): Promise<void> {
    this.operation?.abort(new AndroidEnvironmentError('PHONE_ANDROID_ABORTED', 'Android operation cancelled'))
    await this.stopOwnedEmulator()
    this.publishStopped()
  }

  runtimeEnvironment(): Readonly<Record<string, string>> {
    const plan = this.plan
    return plan === undefined ? Object.freeze({}) : Object.freeze(this.environmentFor(plan))
  }

  private async discoverExistingSdkRoot(): Promise<string | undefined> {
    const candidates = [
      this.ambient.ANDROID_HOME,
      this.ambient.ANDROID_SDK_ROOT,
      this.platform === 'darwin' ? join(this.homeDirectory, 'Library', 'Android', 'sdk') : undefined,
      this.platform === 'win32' ? join(this.ambient.LOCALAPPDATA ?? this.homeDirectory, 'Android', 'Sdk') : undefined,
      this.platform === 'linux' ? join(this.homeDirectory, 'Android', 'Sdk') : undefined,
      sdkRootFromPath(this.ambient.PATH, this.platform),
    ]
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      const root = resolve(candidate)
      if (await exists(this.sdkmanagerAt(root)) && await writable(root)) return root
    }
    return undefined
  }

  private async probe(sdkRoot: string, sdkSource: 'existing' | 'managed'): Promise<AndroidInstallationProbe> {
    const image = this.architecture === 'arm64' ? 'arm64-v8a' : 'x86_64'
    const avdHome = join(this.options.phoneRoot, 'android', 'avd')
    return {
      sdkRoot, sdkSource,
      commandLineTools: await exists(this.sdkmanagerAt(sdkRoot)),
      platformTools: await exists(join(sdkRoot, 'platform-tools', executable('adb', this.platform))),
      emulator: await exists(join(sdkRoot, 'emulator', executable('emulator', this.platform))),
      systemImage: await exists(join(sdkRoot, 'system-images', 'android-35', 'google_apis', image, 'package.xml')),
      avd: await avdMatches(
        join(avdHome, `${this.avdName()}.avd`, 'config.ini'),
        image,
      ),
    }
  }

  private async installCommandLineTools(
    plan: AndroidPreparationPlan,
    asset: AndroidCommandLineToolsAsset,
    signal: AbortSignal,
  ): Promise<void> {
    await mkdir(this.options.phoneRoot, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.options.phoneRoot, '.android-staging-'))
    await chmod(staging, 0o700)
    try {
      this.publish({ kind: 'downloading', plan, receivedBytes: 0, totalBytes: asset.bytes })
      const response = await this.fetcher(asset.url, { signal, redirect: 'error' })
      if (!response.ok || response.body === null) {
        throw new AndroidEnvironmentError('PHONE_ANDROID_DOWNLOAD', `command-line tools download failed with HTTP ${String(response.status)}`)
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) !== asset.bytes) {
        throw new AndroidEnvironmentError('PHONE_ANDROID_LENGTH', 'command-line tools Content-Length did not match the pinned asset')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      const digest = createHash('sha256')
      let receivedBytes = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        receivedBytes += chunk.value.byteLength
        if (receivedBytes > asset.bytes) throw new AndroidEnvironmentError('PHONE_ANDROID_LENGTH', 'command-line tools download exceeded its pinned length')
        chunks.push(chunk.value)
        digest.update(chunk.value)
        this.publish({ kind: 'downloading', plan, receivedBytes, totalBytes: asset.bytes })
      }
      if (receivedBytes !== asset.bytes) throw new AndroidEnvironmentError('PHONE_ANDROID_LENGTH', 'command-line tools download was truncated')
      if (digest.digest('hex') !== asset.sha256) throw new AndroidEnvironmentError('PHONE_ANDROID_DIGEST', 'command-line tools SHA-256 did not match the pinned asset')
      signal.throwIfAborted()
      const archive = new Uint8Array(receivedBytes)
      let offset = 0
      for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.byteLength }
      const entries = unzipSync(archive)
      const target = join(plan.sdkRoot, 'cmdline-tools', 'latest')
      const extracted = join(staging, 'cmdline-tools', 'latest')
      await mkdir(extracted, { recursive: true, mode: 0o700 })
      for (const [rawName, bytes] of Object.entries(entries)) {
        signal.throwIfAborted()
        if (!rawName.startsWith('cmdline-tools/')) {
          throw new AndroidEnvironmentError('PHONE_ANDROID_ARCHIVE', 'command-line tools archive contains an entry outside cmdline-tools')
        }
        if (rawName.endsWith('/')) continue
        const relativeName = normalize(rawName.slice('cmdline-tools/'.length))
        if (relativeName === '..' || relativeName.startsWith(`..${sep}`)) {
          throw new AndroidEnvironmentError('PHONE_ANDROID_ARCHIVE', 'command-line tools archive escapes its root')
        }
        const path = join(extracted, relativeName)
        if (!inside(extracted, path)) throw new AndroidEnvironmentError('PHONE_ANDROID_ARCHIVE', 'command-line tools archive escapes its root')
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { mode: rawName.includes('/bin/') ? 0o700 : 0o600 })
      }
      if (!await exists(join(extracted, 'bin', executable('sdkmanager', this.platform, true)))) {
        throw new AndroidEnvironmentError('PHONE_ANDROID_ARCHIVE', 'command-line tools archive omitted sdkmanager')
      }
      signal.throwIfAborted()
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await rm(target, { recursive: true, force: true })
      await rename(extracted, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async requireSuccess(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    signal: AbortSignal,
    input: string | undefined,
    code: string,
  ): Promise<void> {
    const result = await this.runner.run(command, args, {
      env, ...(input === undefined ? {} : { input }), signal, timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw new AndroidEnvironmentError(code, `${command} failed with code ${String(result.code)}: ${tail(result.stderr || result.stdout)}`)
    }
  }

  private async waitForBoot(
    plan: AndroidPreparationPlan,
    env: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const started = Date.now()
    while (Date.now() - started < BOOT_TIMEOUT_MS) {
      signal?.throwIfAborted()
      const commandOptions = { env, ...(signal === undefined ? {} : { signal }), timeoutMs: 10_000 }
      const devices = await this.runner.run(this.adbPath(plan), ['devices'], commandOptions)
      for (const id of emulatorIds(devices.stdout)) {
        const name = await this.runner.run(this.adbPath(plan), ['-s', id, 'emu', 'avd', 'name'], {
          ...commandOptions,
        })
        if (!name.stdout.includes(plan.avdName)) continue
        const boot = await this.runner.run(this.adbPath(plan), ['-s', id, 'shell', 'getprop', 'sys.boot_completed'], {
          ...commandOptions,
        })
        if (boot.stdout.trim() === '1') return id
      }
      await delay(POLL_MS, signal)
    }
    throw new AndroidEnvironmentError('PHONE_ANDROID_BOOT_TIMEOUT', 'the default Android emulator did not finish booting')
  }

  private environmentFor(plan: AndroidPreparationPlan): Readonly<Record<string, string>> {
    const tools = [
      join(plan.sdkRoot, 'platform-tools'),
      join(plan.sdkRoot, 'emulator'),
      join(plan.sdkRoot, 'cmdline-tools', 'latest', 'bin'),
    ]
    return {
      ANDROID_HOME: plan.sdkRoot,
      ANDROID_SDK_ROOT: plan.sdkRoot,
      ANDROID_AVD_HOME: plan.avdHome,
      PATH: [...tools, this.ambient.PATH ?? ''].filter(Boolean).join(delimiter),
    }
  }

  private sdkmanager(plan: AndroidPreparationPlan): string { return this.sdkmanagerAt(plan.sdkRoot) }
  private sdkmanagerAt(root: string): string { return join(root, 'cmdline-tools', 'latest', 'bin', executable('sdkmanager', this.platform, true)) }
  private avdmanager(plan: AndroidPreparationPlan): string { return join(plan.sdkRoot, 'cmdline-tools', 'latest', 'bin', executable('avdmanager', this.platform, true)) }
  private emulatorPath(plan: AndroidPreparationPlan): string { return join(plan.sdkRoot, 'emulator', executable('emulator', this.platform)) }
  private adbPath(plan: AndroidPreparationPlan): string { return join(plan.sdkRoot, 'platform-tools', executable('adb', this.platform)) }
  private avdConfig(plan: AndroidPreparationPlan): string { return join(plan.avdHome, `${plan.avdName}.avd`, 'config.ini') }
  private avdName(): string { return 'Pixel_6_API_35_Gestalt' }

  private requirePlan(): AndroidPreparationPlan {
    if (this.plan !== undefined) return this.plan
    throw new AndroidEnvironmentError('PHONE_ANDROID_UNSUPPORTED', 'Android preparation is unsupported on this Host')
  }

  private async stopOwnedEmulator(): Promise<void> {
    const owned = this.emulator
    this.emulator = undefined
    await owned?.stop()
  }

  private publishStopped(): void {
    const plan = this.plan
    if (plan === undefined) return
    if (this.current.kind !== 'ready'
      && this.current.kind !== 'booting'
      && this.current.kind !== 'checking-acceleration') return
    if (this.current.kind === 'ready' && !this.current.running) return
    this.publish(Object.values(plan.components).every(Boolean)
      ? { kind: 'ready', plan, running: false }
      : { kind: 'missing', plan })
  }

  private publish(state: PhoneAndroidState): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return
    this.current = Object.freeze(state)
    for (const listener of [...this.listeners]) {
      try { listener(this.current) } catch { /* A consumer callback cannot break platform lifecycle. */ }
    }
  }
}

function executable(name: string, platform: string, script = false): string {
  if (platform !== 'win32') return name
  return `${name}${script ? '.bat' : '.exe'}`
}

function sdkRootFromPath(pathValue: string | undefined, platform: string): string | undefined {
  if (pathValue === undefined) return undefined
  const basename = platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'
  for (const entry of pathValue.split(delimiter)) {
    const normalized = normalize(entry)
    if (normalized.endsWith(join('cmdline-tools', 'latest', 'bin'))) {
      return resolve(normalized, '..', '..', '..')
    }
    if (normalized.endsWith(join('tools', 'bin')) && basename.length > 0) return resolve(normalized, '..', '..')
  }
  return undefined
}

function emulatorIds(output: string): readonly string[] {
  return output.split('\n').map(line => line.trim().split(/\s+/u)).filter(parts => (
    parts[0]?.startsWith('emulator-') === true && parts[1] === 'device'
  )).map(parts => parts[0] as string)
}

function manualAcceleration(plan: AndroidPreparationPlan, platform: string, detail: string): PhoneAndroidState {
  if (platform === 'win32') return {
    kind: 'manual-required', plan, code: 'windows-hypervisor',
    message: 'Enable Windows Hypervisor Platform and CPU virtualization, then restart Windows.',
  }
  if (platform === 'linux') return {
    kind: 'manual-required', plan, code: 'linux-kvm',
    message: 'Install KVM and grant this user access to /dev/kvm, then sign in again.',
  }
  return {
    kind: 'manual-required', plan, code: 'virtualization',
    message: `Android Emulator acceleration is unavailable: ${tail(detail)}`,
  }
}

function androidFailure(error: unknown): AndroidEnvironmentError {
  if (error instanceof AndroidEnvironmentError) return error
  return new AndroidEnvironmentError(
    'PHONE_ANDROID_PREPARE', error instanceof Error ? error.message : String(error), { cause: error },
  )
}

async function availableBytes(path: string): Promise<number> {
  let current = resolve(path)
  for (;;) {
    try {
      const result = await statfs(current, { bigint: true })
      const bytes = result.bavail * result.bsize
      return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function writable(path: string): Promise<boolean> {
  try { await access(path, constants.W_OK); return true } catch { return false }
}

async function avdMatches(path: string, abi: string): Promise<boolean> {
  try {
    const config = (await readFile(path, 'utf8')).replaceAll('\\', '/')
    return config.includes('system-images/android-35/google_apis/') && config.includes(`/${abi}/`)
  } catch { return false }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, resolve(path))
  return child !== '..' && !child.startsWith(`..${sep}`)
}

function tail(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 1_000 ? trimmed.slice(-1_000) : trimmed
}

function formatGiB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    const finish = (): void => { signal?.removeEventListener('abort', abort); resolveDelay() }
    const timer = setTimeout(finish, ms)
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
