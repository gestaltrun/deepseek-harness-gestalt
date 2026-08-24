import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRelayConnectionToken,
  parseRelayDeliveryId,
  parseRelayInstanceId,
  type RelayDirectoryEntry,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayAttachmentId, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { createClient } from 'redis'
import { describe, expect, it } from 'vitest'
import { RedisRelayCoordinator } from '../src/index.ts'

// Real-redis integration requires a redis-server binary; CI jobs do not install one.
const redisServerAvailable = spawnSync('redis-server', ['--version'], { encoding: 'utf8' }).status === 0

describe.skipIf(!redisServerAvailable)('RedisRelayCoordinator with disposable Redis', () => {
  it('executes token-safe Lua, preserves TTL, and creates no offline queue value', async () => {
    const runtime = await startRedis()
    const command = createClient({ socket: { path: runtime.socketPath, tls: false } })
    const subscriber = command.duplicate()
    command.on('error', (error: unknown) => { runtime.observeClientError(errorFromUnknown(error)) })
    subscriber.on('error', (error: unknown) => { runtime.observeClientError(errorFromUnknown(error)) })
    try {
      await Promise.all([command.connect(), subscriber.connect()])
      const now = Date.now()
      const coordinator = new RedisRelayCoordinator({
        command,
        subscriber,
        keyPrefix: 'dsh:integration:relay',
        clock: { now: () => now },
      })
      const original = entry('connection-original', now + 5_000)
      const replacement = entry('connection-replacement', now + 8_000)
      const key = 'dsh:integration:relay:directory:route-integration:desktop-integration'
      const routeDirectoryKey = 'dsh:integration:relay:route-directory:route-integration'

      await coordinator.register(original)
      await coordinator.register(replacement)
      expect(await coordinator.refresh(original)).toBe(false)
      await coordinator.unregister(original)
      expect(await coordinator.locate(replacement.routeId, replacement.attachmentId)).toEqual(replacement)
      expect(await coordinator.refresh({ ...replacement, expiresAt: now + 9_000 })).toBe(true)

      expect(await command.type(key)).toBe('string')
      expect(await command.pTTL(key)).toBeGreaterThan(0)
      expect(await command.pTTL(key)).toBeLessThanOrEqual(9_000)
      const stored = await command.get(key)
      expect(stored).toContain('connection-replacement')
      expect(stored).not.toContain('prompt-secret')

      const published = await coordinator.publish(parseRelayInstanceId('platform-missing'), {
        type: 'delivered', deliveryId: parseRelayDeliveryId('delivery-missing'),
      })
      expect(published).toBe(false)
      const keys = (await command.keys('dsh:integration:relay:*')).sort()
      expect(keys).toEqual([key, routeDirectoryKey].sort())
      expect((await Promise.all(keys.map(async item => await command.type(item)))).sort()).toEqual(['set', 'string'])
      expect(await command.sMembers(routeDirectoryKey)).toEqual(['desktop-integration'])
      await coordinator.unregister(replacement)
      expect(await command.keys('dsh:integration:relay:*')).toEqual([])
    } finally {
      await Promise.allSettled([command.close(), subscriber.close()])
      await runtime.close()
    }
  })
})

function entry(connectionToken: string, expiresAt: number): RelayDirectoryEntry {
  return {
    routeId: parseRelayRouteId('route-integration'),
    attachmentId: parseRelayAttachmentId('desktop-integration'),
    endpoint: 'desktop',
    instanceId: parseRelayInstanceId('platform-integration'),
    connectionToken: parseRelayConnectionToken(connectionToken),
    revision: 1,
    expiresAt,
  }
}

async function startRedis(): Promise<{
  socketPath: string
  observeClientError(error: Error): void
  close(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-redis-'))
  const socketPath = join(directory, 'redis.sock')
  const process = spawn('redis-server', [
    '--port', '0',
    '--unixsocket', socketPath,
    '--save', '',
    '--appendonly', 'no',
    '--dir', directory,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  process.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  await waitForSocket(process, socketPath, () => stderr)
  const clientErrors: Error[] = []
  return {
    socketPath,
    observeClientError: (error) => { clientErrors.push(error) },
    close: async () => {
      await stopProcess(process)
      await rm(directory, { recursive: true, force: true })
      if (clientErrors.length > 0) throw new AggregateError(clientErrors, 'Disposable Redis clients emitted errors')
    },
  }
}

async function waitForSocket(process: ChildProcess, socketPath: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socketPath)) return
    if (process.exitCode !== null) throw new Error(`redis-server exited before readiness: ${stderr()}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  process.kill('SIGTERM')
  throw new Error('redis-server did not create its Unix socket')
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { process.once('exit', () => { resolve() }) })
  process.kill('SIGTERM')
  await exited
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}
