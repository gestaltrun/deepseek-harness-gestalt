import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneEnvironment, { PHONE_ENVIRONMENT_PATH, PhoneEnvironmentError } from '../src/index.ts'

class TestPhoneEnvironment extends PhoneEnvironment {
  protected override async probeRuntimeVersion(executablePath: string): Promise<string> {
    try {
      await access(executablePath)
      return '1.0.5'
    } catch (error) {
      throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_VERSION', 'mobilecli version probe failed', { cause: error })
    }
  }
}

const contexts: Context[] = []
const roots: string[] = []

async function rawGet(url: string, host: string): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = request(url, { headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolveResponse({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
      })
    })
    req.on('error', rejectResponse)
    req.end()
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function executable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-service-'))
  roots.push(root)
  const path = join(root, 'mobilecli')
  await writeFile(path, '#!/bin/sh\necho "mobilecli version 1.0.5"\n')
  await chmod(path, 0o700)
  return path
}

async function mountEnvironment(context: Context, phoneDevices: object = {}, config: { root?: string; executablePath?: string } = {}) {
  const fleet = {
    isReady: () => false,
    onReadinessChanged: () => () => {},
    activateExecutable: async () => {},
    deactivate: async () => {},
    ...phoneDevices,
  }
  context.provide('phoneDevices', fleet as never)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const fiber = context.plugin(TestPhoneEnvironment, config)
  await fiber.await()
  const service = context.get('phoneEnvironment')
  if (service === undefined) throw new Error('phoneEnvironment did not activate')
  return {
    fiber,
    service,
    origin: `http://127.0.0.1:${String(context.webServer.port)}`,
  }
}

