import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  countVisibleUnits,
  nextResolvingIssueStatus,
  parseReferences,
  repositoryCoordinates,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  requiresPullRequestPolicy,
  validateBody,
  validateIssue,
  validatePullRequest,
  validatePullRequestMetadata,
} from './policy.mjs'

const execFileAsync = promisify(execFile)
const policyEntrypoint = join(import.meta.dirname, 'policy.mjs')
const policyConfig = join(import.meta.dirname, 'config.json')

const runResourceCleanups = async (cleanups) => {
  const results = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  )
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (errors.length > 0) throw new AggregateError(errors, 'fake API resource cleanup failed')
}

const registerResourceCleanups = (t) => {
  const cleanups = []
  t.after(() => runResourceCleanups(cleanups))
  return (cleanup) => cleanups.push(cleanup)
}

const withDetails = (summary) =>
  `${summary}\n\n<details><summary>验收与细节</summary>待补充。</details>`

const preparePullRequestCli = async (
  t,
  {
    priorityField,
    pullRequestReadAuthentication = 'token',
    pullRequestPolicyActivation = 'non-draft',
    issueFieldStatus = 200,
    issueStatus = 200,
    pullStatus = 200,
    pullDraft = false,
    pullAuthorType = 'User',
    pullLabels = ['kind/bug-fix', 'area/infra'],
    reviewEndpointStatus = 200,
    requiredAreas = [],
    token = 'test-token',
  },
) => {
  const registerCleanup = registerResourceCleanups(t)
  const requests = []
  const requestDetails = []
  const server = createServer(async (request, response) => {
    requests.push(request.url)
    requestDetails.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization ?? null,
    })
    const send = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.url?.endsWith('/pulls/49')) {
      send({
        body: 'Fixes #49',
        draft: pullDraft,
        labels: pullLabels.map((name) => ({ name })),
        user: { type: pullAuthorType },
      }, pullStatus)
      return
    }
    if (request.url?.endsWith('/pulls/49/requested_reviewers')) {
      send(
        reviewEndpointStatus === 200
          ? { users: [{ login: 'reviewer' }], teams: [] }
          : { message: 'Not Found' },
        reviewEndpointStatus,
      )
      return
    }
    if (request.url?.endsWith('/pulls/49/reviews?per_page=100')) {
      send(reviewEndpointStatus === 200 ? [] : { message: 'Not Found' }, reviewEndpointStatus)
      return
    }
    if (request.url?.endsWith('/issues/49')) {
      send(
        issueStatus === 200
          ? {
              node_id: 'issue-id',
              title: '为个人 tracker 显式关闭 Issue Priority 字段查询',
              body: withDetails('修复个人 tracker 的 Priority 查询。'),
              assignees: [],
              labels: [],
              type: null,
              state: 'open',
              state_reason: null,
            }
          : { message: 'Not Found' },
        issueStatus,
      )
      return
    }
    if (request.url?.endsWith('/issues/49/issue-field-values?per_page=100')) {
      send(issueFieldStatus === 200 ? [] : { message: 'Not Found' }, issueFieldStatus)
      return
    }
    send({ message: 'Not Found' }, 404)
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  registerCleanup(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  const directory = await mkdtemp(join(tmpdir(), 'dsh-issue-priority-policy-'))
  registerCleanup(() => rm(directory, { recursive: true, force: true }))
  const entrypoint = join(await realpath(directory), 'policy.mjs')
  const eventPath = join(directory, 'pull-request.json')
  const config = JSON.parse(await readFile(policyConfig, 'utf8'))
  await copyFile(policyEntrypoint, entrypoint)
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      ...config,
      priorityField,
      pullRequestReadAuthentication,
      pullRequestPolicyActivation,
    }),
  )
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 49 } }))

  return {
    requests,
    requestDetails,
    run: (command = 'pr') =>
      execFileAsync(process.execPath, [entrypoint, command], {
        env: {
          ...(token === null ? {} : { GH_TOKEN: token }),
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: 'BeiKeJieDeLiuLangMao/deepseek-harness-gestalt',
          DSH_REQUIRED_PR_AREAS: JSON.stringify(requiredAreas),
        },
      }),
  }
}

const legalIssue = {
  title: '完成议题管理校验',
  body: withDetails('完成议题管理校验。'),
  assignees: [],
  labels: [],
  type: 'Idea',
  priority: null,
  status: 'In review',
  state: 'open',
  stateReason: null,
}

