// @vitest-environment jsdom
/** First-run configure-models prompt over the shared Models join. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingDialogProps } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `onboarding-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `onboarding-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
})

function emptyNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
    value: {},
    base: {},
    user: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function harness(options: {
  usable?: boolean
  describeFailure?: string
  settingsWritable?: boolean
} = {}) {
  if (document.getElementById('root') === null) {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
  }
  const face = {
    llm: {
      providers: () => Promise.resolve(ok({
        providers: options.usable === true
          ? [{
            provider: 'openai',
            displayName: 'openai',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'openai'],
            active: true,
          }]
          : [],
      })),
    },
    settings: {
      describe: () => options.describeFailure === undefined
        ? Promise.resolve(ok({
          writable: options.settingsWritable ?? true,
          hasDocument: false,
          namespaces: [emptyNamespace()],
        }))
        : Promise.resolve(fail(options.describeFailure)),
      mutate: vi.fn(),
    },
    credentials: {
      describe: () => Promise.resolve(ok({
        credentials: {
          OPENAI_API_KEY: {
            configured: options.usable === true,
            writable: true,
          },
        },
      })),
      set: vi.fn(),
    },
  }
  const controller = new ModelsSettingsStore(face as never, settingsSchema, new SettingsDescribeMirror(face as never))
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: DeepSeekOnboardingDialogProps = {
    stepId: 'configure-models',
    complete,
    openSection,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useModels: bindSnapshotSelector(controller.store),
    t: key => en[key],
  }
  return { controller, complete, openSection, props }
}

describe('DeepSeekOnboardingDialog', () => {
  it('renders when the shell root is absent', async () => {
    const h = harness()
    document.getElementById('root')!.remove()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
  })

  it('loads a configure-models modal and inerts the product', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(document.getElementById('root')?.inert).toBe(true)
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('cannot be dismissed implicitly and restores the previous inert state', async () => {
    const h = harness()
    const appRoot = document.getElementById('root')!
    appRoot.inert = true
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()

    view.unmount()
    expect(appRoot.inert).toBe(true)
  })

  it('opens Settings Models and completes the step', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingOpen }))
    expect(h.openSection).toHaveBeenCalledOnce()
    expect(h.openSection).toHaveBeenCalledWith('models')
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('allows configure-later dismissal without opening settings', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
  })

  it('does not block the product when models setup is unavailable', async () => {
    for (const h of [
      harness({ describeFailure: 'settings down' }),
      harness({ settingsWritable: false }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      expect(h.openSection).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('skips an already-usable provider', async () => {
    const h = harness({ usable: true })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await act(async () => { await h.controller.load() })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
  })
})
