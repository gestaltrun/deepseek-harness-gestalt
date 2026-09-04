import { join } from 'node:path'
import type { AndroidPreparationPlan } from '@deepseek-ai/dsh-phone-environment'
import {
  ANDROID_API_LEVEL, ANDROID_AVD_NAME, ANDROID_COMMAND_LINE_TOOLS_VERSION,
  ANDROID_MINIMUM_FREE_BYTES, ANDROID_SDK_LICENSE_URL, selectAndroidCommandLineToolsAsset,
} from './manifest.ts'
import type { AndroidHostPlan, AndroidInstallationProbe } from './types.ts'

/**
 * Build the fixed Android SDK package id for the Host CPU.
 * @param architecture - Node architecture name.
 * @returns the API 35 Google APIs package id, or `undefined` for an unsupported CPU.
 */
export function androidSystemImagePackage(architecture: string): string | undefined {
  if (architecture === 'arm64') return `system-images;android-${String(ANDROID_API_LEVEL)};google_apis;arm64-v8a`
  if (architecture === 'x64') return `system-images;android-${String(ANDROID_API_LEVEL)};google_apis;x86_64`
  return undefined
}

/**
 * Build one user-visible plan without performing filesystem or process work.
 * @param platform - Node platform name.
 * @param architecture - Node architecture name.
 * @param phoneRoot - private phone environment root.
 * @param probe - optional compatible SDK facts discovered on the Host.
 * @returns the supported immutable plan or an explicit unsupported reason.
 */
export function planAndroidEnvironment(
  platform: string,
  architecture: string,
  phoneRoot: string,
  probe?: AndroidInstallationProbe,
): AndroidHostPlan {
  const asset = selectAndroidCommandLineToolsAsset(platform, architecture)
  const image = androidSystemImagePackage(architecture)
  if (asset === undefined || image === undefined) {
    const family = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform
    return { kind: 'unsupported', reason: `${family} ${architecture} does not have a supported Android Emulator toolchain.` }
  }
  const sdkRoot = probe?.sdkRoot ?? join(phoneRoot, 'android', 'sdk')
  const sdkSource = probe?.sdkSource ?? 'managed'
  const components = Object.freeze({
    commandLineTools: probe?.commandLineTools ?? false,
    platformTools: probe?.platformTools ?? false,
    emulator: probe?.emulator ?? false,
    systemImage: probe?.systemImage ?? false,
    avd: probe?.avd ?? false,
  })
  const plan: AndroidPreparationPlan = Object.freeze({
    sdkRoot,
    sdkSource,
    avdHome: join(phoneRoot, 'android', 'avd'),
    avdName: ANDROID_AVD_NAME,
    abi: architecture === 'arm64' ? 'arm64-v8a' : 'x86_64',
    commandLineToolsVersion: ANDROID_COMMAND_LINE_TOOLS_VERSION,
    commandLineToolsBytes: components.commandLineTools ? 0 : asset.bytes,
    packageIds: Object.freeze(['platform-tools', 'emulator', image]),
    minimumFreeBytes: ANDROID_MINIMUM_FREE_BYTES,
    licenseUrl: ANDROID_SDK_LICENSE_URL,
    components,
  })
  return { kind: 'supported', asset, plan }
}
