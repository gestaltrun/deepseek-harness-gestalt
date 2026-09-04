import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  executableOnHost, parseAndroidLogicalDisplay, readAndroidLogicalDisplay, resolveAdbExecutable,
} from '../src/android-display.ts'

/** Live MI 8 2026-09-03: landscape Clash UI, `device.info.screenSize` still 1080×2248. */
const MI8_DUMPSYS_DISPLAY = `
  mCurrentOrientation=1
  logicalFrame=Rect(0, 0 - 2248, 1080)
`.trim()

describe('parseAndroidLogicalDisplay', () => {
  it('reads the live MI 8 landscape logicalFrame and ignores sticky portrait screenSize', () => {
    expect(parseAndroidLogicalDisplay(`${MI8_DUMPSYS_DISPLAY}\nPhysical size: 1080x2248`))
      .toEqual({ width: 2248, height: 1080 })
  })

  it('returns undefined when logicalFrame is missing or empty', () => {
    expect(parseAndroidLogicalDisplay('mCurrentOrientation=1')).toBeUndefined()
    expect(parseAndroidLogicalDisplay('logicalFrame=Rect(0, 0 - 0, 1080)')).toBeUndefined()
  })
})

describe('readAndroidLogicalDisplay', () => {
  it.each([
    ['linux' as const, '/sdk', '/sdk/platform-tools/adb'],
    ['win32' as const, 'C:\\sdk', 'C:\\sdk\\platform-tools\\adb.exe'],
  ])('runs dumpsys display through the selected %s SDK adb', (platform, sdkRoot, executablePath) => {
    const exec = vi.fn(() => ({ stdout: MI8_DUMPSYS_DISPLAY, status: 0 }))
    expect(readAndroidLogicalDisplay({
      deviceId: 'fbcd1d21',
      environment: { ANDROID_SDK_ROOT: sdkRoot },
    }, { platform, isExecutable: () => true, exec })).toEqual({ width: 2248, height: 1080 })
    expect(exec).toHaveBeenCalledWith({
      executablePath,
      args: ['-s', 'fbcd1d21', 'shell', 'dumpsys', 'display'],
      environment: { ANDROID_SDK_ROOT: sdkRoot },
    })
  })

  it('uses the Host PATH basename when platform and SDK root are omitted', () => {
    const exec = vi.fn(() => ({ stdout: MI8_DUMPSYS_DISPLAY, status: 0 }))
    expect(readAndroidLogicalDisplay({
      deviceId: 'host-path',
      environment: {},
    }, { exec })).toEqual({ width: 2248, height: 1080 })
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: process.platform === 'win32' ? 'adb.exe' : 'adb',
    }))
  })

  it('returns undefined when dumpsys exits non-zero or throws', () => {
    expect(readAndroidLogicalDisplay({
      deviceId: 'offline',
      environment: {},
    }, { platform: 'linux', exec: () => ({ stdout: MI8_DUMPSYS_DISPLAY, status: 1 }) })).toBeUndefined()
    expect(readAndroidLogicalDisplay({
      deviceId: 'offline',
      environment: {},
    }, { platform: 'linux', exec: () => { throw new Error('adb missing') } })).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')('uses the default executable probe for a POSIX SDK', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adb-sdk-'))
    const platformTools = posix.join(dir, 'platform-tools')
    const adb = posix.join(platformTools, 'adb')
    const exec = vi.fn((options: {
      readonly executablePath: string
      readonly args: readonly string[]
      readonly environment: Readonly<Record<string, string>>
    }) => {
      void options
      return { stdout: MI8_DUMPSYS_DISPLAY, status: 0 }
    })
    try {
      expect(readAndroidLogicalDisplay({
        deviceId: 'fbcd1d21',
        environment: { ANDROID_SDK_ROOT: dir },
      }, { platform: 'linux', exec })).toEqual({ width: 2248, height: 1080 })
      expect(exec.mock.calls[0]![0].executablePath).toBe('adb')

      await mkdir(platformTools)
      await writeFile(adb, '')
      await chmod(adb, 0o755)
      exec.mockClear()
      expect(readAndroidLogicalDisplay({
        deviceId: 'fbcd1d21',
        environment: { ANDROID_SDK_ROOT: dir },
      }, { platform: 'linux', exec })).toEqual({ width: 2248, height: 1080 })
      expect(exec.mock.calls[0]![0].executablePath).toBe(adb)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the platform-appropriate executable probe for files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adb-probe-'))
    const adb = join(dir, 'adb')
    const access = vi.fn()
    try {
      await writeFile(adb, '')
      expect(executableOnHost(adb, 'linux', access)).toBe(true)
      expect(access).toHaveBeenLastCalledWith(adb, 1)

      expect(executableOnHost(adb, 'win32', access)).toBe(true)
      expect(access).toHaveBeenLastCalledWith(adb, 0)

      access.mockImplementationOnce(() => { throw new Error('missing') })
      expect(executableOnHost(adb, 'linux', access)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a directory at the Windows adb.exe candidate path', async () => {
    const adb = await mkdtemp(join(tmpdir(), 'dsh-adb.exe-'))
    try {
      expect(executableOnHost(adb, 'win32')).toBe(false)
    } finally {
      await rm(adb, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('reports POSIX execute permission for a candidate SDK adb path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adb-exec-'))
    const adb = join(dir, 'adb')
    try {
      await writeFile(adb, '')
      expect(executableOnHost(adb)).toBe(false)
      await chmod(adb, 0o755)
      expect(executableOnHost(adb)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined when the default adb spawn cannot run', () => {
    expect(readAndroidLogicalDisplay({
      deviceId: 'offline',
      environment: { ANDROID_SDK_ROOT: '/no-such-sdk' },
    }, { platform: 'linux', isExecutable: () => true })).toBeUndefined()
  })
})

describe('resolveAdbExecutable', () => {
  it.each([
    ['win32' as const, 'adb.exe'],
    ['darwin' as const, 'adb'],
  ])('uses the %s PATH basename when no SDK root is selected', (platform, basename) => {
    expect(resolveAdbExecutable({}, platform, () => true)).toBe(basename)
  })

  it.each([
    ['win32' as const, 'C:\\sdk', 'C:\\sdk\\platform-tools\\adb.exe'],
    ['linux' as const, '/sdk', '/sdk/platform-tools/adb'],
    ['win32' as const, 'C:/sdk', 'C:\\sdk\\platform-tools\\adb.exe'],
    ['linux' as const, '/sdk\\nested', '/sdk\\nested/platform-tools/adb'],
  ])('uses target %s path rules for SDK root %s', (platform, sdkRoot, expected) => {
    expect(resolveAdbExecutable({ ANDROID_SDK_ROOT: sdkRoot }, platform, () => true)).toBe(expected)
  })

  it('prefers a non-empty SDK root override over ANDROID_HOME', () => {
    expect(resolveAdbExecutable({
      ANDROID_SDK_ROOT: '  C:\\override  ',
      ANDROID_HOME: 'C:\\home',
    }, 'win32', () => true)).toBe('C:\\override\\platform-tools\\adb.exe')
  })

  it.each([
    ['win32' as const, { ANDROID_SDK_ROOT: 'C:\\missing' }, 'adb.exe'],
    ['linux' as const, { ANDROID_HOME: '/missing' }, 'adb'],
  ])('falls back to the %s PATH basename when the selected SDK executable is missing', (
    platform,
    environment,
    basename,
  ) => {
    expect(resolveAdbExecutable(environment, platform, () => false)).toBe(basename)
  })
})
