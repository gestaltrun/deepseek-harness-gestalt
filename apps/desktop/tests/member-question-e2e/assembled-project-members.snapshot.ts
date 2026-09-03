import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runAssembledProjectMembersWalk } from './assembled-walk.ts'

const expected = fileURLToPath(new URL('./snapshots/assembled-project-members.expected.jsonl', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('assembled keyless Project Members transcript', () => {
  it('records invite, last-window presence, chunked cache, first-claim, later terminals, and wire floor', async () => {
    const transcript = await runAssembledProjectMembersWalk()
    if (refreshing) await writeFile(expected, transcript)
    expect(transcript).toBe(await readFile(expected, 'utf8'))
  }, 30_000)
})
