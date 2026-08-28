import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { WebAcceptanceSupervisor, type WebAcceptanceStatus } from '../../../scripts/web-acceptance.ts'

const root = resolve(import.meta.dirname, '../../..')
let supervisor: WebAcceptanceSupervisor | undefined
let browser: Browser | undefined

async function probeFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => { resolveListen() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('acceptance probe did not bind a TCP port')
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
  return address.port
}

async function workspaceIds(status: WebAcceptanceStatus): Promise<string[]> {
  const response = await fetch(`${status.url}/api/workspace.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'web-acceptance-e2e-list',
      method: 'workspace.list',
      payload: {},
    }),
  })
  const body = await response.json() as {
    result: { ok: true; value: { items: { workspaceId: string }[] } } | { ok: false }
  }
  if (!body.result.ok) throw new Error('workspace.list failed during Web acceptance e2e')
  return body.result.value.items.map(item => item.workspaceId)
}

afterEach(async () => {
  await browser?.close()
  browser = undefined
  await supervisor?.stop()
  supervisor = undefined
})

describe('built Web acceptance supervisor', () => {
  it('starts, registers a Workspace, restarts the exact child, and removes its scratch root', async () => {
    supervisor = new WebAcceptanceSupervisor(root)
    const first = await supervisor.start()
    const scratchRoot = dirname(first.workspacePath)
    expect(first.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
    expect(first.commit.startsWith(first.visibleRevision)).toBe(true)
    expect(await workspaceIds(first)).toContain(first.workspaceId)
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(first.url, { waitUntil: 'load' })
    await page.getByText(first.visibleRevision, { exact: true }).waitFor({ timeout: 30_000 })

    const nextPort = await probeFreePort()
    const second = await supervisor.restart(nextPort)
    expect(second.pid).not.toBe(first.pid)
    expect(new URL(second.url).port).toBe(String(nextPort))
    expect(second.workspaceId).toBe(first.workspaceId)
    expect(await workspaceIds(second)).toContain(second.workspaceId)
    await expect(fetch(first.url, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow()

    await supervisor.stop()
    expect(existsSync(scratchRoot)).toBe(false)
  }, 120_000)
})
