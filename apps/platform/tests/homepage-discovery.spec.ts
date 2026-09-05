import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publicFile = (name: string): string => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')

describe('Platform homepage discovery', () => {
  it('publishes the product identity in raw HTML', () => {
    const html = publicFile('index.html')
    expect(html).toContain('<title>Gestalt · 獭子哥</title>')
    expect(html).toContain('<meta name="description"')
    expect(html).toContain('<link rel="canonical" href="https://www.beikejiedeliulangmao.top/"')
    expect(html).toContain('<meta property="og:type" content="website"')
    expect(html).toContain('<meta property="og:image" content="https://www.beikejiedeliulangmao.top/images/hero-bg.png"')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"')
    expect(html).toContain('https://github.com/gestaltrun/deepseek-harness-gestalt')
    expect(html).toContain('https://github.com/deepseek-ai/deepseek-harness')
    expect(html).toContain('<a class="ds-text-caption text-ds-description" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">辽ICP备19017854号-1</a>')
    expect(html).not.toContain('https://www.gestaltrun.com/')
    expect(html).not.toContain('BeiKeJieDeLiuLangMao')

    const jsonLdSource = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)?.[1]
    expect(jsonLdSource).toBeDefined()
    const jsonLd = JSON.parse(jsonLdSource!) as {
      '@context': string
      '@graph': Array<Record<string, unknown>>
    }
    expect(jsonLd['@context']).toBe('https://schema.org')
    const website = jsonLd['@graph'].find(item => item['@type'] === 'WebSite')
    expect(website).toMatchObject({ name: 'Gestalt', url: 'https://www.beikejiedeliulangmao.top/' })
    expect(website?.alternateName).toEqual(['獭子哥', 'DeepSeek Gestalt'])
    const software = jsonLd['@graph'].find(item => item['@type'] === 'SoftwareApplication')
    expect(software).toMatchObject({
      name: 'Gestalt',
      downloadUrl: 'https://github.com/gestaltrun/deepseek-harness-gestalt/releases',
      isBasedOn: 'https://github.com/deepseek-ai/deepseek-harness',
    })
  })

  it('publishes root-level crawler and agent discovery files in the image', () => {
    expect(publicFile('robots.txt')).toBe([
      'User-agent: *',
      'Allow: /',
      'Sitemap: https://www.beikejiedeliulangmao.top/sitemap.xml',
      '',
    ].join('\n'))
    expect(publicFile('sitemap.xml')).toContain('<loc>https://www.beikejiedeliulangmao.top/</loc>')
    const llms = publicFile('llms.txt')
    expect(llms).toContain('# Gestalt · 獭子哥')
    expect(llms).toContain('https://www.beikejiedeliulangmao.top/')
    expect(llms).toContain('https://github.com/gestaltrun/deepseek-harness-gestalt')
    expect(llms).toContain('https://github.com/deepseek-ai/deepseek-harness')

    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toContain('COPY --chown=platform:platform public ./public')
  })
})
