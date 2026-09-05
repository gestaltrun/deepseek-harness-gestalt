import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyDesktopE2EProfile,
  desktopWindowConstructorOptions,
  handleDesktopWindowActivate,
  planDesktopWindowReopen,
  resolveDesktopNetworkProxy,
} from '../src/e2e-profile.ts'

const roots: string[] = []

function removeExactRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeExactRoot(root)
  }
})

function profileFile(name: string, body: unknown): { readonly path: string; readonly dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  const path = join(root, 'profile.json')
  writeFileSync(path, JSON.stringify(body))
  return {
    path,
    dispose() {
      const index = roots.indexOf(root)
      if (index >= 0) roots.splice(index, 1)
      removeExactRoot(root)
    },
  }
}

function windowTarget(state: { destroyed?: boolean; minimized?: boolean }) {
  const restore = vi.fn()
  const focus = vi.fn()
  return {
    restore,
    focus,
    target: {
      isDestroyed: () => state.destroyed === true,
      isMinimized: () => state.minimized === true,
      restore,
      focus,
    },
  }
}

describe('Desktop E2E process profile', () => {
  it('applies only the explicit source lane allowlist and defaults to visible', () => {
    const profile = profileFile('dsh-desktop-e2e-profile-', {
      DSH_HOME: '/tmp/profile-home',
      DSH_MEMBER_QUESTION_ACCOUNT_ID: 'account-a',
      DSH_PROJECT_MEMBERS_WORKSPACE: '/tmp/profile-workspace',
    })
    try {
      const environment: NodeJS.ProcessEnv = { DSH_DESKTOP_E2E: '1' }
      const applied = applyDesktopE2EProfile({
        packaged: false,
        argv: ['electron', `--dsh-e2e-profile=${profile.path}`],
        environment,
      })
      expect(applied).toEqual({ path: profile.path, windowPresentation: 'visible' })
      expect(Object.isFrozen(applied)).toBe(true)
      expect(environment).toMatchObject({
        DSH_HOME: '/tmp/profile-home',
        DSH_MEMBER_QUESTION_ACCOUNT_ID: 'account-a',
        DSH_PROJECT_MEMBERS_WORKSPACE: '/tmp/profile-workspace',
      })
    } finally {
      profile.dispose()
    }
  })

  it('accepts armed source-only hidden presentation without putting it in the environment', () => {
    const profile = profileFile('dsh-desktop-e2e-profile-hidden-', {
      DSH_HOME: '/tmp/hidden-home',
      windowPresentation: 'hidden',
    })
    try {
      const environment: NodeJS.ProcessEnv = { DSH_DESKTOP_E2E: '1' }
      const applied = applyDesktopE2EProfile({
        packaged: false,
        argv: ['electron', `--dsh-e2e-profile=${profile.path}`],
        environment,
      })
      expect(applied).toEqual({ path: profile.path, windowPresentation: 'hidden' })
      expect(Object.isFrozen(applied)).toBe(true)
      expect(() => {
        Object.assign(applied as { windowPresentation: string }, { windowPresentation: 'visible' })
      }).toThrow()
      expect(applied?.windowPresentation).toBe('hidden')
      expect(environment.DSH_HOME).toBe('/tmp/hidden-home')
      expect(environment.windowPresentation).toBeUndefined()
    } finally {
      profile.dispose()
    }
  })

  it('rejects packaged, unarmed, empty, unknown, and invalid presentation profiles', () => {
    const valid = profileFile('dsh-desktop-e2e-profile-valid-', { DSH_HOME: '/tmp/profile-home' })
    const unknown = profileFile('dsh-desktop-e2e-profile-unknown-', { PATH: '/tmp/replaced' })
    const arrayProfile = profileFile('dsh-desktop-e2e-profile-array-', [])
    const emptyField = profileFile('dsh-desktop-e2e-profile-empty-', { DSH_HOME: '' })
    const badPresentation = profileFile('dsh-desktop-e2e-profile-presentation-', { windowPresentation: 'headless' })
    try {
      expect(() => applyDesktopE2EProfile({
        packaged: true, argv: ['electron', `--dsh-e2e-profile=${valid.path}`], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('source acceptance run')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${valid.path}`], environment: {},
      })).toThrow('source acceptance run')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${valid.path}`], environment: { CI: 'true' },
      })).toThrow('source acceptance run')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', '--dsh-e2e-profile='], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('path must be non-empty')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${unknown.path}`], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('unknown field PATH')
      expect(applyDesktopE2EProfile({ packaged: false, argv: ['electron'], environment: {} })).toBeUndefined()
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${arrayProfile.path}`], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('must be an object')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${emptyField.path}`], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('must be a non-empty string')
      expect(() => applyDesktopE2EProfile({
        packaged: false, argv: ['electron', `--dsh-e2e-profile=${badPresentation.path}`], environment: { DSH_DESKTOP_E2E: '1' },
      })).toThrow('windowPresentation must be visible or hidden')
    } finally {
      valid.dispose()
      unknown.dispose()
      arrayProfile.dispose()
      emptyField.dispose()
      badPresentation.dispose()
    }
  })

  it('does not mutate environment when a later profile field is invalid', () => {
    const profile = profileFile('dsh-desktop-e2e-profile-partial-', {
      DSH_HOME: '/tmp/must-not-apply',
      windowPresentation: 'offscreen',
    })
    try {
      const environment: NodeJS.ProcessEnv = { DSH_DESKTOP_E2E: '1' }
      expect(() => applyDesktopE2EProfile({
        packaged: false,
        argv: ['electron', `--dsh-e2e-profile=${profile.path}`],
        environment,
      })).toThrow('windowPresentation must be visible or hidden')
      expect(environment.DSH_HOME).toBeUndefined()
    } finally {
      profile.dispose()
    }
  })

  it('does not mutate an existing DSH_HOME when a later unknown field is rejected', () => {
    const profile = profileFile('dsh-desktop-e2e-profile-unknown-path-', {
      DSH_HOME: '/test-only-candidate',
      PATH: '/invalid',
    })
    try {
      const environment: NodeJS.ProcessEnv = {
        DSH_DESKTOP_E2E: '1',
        DSH_HOME: '/test-only-original',
      }
      const before = { ...environment }
      expect(() => applyDesktopE2EProfile({
        packaged: false,
        argv: ['electron', `--dsh-e2e-profile=${profile.path}`],
        environment,
      })).toThrow('unknown field PATH')
      expect(environment.DSH_HOME).toBe('/test-only-original')
      expect(environment).toEqual(before)
    } finally {
      profile.dispose()
    }
  })

  it('sets constructor show from presentation and fences activate restore/focus', () => {
    expect(desktopWindowConstructorOptions('visible')).toEqual({ show: true })
    expect(desktopWindowConstructorOptions('hidden')).toEqual({ show: false })
    expect(Object.isFrozen(desktopWindowConstructorOptions('hidden'))).toBe(true)

    const hidden = windowTarget({ minimized: true })
    expect(handleDesktopWindowActivate('hidden', hidden.target)).toBe('handled')
    expect(hidden.restore).not.toHaveBeenCalled()
    expect(hidden.focus).not.toHaveBeenCalled()

    const visibleMinimized = windowTarget({ minimized: true })
    expect(handleDesktopWindowActivate('visible', visibleMinimized.target)).toBe('handled')
    expect(visibleMinimized.restore).toHaveBeenCalledOnce()
    expect(visibleMinimized.focus).toHaveBeenCalledOnce()

    expect(handleDesktopWindowActivate('hidden', undefined)).toBe('missing')
    const destroyed = windowTarget({ destroyed: true })
    expect(handleDesktopWindowActivate('visible', destroyed.target)).toBe('missing')
    expect(destroyed.restore).not.toHaveBeenCalled()
    expect(destroyed.focus).not.toHaveBeenCalled()
    expect(planDesktopWindowReopen(false)).toBe('boot')
    expect(planDesktopWindowReopen(true)).toBe('recreate')
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
