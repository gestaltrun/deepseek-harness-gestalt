import { describe, expect, it } from 'vitest'
import {
  androidSpawnSpec, createNodeAndroidCommandRunner, windowsTaskkillArgs,
} from '../src/process.ts'

describe('Android SDK process launch', () => {
  it('routes a Windows SDK batch launcher through the command processor', () => {
    expect(androidSpawnSpec(
      'C:\\DSH Home\\phone\\android\\sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat',
      ['--sdk_root=C:\\DSH Home\\phone\\android\\sdk', '--licenses'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    )).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d', '/s', '/c',
        '""C:\\DSH Home\\phone\\android\\sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat" "--sdk_root=C:\\DSH Home\\phone\\android\\sdk" "--licenses""',
      ],
    })
  })

  it('uses cmd.exe when Windows exposes no command processor', () => {
    const previous = process.env.ComSpec
    delete process.env.ComSpec
    try {
      expect(androidSpawnSpec('C:\\sdkmanager.bat', ['--licenses'], 'win32')).toMatchObject({ command: 'cmd.exe' })
    } finally {
      if (previous !== undefined) process.env.ComSpec = previous
    }
  })

  it('keeps native executables as direct children', () => {
    expect(androidSpawnSpec('/sdk/emulator/emulator', ['-accel-check'], 'linux')).toEqual({
      command: '/sdk/emulator/emulator',
      args: ['-accel-check'],
    })
  })

  it('rejects command expansion in a Windows SDK batch path', () => {
    expect(() => androidSpawnSpec('C:\\%USER%\\sdkmanager.bat', ['--licenses'], 'win32'))
      .toThrow(/command-expansion character/)
  })

  it('targets the complete Windows process tree before and after escalation', () => {
    expect(windowsTaskkillArgs(42, false)).toEqual(['/PID', '42', '/T'])
    expect(windowsTaskkillArgs(42, true)).toEqual(['/PID', '42', '/T', '/F'])
  })

  it('distinguishes a command deadline from the child exit facts', async () => {
    const result = await createNodeAndroidCommandRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { env: {}, timeoutMs: 10 },
    )

    expect(result).toMatchObject({ timedOut: true, callerAborted: false })
  })

  it('honors an already-aborted caller and retains its ownership fact', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))

    const result = await createNodeAndroidCommandRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { env: {}, signal: controller.signal },
    )

    expect(result).toMatchObject({ timedOut: false, callerAborted: true })
  })

  it.skipIf(process.platform === 'win32')('retains an unowned signal death', async () => {
    const result = await createNodeAndroidCommandRunner().run(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { env: {} },
    )

    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      callerAborted: false,
    })
  })

  it.skipIf(process.platform === 'win32')('bounds and surfaces a failed Windows process-tree stop', async () => {
    const runner = createNodeAndroidCommandRunner({
      platform: 'win32', stopGraceMs: 5,
      taskkill: () => { throw new Error('taskkill refused the process tree') },
    })
    const owned = runner.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { env: {} },
    )

    await expect(owned.stop()).rejects.toThrow(/taskkill refused the process tree/)
    if (owned.pid !== undefined) process.kill(owned.pid, 'SIGKILL')
    await expect(owned.exit).resolves.toMatchObject({
      terminationError: 'taskkill refused the process tree',
    })
  })

  it.skipIf(process.platform === 'win32')('retries a retained Windows process after an earlier taskkill failure', async () => {
    let attempts = 0
    const runner = createNodeAndroidCommandRunner({
      platform: 'win32', stopGraceMs: 5,
      taskkill: (pid) => {
        attempts += 1
        if (attempts <= 2) throw new Error('taskkill temporarily unavailable')
        process.kill(pid, 'SIGTERM')
      },
    })
    const owned = runner.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { env: {} },
    )

    await expect(owned.stop()).rejects.toThrow(/taskkill temporarily unavailable/)
    expect(() => { if (owned.pid !== undefined) process.kill(owned.pid, 0) }).not.toThrow()
    await expect(owned.stop()).resolves.toBeUndefined()
    expect(attempts).toBe(3)
  })
})
