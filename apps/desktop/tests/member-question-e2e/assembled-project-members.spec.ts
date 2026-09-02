import { describe, expect, it } from 'vitest'
import { runAssembledProjectMembersWalk } from './assembled-walk.ts'

describe('assembled keyless Project Members acceptance', () => {
  it('walks real Account, membership, presence, encrypted ask, and offline failure listeners', { timeout: 30_000 }, async () => {
    const transcript = await runAssembledProjectMembersWalk()
    expect(transcript).toContain('"type":"invite"')
    expect(transcript).toContain('"type":"documents"')
    expect(transcript).toContain('"payloadChunks":2')
    expect(transcript).toContain('"type":"first-claim"')
    expect(transcript).toContain('"MEMBER_OFFLINE"')
    expect(transcript).toContain('"retained":"ciphertext-only"')
  })
})
