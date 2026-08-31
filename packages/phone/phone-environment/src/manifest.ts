import type { MobilecliArchitecture, MobilecliPlatform, MobilecliReleaseAsset } from './types.ts'

/** Pinned upstream mobilecli release accepted by the managed installer. */
export const MOBILECLI_MANAGED_VERSION = '1.0.5'

const RELEASE_BASE = `https://github.com/mobile-next/mobilecli/releases/download/${MOBILECLI_MANAGED_VERSION}`

/** Fixed URL, length, and digest allowlist for every supported host tuple. */
export const MOBILECLI_RELEASE_ASSETS: readonly MobilecliReleaseAsset[] = Object.freeze([
  asset('linux', 'x64', 'linux-amd64', 6_011_991, 'ef09ca808b60479616c39991aaad1beb6d6da14b49328699043a066c8d539f68'),
  asset('linux', 'arm64', 'linux-arm64', 5_445_336, '93998b09d19d88a2e253874b8f29892ae81081d961fb513a11570bc0e050f49e'),
  asset('darwin', 'x64', 'macos-amd64', 5_896_174, '05bbfcc79d45d75d927808a6fea2457170001fb9559c40e004c4d302232e4d5a'),
  asset('darwin', 'arm64', 'macos-arm64', 5_458_848, '06067df993ebbd7c680948d667d5b43fa6b3c2f9ef5217ee2a659193a33ea39f'),
  asset('win32', 'x64', 'windows-amd64', 5_924_734, 'eb21a5c6345a057607b7564d6b99e46da7e0ea4a8395cc257b7a06836c2658ad'),
  asset('win32', 'arm64', 'windows-arm64', 5_298_945, '30d559d1a75b2bc4ca8bd7a940ad88a3a82aaa48f75d7a21a22366291f9df302'),
])

function asset(
  platform: MobilecliPlatform,
  architecture: MobilecliArchitecture,
  releaseTuple: string,
  bytes: number,
  sha256: string,
): MobilecliReleaseAsset {
  const name = `mobilecli-${MOBILECLI_MANAGED_VERSION}-${releaseTuple}.zip`
  return Object.freeze({
    platform,
    architecture,
    name,
    url: `${RELEASE_BASE}/${name}`,
    bytes,
    sha256,
    executable: platform === 'win32' ? 'mobilecli.exe' : 'mobilecli',
  })
}

/**
 * Select the one pinned upstream asset for a Node host tuple.
 * @param platform - Node platform value.
 * @param architecture - Node architecture value.
 * @returns the immutable asset manifest row.
 * @throws when mobilecli publishes no admitted asset for the tuple.
 */
export function selectMobilecliReleaseAsset(platform: string, architecture: string): MobilecliReleaseAsset {
  const selected = MOBILECLI_RELEASE_ASSETS.find(asset =>
    asset.platform === platform && asset.architecture === architecture)
  if (selected !== undefined) return selected
  throw new Error(`phone-environment: mobilecli ${MOBILECLI_MANAGED_VERSION} has no managed asset for ${platform}/${architecture}`)
}