const canonicalKinds = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

// Keep an independent oracle rather than importing the implementation's reserved set.
const legacyLabels = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

test('routes policy requests to the repository from the workflow event', () => {
  assert.deepEqual(
    repositoryCoordinates({ GITHUB_REPOSITORY: 'BeiKeJieDeLiuLangMao/deepseek-harness-gestalt' }),
    {
      owner: 'BeiKeJieDeLiuLangMao',
      name: 'deepseek-harness-gestalt',
      fullName: 'BeiKeJieDeLiuLangMao/deepseek-harness-gestalt',
    },
  )
  assert.throws(
    () => repositoryCoordinates({ GITHUB_REPOSITORY: 'deepseek-harness-gestalt' }),
    /GITHUB_REPOSITORY 必须为 owner\/name/,
  )
})

test('skips Issue field requests when Priority integration is disabled', async (t) => {
  const fixture = await preparePullRequestCli(t, { priorityField: null })

  const result = await fixture.run()

  assert.match(result.stdout, /Issue policy 通过。/)
  assert.ok(
    !fixture.requests.includes(
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49/issue-field-values?per_page=100',
    ),
  )
})

test('non-draft activation skips unavailable review endpoints and uses the workflow token', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullRequestPolicyActivation: 'non-draft',
    reviewEndpointStatus: 404,
  })

  const result = await fixture.run()

  assert.match(result.stdout, /Issue policy 通过。/)
  assert.deepEqual(
    fixture.requestDetails.map(({ path }) => path),
    [
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49',
    ],
  )
  for (const request of fixture.requestDetails) {
    assert.equal(request.method, 'GET')
    assert.equal(request.authorization, 'Bearer test-token')
  }
})

test('Draft, Bot, and App pull requests stop after the initial PR read', async (t) => {
  const exemptions = [
    { name: 'Draft', pullDraft: true, pullAuthorType: 'User' },
    { name: 'Bot', pullDraft: false, pullAuthorType: 'Bot' },
    { name: 'App', pullDraft: false, pullAuthorType: 'App' },
  ]
  for (const pullRequestPolicyActivation of ['non-draft', 'review-activity']) {
    for (const exemption of exemptions) {
      await t.test(`${pullRequestPolicyActivation}: ${exemption.name}`, async (t) => {
        const fixture = await preparePullRequestCli(t, {
          priorityField: 'Priority',
          pullRequestPolicyActivation,
          pullDraft: exemption.pullDraft,
          pullAuthorType: exemption.pullAuthorType,
          reviewEndpointStatus: 404,
          issueStatus: 404,
        })

        const result = await fixture.run()

        assert.match(result.stdout, /PR 尚未进入 Issue policy 强制范围。/)
        assert.deepEqual(
          fixture.requestDetails.map(({ path }) => path),
          ['/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49'],
        )
      })
    }
  }
})

test('preflight validates Draft PR metadata and resolves its same-repository Issue', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullDraft: true,
  })

  const result = await fixture.run('pr-metadata')

  assert.match(result.stdout, /PR metadata 通过。/)
  assert.deepEqual(
    fixture.requestDetails.map(({ path }) => path),
    [
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49',
    ],
  )
})

test('preflight rejects malformed Draft PR labels', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullDraft: true,
    pullLabels: [],
  })

  await assert.rejects(fixture.run('pr-metadata'), (error) => {
    assert.match(error.stdout, /PR 必须恰好有一个允许的 kind\/\*/)
    assert.match(error.stdout, /PR 必须至少有一个 area\/\*/)
    return true
  })
})

test('preflight rejects a Draft PR missing a planner-selected area', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullDraft: true,
    requiredAreas: ['area/infra', 'area/web'],
  })

  await assert.rejects(fixture.run('pr-metadata'), (error) => {
    assert.match(error.stdout, /PR 缺少相关 area\/\*：area\/web/)
    return true
  })
})

test('eligible non-draft pull requests keep downstream API failures fatal', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullRequestPolicyActivation: 'non-draft',
    issueStatus: 404,
  })

  await assert.rejects(fixture.run(), (error) => {
    assert.match(
      error.stderr,
      /GET \/repos\/BeiKeJieDeLiuLangMao\/deepseek-harness-gestalt\/issues\/49: 404/,
    )
    return true
  })
})

