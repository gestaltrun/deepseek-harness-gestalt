# Agent Note: Platform 官网持有产品发现元数据

Status: implemented

[English](2026-08-29-platform-homepage-discovery-metadata.md) | 中文

## Problem

生产产品域名 `https://www.gestaltrun.com/` 从 Platform 容器提供 `apps/platform/public/index.html`。原始 HTML 只有标题，产品链接仍指向此前的个人仓库 owner。搜索引擎与 agent（智能体）无法获得 canonical URL、description、社交预览、结构化产品身份、爬虫策略、sitemap 或简短的机器可读产品说明。

文档站会在 Pages 路由下发布发现元数据，但这些文件不能控制产品域名。Platform 镜像持有产品域名根路径提供的全部文件。

## Decision

`apps/platform/public/index.html` 在原始 HTML 中将产品标识为 Gestalt 与獭子哥。它输出 description、自引用 canonical URL、Open Graph 字段、Twitter 大图摘要卡，以及包含 `WebSite` 与 `SoftwareApplication` 的 JSON-LD graph。产品与发布链接使用 `gestaltrun/deepseek-harness-gestalt`；graph 将 DSH 官方仓库单独标记为兼容基础。

首页只有一个 canonical URL，中文与英文通过客户端切换。它使用 Open Graph locale 字段，但不会为不存在的独立路由发布 `hreflang` alternate。

Platform public 目录包含 `robots.txt`、`sitemap.xml` 与 `llms.txt`。sitemap 只列出唯一的产品页。agent 指南提供简短产品说明，并链接产品域名、源码、发布页、双语文档与 DSH 官方仓库。静态文件服务器以 UTF-8 纯文本提供 `.txt`，以 UTF-8 XML 提供 `.xml`。

Platform 测试读取受版本控制的元数据，启动组装后的产品入口，并请求发现文件。一个无密钥的真实 Chromium 快照会通过 Loader 组合启动首页，并固定标题、产品链接、社交预览图、发现响应及中英文状态。Platform Dockerfile 继续复制完整 public 目录，因此测试与部署使用同一份文件来源。

## Alternatives considered

**把这些文件放进 VitePress 构建。** 否决，因为 Pages 使用不同的 origin 与 route base，无法提供 `https://www.gestaltrun.com/robots.txt` 或产品首页元数据。

**为 SEO 增加独立中英文路径。** 否决，因为产品目前从同一客户端页面提供两种语言。alternate link 必须指向真实且可独立访问的页面。

**在 `llms.txt` 生成完整文档集。** 否决，因为文档站已经发布原始 Markdown twin。产品域名下的文件应把 agent 指向这些来源，不应重复复制。

## Consequences

JavaScript 运行前，产品域名就会向浏览器、搜索爬虫、社交预览与 agent 提供同一份 Gestalt 身份。canonical URL、仓库 owner、结构化身份、发现文件、MIME 或镜像打包发生漂移时，测试会失败。

产品元数据随 Platform 容器发布。推送镜像并部署到 ECS 仍是显式发布操作；只合并源码不会更新生产域名。
