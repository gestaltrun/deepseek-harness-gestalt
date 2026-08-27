/** Build and execute the committed proof in a real Android Emulator WebView. */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CleanupStack, requireSpawnSuccess } from './runner-support.mjs'

const proofRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(proofRoot, '../..')
const androidRoot = join(proofRoot, 'runtimes/android/app/src/main')
const artifacts = join(repositoryRoot, '.artifacts/noise-security-path/android')
const sdkRoot = process.env.ANDROID_SDK_ROOT
  ?? process.env.ANDROID_HOME
  ?? '/opt/homebrew/share/android-commandlinetools'
const adb = join(sdkRoot, 'platform-tools/adb')
const emulator = join(sdkRoot, 'emulator/emulator')
const buildTools = join(sdkRoot, `build-tools/${process.env.DSH_NOISE_ANDROID_BUILD_TOOLS ?? '35.0.0'}`)
const androidJar = join(sdkRoot, `platforms/android-${process.env.DSH_NOISE_ANDROID_API ?? '34'}/android.jar`)
const bundleId = 'dev.deepseek.noiseproof'
const reportTimeoutMs = 30_000
const environment = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
}

const defaultCommands = { execFileSync, spawnSync }
const defaultClock = {
  now: Date.now,
  sleep: delay => new Promise(resolvePromise => setTimeout(resolvePromise, delay)),
}

/**
 * Build the disposable Android proof APK.
 * @returns {string} Absolute APK path.
 */
