# dsh-request-trust

[English](README.md) | 中文

浏览器可触达的每个本地 HTTP 路由共享的零依赖浏览器信任栅栏：`/api` 载体（`@deepseek-ai/dsh-client-connection`）与 phone-stream 路由（`@deepseek-ai/dsh-phone-stream`）。Host、Origin 与 Fetch-Metadata 规则只有一份判定，且可从两种 HTTP 表示——Node `IncomingMessage` 头与 Fetch `Headers`——读取，各路由的副本因此不会漂移。

## 栅栏判定什么

`isTrustedApiRequest(request, trustedHosts)` 仅在 `Host` 权威属于本服务且附带的所有浏览器标记同为同源时放行请求：

- **Host 栅栏**（DNS rebinding 防御，作用于每个请求）：`Host` 必须是回环权威，或匹配某个 `trustedHosts` 条目——带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较。刻意不为无标记请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 `Host` 是重绑唯一伪造不了的请求头。
- **跨站栅栏**：显式的 `sec-fetch-site: cross-site` 标记无论 `Origin` 为何一律拒绝。
- **Origin 栅栏**：附带的 `Origin` 必须经同一归一化后等于 `Host` 权威；缺失 `Origin` 没有问题，字面量 `null`（沙箱 iframe、`file:` 页面）则被拒绝。

`isLoopbackApiRequest(request)` 是面向已受信任页面提供签名 URL 的路由（phone 捕获流）附加的仅回环检查：受信任的局域网 `Host` 并不足够。

`isBareAuthority(entry)` 是 `trustedHosts` 的配置判定：条目必须是经 WHATWG 解析后读回不变的纯规范 `host[:port]` 权威（大小写除外）。加载器在插件加载时断言它，否则解析会悄悄授权 `harness.internal/path` 内嵌的 hostname，或把悬空冒号、补零端口放大成任意端口授权。

这道栅栏是混淆代理人防御，而不是认证层；可达性仍属于 webserver 绑定，真正远程部署的认证仍是消费载体的待办工作。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)。
