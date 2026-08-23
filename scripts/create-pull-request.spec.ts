import { describe, expect, it } from 'vitest'

import {
  planPullRequestCreation,
  pullRequestCreateArgs,
  type PullRequestCreationInput,
} from './create-pull-request.ts'

const input: PullRequestCreationInput = {
  repository: 'owner/repository',
  issueNumber: 256,
  kind: 'kind/feature',
  explicitAreas: ['area/infra'],
  plannerAreas: ['area/web', 'area/infra'],
  title: 'feat(ci): add trustworthy preflight',
  body: '## Summary\n\nAdd preflight.',
  base: 'codex/feature-ci-trustworthy-feedback',
}

describe('supported pull request creation', () => {
  it('adds one kind, every explicit and planner area, and a same-repository Issue reference', () => {
    expect(planPullRequestCreation(input)).toEqual({
      repository: 'owner/repository',
      issueNumber: 256,
      labels: ['kind/feature', 'area/infra', 'area/web'],
      title: input.title,
      body: `${input.body}\n\nRefs #256`,
      base: input.base,
    })
  })

  it('renders one gh invocation carrying the complete metadata', () => {
    expect(pullRequestCreateArgs(planPullRequestCreation(input))).toEqual([
      'pr', 'create',
      '--repo', 'owner/repository',
      '--draft',
      '--base', input.base,
      '--title', input.title,
      '--body', `${input.body}\n\nRefs #256`,
      '--label', 'kind/feature',
      '--label', 'area/infra',
      '--label', 'area/web',
    ])
  })

  it('rejects an unsupported kind, malformed area, and empty planner result', () => {
    expect(() => planPullRequestCreation({ ...input, kind: 'kind/unknown' })).toThrow('unsupported kind')
    expect(() => planPullRequestCreation({ ...input, explicitAreas: ['infra'] })).toThrow('area/*')
    expect(() => planPullRequestCreation({ ...input, explicitAreas: [], plannerAreas: [] })).toThrow('at least one area')
  })
})
