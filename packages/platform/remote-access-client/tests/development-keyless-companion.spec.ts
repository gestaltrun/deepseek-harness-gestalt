import { describe, expect, it } from 'vitest'
import { parseCompanionOperationId, parseCompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'
import {
  isDevelopmentKeylessSyncCiphertext,
  negotiateDevelopmentCompanionProtocol,
  openDevelopmentCompanionMessage,
  sealDevelopmentCompanionMessage,
} from '../src/development-keyless-companion.ts'

describe('development keyless Companion seal', () => {
  it('round-trips a create-session operation and rejects a truncated frame', async () => {
    const protocol = negotiateDevelopmentCompanionProtocol()
    const message = {
      type: 'operation',
      operation: {
        type: 'create-session',
        operationId: parseCompanionOperationId('operation-seal'),
        sessionId: parseCompanionSessionId('session-seal'),
        title: 'Ungrouped Session',
      },
    } as const
    const sealed = await sealDevelopmentCompanionMessage(protocol, message)
    expect(isDevelopmentKeylessSyncCiphertext(sealed)).toBe(false)
    expect(isDevelopmentKeylessSyncCiphertext(Uint8Array.of(1))).toBe(true)
    await expect(openDevelopmentCompanionMessage(protocol, sealed)).resolves.toEqual(message)
    await expect(openDevelopmentCompanionMessage(protocol, sealed.slice(0, 8))).rejects.toThrow('truncated')
    const offset = new Uint8Array(sealed.buffer, sealed.byteOffset, sealed.byteLength)
    await expect(openDevelopmentCompanionMessage(protocol, offset)).resolves.toEqual(message)
    await expect(openDevelopmentCompanionMessage(protocol, Buffer.from(sealed))).resolves.toEqual(message)
  })
})
