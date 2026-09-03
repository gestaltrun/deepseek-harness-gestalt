import type { AndroidCommandLineToolsAsset } from './types.ts'

/** Pinned Google command-line tools build used by managed preparation. */
export const ANDROID_COMMAND_LINE_TOOLS_VERSION = '15859902'
/** Fixed API level of the default Gestalt emulator. */
export const ANDROID_API_LEVEL = 35
/** Private default AVD identity. */
export const ANDROID_AVD_NAME = 'Pixel_6_API_35_Gestalt'
/** Official Android SDK terms displayed before preparation. */
export const ANDROID_SDK_LICENSE_URL = 'https://developer.android.com/studio/terms'
/** Conservative free-space floor from the official Emulator system requirements. */
export const ANDROID_MINIMUM_FREE_BYTES = 16 * 1024 * 1024 * 1024

const DOWNLOAD_ROOT = 'https://dl.google.com/android/repository'

/** Immutable official command-line tools assets for supported Host tuples. */
export const ANDROID_COMMAND_LINE_TOOLS_ASSETS: readonly AndroidCommandLineToolsAsset[] = Object.freeze([
  {
    platform: 'darwin', architecture: 'arm64',
    name: 'commandlinetools-mac_arm64-15859902_latest.zip',
    url: `${DOWNLOAD_ROOT}/commandlinetools-mac_arm64-15859902_latest.zip`,
    bytes: 156_083_281,
    sha256: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
  },
  {
    platform: 'darwin', architecture: 'x64',
    name: 'commandlinetools-mac_x86_64-15859902_latest.zip',
    url: `${DOWNLOAD_ROOT}/commandlinetools-mac_x86_64-15859902_latest.zip`,
    bytes: 156_281_494,
    sha256: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
  },
  {
    platform: 'linux', architecture: 'x64',
    name: 'commandlinetools-linux-15859902_latest.zip',
    url: `${DOWNLOAD_ROOT}/commandlinetools-linux-15859902_latest.zip`,
    bytes: 181_833_628,
    sha256: '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583',
  },
  {
    platform: 'win32', architecture: 'x64',
    name: 'commandlinetools-win-15859902_latest.zip',
    url: `${DOWNLOAD_ROOT}/commandlinetools-win-15859902_latest.zip`,
    bytes: 155_655_386,
    sha256: '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a',
  },
])

/**
 * Select one pinned command-line tools asset for a Host tuple.
 * @param platform - Node platform name.
 * @param architecture - Node architecture name.
 * @returns the admitted asset, or `undefined` for an unsupported tuple.
 */
export function selectAndroidCommandLineToolsAsset(
  platform: string,
  architecture: string,
): AndroidCommandLineToolsAsset | undefined {
  return ANDROID_COMMAND_LINE_TOOLS_ASSETS.find(asset => (
    asset.platform === platform && asset.architecture === architecture
  ))
}
