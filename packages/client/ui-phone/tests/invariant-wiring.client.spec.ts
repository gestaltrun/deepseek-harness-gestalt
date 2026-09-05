/**
 * The invariant's browser-free registration inputs: its probe chrome stays
 * inert, its gate stays disabled, and attempting to create a real controller
 * fails loud because the symmetry round-trip never renders a device body.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  PHONE_TAB_TITLE, type PhoneTabDescriptor, type PhoneTabEnvironment, type PhoneTabOptions,
} from '../src/client/registry.ts'
import * as PhoneInvariant from '../src/invariant.ts'

const probe = vi.hoisted(() => ({ options: undefined as PhoneTabOptions | undefined }))

vi.mock('../src/client/registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/registry.ts')>()
  return {
    ...actual,
    installPhoneTab: (ctx: Context, options: PhoneTabOptions): void => {
      probe.options = options
      const sidebar = ctx.get('betterSidebar') as {
        registerTab(descriptor: PhoneTabDescriptor): () => void
      }
      ctx.effect(() => sidebar.registerTab(actual.buildPhoneTabDescriptor({
        ...options,
        switchDevice: () => {},
        showPicker: () => {},
      })), 'ui-phone invariant wiring probe')
    },
  }
})

describe('ui-phone invariant wiring', () => {
  it('uses inert chrome and refuses controller creation during the symmetry probe', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PhoneInvariant)
    await fiber.await()
    const options = probe.options
    if (options === undefined) throw new Error('the invariant did not install its phone tab probe')

    const environment: PhoneTabEnvironment = {
      isEnabled: options.isEnabled,
      gate: options.gate,
      source: options.source,
      switchDevice: () => {},
      showPicker: () => {},
      createController: options.createController,
    }
    expect(options.view.icon(16)).toBeNull()
    expect(options.view.component({ tab: { id: 'phone' }, visible: false }, environment)).toBeNull()
    expect(options.title()).toBe(PHONE_TAB_TITLE)
    expect(options.isEnabled()).toBe(false)
    expect(options.gate.snapshot()).toBe(false)
    const stopGate = options.gate.subscribe(() => {})
    expect(stopGate).toBeTypeOf('function')
    stopGate()
    expect(() => options.createController('emulator-5554')).toThrow('never renders a tab body')
    await fiber.dispose()
  })
})
