import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolPhone from '@deepseek-ai/dsh-tool-phone'
import { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const fakePhoneDevices = {
  name: 'fake-phone-devices',
  apply(ctx: Context): void {
    ctx.provide('phoneDevices', {
      async listDevices() {
        return {
          android: [{ id: deviceId('emulator-5554'), name: 'Pixel_6', kind: 'emulator', platform: 'android', state: 'online', online: true }],
          ios: { simulators: [], reals: [] },
        }
      },
      async boot() {},
      async shutdown() {},
    } as never)
  },
}

describe('tool-phone Loader composition', () => {
  it('loads through cordis.yml and keeps device schemas deferred until tool_search', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-phone-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      '  config:',
      '    toolSearch:',
      '      maxResultBytes: 65536',
      '      maxResults: 10',
      "- name: 'fake-phone-devices'",
      "- name: '@deepseek-ai/dsh-tool-phone'",
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['fake-phone-devices', fakePhoneDevices],
      ['@deepseek-ai/dsh-tool-phone', ToolPhone],
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

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
    const listed = await context.tools.execute({
      callId: CallId('loader-list'),
      name: 'device_list',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(listed).toMatchObject({ isError: false, value: { android: [{ id: 'emulator-5554' }] } })
  }, 15_000)
})