test('uses anonymous authentication for every PR policy read', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: 'Priority',
    pullRequestReadAuthentication: 'anonymous',
    pullRequestPolicyActivation: 'review-activity',
  })

  const result = await fixture.run()

  assert.match(result.stdout, /Issue policy 通过。/)
  assert.equal(fixture.requestDetails.length, 5)
  for (const request of fixture.requestDetails) {
    assert.equal(request.method, 'GET')
    assert.equal(request.authorization, null)
  }
})

test('review-activity activation reads review activity with bearer authentication', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: 'Priority',
    pullRequestReadAuthentication: 'token',
    pullRequestPolicyActivation: 'review-activity',
  })

  const result = await fixture.run()

  assert.match(result.stdout, /Issue policy 通过。/)
  assert.deepEqual(
    fixture.requestDetails.map(({ path }) => path),
    [
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49/requested_reviewers',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/49/reviews?per_page=100',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49',
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49/issue-field-values?per_page=100',
    ],
  )
  for (const request of fixture.requestDetails) {
    assert.equal(request.method, 'GET')
    assert.equal(request.authorization, 'Bearer test-token')
  }
})

test('rejects a missing token before token-mode PR policy API access', async (t) => {
  for (const pullRequestPolicyActivation of ['non-draft', 'review-activity']) {
    const fixture = await preparePullRequestCli(t, {
      priorityField: null,
      pullRequestReadAuthentication: 'token',
      pullRequestPolicyActivation,
      token: null,
    })

    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.stderr, /GH_TOKEN 或 GITHUB_TOKEN 未设置/)
      return true
    })
    assert.deepEqual(fixture.requests, [])
  }
})

test('rejects invalid PR-read authentication modes before API access', async (t) => {
  for (const pullRequestReadAuthentication of ['oauth', '   ']) {
    const fixture = await preparePullRequestCli(t, {
      priorityField: null,
      pullRequestReadAuthentication,
    })

    await assert.rejects(fixture.run(), (error) => {
      assert.match(
        error.stderr,
        /config\.pullRequestReadAuthentication 必须为 anonymous 或 token/,
      )
      return true
    })
    assert.deepEqual(fixture.requests, [])
  }
})

test('rejects invalid PR policy activation modes before API access', async (t) => {
  for (const pullRequestPolicyActivation of ['opened', '   ']) {
    const fixture = await preparePullRequestCli(t, {
      priorityField: null,
      pullRequestPolicyActivation,
    })

    await assert.rejects(fixture.run(), (error) => {
      assert.match(
        error.stderr,
        /config\.pullRequestPolicyActivation 必须为 non-draft 或 review-activity/,
      )
      return true
    })
    assert.deepEqual(fixture.requests, [])
  }
})

test('review-activity API failures remain fatal', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: null,
    pullRequestPolicyActivation: 'review-activity',
    reviewEndpointStatus: 404,
  })

  await assert.rejects(fixture.run(), (error) => {
    assert.match(
      error.stderr,
      /GET \/repos\/BeiKeJieDeLiuLangMao\/deepseek-harness-gestalt\/pulls\/49\/(?:requested_reviewers|reviews\?per_page=100): 404/,
    )
    return true
  })
  assert.ok(
    fixture.requests.some(
      (path) => path?.endsWith('/requested_reviewers') || path?.endsWith('/reviews?per_page=100'),
    ),
  )
})

test('fails loud on PR API 404 without authentication fallback', async (t) => {
  for (const pullRequestReadAuthentication of ['anonymous', 'token']) {
    const fixture = await preparePullRequestCli(t, {
      priorityField: null,
      pullRequestReadAuthentication,
      pullStatus: 404,
    })

    await assert.rejects(fixture.run(), (error) => {
      assert.match(
        error.stderr,
        /GET \/repos\/BeiKeJieDeLiuLangMao\/deepseek-harness-gestalt\/pulls\/49: 404/,
      )
      return true
    })
    assert.equal(
      fixture.requests.filter((path) => path?.endsWith('/pulls/49')).length,
      1,
    )
  }
})

