import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import PhoneStream from '../src/index.ts'
import { stageFake, wireDevice } from '../../phone-runtime/tests/helpers.ts'

let root: string | undefined
let context: Context | undefined
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('phone stream Loader composition', () => {
  it('loads through cordis.yml over phoneDevices and webServer', async () => {
    const fake = await stageFake({
      devices: [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
    })
    fakes.push(fake)
    await fake.claim()
    root = await mkdtemp(join(tmpdir(), 'dsh-phone-stream-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-phone-runtime'",
      '  config:',
      `    executablePath: '${fake.executablePath}'`,
      `    serverPort: ${String(fake.port)}`,
      '    pollIntervalMs: 20',
      '    readyTimeoutMs: 6000',
      '    requestTimeoutMs: 1500',
      "- name: '@deepseek-ai/dsh-phone-stream'",
      '  config:',
      '    tokenTtlMs: 5000',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-phone-runtime', PhoneDevices],
      ['@deepseek-ai/dsh-phone-stream', PhoneStream],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    const session = context.phoneStream.sessionFor(deviceId('emulator-5554'))
    expect(session.ioPath).toBe('/phone/ws/io')
    expect(session.mjpeg.url).toContain('/phone/stream/emulator-5554/mjpeg')
    expect(session.h264.url).toContain('/phone/stream/emulator-5554/h264')
    await context.fiber.dispose()
    context = undefined
  }, 15_000)
})
