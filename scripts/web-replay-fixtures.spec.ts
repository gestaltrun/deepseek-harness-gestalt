import { describe, expect, it } from 'vitest'
import { assertReplayFixture } from '@deepseek-ai/dsh-llm-replay'
import {
  sideChatRoundReplayConfig,
  sideChatRoundReplayExpectation,
} from '../apps/web/tests/sidechat-round.fixture.ts'

describe('Web replay fixtures', () => {
  it('keeps the Side Chat call inventory and browser-visible replies canonical', () => {
    expect(() => {
      assertReplayFixture(sideChatRoundReplayConfig, sideChatRoundReplayExpectation)
    }).not.toThrow()
  })
})