test('fails loud when enabled Priority integration cannot read Issue fields', async (t) => {
  const fixture = await preparePullRequestCli(t, {
    priorityField: 'Priority',
    issueFieldStatus: 404,
  })

  await assert.rejects(fixture.run(), (error) => {
    assert.match(
      error.stderr,
      /GET \/repos\/BeiKeJieDeLiuLangMao\/deepseek-harness-gestalt\/issues\/49\/issue-field-values\?per_page=100: 404/,
    )
    return true
  })
  assert.ok(
    fixture.requests.includes(
      '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/49/issue-field-values?per_page=100',
    ),
  )
})

test('rejects a malformed Priority integration setting before API access', async (t) => {
  const fixture = await preparePullRequestCli(t, { priorityField: false })

  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.stderr, /config\.priorityField 必须为非空字符串或 null/)
    return true
  })
  assert.deepEqual(fixture.requests, [])
})

test('rejects whitespace-only Priority configuration before API access', async (t) => {
  const fixture = await preparePullRequestCli(t, { priorityField: '   ' })

  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.stderr, /config\.priorityField 必须为非空字符串或 null/)
    return true
  })
  assert.deepEqual(fixture.requests, [])
})

test('attempts every fake API resource cleanup when one disposer fails', async () => {
  const disposed = []

  await assert.rejects(
    runResourceCleanups([
      async () => {
        disposed.push('server')
        throw new Error('server close failed')
      },
      async () => {
        disposed.push('directory')
      },
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors.map((entry) => entry.message), ['server close failed'])
      return true
    },
  )
  assert.deepEqual(disposed.sort(), ['directory', 'server'])
})

