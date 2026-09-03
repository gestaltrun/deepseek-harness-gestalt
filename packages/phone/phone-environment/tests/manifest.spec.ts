import { describe, expect, it } from 'vitest'
import {
  MOBILECLI_MANAGED_VERSION,
  MOBILECLI_RELEASE_ASSETS,
  selectMobilecliReleaseAsset,
} from '../src/index.ts'

describe('mobilecli managed release manifest', () => {
  it('pins all six official 1.0.5 platform assets by exact URL, size, and SHA-256', () => {
    expect(MOBILECLI_MANAGED_VERSION).toBe('1.0.5')
    expect(MOBILECLI_RELEASE_ASSETS).toEqual([
      expect.objectContaining({ platform: 'linux', architecture: 'x64', bytes: 6_011_991, sha256: 'ef09ca808b60479616c39991aaad1beb6d6da14b49328699043a066c8d539f68' }),
      expect.objectContaining({ platform: 'linux', architecture: 'arm64', bytes: 5_445_336, sha256: '93998b09d19d88a2e253874b8f29892ae81081d961fb513a11570bc0e050f49e' }),
      expect.objectContaining({ platform: 'darwin', architecture: 'x64', bytes: 5_896_174, sha256: '05bbfcc79d45d75d927808a6fea2457170001fb9559c40e004c4d302232e4d5a' }),
      expect.objectContaining({ platform: 'darwin', architecture: 'arm64', bytes: 5_458_848, sha256: '06067df993ebbd7c680948d667d5b43fa6b3c2f9ef5217ee2a659193a33ea39f' }),
      expect.objectContaining({ platform: 'win32', architecture: 'x64', bytes: 5_924_734, sha256: 'eb21a5c6345a057607b7564d6b99e46da7e0ea4a8395cc257b7a06836c2658ad' }),
      expect.objectContaining({ platform: 'win32', architecture: 'arm64', bytes: 5_298_945, sha256: '30d559d1a75b2bc4ca8bd7a940ad88a3a82aaa48f75d7a21a22366291f9df302' }),
    ])
    for (const asset of MOBILECLI_RELEASE_ASSETS) {
      expect(asset.url).toBe(`https://github.com/mobile-next/mobilecli/releases/download/1.0.5/${asset.name}`)
      expect(asset.executable).toBe(asset.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli')
    }
  })

  it.each([
    ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'],
    ['linux', 'x64'], ['win32', 'arm64'], ['win32', 'x64'],
  ])('selects %s/%s without a shell shim', (platform, architecture) => {
    const asset = selectMobilecliReleaseAsset(platform, architecture)
    expect(asset.platform).toBe(platform)
    expect(asset.architecture).toBe(architecture)
  })

  it.each([['aix', 'x64'], ['darwin', 'ia32'], ['win32', 'ia32']])(
    'rejects unsupported %s/%s tuples',
    (platform, architecture) => {
      expect(() => selectMobilecliReleaseAsset(platform, architecture)).toThrow(/no managed asset/)
    },
  )
})
