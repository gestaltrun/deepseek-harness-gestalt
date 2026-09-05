/** Search and agent-discovery metadata for the projected documentation site. */

import type { DocsLocale, DocsPage } from '../website/docs.ts'

type HeadConfig =
  | [tag: string, attributes: Record<string, string>]
  | [tag: string, attributes: Record<string, string>, content: string]

const DEFAULT_DOCS_SITE_URL = 'https://gestaltrun.github.io/deepseek-harness-gestalt/'

/** Public repository that owns Gestalt source, issues, and releases. */
export const GESTALT_REPOSITORY_URL = 'https://github.com/gestaltrun/deepseek-harness-gestalt'

/** Official DeepSeek Harness repository that supplies the compatible runtime base. */
export const DSH_REPOSITORY_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** Product website linked from search metadata and structured data. */
export const GESTALT_PRODUCT_URL = 'https://www.beikejiedeliulangmao.top/'

/** Product artwork used by search and social previews. */
const GESTALT_SOCIAL_IMAGE_URL = 'https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/master/docs/assets/brand/tazige-ip.png'

/** Bilingual identity used by the agent-facing documentation index. */
export const docsSiteIdentity = {
  title: 'Gestalt / 獭子哥',
  description: 'Gestalt (獭子哥) is an open-source desktop, web, and mobile agent product built on DeepSeek Harness. It preserves DSH profiles, plugins, CLI modes, and SDK entry points.',
}

/** Locale-specific titles and descriptions used by rendered documentation pages. */
export const docsLocaleIdentity = {
  root: {
    title: '獭子哥',
    titleTemplate: ':title | 獭子哥 Gestalt',
    description: '獭子哥（Gestalt）是基于 DeepSeek Harness 的开源桌面、Web 与移动 agent（智能体）产品，兼容 DSH Profile、插件、CLI 模式和 SDK 入口。',
  },
  en: {
    title: 'Gestalt',
    titleTemplate: ':title | Gestalt',
    description: 'Gestalt is an open-source desktop, web, and mobile agent product built on DeepSeek Harness, compatible with DSH profiles, plugins, CLI modes, and SDK entry points.',
  },
} satisfies Record<DocsLocale, { title: string; titleTemplate: string; description: string }>

/** Inputs for page-specific HTML head metadata. */
export interface DocsPageHeadOptions {
  /** Manifest page being rendered. */
  page: DocsPage
  /** Complete manifest used to resolve the page's language counterpart. */
  pages: readonly DocsPage[]
  /** Absolute base URL of the deployed documentation site. */
  siteBaseUrl: URL
  /** Final rendered page title. */
  title: string
  /** Rendered page description. */
  description: string
}

/**
 * Resolve the absolute deployed documentation URL.
 *
 * @param environment - Build environment carrying an optional Pages `base_url`.
 * @returns Validated absolute site base URL with a trailing slash.
 * @throws When `DOCS_SITE_URL` is not an absolute HTTP(S) URL without a query or fragment and with a trailing slash.
 */
export function resolveDocsSiteBaseUrl(environment: NodeJS.ProcessEnv): URL {
  const value = environment.DOCS_SITE_URL ?? DEFAULT_DOCS_SITE_URL
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`DOCS_SITE_URL must be an absolute URL, received ${JSON.stringify(value)}.`, { cause: error })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`DOCS_SITE_URL must use http or https, received ${JSON.stringify(value)}.`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`DOCS_SITE_URL must not contain a query or fragment, received ${JSON.stringify(value)}.`)
  }
  if (!url.pathname.endsWith('/')) {
    throw new Error(`DOCS_SITE_URL must end with /, received ${JSON.stringify(value)}.`)
  }
  return url
}

/**
 * Convert one manifest Markdown route into its clean public URL.
 *
 * @param siteBaseUrl - Absolute deployment base URL.
 * @param route - Manifest route ending in `.md`.
 * @returns Absolute clean URL for the rendered page.
 * @throws When the route is absolute or does not end in `.md`.
 */
export function docsRouteUrl(siteBaseUrl: URL, route: string): string {
  if (route.startsWith('/') || !route.endsWith('.md')) {
    throw new Error(`Documentation route must be relative and end with .md, received ${JSON.stringify(route)}.`)
  }
  const stem = route.slice(0, -'.md'.length)
  const cleanRoute = stem === 'index'
    ? ''
    : stem.endsWith('/index') ? stem.slice(0, -'index'.length) : stem
  return new URL(cleanRoute, siteBaseUrl).href
}

