import { Context } from '@deepseek-ai/cordis'
import { generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseInstallationId, selectPlatformEnvironment, validatePlatformEnvironmentPair } from '@deepseek-ai/dsh-platform-account'
import type { AccountSessionView, LoginPollResult } from '@deepseek-ai/dsh-platform-account'
import type { PlatformAccountTransport } from '@deepseek-ai/dsh-platform-account-client'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import {
  DesktopAccountController,
  EncryptedDesktopAccountStore,
  type DesktopAccountStore,
  type PersistedDesktopAccount,
} from '../src/platform-account.ts'
import { loadDesktopPlatformEnvironment } from '../src/platform-environment.ts'

const NOW = Date.parse('2026-08-17T10:00:00.000Z')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'desktop-development', credentialReference: 'credentials://development',
    databaseIdentity: 'database-development', identityNamespace: 'gestalt-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'desktop-production', credentialReference: 'credentials://production',
    databaseIdentity: 'database-production', identityNamespace: 'gestalt-production',
  },
}), 'development')

class MemoryDesktopStore implements DesktopAccountStore {
  record: PersistedDesktopAccount | undefined
  material = new Map<string, unknown>()

  async load(): Promise<PersistedDesktopAccount | undefined> {
    return this.record === undefined ? undefined : structuredClone(this.record)
  }

  async save(record: PersistedDesktopAccount): Promise<void> {
    this.record = structuredClone(record)
  }
}

function github(): GitHubIdentityProvider {
  return {
    environment: ENVIRONMENT,
    authorizationUrl(input) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', 'desktop-development')
      url.searchParams.set('redirect_uri', input.callbackUrl)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },
    async exchange() {
      return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
    },
  }
}

function platform() {
  return new PlatformAccount(new Context(), {
    backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
    invalidation: new MemoryAccountInvalidationBus(),
    github: github(),
    environment: ENVIRONMENT,
    clock: { now: () => NOW },
    config: {
      tokenSigningKey: Buffer.alloc(32, 7),
      pollingSigningKey: Buffer.alloc(32, 9),
    },
  })
}