test('routes CLI policy and keeps lifecycle requests token-authenticated', async (t) => {
  const registerCleanup = registerResourceCleanups(t)
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: request.method,
      path: request.url,
      body,
      authorization: request.headers.authorization ?? null,
    })

    const send = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.url === '/graphql') {
      send({
        data: {
          organization: {
            projectV2: {
              id: 'project-id',
              title: 'DSH Issue Management',
              fields: {
                nodes: [
                  {
                    id: 'status-field-id',
                    name: 'Status',
                    options: [
                      { id: 'inbox-id', name: 'Inbox' },
                      { id: 'in-progress-id', name: 'In progress' },
                    ],
                  },
                ],
              },
            },
          },
          repository: {
            issue: {
              id: 'issue-id',
              timelineItems: { nodes: [] },
              projectItems: {
                nodes: [
                  {
                    id: 'item-id',
                    project: { id: 'project-id' },
                    fieldValueByName: { name: 'In progress', optionId: 'in-progress-id' },
                  },
                ],
              },
            },
          },
        },
      })
      return
    }
    if (request.url?.endsWith('/pulls/48')) {
      send({
        body: 'Related to #47',
        draft: false,
        labels: [],
        user: { type: 'Bot' },
      })
      return
    }
    if (request.url?.endsWith('/pulls/48/requested_reviewers')) {
      send({ users: [], teams: [] })
      return
    }
    if (request.url?.endsWith('/pulls/48/reviews?per_page=100')) {
      send([])
      return
    }
    if (request.url?.endsWith('/issues/47')) {
      send({
        node_id: 'issue-id',
        title: '完成议题管理校验',
        body: withDetails('完成议题管理校验。'),
        assignees: [],
        labels: [],
        type: { name: 'Idea' },
        state: 'open',
        state_reason: null,
      })
      return
    }
    if (request.url?.endsWith('/issues/47/comments?per_page=100')) {
      send([])
      return
    }
    send({ message: 'Not Found' }, 404)
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  registerCleanup(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  const directory = await mkdtemp(join(tmpdir(), 'dsh-issue-policy-'))
  registerCleanup(() => rm(directory, { recursive: true, force: true }))
  const pullEvent = join(directory, 'pull-request.json')
  const issueEvent = join(directory, 'issue.json')
  await writeFile(pullEvent, JSON.stringify({ pull_request: { number: 48 } }))
  await writeFile(issueEvent, JSON.stringify({ action: 'opened', issue: { number: 47 } }))
  const apiEnvironment = {
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
  }
  const environment = { ...apiEnvironment, GH_TOKEN: 'test-token' }

  await assert.rejects(
    execFileAsync(process.execPath, [policyEntrypoint, 'deployment'], {
      env: {
        ...environment,
        GITHUB_REPOSITORY: 'BeiKeJieDeLiuLangMao/deepseek-harness-gestalt',
      },
    }),
    (error) => {
      assert.match(error.stderr, /config\.projectOrganization 必须与 GITHUB_REPOSITORY owner 一致/)
      return true
    },
  )

  await execFileAsync(process.execPath, [policyEntrypoint, 'pr'], {
    env: {
      ...environment,
      GITHUB_EVENT_PATH: pullEvent,
      GITHUB_REPOSITORY: 'BeiKeJieDeLiuLangMao/deepseek-harness-gestalt',
    },
  })
  await execFileAsync(process.execPath, [policyEntrypoint, 'lifecycle'], {
    env: {
      ...environment,
      GITHUB_EVENT_NAME: 'issues',
      GITHUB_EVENT_PATH: issueEvent,
      GITHUB_REPOSITORY: 'deepseek-harness/tracker',
    },
  })

  const requestCount = requests.length
  await assert.rejects(
    execFileAsync(process.execPath, [policyEntrypoint, 'lifecycle'], {
      env: {
        ...apiEnvironment,
        GITHUB_EVENT_NAME: 'issues',
        GITHUB_EVENT_PATH: issueEvent,
        GITHUB_REPOSITORY: 'deepseek-harness/tracker',
      },
    }),
    (error) => {
      assert.match(error.stderr, /GH_TOKEN 或 GITHUB_TOKEN 未设置/)
      return true
    },
  )
  assert.equal(requests.length, requestCount)

  const restPaths = requests
    .filter((request) => request.path !== '/graphql')
    .map((request) => request.path)
    .sort()
  assert.deepEqual(restPaths, [
    '/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/pulls/48',
    '/repos/deepseek-harness/tracker/issues/47',
    '/repos/deepseek-harness/tracker/issues/47/comments?per_page=100',
  ])
  const pullRequestReads = requests.filter((request) =>
    request.path?.startsWith('/repos/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/'),
  )
  assert.ok(pullRequestReads.length > 0)
  for (const request of pullRequestReads) {
    assert.equal(request.authorization, 'Bearer test-token')
  }
  const lifecycleRequests = requests.filter(
    (request) =>
      request.path === '/graphql' || request.path?.startsWith('/repos/deepseek-harness/tracker/'),
  )
  assert.ok(lifecycleRequests.length > 0)
  for (const request of lifecycleRequests) {
    assert.equal(request.authorization, 'Bearer test-token')
  }
  assert.ok(
    lifecycleRequests.some(
      (request) => request.path === '/graphql' && request.body.includes('mutation('),
    ),
  )
  const graphqlVariables = requests
    .filter((request) => request.path === '/graphql')
    .map((request) => JSON.parse(request.body).variables)
    .filter((variables) => variables.organization !== undefined)
  assert.ok(graphqlVariables.length >= 2)
  for (const variables of graphqlVariables) {
    assert.equal(variables.organization, 'deepseek-harness')
    assert.equal(variables.repositoryOwner, 'deepseek-harness')
    assert.equal(variables.repository, 'tracker')
  }
})

const reviewedPull = (labels) => ({
  isDraft: false,
  authorType: 'User',
  reviewRequestCount: 1,
  reviewCount: 0,
  labels,
  references: { all: [2], resolving: [], related: [2] },
  issues: new Map([[2, { priority: null }]]),
})

test('counts only text outside details', () => {
  assert.deepEqual(countVisibleUnits('支持 GitHub Project。<details>隐藏文字</details>'), {
    units: 4,
    balanced: true,
    detailsCount: 1,
    allCollapsed: true,
  })
})

test('requires a balanced default-collapsed details region', () => {
  assert.deepEqual(validateBody({ body: '完成工作。', assignees: [] }), [
    '正文必须包含默认收起的 <details> 区域',
  ])
  assert.deepEqual(
    validateBody({
      body: '完成工作。\n\n<details open><summary>细节</summary>待补充。</details>',
      assignees: [],
    }),
    ['details 必须默认收起，不得设置 open'],
  )
  assert.deepEqual(
    validateBody({ body: '完成工作。\n\n<details><summary>细节</summary>', assignees: [] }),
    ['details 标签必须成对闭合'],
  )
})

test('requires Owner for multiple assignees', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('完成工作。'),
      assignees: ['tianyicui', 'tianyicui-bot'],
    }),
    ['多个 Assignees 时首个非空行必须是 Owner: @login'],
  )
})

