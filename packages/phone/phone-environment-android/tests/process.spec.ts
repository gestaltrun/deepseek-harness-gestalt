import { describe, expect, it } from 'vitest'
import { androidSpawnSpec, windowsTaskkillArgs } from '../src/process.ts'

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
})