describe('DesktopAccountController', () => {
  it('does not persist an empty first-run account record during start', async () => {
    const store = new MemoryDesktopStore()
    const save = vi.spyOn(store, 'save')
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport: platform(),
      store,
      systemBrowser: { open: vi.fn() },
      now: () => NOW,
    })

    await controller.start()

    expect(save).not.toHaveBeenCalled()
    expect(store.record).toBeUndefined()
    expect(controller.getSnapshot()).toEqual({ status: 'idle', privacyAccepted: false })
  })

  it('does not probe Keychain availability while composing Desktop Host Account', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/main.ts'), 'utf8')
    expect(source).not.toContain('isEncryptionAvailable')
  })

  it('contains a throwing subscriber and still notifies later subscribers', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport: platform(),
      store: new MemoryDesktopStore(),
      systemBrowser: { open: vi.fn() },
      now: () => NOW,
    })
    const later = vi.fn()
    controller.subscribe(() => { throw new Error('first Desktop subscriber failed') })
    controller.subscribe(later)

    await expect(controller.acceptPrivacy()).resolves.toMatchObject({ privacyAccepted: true })

    expect(later).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledWith(
      '[desktop-platform-account] subscriber failures:',
      expect.any(AggregateError),
    )
  })

  it('drains an in-flight poll during disposal without post-dispose mutation or callbacks', async () => {
    const poll = deferred<LoginPollResult>()
    const pollLogin = vi.fn(async () => poll.promise)
    const transport: PlatformAccountTransport = {
      environment: ENVIRONMENT,
      beginLogin: vi.fn(),
      pollLogin,
      refresh: vi.fn(),
      current: vi.fn(),
      signOut: vi.fn(),
    }
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString()
    const store = new MemoryDesktopStore()
    store.record = {
      installationId: parseInstallationId('dispose-poll'),
      pending: {
        id: 'dispose-attempt' as never,
        state: 'state',
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        pollingToken: 'polling-token',
        expiresAt: NOW + 300_000,
      },
      pendingPrivateKey: privateKey,
    }
    const scheduled: Array<() => void> = []
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport,
      store,
      systemBrowser: { open: vi.fn() },
      now: () => NOW,
      schedule: (task) => {
        scheduled.push(task)
        return { unref() {} } as never
      },
    })
    await controller.start()
    const listener = vi.fn()
    controller.subscribe(listener)
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(pollLogin).toHaveBeenCalledOnce() })

    let quiescent = false
    const disposal = controller.dispose().then(() => { quiescent = true })
    await Promise.resolve()
    expect(quiescent).toBe(false)
    poll.resolve({ status: 'complete', ...desktopSession() })
    await disposal

    expect(store.record?.session).toBeUndefined()
    expect(store.record?.pending?.id).toBe('dispose-attempt')
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the P-256 private key in Host storage and completes signed polling', async () => {
    const service = platform()
    const store = new MemoryDesktopStore()
    const scheduled: Array<() => void> = []
    let authorizationUrl = ''
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport: service,
      store,
      now: () => NOW,
      systemBrowser: { open: async (url) => { authorizationUrl = url } },
      schedule: (task) => {
        scheduled.push(task)
        return { unref() {}, [Symbol.dispose]() {} } as never
      },
    })
    await controller.start()
    await expect(controller.beginLogin()).rejects.toThrow('privacy notice must be accepted')
    await controller.acceptPrivacy()
    await controller.beginLogin()
    expect(new URL(authorizationUrl).searchParams.has('scope')).toBe(false)
    expect(store.record?.pendingPrivateKey).toContain('BEGIN PRIVATE KEY')

    const state = new URL(authorizationUrl).searchParams.get('state')
    if (state === null) throw new Error('missing state')
    await service.completeGitHubCallback({ code: 'github-code', state })
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('signed-in') })

    expect(controller.getSnapshot().account?.githubLogin).toBe('octocat')
    expect(store.record?.pendingPrivateKey).toBeUndefined()
    expect(store.record?.sessionPrivateKey).toContain('BEGIN PRIVATE KEY')
    const authorization = await controller.authorizeCurrentInstallation()
    await expect(service.currentInstallation(authorization)).resolves.toMatchObject({
      installation: { id: store.record?.installationId, kind: 'desktop' },
    })
  })

  it('revokes only the stored installation session and preserves account-scoped material', async () => {
    const service = platform()
    const store = new MemoryDesktopStore()
    const scheduled: Array<() => void> = []
    let authorizationUrl = ''
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport: service,
      store,
      now: () => NOW,
      systemBrowser: { open: async (url) => { authorizationUrl = url } },
      schedule: (task) => {
        scheduled.push(task)
        return { unref() {}, [Symbol.dispose]() {} } as never
      },
    })
    await controller.start()
    expect(store.record).toBeUndefined()
    await controller.acceptPrivacy()
    await controller.beginLogin()
    const installationId = store.record?.installationId
    const state = new URL(authorizationUrl).searchParams.get('state')
    if (state === null) throw new Error('missing state')
    await service.completeGitHubCallback({ code: 'github-code', state })
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('signed-in') })
    store.material.set('personal-pairing', 'preserved')

    await controller.signOut()

    expect(controller.getSnapshot().status).toBe('idle')
    expect(store.record?.installationId).toBe(installationId)
    expect(store.record?.session).toBeUndefined()
    expect(store.material.get('personal-pairing')).toBe('preserved')
  })
})

