import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'

const PUBLIC_INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/homepage-discovery/ui.expected.md', import.meta.url))

describe('Platform homepage browser snapshot', () => {
  let fixtureRoot: string | undefined
  let context: Context | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let origin = ''
  const pageErrors: string[] = []

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-platform-homepage-'))
    const configPath = join(fixtureRoot, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      '- id: homepage',
      "  name: '@deepseek-ai/dsh-host-frontend-static'",
      '  config:',
      `    distIndex: '${PUBLIC_INDEX}'`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(fixtureRoot).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    origin = `http://127.0.0.1:${String(context.webServer.port)}`
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    await page.goto(origin, { waitUntil: 'networkidle' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await context?.fiber.dispose()
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  })

  it('pins the shipped product identity, links, discovery responses, and language states', async () => {
    if (page === undefined) throw new Error('Platform homepage browser did not start')
    const head = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
      repositoryLinks: [...new Set([...document.querySelectorAll<HTMLAnchorElement>('a[href*="github.com"]')]
        .map(link => link.href))].sort(),
      jsonLd: document.querySelector<HTMLScriptElement>('script[type="application/ld+json"]')?.textContent?.trim(),
    }))
    const discovery = await page.evaluate(async () => {
      const results: Array<{ path: string; status: number; type: string | null; body: string }> = []
      for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt']) {
        const response = await fetch(path)
        results.push({
          path,
          status: response.status,
          type: response.headers.get('content-type'),
          body: await response.text(),
        })
      }
      return results
    })
    const chineseHero = await page.locator('main > section').first().ariaSnapshot()
    await page.locator('#en').click()
    await expect.poll(() => page?.locator('html').getAttribute('lang')).toBe('en')
    const englishHero = await page.locator('main > section').first().ariaSnapshot()

    const snapshot = [
      '# Platform homepage browser snapshot',
      '',
      '## Head and links',
      '',
      '```json',
      JSON.stringify(head, null, 2),
      '```',
      '',
      '## Discovery responses',
      '',
      '```json',
      JSON.stringify(discovery, null, 2),
      '```',
      '',
      '## Chinese hero',
      '',
      chineseHero,
      '',
      '## English hero',
      '',
      englishHero,
    ].join('\n')
    await compareOrRefresh(EXPECTED, snapshot)
    expect(pageErrors).toEqual([])
  }, 30_000)
})

async function compareOrRefresh(path: string, value: string): Promise<void> {
  const payload = `${value.trimEnd()}\n`
  if (process.env.DSH_SNAPSHOT === 'refresh') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, payload)
    return
  }
  expect(payload).toBe(await readFile(path, 'utf8'))
}
