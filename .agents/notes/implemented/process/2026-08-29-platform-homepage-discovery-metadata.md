# Agent Note: The Platform homepage owns product discovery metadata

Status: implemented

English | [中文](2026-08-29-platform-homepage-discovery-metadata.zh.md)

## Problem

The production product origin `https://www.gestaltrun.com/` serves `apps/platform/public/index.html` from the Platform container. Its raw HTML has only a title, and the product links still name an earlier personal repository owner. Search engines and agents receive no canonical URL, description, social preview, structured product identity, crawler policy, sitemap, or concise machine-readable product guide.

The documentation site publishes discovery metadata under its Pages routes, but those files cannot control the product origin. The Platform image owns every file served at the product origin root.

## Decision

`apps/platform/public/index.html` identifies the product as Gestalt and 獭子哥 in raw HTML. It emits a description, a self-referential canonical URL, Open Graph fields, a Twitter summary image card, and a `WebSite` plus `SoftwareApplication` JSON-LD graph. Product and release links name `gestaltrun/deepseek-harness-gestalt`; the graph names official DeepSeek Harness separately as the compatible base.

The homepage has one canonical URL with a client-side Chinese and English switch. It uses Open Graph locale fields but does not publish `hreflang` alternates for routes that do not exist.

The Platform public directory contains `robots.txt`, `sitemap.xml`, and `llms.txt`. The sitemap lists the only product page. The agent guide gives a short product description and links to the product origin, source, releases, bilingual documentation, and official DeepSeek Harness. The static file server sends `.txt` as UTF-8 plain text and `.xml` as UTF-8 XML.

The Platform tests read the tracked metadata, boot the assembled product entry, and request the discovery files. A keyless real-Chromium snapshot boots the homepage through a Loader composition and pins its title, product links, social preview image, discovery responses, and Chinese and English states. The Platform Dockerfile continues to copy the complete public directory, so the tested files and the deployed files share one source.

## Alternatives considered

**Put these files in the VitePress build.** Rejected because Pages serves a different origin and route base. It cannot provide `https://www.gestaltrun.com/robots.txt` or the homepage metadata.

**Add separate English and Chinese paths for SEO.** Rejected because the product currently serves both languages from one client-side page. Alternate links must point to real, independently addressable pages.

**Generate a complete documentation corpus in `llms.txt`.** Rejected because the documentation site already publishes raw Markdown twins. The product-origin file should direct agents to those sources instead of copying them.

## Consequences

The product origin exposes the same Gestalt identity to browsers, search crawlers, social previews, and agents before JavaScript runs. Tests fail when the canonical URL, repository owner, structured identity, discovery files, MIME types, or image packaging drift.

Product metadata changes ship with the Platform container. Publishing an image and deploying it to ECS remain explicit release operations; merging source alone does not update the production origin.
