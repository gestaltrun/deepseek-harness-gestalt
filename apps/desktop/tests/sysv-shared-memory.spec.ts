import { describe, expect, it } from 'vitest'
import { newDetachedPostgresSegmentIds, parseDarwinSharedMemory } from '../scripts/sysv-shared-memory.mjs'

const IPCS_OUTPUT = `IPC status from <running system>
T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH  SEGSZ  CPID  LPID
Shared Memory:
m  65536 0x08f36b5c --rw------- user staff user staff 6 56 1000 1000
m 27983873 0x3f9d7568 --rw------- user staff user staff 0 56 28734 28734
m 3670018 0x3f9dc306 --rw------- other staff other staff 0 56 63074 63074
m 3407875 0x3f9e492b --rw------- user staff user staff 0 4096 95278 95278
`

describe('macOS System V shared-memory cleanup', () => {
  it('parses attachment, owner, and size facts', () => {
    expect(parseDarwinSharedMemory(IPCS_OUTPUT)).toEqual([
      { id: '65536', owner: 'user', attachments: 6, size: 56 },
      { id: '27983873', owner: 'user', attachments: 0, size: 56 },
      { id: '3670018', owner: 'other', attachments: 0, size: 56 },
      { id: '3407875', owner: 'user', attachments: 0, size: 4096 },
    ])
  })

  it('selects only new detached PostgreSQL marker segments owned by the run user', () => {
    const segments = parseDarwinSharedMemory(IPCS_OUTPUT)
    expect(newDetachedPostgresSegmentIds(new Set(['65536']), segments, 'user')).toEqual(['27983873'])
  })
})
