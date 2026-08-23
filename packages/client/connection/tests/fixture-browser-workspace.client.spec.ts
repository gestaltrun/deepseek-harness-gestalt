/** Fixture Browser Workspace remotes: create, mutate, observe, and close. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import { createFixtureFaces } from '../src/client/fixture.ts'

const sid = (id: string): SessionId => id as SessionId
const TARGET = {
  profileId: 'fx-profile',
  workspaceId: 'fx-workspace',
  browserId: 'fx-browser',
  tabId: 'fx-tab',
}

async function callRemote<T>(
  rpc: ReturnType<typeof createFixtureFaces>['rpc'],
  endpoint: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await rpc.call('/api', endpoint, { args })
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}`)
  return result.value as T
}

describe('createFixtureFaces browserWorkspace remotes', () => {
  it('creates, mutates, observes, and closes a page for the addressed Session', async () => {
    const { rpc } = createFixtureFaces()
    const observed = await callRemote<{ status: string; title: string; revision: number }>(
      rpc, 'browserWorkspace/observe', { agentId: sid('fx-alpha'), target: TARGET })
    expect(observed).toMatchObject({ status: 'open', title: 'Example Domain', revision: 1 })

    const shot = await callRemote<{ mediaType: string }>(
      rpc, 'browserWorkspace/screenshot', { agentId: sid('fx-alpha'), target: TARGET })
    expect(shot.mediaType).toBe('image/png')

    const focused = await callRemote<{ focused: boolean; revision: number }>(
      rpc, 'browserWorkspace/focus', { agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 1 })
    expect(focused).toMatchObject({ focused: true, revision: 2 })

    const inputted = await callRemote<{ url: string; revision: number }>(
      rpc, 'browserWorkspace/input', {
        agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 2, input: { url: 'https://typed.test/' },
      })
    expect(inputted).toMatchObject({ url: 'https://typed.test/', revision: 3 })

    const navigated = await callRemote<{ url: string; status: string; revision: number }>(
      rpc, 'browserWorkspace/navigate', {
        agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 3, url: 'https://login.test/',
      })
    expect(navigated).toMatchObject({ status: 'open', url: 'https://login.test/', revision: 4 })
    const afterNavigate = await callRemote<{ url: string; title: string; status: string }>(
      rpc, 'browserWorkspace/observe', { agentId: sid('fx-alpha'), target: TARGET })
    expect(afterNavigate).toMatchObject({ status: 'open', url: 'https://login.test/', title: 'login.test' })
    const shotAfterNavigate = await callRemote<{ url: string; title: string }>(
      rpc, 'browserWorkspace/screenshot', { agentId: sid('fx-alpha'), target: TARGET })
    expect(shotAfterNavigate).toMatchObject({ url: 'https://login.test/', title: 'login.test' })

    const closed = await callRemote<{ status: string }>(
      rpc, 'browserWorkspace/close', { agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 4 })
    expect(closed.status).toBe('closed')

    const afterClose = await callRemote<{ status: string }>(
      rpc, 'browserWorkspace/observe', { agentId: sid('fx-alpha'), target: TARGET })
    expect(afterClose.status).toBe('closed')

    const created = await callRemote<{ status: string; target: typeof TARGET; revision: number }>(
      rpc, 'browserWorkspace/create', { agentId: sid('fx-alpha'), request: { profile: 'temporary' } })
    expect(created).toMatchObject({ status: 'open', target: TARGET, revision: 1 })
    const afterCreate = await callRemote<{ status: string; revision: number }>(
      rpc, 'browserWorkspace/observe', { agentId: sid('fx-alpha'), target: TARGET })
    expect(afterCreate).toMatchObject({ status: 'open', revision: 1 })
  })

  it('observes about:blank and unparseable URLs committed by navigate', async () => {
    const { rpc } = createFixtureFaces()
    const blank = await callRemote<{ url: string; title: string; status: string }>(
      rpc, 'browserWorkspace/navigate', {
        agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 1, url: 'about:blank',
      })
    expect(blank).toMatchObject({ status: 'open', url: 'about:blank', title: 'New Tab' })
    const observedBlank = await callRemote<{ url: string; title: string }>(
      rpc, 'browserWorkspace/observe', { agentId: sid('fx-alpha'), target: TARGET })
    expect(observedBlank).toMatchObject({ url: 'about:blank', title: 'New Tab' })
    const fileUrl = await callRemote<{ url: string; title: string }>(
      rpc, 'browserWorkspace/navigate', {
        agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 2, url: 'file:///tmp/page.html',
      })
    expect(fileUrl).toMatchObject({ url: 'file:///tmp/page.html', title: 'file:///tmp/page.html' })
    const junk = await callRemote<{ url: string; title: string }>(
      rpc, 'browserWorkspace/navigate', {
        agentId: sid('fx-alpha'), target: TARGET, expectedRevision: 3, url: 'not a url',
      })
    expect(junk).toMatchObject({ url: 'not a url', title: 'not a url' })
  })

  it('accepts the generated sessionId wire name for observe', async () => {
    const { rpc } = createFixtureFaces()
    const observed = await callRemote<{ status: string; title: string }>(
      rpc, 'browserWorkspace/observe', { sessionId: sid('fx-alpha'), target: TARGET })
    expect(observed).toMatchObject({ status: 'open', title: 'Example Domain' })
  })

  it('rejects an unknown Session', async () => {
    const { rpc } = createFixtureFaces()
    const missing = await rpc.call('/api', 'browserWorkspace/observe', {
      args: { agentId: sid('fx-nope'), target: TARGET },
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })
})
