import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyDesktopE2EProfile, resolveDesktopNetworkProxy } from '../src/e2e-profile.ts'

describe('Desktop E2E process profile', () => {
  it('applies only the explicit source lane allowlist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-e2e-profile-')), 'profile.json')
    writeFileSync(path, JSON.stringify({
      DSH_HOME: '/tmp/profile-home',
      DSH_MEMBER_QUESTION_ACCOUNT_ID: 'account-a',
      DSH_PROJECT_MEMBERS_WORKSPACE: '/tmp/profile-workspace',
    }))
    const environment: NodeJS.ProcessEnv = { DSH_DESKTOP_E2E: '1' }
    expect(applyDesktopE2EProfile({
      packaged: false,
      argv: ['electron', `--dsh-e2e-profile=${path}`],
      environment,
    })).toBe(path)
    expect(environment).toMatchObject({
      DSH_HOME: '/tmp/profile-home',
      DSH_MEMBER_QUESTION_ACCOUNT_ID: 'account-a',
      DSH_PROJECT_MEMBERS_WORKSPACE: '/tmp/profile-workspace',
    })
  })

  it('rejects packaged, unarmed, empty, and unknown profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-e2e-profile-bad-'))
    const valid = join(root, 'valid.json')
    const unknown = join(root, 'unknown.json')
    writeFileSync(valid, JSON.stringify({ DSH_HOME: '/tmp/profile-home' }))
    writeFileSync(unknown, JSON.stringify({ PATH: '/tmp/replaced' }))
    expect(() => applyDesktopE2EProfile({
      packaged: true, argv: ['electron', `--dsh-e2e-profile=${valid}`], environment: { DSH_DESKTOP_E2E: '1' },
    })).toThrow('source acceptance run')
    expect(() => applyDesktopE2EProfile({
      packaged: false, argv: ['electron', `--dsh-e2e-profile=${valid}`], environment: {},
    })).toThrow('source acceptance run')
    expect(() => applyDesktopE2EProfile({
      packaged: false, argv: ['electron', '--dsh-e2e-profile='], environment: { DSH_DESKTOP_E2E: '1' },
    })).toThrow('path must be non-empty')
    expect(() => applyDesktopE2EProfile({
      packaged: false, argv: ['electron', `--dsh-e2e-profile=${unknown}`], environment: { DSH_DESKTOP_E2E: '1' },
    })).toThrow('unknown field PATH')
    expect(applyDesktopE2EProfile({ packaged: false, argv: ['electron'], environment: {} })).toBeUndefined()
    const arrayProfile = join(root, 'array.json')
    const emptyField = join(root, 'empty.json')
    writeFileSync(arrayProfile, '[]')
    writeFileSync(emptyField, JSON.stringify({ DSH_HOME: '' }))
    expect(() => applyDesktopE2EProfile({
      packaged: false, argv: ['electron', `--dsh-e2e-profile=${arrayProfile}`], environment: { DSH_DESKTOP_E2E: '1' },
    })).toThrow('must be an object')
    expect(() => applyDesktopE2EProfile({
      packaged: false, argv: ['electron', `--dsh-e2e-profile=${emptyField}`], environment: { DSH_DESKTOP_E2E: '1' },
    })).toThrow('must be a non-empty string')
  })

  it('uses DIRECT only for an explicitly armed source acceptance run', async () => {
    const resolve = vi.fn(async () => 'PROXY system.example:8080')
    await expect(resolveDesktopNetworkProxy({
      packaged: false,
      environment: { DSH_DESKTOP_E2E: '1', DSH_DESKTOP_E2E_DIRECT_NETWORK: '1' },
      url: 'https://192.0.2.1',
      resolve,
    })).resolves.toBe('DIRECT')
    expect(resolve).not.toHaveBeenCalled()
    await expect(resolveDesktopNetworkProxy({
      packaged: true,
      environment: { DSH_DESKTOP_E2E: '1', DSH_DESKTOP_E2E_DIRECT_NETWORK: '1' },
      url: 'https://platform.example',
      resolve,
    })).resolves.toBe('PROXY system.example:8080')
    expect(resolve).toHaveBeenCalledWith('https://platform.example')
  })
})
