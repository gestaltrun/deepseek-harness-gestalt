import { describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import {
  ScenarioResourceOwner,
  validateBundledConfig,
  withResources,
  type Config,
} from '../start.ts'

const CONFIG: Config = {
  attachTimeoutMs: 1_000,
  maxPendingChallenges: 16,
  capacityRetryAfterMs: 100,
  deliveryAckTimeoutMs: 500,
  directoryTtlMs: 2_000,
  heartbeatIntervalMs: 50,
  heartbeatTimeoutMs: 1_000,
  inboundMaxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
  inboundMaxMessages: 16,
  maxBufferedCiphertextBytes: 131_070,
  maxConnections: 16,
  maxPendingDeliveries: 16,
  reconnectDelayMs: 10,
}

describe('two-instance Relay composition ownership', () => {
  it('rejects timing and queue relationships before composition acquisition', () => {
    const timeoutConfig = structuredClone(CONFIG)
    timeoutConfig.heartbeatIntervalMs = CONFIG.heartbeatTimeoutMs
    expect(() => { validateBundledConfig(timeoutConfig) })
      .toThrow('heartbeatIntervalMs')
    const inboundConfig = structuredClone(CONFIG)
    inboundConfig.inboundMaxBytes = REMOTE_PROTOCOL_LIMITS.relayMessageBytes - 1
    expect(() => { validateBundledConfig(inboundConfig) }).toThrow('inboundMaxBytes')
    expect(() => { validateBundledConfig(CONFIG) }).not.toThrow()
  })

  it('closes every staged owner in reverse order and aggregates cleanup failures', async () => {
    const calls: string[] = []
    const owner = new ScenarioResourceOwner()
    owner.add({ close: vi.fn(async () => { calls.push('first'); throw new Error('first cleanup failed') }) })
    owner.add({ close: vi.fn(async () => { calls.push('second'); throw new Error('second cleanup failed') }) })

    await expect(owner.close()).rejects.toSatisfy((error: unknown) => error instanceof AggregateError
      && error.errors.length === 2)
    expect(calls).toEqual(['second', 'first'])
  })

  it('retains a partial acquisition owner and reports both acquisition and cleanup failures', async () => {
    const close = vi.fn(async () => { throw new Error('partial cleanup failed') })

    await expect(withResources(async (owner) => {
      owner.add({ close })
      throw new Error('second backend acquisition failed')
    })).rejects.toSatisfy((error: unknown) => error instanceof AggregateError
      && error.errors[0] instanceof Error
      && error.errors[0].message === 'second backend acquisition failed'
      && error.errors[1] instanceof Error
      && error.errors[1].message === 'partial cleanup failed')
    expect(close).toHaveBeenCalledOnce()
  })
})