function buildAndroidApk() {
  rmSync(artifacts, { force: true, recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const classes = join(artifacts, 'classes')
  const dex = join(artifacts, 'dex')
  const staging = join(artifacts, 'staging')
  mkdirSync(classes, { recursive: true })
  mkdirSync(dex, { recursive: true })
  mkdirSync(join(staging, 'assets'), { recursive: true })

  execFileSync('javac', [
    '-source', '8',
    '-target', '8',
    '-Xlint:-options',
    '-classpath', androidJar,
    '-d', classes,
    join(androidRoot, 'java/dev/deepseek/noiseproof/MainActivity.java'),
  ], { stdio: 'inherit' })
  const classArchive = join(artifacts, 'classes.jar')
  execFileSync('jar', ['--create', '--file', classArchive, '-C', classes, '.'])
  execFileSync(join(buildTools, 'd8'), [
    '--lib', androidJar,
    '--min-api', '26',
    '--output', dex,
    classArchive,
  ], { stdio: 'inherit' })

  const unsignedApk = join(artifacts, 'unsigned.apk')
  execFileSync(join(buildTools, 'aapt2'), [
    'link',
    '-o', unsignedApk,
    '-I', androidJar,
    '--manifest', join(androidRoot, 'AndroidManifest.xml'),
    '--min-sdk-version', '26',
    '--target-sdk-version', '34',
  ], { stdio: 'inherit' })
  cpSync(join(dex, 'classes.dex'), join(staging, 'classes.dex'))
  cpSync(join(proofRoot, 'web'), join(staging, 'assets/web'), { recursive: true })
  cpSync(join(proofRoot, 'pkg'), join(staging, 'assets/pkg'), { recursive: true })
  execFileSync('/usr/bin/zip', ['-q', '-r', unsignedApk, '.'], { cwd: staging })

  const alignedApk = join(artifacts, 'aligned.apk')
  execFileSync(join(buildTools, 'zipalign'), ['-f', '4', unsignedApk, alignedApk])
  const keyStore = join(artifacts, 'debug.keystore')
  execFileSync('keytool', [
    '-genkeypair',
    '-keystore', keyStore,
    '-storepass', 'android',
    '-alias', 'androiddebugkey',
    '-keypass', 'android',
    '-dname', 'CN=Android Debug,O=DeepSeek Harness,C=US',
    '-keyalg', 'RSA',
    '-validity', '10000',
  ], { stdio: 'ignore' })
  const apk = join(artifacts, 'noise-proof.apk')
  execFileSync(join(buildTools, 'apksigner'), [
    'sign',
    '--ks', keyStore,
    '--ks-pass', 'pass:android',
    '--key-pass', 'pass:android',
    '--out', apk,
    alignedApk,
  ])
  execFileSync(join(buildTools, 'apksigner'), ['verify', apk])
  return apk
}

/**
 * Execute a built APK with injectable command and Emulator adapters.
 * @param {string} apk Absolute APK path.
 * @param {object} overrides Test-only adapters for commands and time.
 * @returns {Promise<{ reportText: string, status: string }>}
 */
export async function runAndroidProof(apk, overrides = {}) {
  const commands = overrides.commands ?? defaultCommands
  const clock = overrides.clock ?? defaultClock
  const startEmulator = overrides.startEmulator ?? startDefaultEmulator
  const cleanup = new CleanupStack()
  let primaryError
  let result

  try {
    const devices = commands.execFileSync(adb, ['devices'], { encoding: 'utf8' })
    if (!/^emulator-\d+\s+device$/m.test(devices)) {
      const ownedEmulator = startEmulator()
      cleanup.defer('wait for Android Emulator process exit', () => ownedEmulator.waitForExit())
      cleanup.defer('terminate Android Emulator', () => {
        const killed = commands.spawnSync(adb, ['emu', 'kill'])
        if (killed.status !== 0 || killed.error) ownedEmulator.terminate()
        requireSpawnSuccess(killed, 'adb emu kill')
      })
      commands.execFileSync(adb, ['wait-for-device'], { timeout: 60_000 })
    }

    const bootDeadline = clock.now() + 60_000
    let booted = false
    while (clock.now() < bootDeadline) {
      const completed = commands.spawnSync(
        adb,
        ['shell', 'getprop', 'sys.boot_completed'],
        { encoding: 'utf8' },
      )
      if (completed.status === 0 && completed.stdout.trim() === '1') {
        booted = true
        break
      }
      await clock.sleep(500)
    }
    if (!booted) throw new Error('Android Emulator did not finish booting within 60 seconds')

    cleanup.defer('uninstall Android proof app', () => {
      requireSpawnSuccess(commands.spawnSync(adb, ['uninstall', bundleId]), 'adb uninstall')
    })
    cleanup.defer('terminate Android proof app', () => {
      requireSpawnSuccess(
        commands.spawnSync(adb, ['shell', 'am', 'force-stop', bundleId]),
        'adb force-stop',
      )
    })
    commands.execFileSync(adb, ['install', apk], { stdio: 'inherit' })
    commands.execFileSync(adb, [
      'shell', 'am', 'start', '-n', `${bundleId}/.MainActivity`,
    ], { stdio: 'inherit' })

    const reportDeadline = clock.now() + reportTimeoutMs
    let reportText
    while (clock.now() < reportDeadline) {
      const report = commands.spawnSync(
        adb,
        ['shell', 'run-as', bundleId, 'cat', 'files/noise-proof.json'],
        { encoding: 'utf8' },
      )
      if (report.status === 0 && report.stdout.trim() !== '') {
        reportText = report.stdout.trim()
        break
      }
      await clock.sleep(250)
    }
    if (!reportText) {
      const progress = commands.spawnSync(adb, [
        'shell', 'run-as', bundleId, 'cat', 'files/noise-proof-progress.txt',
      ], { encoding: 'utf8' })
      throw new Error(
        `Android WebView did not produce a proof report within 30 seconds; ${progress.stdout?.trim() || 'no progress reported'}`,
      )
    }
    const androidApi = commands.execFileSync(
      adb,
      ['shell', 'getprop', 'ro.build.version.sdk'],
      { encoding: 'utf8' },
    ).trim()
    const webViewPackage = commands.execFileSync(
      adb,
      ['shell', 'dumpsys', 'package', 'com.android.webview'],
      { encoding: 'utf8' },
    )
    const webViewVersion = webViewPackage.match(/versionName=([^\s]+)/)?.[1] ?? 'unknown'
    if (reportText.startsWith('ERROR:')) throw new Error(reportText)
    const report = JSON.parse(reportText)
    if (report.runtime !== 'Android WebView') {
      throw new Error('Android proof returned the wrong runtime label')
    }
    if (report.allPass !== true) throw new Error('Android WebView returned a failing proof report')
    result = {
      reportText,
      status: `Android API ${androidApi}, WebView ${webViewVersion}: pass`,
    }
  } catch (error) {
    primaryError = error
  }

  await cleanup.finish(primaryError)
  return result
}

/**
 * Start one owned Emulator and expose deterministic termination observation.
 * @returns {{ terminate: () => void, waitForExit: () => Promise<void> }} Emulator resource.
 */
function startDefaultEmulator() {
  const emulatorProcess = spawn(emulator, [
    `@${process.env.DSH_NOISE_ANDROID_AVD ?? 'GestaltTest'}`,
    '-no-window',
    '-no-audio',
    '-no-snapshot',
    '-gpu',
    'swiftshader_indirect',
  ], { env: environment, stdio: 'ignore' })
  const exited = new Promise((resolvePromise, rejectPromise) => {
    emulatorProcess.once('exit', resolvePromise)
    emulatorProcess.once('error', rejectPromise)
  })
  return {
    terminate: () => emulatorProcess.kill('SIGTERM'),
    waitForExit: async () => {
      if (emulatorProcess.exitCode !== null || emulatorProcess.signalCode !== null) return
      let timeout
      try {
        await Promise.race([
          exited,
          new Promise((_, rejectPromise) => {
            timeout = setTimeout(
              () => rejectPromise(new Error('Android Emulator process did not exit within 30 seconds')),
              30_000,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { reportText, status } = await runAndroidProof(buildAndroidApk())
  process.stderr.write(`${status}\n`)
  process.stdout.write(`${reportText}\n`)
}
