import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stageFake, wireDevice } from './helpers.ts'

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

describe('phone runtime Loader composition', () => {
  it('loads through cordis.yml and answers the unified listing over ctx.phoneDevices', async () => {
    const fake = await stageFake({
      devices: [
        wireDevice('emulator-5554', 'android', 'emulator', 'online'),
        wireDevice('SIM-UDID', 'ios', 'simulator', 'offline'),
      ],
    })
    fakes.push(fake)
    fake.claim()
    root = await mkdtemp(join(tmpdir(), 'dsh-phone-loader-'))
    const configPath = join(root, 'cordis.yml')
    const composedConfig: Partial<Config> = {
      pollIntervalMs: 20,
      readyTimeoutMs: 6_000,
      requestTimeoutMs: 1_500,
    }
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-phone-runtime'",
      '  config:',
      `    executablePath: '${fake.executablePath}'`,
      `    serverPort: ${String(fake.port)}`,
      `    pollIntervalMs: ${String(composedConfig.pollIntervalMs)}`,
      `    readyTimeoutMs: ${String(composedConfig.readyTimeoutMs)}`,
      `    requestTimeoutMs: ${String(composedConfig.requestTimeoutMs)}`,
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-phone-runtime', PhoneDevices],
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

    const list = await context.phoneDevices.listDevices()
    expect(list.android.map(device => device.id)).toEqual(['emulator-5554'])
    expect(list.ios.simulators.map(device => device.online)).toEqual([false])
    expect(list.ios.reals).toEqual([])

    // The Consumer-free Service still enforces the upstream lifecycle rule.
    await expect(context.phoneDevices.shutdown(deviceId('SIM-UDID'))).resolves.toBeUndefined()
    await context.fiber.dispose()
    context = undefined
  }, 15_000)
})