describe('PhoneEnvironment', () => {
  it('updates the durable enable gate without remounting the Service', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const seen = vi.fn()
    const unsubscribe = service.onChanged(seen)
    const before = service.snapshot().revision
    await service.setEnabled(true)
    const afterEnable = service.snapshot().revision
    await service.setEnabled(true)
    expect(service.snapshot().enabled).toBe(true)
    expect(afterEnable).toBeGreaterThan(before)
    expect(service.snapshot().revision).toBe(afterEnable)
    expect(seen).toHaveBeenCalled()
    const calls = seen.mock.calls.length
    unsubscribe()
    await service.setEnabled(false)
    expect(seen).toHaveBeenCalledTimes(calls)
  })

  it('serializes disable and re-enable around one activating generation', async () => {
    const context = new Context()
    contexts.push(context)
    let releaseActivation: (() => void) | undefined
    const calls: string[] = []
    const activation = new Promise<void>((resolve) => { releaseActivation = resolve })
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => { calls.push('activate'); await activation },
      deactivate: async () => { calls.push('deactivate') },
    })
    const first = service.setEnabled(true)
    await vi.waitFor(() => { expect(calls).toContain('activate') })
    const off = service.setEnabled(false)
    const on = service.setEnabled(true)
    releaseActivation?.()
    await Promise.all([first, off, on])
    expect(calls).toEqual(['activate', 'deactivate', 'activate'])
    expect(service.snapshot().enabled).toBe(true)
  })

  it('actively aborts a non-prepare activation when disabled', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const deactivate = vi.fn(async () => {})
    const { service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
      deactivate,
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    const beganDisable = Date.now()
    const disabling = service.setEnabled(false)
    await expect(enabling).rejects.toBeTruthy()
    await disabling
    expect(Date.now() - beganDisable).toBeLessThan(500)
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().enabled).toBe(false)
  })

  it('lets the cancel operation interrupt a non-prepare activation', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const { service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    service.cancel()
    await expect(enabling).rejects.toBeTruthy()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed' })
  })

  it('aborts and drains activation before teardown returns', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const { fiber, service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    const beganTeardown = Date.now()
    const teardown = fiber.dispose()
    await expect(enabling).rejects.toBeTruthy()
    await teardown
    expect(Date.now() - beganTeardown).toBeLessThan(500)
  })

  it('keeps an explicit executable override authoritative over managed preparation', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, { executablePath: '/operator/mobilecli' })
    await expect(service.prepare()).rejects.toEqual(expect.objectContaining<Partial<PhoneEnvironmentError>>({
      code: 'PHONE_ENVIRONMENT_OVERRIDE',
    }))
  })

  it('rejects a concurrent preparation instead of replacing its cancellation owner', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const first = service.prepare()
    await expect(service.prepare()).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_BUSY' })
    service.cancel()
    await first.catch(() => {})
  })

  it('revokes the active generation when later detection fails', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const deactivate = vi.fn(async () => {})
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      deactivate,
    }, { executablePath: path })
    await service.setEnabled(true)
    await rm(path)
    await service.refresh()
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed', code: 'PHONE_ENVIRONMENT_VERSION' })
  })

  it('projects an unexpected runtime readiness loss into the environment snapshot', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let readiness: ((ready: boolean) => void) | undefined
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      onReadinessChanged: (listener: (ready: boolean) => void) => {
        readiness = listener
        return () => { readiness = undefined }
      },
    }, { executablePath: path })
    await service.setEnabled(true)
    expect(service.snapshot().runtime.kind).toBe('ready')
    readiness?.(false)
    expect(service.snapshot().runtime).toMatchObject({
      kind: 'failed', code: 'PHONE_ENVIRONMENT_RUNTIME_LOST',
    })
  })

  it('recovers an existing managed current after the Service is rebuilt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-restart-'))
    roots.push(root)
    const executableName = process.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli'
    const versionDir = join(root, 'versions', 'persisted')
    await mkdir(versionDir, { recursive: true })
    const managedExecutable = join(versionDir, executableName)
    await writeFile(managedExecutable, '#!/bin/sh\necho "mobilecli version 1.0.5"\n')
    await chmod(managedExecutable, 0o700)
    await writeFile(join(root, 'current.json'), `${JSON.stringify({
      version: '1.0.5', platform: process.platform, architecture: process.arch,
      executable: `versions/persisted/${executableName}`,
    })}\n`)

    const firstContext = new Context()
    contexts.push(firstContext)
    const first = await mountEnvironment(firstContext, {}, { root })
    expect(first.service.snapshot().runtime).toEqual({ kind: 'ready', source: 'managed', version: '1.0.5' })
    await first.fiber.dispose()

    const restartedContext = new Context()
    contexts.push(restartedContext)
    const restarted = await mountEnvironment(restartedContext, {}, { root })
    expect(restarted.service.snapshot().runtime).toEqual({ kind: 'ready', source: 'managed', version: '1.0.5' })
  })

  it('removes subscribers when its owning fiber disposes', async () => {
    const context = new Context()
    contexts.push(context)
    const { fiber, service } = await mountEnvironment(context)
    const listener = vi.fn()
    service.onChanged(listener)
    await fiber.dispose()
    await service.setEnabled(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('serves full snapshots only through the shared Host trust fence', async () => {
    const context = new Context()
    contexts.push(context)
    const { origin } = await mountEnvironment(context)
    const accepted = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}`)
    expect(accepted.status).toBe(200)
    const body = await accepted.json() as {
      enabled: boolean
      runtime: { kind: string; targetVersion?: string; version?: string }
      platforms: { android: { kind: string } }
    }
    expect(body).toMatchObject({
      enabled: false,
      platforms: { android: { kind: 'deferred' } },
    })
    expect(body.runtime.kind).toMatch(/missing|ready/)
    expect(body.runtime.targetVersion ?? body.runtime.version).toBe('1.0.5')
    const refused = await rawGet(`${origin}${PHONE_ENVIRONMENT_PATH}`, 'attacker.example')
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({
      error: { code: 'forbidden', message: 'phone environment request is not trusted' },
    })
    expect((await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/unknown`, { method: 'POST' })).status).toBe(404)
  })
})
