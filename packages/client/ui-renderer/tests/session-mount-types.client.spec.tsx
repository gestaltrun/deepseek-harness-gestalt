import { describe, expectTypeOf, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiRendererService } from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'types.session': { kind: 'single'; scope: 'session'; owner: { label: string } }
    'types.maybe': { kind: 'single'; scope: 'session-maybe' }
    'types.root': { kind: 'single'; scope: 'root' }
  }
}

describe('explicit Session mount types', () => {
  it('accepts only Session-scoped keys with their derived owner props', () => {
    const mount = (() => () => {}) as UiRendererService['mountSession']
    const container = null as unknown as HTMLElement
    const sessionId = 'session' as SessionId

    expectTypeOf(mount(container, 'types.session', sessionId, { label: 'owner' })).toEqualTypeOf<() => void>()
    expectTypeOf(mount(container, 'types.maybe', sessionId, {})).toEqualTypeOf<() => void>()
    // @ts-expect-error root-scoped slots cannot use the explicit Session mount.
    mount(container, 'types.root', sessionId, {})
    // @ts-expect-error owner props derive from the selected SlotMap entry.
    mount(container, 'types.session', sessionId, {})
  })
})
