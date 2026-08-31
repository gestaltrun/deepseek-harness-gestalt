import type {
  IosDeviceType, IosHostPlan, IosInstallationProbe, IosPreparationPlan, IosRuntime,
} from './types.ts'

/** Product-owned Simulator name used to find or create the default iPhone. */
export const IOS_SIMULATOR_NAME = 'DSH Gestalt iPhone'

/**
 * Build one iOS preparation state from authoritative Host observations.
 * @param platform - Node platform name from the Host process.
 * @param probe - complete Xcode and simctl observations on macOS.
 * @returns the immutable next state without running preparation commands.
 */
export function planIosEnvironment(platform: string, probe?: IosInstallationProbe): IosHostPlan {
  if (platform !== 'darwin') {
    const family = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform
    return {
      kind: 'unsupported',
      reason: `${family} cannot run iOS Simulator or control iPhone devices; use macOS with a complete Xcode installation.`,
    }
  }
  if (probe === undefined) return {
    kind: 'xcode-missing',
    message: 'Install or update the complete Xcode application, then select it in Xcode Settings.',
  }
  if (!probe.licenseAccepted) return {
    kind: 'license-required', developerDir: probe.developerDir,
    message: 'Open Xcode and accept the Apple Xcode license before preparing iOS Simulator.',
  }
  if (!probe.firstLaunchComplete) return {
    kind: 'manual-required', code: 'first-launch', developerDir: probe.developerDir,
    message: 'Open Xcode and finish installing its first-launch components.',
  }
  const runtime = newestRuntime(probe.runtimes)
  const deviceType = newestIphoneType(probe.deviceTypes)
  const plan: IosPreparationPlan = Object.freeze({
    developerDir: probe.developerDir,
    xcodeVersion: probe.xcodeVersion,
    simulatorName: IOS_SIMULATOR_NAME,
    ...(runtime === undefined ? {} : { runtime }),
    ...(deviceType === undefined ? {} : { deviceType }),
  })
  if (runtime === undefined) return { kind: 'runtime-missing', plan }
  if (deviceType === undefined) return {
    kind: 'manual-required', code: 'xcode-update', developerDir: probe.developerDir,
    message: 'Update Xcode to an installation that includes an iPhone Simulator device type.',
  }
  const simulator = probe.devices.find(device => (
    device.available
    && device.name === IOS_SIMULATOR_NAME
    && device.runtimeIdentifier === runtime.identifier
  ))
  if (simulator === undefined) return { kind: 'no-simulator', plan }
  return {
    kind: 'ready', plan, deviceId: simulator.udid,
    running: simulator.state.toLowerCase() === 'booted',
  }
}

function newestRuntime(runtimes: readonly IosRuntime[]): IosPreparationPlan['runtime'] {
  const runtime = [...runtimes].filter(runtime => runtime.available && /^iOS\b/u.test(runtime.name))
    .sort((left, right) => compareVersions(right.version, left.version))[0]
  return runtime === undefined ? undefined : { ...runtime, available: true }
}

function newestIphoneType(types: readonly IosDeviceType[]): IosDeviceType | undefined {
  return [...types].filter(type => /^iPhone\b/u.test(type.name)).sort((left, right) => {
    const versionOrder = compareVersions(deviceGeneration(right.name), deviceGeneration(left.name))
    if (versionOrder !== 0) return versionOrder
    const leftPro = /\bPro\b/u.test(left.name) ? 1 : 0
    const rightPro = /\bPro\b/u.test(right.name) ? 1 : 0
    return rightPro - leftPro || left.name.localeCompare(right.name)
  })[0]
}

function deviceGeneration(name: string): string {
  return /\b(\d+(?:\.\d+)*)\b/u.exec(name)?.[1] ?? '0'
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