test('accepts an intended Owner while assignment permission is pending', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: [],
    }),
    [],
  )
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: ['hubot'],
    }),
    ['零或一个 Assignee 时不得写 Owner 行'],
  )
})

test('allows optional metadata in every open Status', () => {
  assert.deepEqual(validateIssue(legalIssue), [])
  for (const status of ['Inbox', 'Backlog', 'Ready', 'In progress', 'In review']) {
    assert.deepEqual(validateIssue({ ...legalIssue, status }), [])
  }
})

test('rejects metadata prefixes in an Issue title', () => {
  const errors = validateIssue({ ...legalIssue, title: '[Bug] 修复恢复错误' })
  assert.ok(errors.includes('Issue 标题不得带 Type、Priority、Status、area 或 Owner 前缀'))
})

test('reserves PR kind and legacy labels for pull requests', () => {
  for (const label of [
    ...canonicalKinds,
    'kind/experimental',
    ...legacyLabels,
  ]) {
    assert.ok(
      validateIssue({ ...legalIssue, labels: [label] }).some((error) =>
        error.startsWith('Issue 不得使用 PR kind 或旧版标签：'),
      ),
      label,
    )
  }
  assert.deepEqual(validateIssue({ ...legalIssue, labels: ['area/web', 'source/member'] }), [])
})

test('keeps terminal Status aligned with the native close reason', () => {
  assert.deepEqual(
    validateIssue({ ...legalIssue, status: 'Done', state: 'closed', stateReason: 'completed' }),
    [],
  )
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      status: 'No action',
      state: 'closed',
      stateReason: 'not_planned',
    }),
    [],
  )
  assert.ok(validateIssue({ ...legalIssue, status: 'Done' }).includes('Done 必须对应 Completed 关闭原因'))
})

test('separates resolving and informational references', () => {
  assert.deepEqual(
    parseReferences({
      body: 'Fixes #12\nRelated to #4\nRefs deepseekharness/dsh-test#7',
      repository: 'deepseekharness/dsh-test',
    }),
    { all: [4, 7, 12], resolving: [12], related: [4, 7] },
  )
})

test('does not treat pull request references as Issue associations', () => {
  const references = {
    all: [123, 1180, 1181],
    resolving: [123, 1180],
    related: [1181],
  }
  const issues = new Map([
    [1180, {}],
    [1181, {}],
  ])

  assert.deepEqual(retainIssueReferences(references, issues), {
    all: [1180, 1181],
    resolving: [1180],
    related: [1181],
  })
})

test('allows informational references without cross-object constraints', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [4], resolving: [], related: [4] },
    issues: new Map([[4, { type: 'Bug', priority: 'P0', labels: ['area/web'] }]]),
  })
  assert.deepEqual(errors, [])
})

test('validates metadata independently of Draft policy activation', () => {
  const input = {
    isDraft: true,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 0,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
  }

  assert.deepEqual(validatePullRequest(input), [])
  assert.ok(validatePullRequestMetadata(input).includes('PR 正文必须引用至少一个同仓库 Issue'))
  assert.ok(validatePullRequestMetadata(input).includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
})

test('requires every planner-selected area label', () => {
  const input = {
    authorType: 'User',
    labels: ['kind/feature', 'area/infra'],
    references: { all: [256], resolving: [], related: [256] },
    issues: new Map([[256, { priority: null }]]),
    requiredAreas: ['area/infra', 'area/web'],
  }

  assert.deepEqual(validatePullRequestMetadata(input), ['PR 缺少相关 area/*：area/web'])
})

test('enforces highest resolving Priority without Type or area synchronization', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 1,
    labels: ['kind/cleanup', 'p0', 'area/web'],
    references: { all: [2, 3], resolving: [2, 3], related: [] },
    issues: new Map([
      [2, { type: 'Feature', priority: 'P2', labels: ['area/web'] }],
      [3, { type: 'Bug', priority: 'P0', labels: ['area/session'] }],
    ]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, labels: ['kind/cleanup', 'p2', 'area/web'] }).includes(
      'PR Priority 应为 p0',
    ),
  )
})

