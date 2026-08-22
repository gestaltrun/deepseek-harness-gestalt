import { createServer, type Server } from 'node:http'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BrowserProfileName } from '@deepseek-ai/dsh-browser-runtime'
import ElectronBrowserRuntime from '@deepseek-ai/dsh-browser-runtime-electron'

const REAL_PAGE = 'https://example.com/'

/**
 * Drive one real page and two persist partitions through this Electron process.
 */
export async function runElectronRuntimeE2eCases(): Promise<void> {
  await driveRealPage()
  await isolateCookiesAcrossPartitions()
}

/**
 * Navigate, observe, screenshot, and focus one temporary Profile.
 */
export async function driveRealPage(): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(ElectronBrowserRuntime, {
      idPrefix: 'electron-e2e',
      requestTimeoutMs: 30_000,
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    assert.equal(created.status, 'open')
    assert.equal(created.revision, 0)
    assert.deepEqual(created.chrome, { kind: 'temporary', partition: 'session-electron-e2e-tmp-1' })
    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: REAL_PAGE,
    })
    assert.equal(navigated.status, 'open')
    assert.equal(navigated.revision, 1)
    assert.equal(navigated.url, REAL_PAGE)
    assert.equal(typeof navigated.title, 'string')
    assert.deepEqual(await ctx.browserRuntime.observe({ target: created.target }), navigated)
    const shot = await ctx.browserRuntime.screenshot({ target: created.target })
    assert.equal(shot.revision, 1)
    assert.equal(shot.url, REAL_PAGE)
    assert.equal(shot.mediaType, 'image/png')
    assert.ok(shot.data.length > 0)
    const focused = await ctx.browserRuntime.focus({ target: created.target, expectedRevision: 1 })
    assert.equal(focused.revision, 2)
    assert.equal(focused.focused, true)
    const closed = await ctx.browserRuntime.close({
      target: created.target,
      expectedRevision: focused.revision,
    })
    assert.deepEqual(closed, { status: 'closed', target: created.target, revision: 3 })
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * Type a newline and a non-BMP character, then prove two named partitions keep distinct cookies.
 */
export async function isolateCookiesAcrossPartitions(): Promise<void> {
  const pages = await serveLocalPages()
  const ctx = new Context()
  try {
    await ctx.plugin(ElectronBrowserRuntime, {
      idPrefix: 'electron-e2e-input',
      requestTimeoutMs: 30_000,
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const form = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: `${pages.origin}/form`,
    })
    const typed = await ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: form.revision,
      text: 'line\n👍',
    })
    assert.match(typed.text, /line/)
    assert.match(typed.text, /\n/)
    assert.match(typed.text, /👍/)

    const work = await ctx.browserRuntime.create({
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })
    const workSet = await ctx.browserRuntime.navigate({
      target: work.target,
      expectedRevision: work.revision,
      url: `${pages.origin}/cookie?name=work`,
    })
    assert.match(workSet.text, /iso=work/)
    const personal = await ctx.browserRuntime.create({
      profile: 'persistent',
      name: BrowserProfileName('personal'),
    })
    const personalSet = await ctx.browserRuntime.navigate({
      target: personal.target,
      expectedRevision: personal.revision,
      url: `${pages.origin}/cookie?name=personal`,
    })
    assert.match(personalSet.text, /iso=personal/)
    const workRead = await ctx.browserRuntime.navigate({
      target: work.target,
      expectedRevision: workSet.revision,
      url: `${pages.origin}/cookie-read`,
    })
    assert.match(workRead.text, /iso=work/)
    assert.doesNotMatch(workRead.text, /iso=personal/)
    const personalRead = await ctx.browserRuntime.navigate({
      target: personal.target,
      expectedRevision: personalSet.revision,
      url: `${pages.origin}/cookie-read`,
    })
    assert.match(personalRead.text, /iso=personal/)
    assert.doesNotMatch(personalRead.text, /iso=work/)
  } finally {
    await ctx.fiber.dispose()
    await pages.close()
  }
}

/** Local pages for input and cookie-isolation checks. */
async function serveLocalPages(): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body>
<textarea id="box" autofocus></textarea>
<pre id="out"></pre>
<script>
const box = document.getElementById('box')
const out = document.getElementById('out')
const sync = () => { out.textContent = box.value }
box.addEventListener('input', sync)
box.focus()
</script>
</body></html>`)
      return
    }
    if (url.pathname === '/cookie') {
      const name = url.searchParams.get('name') ?? 'anon'
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `iso=${name}; Path=/`,
      })
      response.end(`<!doctype html><html><body><pre id="out"></pre>
<script>document.getElementById('out').textContent = document.cookie</script>
</body></html>`)
      return
    }
    if (url.pathname === '/cookie-read') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body><pre id="out"></pre>
<script>document.getElementById('out').textContent = document.cookie</script>
</body></html>`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP test port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}
