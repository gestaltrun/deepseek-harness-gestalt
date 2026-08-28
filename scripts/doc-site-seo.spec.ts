/** Tests for documentation-site search and agent discovery metadata. */

import { describe, expect, it } from 'vitest'
import { docsPages } from '../website/docs.ts'
import {
  docsPageHead,
  docsRouteUrl,
  resolveDocsSiteBaseUrl,
  robotsTxt,
} from './doc-site-seo.ts'

describe('resolveDocsSiteBaseUrl', () => {
  it('uses the public project Pages URL outside deployment', () => {
    expect(resolveDocsSiteBaseUrl({}).href)
      .toBe('https://gestaltrun.github.io/deepseek-harness-gestalt/')
  })

  it('accepts the deployment-provided full base URL', () => {
    expect(resolveDocsSiteBaseUrl({ DOCS_SITE_URL: 'https://docs.example.com/product/' }).href)
      .toBe('https://docs.example.com/product/')
  })

  it('rejects a non-HTTP URL and a base without a trailing slash', () => {
    expect(() => resolveDocsSiteBaseUrl({ DOCS_SITE_URL: 'file:///tmp/site/' }))
      .toThrow('must use http or https')
    expect(() => resolveDocsSiteBaseUrl({ DOCS_SITE_URL: 'https://docs.example.com/product' }))
      .toThrow('must end with /')
  })
})

describe('docsRouteUrl', () => {
  const siteBaseUrl = new URL('https://docs.example.com/product/')

  it('maps VitePress Markdown routes to clean canonical URLs', () => {
    expect(docsRouteUrl(siteBaseUrl, 'index.md')).toBe('https://docs.example.com/product/')
    expect(docsRouteUrl(siteBaseUrl, 'en/index.md')).toBe('https://docs.example.com/product/en/')
    expect(docsRouteUrl(siteBaseUrl, 'guide/quickstart.md'))
      .toBe('https://docs.example.com/product/guide/quickstart')
    expect(docsRouteUrl(siteBaseUrl, 'reference/index.md'))
      .toBe('https://docs.example.com/product/reference/')
  })
})

describe('docsPageHead', () => {
  const siteBaseUrl = new URL('https://docs.example.com/product/')
  const page = docsPages.find(candidate => candidate.route === 'guide/quickstart.md')

  it('emits one canonical URL, reciprocal language alternates, and social metadata', () => {
    expect(page).toBeDefined()
    const head = docsPageHead({
      page: page!,
      pages: docsPages,
      siteBaseUrl,
      title: '快速开始 | 獭子哥 Gestalt',
      description: '使用獭子哥运行基于 DeepSeek Harness 的 agent。',
    })

    expect(head).toContainEqual([
      'link',
      { rel: 'canonical', href: 'https://docs.example.com/product/guide/quickstart' },
    ])
    expect(head).toContainEqual([
      'link',
      { rel: 'alternate', hreflang: 'zh-CN', href: 'https://docs.example.com/product/guide/quickstart' },
    ])
    expect(head).toContainEqual([
      'link',
      { rel: 'alternate', hreflang: 'en-US', href: 'https://docs.example.com/product/en/guide/quickstart' },
    ])
    expect(head).toContainEqual([
      'link',
      { rel: 'alternate', hreflang: 'x-default', href: 'https://docs.example.com/product/guide/quickstart' },
    ])
    expect(head).toContainEqual(['meta', { property: 'og:site_name', content: 'Gestalt' }])
    expect(head).toContainEqual([
      'meta',
      { property: 'og:url', content: 'https://docs.example.com/product/guide/quickstart' },
    ])
    expect(head).toContainEqual(['meta', { name: 'twitter:card', content: 'summary' }])
    expect(head).toContainEqual([
      'meta',
      { name: 'twitter:title', content: '快速开始 | 獭子哥 Gestalt' },
    ])
  })

  it('emits the site and application identities on both locale homes', () => {
    for (const route of ['index.md', 'en/index.md']) {
      const home = docsPages.find(candidate => candidate.route === route)
      expect(home).toBeDefined()
      const head = docsPageHead({
        page: home!,
        pages: docsPages,
        siteBaseUrl,
        title: route === 'index.md' ? '獭子哥' : 'Gestalt',
        description: 'Gestalt is built on DeepSeek Harness.',
      })
      const schema = head.find(entry => entry[0] === 'script' && entry[1].type === 'application/ld+json')
      expect(schema).toBeDefined()
      expect(JSON.parse(schema![2] ?? '')).toMatchObject({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebSite',
            name: 'Gestalt',
            alternateName: ['獭子哥', 'DeepSeek Gestalt'],
            url: 'https://docs.example.com/product/',
          },
          {
            '@type': 'SoftwareApplication',
            name: 'Gestalt',
            codeRepository: 'https://github.com/gestaltrun/deepseek-harness-gestalt',
            isBasedOn: 'https://github.com/deepseek-ai/deepseek-harness',
          },
        ],
      })
    }
  })
})

describe('robotsTxt', () => {
  it('allows crawling and points at the deployment sitemap', () => {
    expect(robotsTxt(new URL('https://docs.example.com/product/'))).toBe([
      'User-agent: *',
      'Allow: /',
      'Sitemap: https://docs.example.com/product/sitemap.xml',
      '',
    ].join('\n'))
  })
})