test('activates policy by the configured non-draft or review-activity rule', () => {
  const unreviewed = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 0,
  }
  assert.equal(requiresPullRequestPolicy(unreviewed, 'non-draft'), true)
  assert.equal(requiresPullRequestPolicy(unreviewed, 'review-activity'), false)
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 1,
      reviewCount: 0,
    }, 'review-activity'),
    true,
  )
  for (const activation of ['non-draft', 'review-activity']) {
    assert.equal(requiresPullRequestPolicy({ ...unreviewed, isDraft: true }, activation), false)
    assert.equal(requiresPullRequestPolicy({ ...unreviewed, authorType: 'Bot' }, activation), false)
    assert.equal(requiresPullRequestPolicy({ ...unreviewed, authorType: 'App' }, activation), false)
  }
})

test('maps only explicit review handoffs to review status commands', () => {
  assert.equal(
    resolvingIssueStatusCommand('pull_request', {
      action: 'review_requested',
    }),
    'review-requested',
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
    }),
    'changes-requested',
  )
  for (const state of ['approved', 'commented']) {
    assert.equal(
      resolvingIssueStatusCommand('pull_request_review', {
        action: 'submitted',
        review: { state },
      }),
      null,
    )
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
    }),
    null,
  )
})

test('keeps ordinary pull request events as forward-only implementation signals', () => {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'review_request_removed' }),
    null,
  )
})

test('toggles automation-owned work on request changes and repeated review request', () => {
  for (const status of ['Inbox', 'Backlog', 'Ready']) {
    assert.equal(nextResolvingIssueStatus(status, 'implementation'), 'In progress')
    assert.equal(nextResolvingIssueStatus(status, 'review-requested'), 'In review')
    assert.equal(nextResolvingIssueStatus(status, 'changes-requested'), 'In progress')
  }
  let status = nextResolvingIssueStatus(
    'In review',
    'changes-requested',
    'dsh-issue-management',
  )
  assert.equal(status, 'In progress')
  status = nextResolvingIssueStatus(status, 'review-requested')
  assert.equal(status, 'In review')
})

test('preserves human review status and terminal Issues', () => {
  assert.equal(nextResolvingIssueStatus('In progress', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested', 'tianyicui'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus('Done', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('No action', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus(null, 'review-requested'), null)
})

test('keeps lifecycle projection independent of PR metadata enforcement', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }

  assert.ok(validatePullRequest(pull).length > 0)
  assert.equal(nextResolvingIssueStatus('Inbox', 'review-requested'), 'In review')
})

test('exempts Draft, Bot, and App PRs', () => {
  const invalid = {
    isDraft: false,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
    reviewRequestCount: 1,
    reviewCount: 0,
  }
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'Bot' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'App' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'User', isDraft: true }), [])
  assert.ok(validatePullRequest({ ...invalid, authorType: 'User' }).length > 0)
})

test('requires repository PR labels in the enforcement scope', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [], related: [2] },
    issues: new Map([[2, { priority: null }]]),
  })
  assert.ok(errors.includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
  assert.ok(errors.includes('PR 必须至少有一个 area/*'))
})

test('accepts exactly the canonical kinds with extensible areas', () => {
  for (const kind of canonicalKinds) {
    assert.deepEqual(validatePullRequest(reviewedPull([kind, 'area/future-domain'])), [], kind)
  }
})

test('rejects multiple, unknown, legacy, and Issue-source PR labels', () => {
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'kind/doc', 'area/web']),
    ).includes('PR 必须恰好有一个允许的 kind/*，当前为 2'),
  )
  assert.ok(
    validatePullRequest(reviewedPull(['kind/experimental', 'area/web'])).includes(
      'PR 含不支持的 kind/*：kind/experimental',
    ),
  )
  for (const label of legacyLabels) {
    assert.ok(
      validatePullRequest(reviewedPull(['kind/feature', 'area/web', label])).some((error) =>
        error.startsWith('PR 含旧版标签：'),
      ),
      label,
    )
  }
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'area/web', 'source/internal-pr']),
    ).includes('source/* 仅用于 Issue：source/internal-pr'),
  )
})

test('allows missing Priority only when resolving Issues are also unprioritized', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/feature', 'area/web'],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, issues: new Map([[2, { priority: 'P2' }]]) }).includes(
      'PR Priority 应为 p2',
    ),
  )
  assert.ok(
    validatePullRequest({ ...pull, labels: [...pull.labels, 'p2'] }).includes(
      '有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority',
    ),
  )
})
