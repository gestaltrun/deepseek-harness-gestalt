import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openAndroidSystemH264 } from '../src/android-h264-process.ts'
import type { ServerExit } from '../src/server-process.ts'

interface FakeTree {
  readonly process: ChildProcess
  readonly exit: Promise<ServerExit>
  readonly error: NodeJS.ErrnoException | undefined
  readonly lastStderr: string
  stop(): Promise<void>
}

function tree(options: {
  readonly stdout?: PassThrough | null
  readonly error?: NodeJS.ErrnoException
  readonly stderr?: string
  readonly stop?: () => Promise<void>
} = {}): { readonly value: FakeTree; readonly settle: (exit: ServerExit) => void } {
  const settlement = Promise.withResolvers<ServerExit>()
  const stdout = options.stdout === undefined ? new PassThrough() : options.stdout
  return {
    value: {
      process: { stdout } as ChildProcess,
      exit: settlement.promise,
      error: options.error,
      lastStderr: options.stderr ?? '',
      stop: options.stop ?? (async () => {}),
    },
    settle: settlement.resolve,
  }
}

describe('openAndroidSystemH264', () => {
  it('uses the selected SDK adb and streams stdout through clean exit', async () => {
    const fake = tree()
    const launch = vi.fn(() => fake.value)
    const body = openAndroidSystemH264({
      deviceId: 'device-1',
      environment: { ANDROID_SDK_ROOT: '/sdk', PATH: '/bin' },
      signal: new AbortController().signal,
    }, { platform: 'linux', isExecutable: () => true, launch })
    const reader = body.getReader()
    const firstRead = reader.read()
    ;(fake.value.process.stdout as PassThrough).write(Buffer.from([1, 2, 3]))
    expect(await firstRead).toEqual({ done: false, value: Uint8Array.from([1, 2, 3]) })
    fake.settle({ code: 0 })
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(launch).toHaveBeenCalledWith({
      executablePath: '/sdk/platform-tools/adb',
      args: ['-s', 'device-1', 'exec-out', 'screenrecord', '--output-format=h264', '-'],
      environment: { ANDROID_SDK_ROOT: '/sdk', PATH: '/bin' },
    })
  })

  it('passes logical landscape size as screenrecord --size', async () => {
    const fake = tree()
    const launch = vi.fn(() => fake.value)
    const body = openAndroidSystemH264({
      deviceId: 'fbcd1d21',
      environment: { ANDROID_SDK_ROOT: '/sdk' },
      signal: new AbortController().signal,
      size: { width: 2248, height: 1080 },
    }, { platform: 'linux', isExecutable: () => true, launch })
    fake.settle({ code: 0 })
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(0)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      args: ['-s', 'fbcd1d21', 'exec-out', 'screenrecord', '--output-format=h264', '--size=2248x1080', '-'],
    }))
  })

  it('uses adb.exe from PATH on Windows when no SDK root is selected', async () => {
    const fake = tree()
    const launch = vi.fn(() => fake.value)
    const body = openAndroidSystemH264({
      deviceId: 'device-2', environment: {}, signal: new AbortController().signal,
    }, { platform: 'win32', launch })
    fake.settle({ code: 0 })
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(0)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: 'adb.exe' }))
  })

  it('uses Windows path syntax for a selected Windows SDK', async () => {
    const fake = tree()
    const launch = vi.fn(() => fake.value)
    const body = openAndroidSystemH264({
      deviceId: 'device-win-sdk',
      environment: { ANDROID_SDK_ROOT: 'C:\\sdk' },
      signal: new AbortController().signal,
    }, { platform: 'win32', isExecutable: () => true, launch })
    fake.settle({ code: 0 })
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(0)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: 'C:\\sdk\\platform-tools\\adb.exe',
    }))
  })

  it('falls back from a selected but incomplete SDK to adb on PATH', async () => {
    const fake = tree()
    const launch = vi.fn(() => fake.value)
    const body = openAndroidSystemH264({
      deviceId: 'device-path',
      environment: { ANDROID_HOME: '/incomplete-sdk' },
      signal: new AbortController().signal,
    }, { platform: 'linux', launch })
    fake.settle({ code: 0 })
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(0)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: 'adb' }))
  })

  it.skipIf(process.platform === 'win32')('launches the owned process tree with an executable selected SDK adb', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-adb-h264-'))
    const platformTools = join(root, 'platform-tools')
    const adb = join(platformTools, 'adb')
    await mkdir(platformTools)
    await writeFile(adb, '#!/bin/sh\nprintf "native-h264"\n')
    await chmod(adb, 0o755)
    try {
      const body = openAndroidSystemH264({
        deviceId: 'device-owned-tree',
        environment: { ANDROID_SDK_ROOT: root, PATH: '/usr/bin:/bin' },
        signal: new AbortController().signal,
      })
      await expect(new Response(body).text()).resolves.toBe('native-h264')
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it.runIf(process.platform === 'win32')('launches the owned Windows process tree with the selected SDK adb', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-adb-h264-win-'))
    const platformTools = join(root, 'platform-tools')
    const adb = join(platformTools, 'adb.exe')
    await mkdir(platformTools)
    await symlink(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', adb, 'file')
    try {
      const body = openAndroidSystemH264({
        deviceId: 'device-owned-tree',
        environment: { ANDROID_SDK_ROOT: root },
        signal: new AbortController().signal,
      })
      await expect(new Response(body).arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('surfaces spawn and nonzero-exit diagnostics', async () => {
    const spawnError = Object.assign(new Error('missing adb'), { code: 'ENOENT' })
    const missing = tree({ error: spawnError })
    const missingBody = openAndroidSystemH264({
      deviceId: 'missing', environment: {}, signal: new AbortController().signal,
    }, { launch: () => missing.value })
    missing.settle({ code: null })
    await expect(new Response(missingBody).arrayBuffer()).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })

    const failed = tree({ stderr: 'encoder refused' })
    const failedBody = openAndroidSystemH264({
      deviceId: 'failed', environment: {}, signal: new AbortController().signal,
    }, { launch: () => failed.value })
    failed.settle({ code: 9 })
    await expect(new Response(failedBody).arrayBuffer())
      .rejects.toThrow('exited with code 9; stderr tail follows\nencoder refused')
  })

  it('rejects a missing stdout after the owned tree stops', async () => {
    const stop = vi.fn(async () => {})
    const fake = tree({ stdout: null, stop })
    const body = openAndroidSystemH264({
      deviceId: 'missing-stdout', environment: {}, signal: new AbortController().signal,
    }, { launch: () => fake.value })
    await expect(new Response(body).arrayBuffer()).rejects.toThrow('exposed no stdout')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('surfaces a missing-stdout cleanup rejection', async () => {
    const fake = tree({ stdout: null, stop: async () => { throw new Error('cleanup refusal') } })
    const body = openAndroidSystemH264({
      deviceId: 'missing-stdout-cleanup', environment: {}, signal: new AbortController().signal,
    }, { launch: () => fake.value })
    await expect(new Response(body).arrayBuffer()).rejects.toThrow('exposed no stdout and cleanup failed')
  })

  it('stops the tree when the consumer cancels', async () => {
    const stop = vi.fn(async () => {})
    const fake = tree({ stop })
    const body = openAndroidSystemH264({
      deviceId: 'cancelled', environment: {}, signal: new AbortController().signal,
    }, { launch: () => fake.value })
    await body.cancel('browser closed')
    fake.settle({ code: 0 })
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('pauses stdout when the Web stream queue fills and resumes for demand', async () => {
    const stdout = new PassThrough()
    const pause = vi.spyOn(stdout, 'pause')
    const resume = vi.spyOn(stdout, 'resume')
    const fake = tree({ stdout })
    const body = openAndroidSystemH264({
      deviceId: 'backpressure', environment: {}, signal: new AbortController().signal,
    }, { launch: () => fake.value })
    await new Promise(resolve => setTimeout(resolve, 0))
    stdout.write(Buffer.from([1]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pause.mock.calls.length).toBeGreaterThanOrEqual(2)

    const reader = body.getReader()
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.from([1]) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resume).toHaveBeenCalled()
    await reader.cancel()
  })

  it('ignores captured data and abort callbacks after a clean exit', async () => {
    const stdout = new PassThrough()
    const on = vi.spyOn(stdout, 'on')
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const fake = tree({ stdout })
    const body = openAndroidSystemH264({
      deviceId: 'late-events', environment: {}, signal: controller.signal,
    }, { launch: () => fake.value })
    const reader = body.getReader()
    fake.settle({ code: 0 })
    expect(await reader.read()).toEqual({ done: true, value: undefined })

    const data = on.mock.calls.find(([name]) => name === 'data')?.[1] as ((chunk: Buffer) => void)
    data(Buffer.from('late'))
    const abort = add.mock.calls.find(([name]) => name === 'abort')?.[1] as EventListener
    abort.call(controller.signal, new Event('abort'))
  })

  it('rejects pre-abort and turns live abort cleanup outcomes into stream errors', async () => {
    const pre = new AbortController()
    pre.abort(new Error('already stopped'))
    expect(() => openAndroidSystemH264({
      deviceId: 'pre', environment: {}, signal: pre.signal,
    }, { launch: () => tree().value })).toThrow('Android system H264 capture was cancelled')

    const stringAbort = new AbortController()
    stringAbort.abort('caller stopped')
    expect(() => openAndroidSystemH264({
      deviceId: 'pre-string', environment: {}, signal: stringAbort.signal,
    }, { launch: () => tree().value })).toThrow('Android system H264 capture was cancelled')

    const controller = new AbortController()
    const stopped = vi.fn(async () => {})
    const active = tree({ stop: stopped })
    const body = openAndroidSystemH264({
      deviceId: 'active', environment: {}, signal: controller.signal,
    }, { launch: () => active.value })
    const reading = body.getReader().read()
    controller.abort(new Error('generation replaced'))
    await expect(reading).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(stopped).toHaveBeenCalledOnce()

    const failingController = new AbortController()
    const cleanupFailure = tree({ stop: async () => { throw 'tree refusal' } })
    const failingBody = openAndroidSystemH264({
      deviceId: 'cleanup', environment: {}, signal: failingController.signal,
    }, { launch: () => cleanupFailure.value })
    const failingRead = failingBody.getReader().read()
    failingController.abort()
    await expect(failingRead).rejects.toThrow('abort cleanup failed')
  })
})
