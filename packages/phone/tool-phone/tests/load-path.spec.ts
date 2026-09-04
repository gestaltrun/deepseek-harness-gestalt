/**
 * Real Loader-path guard for an injected namespace plugin. A default export
 * would make `unwrapExports` collapse the namespace and drop `inject`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolPhone from '@deepseek-ai/dsh-tool-phone'
import { deviceId } from '@deepseek-ai/dsh-phone-runtime'

describe('dsh-tool-phone real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolPhone).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolPhone) as Record<string, unknown>
    expect(unwrapped).toBe(toolPhone)
    expect(unwrapped.name).toBe('tool-phone')
    expect(unwrapped.inject).toEqual(['phoneDevices', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.phoneDevices through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    ctx.provide('phoneDevices', {
      async listDevices() {
        return {
          android: [{ id: deviceId('emulator-5554'), name: 'Pixel', kind: 'emulator', online: true }],
          ios: { simulators: [], reals: [] },
        }
      },
      async boot() {},
      async shutdown() {},
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolPhone) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.catalogSchemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'device_list',
      'device_act',
    ]))
    await fiber.dispose()
  })
})