function localePage(page: DocsPage, pages: readonly DocsPage[], locale: DocsLocale): DocsPage {
  const sharedRoute = page.locale === 'en' ? page.route.replace(/^en\//, '') : page.route
  const route = locale === 'en' ? `en/${sharedRoute}` : sharedRoute
  const match = pages.find(candidate => candidate.route === route)
  if (match === undefined) {
    throw new Error(`Documentation page ${JSON.stringify(page.route)} has no ${locale} route ${JSON.stringify(route)}.`)
  }
  return match
}

function siteSchema(siteBaseUrl: URL): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'Gestalt',
        alternateName: ['獭子哥', 'DeepSeek Gestalt'],
        url: siteBaseUrl.href,
        description: docsSiteIdentity.description,
        inLanguage: ['zh-CN', 'en-US'],
        sameAs: [GESTALT_PRODUCT_URL, GESTALT_REPOSITORY_URL],
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Gestalt',
        alternateName: ['獭子哥', 'DeepSeek Gestalt'],
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Windows, Web, iOS, Android',
        url: GESTALT_PRODUCT_URL,
        codeRepository: GESTALT_REPOSITORY_URL,
        isBasedOn: DSH_REPOSITORY_URL,
        license: `${GESTALT_REPOSITORY_URL}/blob/master/LICENSE`,
        description: docsSiteIdentity.description,
        isAccessibleForFree: true,
      },
    ],
  })
}

/**
 * Build canonical, language, social, and home-page structured metadata.
 *
 * @param options - Page, manifest, deployment URL, and rendered metadata.
 * @returns VitePress head entries for the page.
 * @throws When the manifest has no matching Chinese or English route for the page.
 */
export function docsPageHead(options: DocsPageHeadOptions): HeadConfig[] {
  const rootPage = localePage(options.page, options.pages, 'root')
  const englishPage = localePage(options.page, options.pages, 'en')
  const canonical = docsRouteUrl(options.siteBaseUrl, options.page.route)
  const rootUrl = docsRouteUrl(options.siteBaseUrl, rootPage.route)
  const englishUrl = docsRouteUrl(options.siteBaseUrl, englishPage.route)
  const locale = options.page.locale === 'root' ? 'zh_CN' : 'en_US'
  const alternateLocale = options.page.locale === 'root' ? 'en_US' : 'zh_CN'
  const sharedRoute = options.page.locale === 'en'
    ? options.page.route.replace(/^en\//, '')
    : options.page.route
  const head: HeadConfig[] = [
    ['link', { rel: 'canonical', href: canonical }],
    ['link', { rel: 'alternate', hreflang: 'zh-CN', href: rootUrl }],
    ['link', { rel: 'alternate', hreflang: 'en-US', href: englishUrl }],
    ['link', { rel: 'alternate', hreflang: 'x-default', href: rootUrl }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Gestalt' }],
    ['meta', { property: 'og:title', content: options.title }],
    ['meta', { property: 'og:description', content: options.description }],
    ['meta', { property: 'og:url', content: canonical }],
    ['meta', { property: 'og:image', content: GESTALT_SOCIAL_IMAGE_URL }],
    ['meta', { property: 'og:image:alt', content: 'Gestalt (獭子哥) product identity' }],
    ['meta', { property: 'og:locale', content: locale }],
    ['meta', { property: 'og:locale:alternate', content: alternateLocale }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: options.title }],
    ['meta', { name: 'twitter:description', content: options.description }],
    ['meta', { name: 'twitter:image', content: GESTALT_SOCIAL_IMAGE_URL }],
    ['meta', { name: 'twitter:image:alt', content: 'Gestalt (獭子哥) product identity' }],
  ]
  if (sharedRoute === 'index.md') {
    head.push(['script', { id: 'gestalt-site-schema', type: 'application/ld+json' }, siteSchema(options.siteBaseUrl)])
  }
  return head
}

/**
 * Build the crawler policy emitted beside the VitePress sitemap.
 *
 * @param siteBaseUrl - Absolute deployment base URL.
 * @returns robots.txt content allowing the site and naming its sitemap.
 */
export function robotsTxt(siteBaseUrl: URL): string {
  return [
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${new URL('sitemap.xml', siteBaseUrl).href}`,
    '',
  ].join('\n')
}
