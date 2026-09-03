import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it('runs dumpsys display through the selected SDK adb', () => {
    const exec = vi.fn(() => ({ stdout: MI8_DUMPSYS_DISPLAY, status: 0 }))
    expect(readAndroidLogicalDisplay({
      deviceId: 'fbcd1d21',
      environment: { ANDROID_SDK_ROOT: '/sdk' },
    }, { isExecutable: () => true, exec })).toEqual({ width: 2248, height: 1080 })
    expect(exec).toHaveBeenCalledWith({
      executablePath: '/sdk/platform-tools/adb',
      args: ['-s', 'fbcd1d21', 'shell', 'dumpsys', 'display'],
      environment: { ANDROID_SDK_ROOT: '/sdk' },
    })
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

  it('uses the default executable probe when internals omit isExecutable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adb-sdk-'))
    const platformTools = join(dir, 'platform-tools')
    const adb = join(platformTools, 'adb')
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

  it('reports whether a candidate SDK adb path is executable', async () => {
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
  it('uses the PATH basename when no SDK root is selected', () => {
    expect(resolveAdbExecutable({}, 'win32', () => true)).toBe('adb.exe')
    expect(resolveAdbExecutable({ ANDROID_SDK_ROOT: 'C:\\sdk' }, 'win32', () => true))
      .toBe('C:\\sdk\\platform-tools\\adb.exe')
    expect(resolveAdbExecutable({}, 'darwin', () => true)).toBe('adb')
    expect(resolveAdbExecutable({ ANDROID_HOME: '/sdk' }, 'linux', () => false)).toBe('adb')
  })
})
