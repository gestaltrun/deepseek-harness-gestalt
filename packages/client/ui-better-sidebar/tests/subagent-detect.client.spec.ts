import { describe, expect, it } from 'vitest'
import type { SidebarSessionList, SidebarSessionSummary } from '../src/context-types.ts'
import {
  countSubagentDescendants,
  detectNewDirectSubagent,
  directSubagentCount,
} from '../src/client/subagent-detect.ts'

function summary(
  id: string,
  overrides: Partial<SidebarSessionSummary> = {},
): SidebarSessionSummary {
  return { id, displayTitle: id, running: false, blank: false, ...overrides }
}

function list(...summaries: SidebarSessionSummary[]): SidebarSessionList {
  return { current: 'parent', byId: Object.fromEntries(summaries.map(item => [item.id, item])) }
}

describe('Side Chat topology exclusion', () => {
  it('ignores a renderer-only Side Chat before its durable title exists', () => {
    const parent = summary('parent')
    const draft = summary('draft', {
      parentId: parent.id,
      origin: 'subagent',
      provisional: true,
    })
    const before = list(parent)
    const after = list(parent, draft)

    expect(directSubagentCount(after.byId, parent.id)).toBe(0)
    expect(detectNewDirectSubagent(before, after, parent.id)).toBe(false)
    expect(countSubagentDescendants(after.byId, parent.id)).toEqual({ count: 0, runningCount: 0 })
  })
})
