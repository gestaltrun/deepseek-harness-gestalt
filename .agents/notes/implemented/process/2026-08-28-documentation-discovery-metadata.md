# Agent Note: Documentation discovery metadata follows the Gestalt product identity

Status: implemented

English | [中文](2026-08-28-documentation-discovery-metadata.zh.md)

## Problem

The root README identifies Gestalt as the product layer built on DeepSeek Harness, but the documentation build still names the site and source repository as official DSH. Search engines receive no canonical URL, language relationship, social metadata, sitemap, or structured product identity. Agents can read raw Markdown and `llms.txt`, but that index also presents the wrong site identity.

The product site at `www.gestaltrun.com` is served from `apps/platform/public` in this repository and deployed with the Platform container. The documentation build and the product origin own different routes, so each deployment must publish metadata for the URLs it serves.

## Decision

The documentation site names the product **Gestalt**, uses **獭子哥** for the Chinese locale, and states that official DeepSeek Harness supplies the compatible plugin and runtime base. Repository, edit, and unpublished-source links point to `gestaltrun/deepseek-harness-gestalt`; the upstream DSH repository remains a separately named source in `llms.txt` and structured data.

`DOCS_SITE_URL` carries the absolute deployed base URL. The Pages workflow supplies `actions/configure-pages` `base_url`; local and ordinary CI builds use the predictable project Pages URL `https://gestaltrun.github.io/deepseek-harness-gestalt/`. The value must use HTTP or HTTPS, contain no query or fragment, and end in `/`.

Every manifest page emits a self-referential clean canonical URL and reciprocal `zh-CN`, `en-US`, and `x-default` alternates. `website/docs.ts` remains the authority for route and locale pairing, so source moves cannot create a second SEO route map. Each page also emits Open Graph and Twitter summary fields from its rendered title and description, with the tracked 獭子哥 product artwork as the social preview image. Both locale homes carry the same `WebSite` and `SoftwareApplication` JSON-LD graph, which names Gestalt, 獭子哥, DeepSeek Gestalt, the product website, the current source repository, and official DSH as the base.

VitePress generates `sitemap.xml` from the deployed site URL. The build writes `robots.txt` beside it and names the sitemap explicitly. The post-build verifier requires both files, `llms.txt`, and every raw-Markdown twin.

`llms.txt` identifies Gestalt and 獭子哥, explains the raw-Markdown convention, links the product website, current source repository, and official DSH, then lists both locale trees from the publication manifest. It remains concise; the per-page twins carry full documentation, so this site does not duplicate them into `llms-full.txt`.

The [Platform homepage discovery decision](2026-08-29-platform-homepage-discovery-metadata.md) owns metadata and origin-root discovery files for `www.gestaltrun.com`.

The root README uses the concrete phrase "open-source AI coding agent product" once in each language. Metadata does not include a keywords tag or unsupported capability claims.

## Alternatives considered

**Use the marketing site as the documentation canonical.** Rejected because the current documentation deployment does not own routes under `www.gestaltrun.com`; a canonical must name the URL that serves the page.

**Maintain canonical and language tags in page frontmatter.** Rejected because the publication manifest already owns routes and locale pairs. Repeating URLs across canonical Markdown would create a second inventory that can drift.

**Add meta keywords and repeat product phrases throughout the README.** Rejected because search engines do not need a keywords tag, and repeated phrases make the product explanation less precise without adding facts.

**Generate `llms-full.txt`.** Rejected because every published page already has a link-closed raw-Markdown twin. Concatenating the corpus adds another large derivative artifact without improving discovery.

## Consequences

Search engines receive one canonical route per rendered page, reciprocal language signals, a generated sitemap, and explicit site and software identities. Agents receive the same product identity plus direct Markdown routes. Tests fail when routes, identities, source links, or discovery files drift.

Deployments must pass the destination's complete base URL. Google assigns site names at a domain or subdomain, and a `robots.txt` under a project Pages subpath cannot control the host root. The Platform homepage owns the origin-root product signals; the Pages build owns documentation routes and their language pairs.
