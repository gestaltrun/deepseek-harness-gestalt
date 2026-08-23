import { describe, expect, it } from 'vitest'
import { parseCompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'
import { DesktopCompanionInteractionRegistry } from '../src/companion-interactions.ts'

describe('Desktop Companion pending interactions', () => {
  it('projects stable pairing-private Approval and Ask User ids and removes resolved waits', () => {
    const registry = new DesktopCompanionInteractionRegistry()
    registry.accept({
      rpcId: 'host-approval-rpc',
      payload: {
        type: 'approval/requested', sessionId: 'session-interaction',
        approvalId: 'approval-1', toolName: 'bash', reason: 'needs permission',
      },
    })
    registry.accept({
      rpcId: 'host-question-rpc',
      payload: {
        type: 'question/requested', sessionId: 'session-interaction',
        questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    })
    const key = Uint8Array.from({ length: 32 }, (_, index) => index)
    const projected = registry.project(parseCompanionSessionId('session-interaction'), key)
    expect(projected).toHaveLength(2)
    expect(projected.map(item => item.interactionId)).not.toContain('host-approval-rpc')
    expect(registry.resolve(projected[0]!.interactionId, key)).toMatchObject({ rpcId: 'host-approval-rpc' })

    registry.accept({
      rpcId: 'resolved-frame',
      payload: {
        type: 'approval/resolved', sessionId: 'session-interaction',
        approvalId: 'approval-1', outcome: 'allowed-once',
      },
    })
    expect(registry.project(parseCompanionSessionId('session-interaction'), key)).toHaveLength(1)
  })
})
