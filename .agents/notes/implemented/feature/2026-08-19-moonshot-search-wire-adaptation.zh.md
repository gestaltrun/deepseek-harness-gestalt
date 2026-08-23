# Agent Note: 一张 Web Search 卡片上的显式提供方 tab

Status: implemented

[English](2026-08-19-moonshot-search-wire-adaptation.md) | 中文

## Problem

Gestalt 只发货一个覆盖 `web-search-deepseek` 的 `web_search` 工具。需要另一条搜索协议的用户——Anthropic Messages 的具名基址，或 Moonshot `POST /v1/search`——只能改写一个 `baseURL` 并猜测协议。猜测会把 Messages 搜索和专用检索混在一起。面向模型的工具仍然是一个 `web_search`；缺的是下一次搜索读取哪个后端的显式选择。

## Decision

一张设置卡片 **Web Search** 在 DeepSeek 段写入 `backend`：`deepseek` | `anthropic-messages` | `kimi`。Tab 会立即选中后端。每个 tab 有自己的 settings 命名空间；选中其他 tab 时不会读取残留的 DeepSeek `baseURL`。

同一个 `deepseek-official` 提供方仍拥有 `ctx.web` 搜索。协议是显式的，不从 URL 猜测：

- **DeepSeek** — Anthropic Messages + `web_search_20250305`，基址 `https://api.deepseek.com/anthropic/v1`。
- **Anthropic** — 同一套 Messages 约定，基址由用户填写；缺少 `baseURL` 时提供方不可用。
- **Kimi** — Moonshot 专用搜索：对配置的 URL（默认 `https://api.kimi.com/coding/v1/search`）发起 `POST`，请求体 `{ "text_query" }`，鉴权 `Authorization: Bearer`。密钥先读 `KIMI_WEB_SEARCH_API_KEY`，该值不是可进 header 的 ASCII 时再读 `DEEPSEEK_API_KEY`。

其他插件可以向 `settings.plugin.web-search.provider` 再注册 tab。插件卡片的 **测试搜索** 调用 `settings.testWebSearch`，内部执行 `ctx.web.search({ query: 'deepseek harness' })`。

## Alternatives considered

**根据已配置 URL 的主机或路径猜测协议。** 否决：`api.kimi.com/coding/v1` 是 Messages，`api.kimi.com/coding/v1/search` 是检索，主机白名单会分错路。

**再做一个 `WebSearchProvider` id，并在 `ctx.web` 里选择 `searchProvider`。** 暂缓：已发布组合把 `searchProvider` 固定为 `deepseek-official`，而且 `WebRuntime` 在构造时固化该 id。

**两张顶层卡片外加「使用此搜索」。** 否决为已发货外壳：两张卡片重复同一套字段，第二条「使用此」控件容易被漏掉。一张卡片上的 tab 在点击时写入 `backend`。

**没有 tab 的协议下拉框。** 否决：DeepSeek、Anthropic Messages 和 Moonshot 检索需要不同的端点文案；tab 把文案留在字段旁边。

**把 Moonshot `POST /v1/search` 留在另一个包。** 否决为 Kimi tab：用户面对的提供方已经是这张卡片，第二个提供方 id 也不会改 `searchProvider`。

## Consequences

想用官方 DeepSeek 的用户留在 DeepSeek tab。想在 Kimi coding 上走 Messages 的用户使用 Anthropic tab，并填写 `https://api.kimi.com/coding/v1`。想用 Moonshot 检索的用户使用 Kimi tab 和专用搜索 URL。非 ASCII 的已存密钥不会作为 HTTP 头发送。

未使用的字段 panel 和 `useThis` 残留见 [删除未使用的提供方面板](../../proposed/simplification/2026-08-19-drop-dead-web-search-provider-panel.zh.md)。

## Testing

`packages/web/web-search-deepseek/tests/settings.spec.ts` 会切换 `backend`，并断言 Messages 打到 `{baseURL}/messages`，而 Kimi 打到搜索 URL 且不追加 `/messages`。客户端测试覆盖 tab 选择和测试搜索控件。plugin-config 快照列出一张 Web Search 卡片。

## Related

- [Web 能力 seam](../architecture/2026-06-24-web-capability-seam.zh.md) — 提供方注册能力；`dsh-tool-web` 拥有稳定的 `web_search` schema。
- [Web 插件配置](2026-08-10-web-plugin-configuration.zh.md) — 设置卡片各自绑定一个命名空间。
