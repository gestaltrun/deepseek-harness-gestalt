import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneEnvironment, { PHONE_ENVIRONMENT_PATH, PhoneEnvironmentError } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

async function rawGet(url: string, host: string): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = request(url, { headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
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
  const fiber = context.plugin(PhoneEnvironment, config)
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