describe('Desktop Platform environment composition', () => {
  it('loads only the complete operated identity and rejects legacy environment selection', () => {
    const source = desktopEnvironmentSource()
    expect(loadDesktopPlatformEnvironment(source)).toMatchObject({
      environment: 'production',
      origin: 'https://platform.example.com',
      callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    })
    expect(() => loadDesktopPlatformEnvironment({ ...source, origin: undefined }))
      .toThrow('production origin is required')
    expect(() => loadDesktopPlatformEnvironment({ ...source, environment: undefined }))
      .toThrow('environment must be production')
    expect(() => loadDesktopPlatformEnvironment({
      ...source,
      origin: 'https://localhost',
    })).toThrow('must not use a local host')
    expect(() => loadDesktopPlatformEnvironment([])).toThrow('must be an object')
  })
})

describe('EncryptedDesktopAccountStore', () => {
  const protection = {
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Uint8Array) => Buffer.from(value).toString('utf8'),
  }

  it('atomically replaces a symlink without writing its referent and preserves owner-only mode', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'account.bin')
    const victim = join(directory, 'victim.txt')
    await writeFile(victim, 'untouched')
    await symlink(victim, path)
    const store = new EncryptedDesktopAccountStore(path, protection)

    await store.save({ installationId: parseInstallationId('desktop-atomic') })

    expect(await readFile(victim, 'utf8')).toBe('untouched')
    expect((await lstat(path)).isSymbolicLink()).toBe(false)
    // Windows synthesizes mode bits from DACLs; owner-only 0600 is a POSIX
    // semantic and only holds where the platform exposes POSIX modes.
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    await expect(store.load()).resolves.toEqual({ installationId: 'desktop-atomic' })
  })

  it('rejects malformed durable variants and non-canonical encrypted bytes', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'account.bin')
    const store = new EncryptedDesktopAccountStore(path, protection)
    await writeFile(path, 'not base64')
    await expect(store.load()).rejects.toThrow('canonical base64')

    const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString()
    const invalid = [
      { installationId: 'desktop', session: {}, sessionPrivateKey: privateKey },
      { installationId: 'desktop', pending: {}, pendingPrivateKey: privateKey },
      { installationId: 'desktop', session: { accessToken: 'partial' } },
    ]
    for (const value of invalid) {
      await writeFile(path, Buffer.from(JSON.stringify(value)).toString('base64'))
      await expect(store.load()).rejects.toThrow()
    }
  })

  it('cleans random temporary siblings after a failed commit and never exposes partial concurrent writes', async () => {
    const directory = await temporaryDirectory()
    const targetDirectory = join(directory, 'target')
    await mkdir(targetDirectory)
    const failing = new EncryptedDesktopAccountStore(targetDirectory, protection)
    await expect(failing.save({ installationId: parseInstallationId('failure') })).rejects.toThrow()
    expect((await readdir(directory)).filter(name => name.startsWith('target.') && name.endsWith('.tmp'))).toEqual([])

    const path = join(directory, 'account.bin')
    const store = new EncryptedDesktopAccountStore(path, protection)
    await Promise.all([
      store.save({ installationId: parseInstallationId('concurrent-a') }),
      store.save({ installationId: parseInstallationId('concurrent-b') }),
    ])
    expect(['concurrent-a', 'concurrent-b']).toContain((await store.load())?.installationId)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-account-'))
  temporaryDirectories.push(directory)
  return directory
}

function desktopSession(): AccountSessionView {
  return {
    sessionId: 'desktop-session' as never,
    account: {
      id: 'desktop-account' as never,
      githubId: 13994321,
      githubLogin: 'octocat',
      avatarUrl: 'https://avatars.example/octocat',
    },
    accessToken: 'access',
    refreshToken: 'refresh',
    accessExpiresAt: NOW + 900_000,
    refreshExpiresAt: NOW + 2_592_000_000,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function desktopEnvironmentSource(): Record<string, string> {
  return {
    environment: 'production',
    origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'desktop-production',
    credentialReference: 'credentials://production',
    databaseIdentity: 'database-production',
    identityNamespace: 'gestalt-production',
  }
}
