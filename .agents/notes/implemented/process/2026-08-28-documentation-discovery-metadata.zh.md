# Agent Note: 文档发现元数据遵循獭子哥产品身份

Status: implemented

[English](2026-08-28-documentation-discovery-metadata.md) | 中文

## Problem

根 README 将獭子哥定义为基于 DeepSeek Harness 构建的产品层，但文档构建仍把站点和源代码仓库写成官方 DSH。搜索引擎无法获得 canonical URL、语言关系、社交元数据、sitemap 或结构化产品身份。Agent 虽然可以读取原始 Markdown 与 `llms.txt`，但该索引也使用了错误的站点身份。

营销站 `www.gestaltrun.com` 的部署源码不在当前仓库。当前仓库不能声称能够修复自己并不拥有的文件或元数据。

## Decision

文档站使用英文产品名 **Gestalt**，中文 locale 使用 **獭子哥**，并说明官方 DeepSeek Harness 提供兼容的插件与运行时基础。仓库、编辑和未发布源文件链接指向 `gestaltrun/deepseek-harness-gestalt`；`llms.txt` 与结构化数据把 DSH 官方仓库作为单独命名的基础来源。

`DOCS_SITE_URL` 携带部署后的绝对基础 URL。Pages 工作流传入 `actions/configure-pages` 的 `base_url`；本地与普通 CI 构建使用可预测的项目 Pages URL `https://gestaltrun.github.io/deepseek-harness-gestalt/`。该值必须使用 HTTP 或 HTTPS，不得包含 query 或 fragment，并以 `/` 结尾。

每个 manifest 页面输出 self-referential clean canonical URL，以及相互对应的 `zh-CN`、`en-US` 与 `x-default` alternate。`website/docs.ts` 继续持有路由与 locale 配对权威，源文件移动不会产生第二份 SEO 路由表。每个页面还会根据最终渲染的标题和描述输出 Open Graph 与 Twitter summary 字段，并使用仓库内的獭子哥产品图作为社交预览图片。两个 locale 首页携带同一份 `WebSite` 与 `SoftwareApplication` JSON-LD graph，明确 Gestalt、獭子哥、DeepSeek Gestalt、产品网站、当前源代码仓库，以及作为基础的 DSH 官方仓库。

VitePress 根据部署站点 URL 生成 `sitemap.xml`。构建在同级写入 `robots.txt`，并显式引用该 sitemap。构建后校验器要求这两个文件、`llms.txt` 和每个原始 Markdown twin 同时存在。

`llms.txt` 标明 Gestalt 与獭子哥身份，说明原始 Markdown 规则，链接产品网站、当前源代码仓库与 DSH 官方仓库，然后根据发布 manifest 列出两个 locale tree。该文件保持简短；每页 twin 已携带完整文档，因此站点不再复制生成 `llms-full.txt`。

根 README 在两种语言中各使用一次明确的「开源 AI coding agent（编程智能体）产品」。元数据不包含 keywords tag，也不声称未支持的能力。

## Alternatives considered

**把营销站作为文档 canonical。** 否决，因为当前文档部署并不拥有 `www.gestaltrun.com` 下的路由；canonical 必须指向实际提供页面的 URL。

**在每页 frontmatter 中维护 canonical 和语言标签。** 否决，因为发布 manifest 已经持有路由与 locale 配对。把 URL 重复写进 canonical Markdown 会形成可能漂移的第二份清单。

**增加 meta keywords，并在 README 中重复产品短语。** 否决，因为搜索引擎不需要 keywords tag，重复短语不会增加事实，只会降低产品说明的准确性。

**生成 `llms-full.txt`。** 否决，因为每个已发布页面已有链接闭合的原始 Markdown twin。把整个文档集再次拼接成大文件会增加一份衍生产物，却不会改善发现能力。

## Consequences

搜索引擎会获得每个渲染页面的唯一 canonical 路由、相互对应的语言信号、生成的 sitemap，以及明确的站点和软件身份。Agent 会获得同一产品身份与直接 Markdown 路由。路由、身份、源文件链接或发现文件发生漂移时，测试会失败。

部署必须传入目标站点的完整基础 URL。Google 只在 domain 或 subdomain 级别分配 site name，项目 Pages 子路径下的 `robots.txt` 也无法控制 host root。托管方必须提供 origin-root 部署与 host-level policy，才能让这两类信号生效。外部营销站仍需在持有其部署的仓库中补充 description、canonical、社交元数据、结构化数据、sitemap、robots 文件和 `llms.txt`。
