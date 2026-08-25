# `@deepseek-ai/dsh-platform-account-http`

[English](README.md) | 中文

本包是 `ctx.platformAccount` 的 HTTP 消费方。它注册登录尝试创建、固定的 `/v1/account/oauth/github/callback`、签名轮询、刷新、当前账号和当前安装退出路由。响应禁用缓存，错误使用稳定 JSON 信封。`QUOTA` 与 `PLATFORM_CAPACITY` 返回 HTTP 429、`Retry-After` 响应头，以及秒级 JSON `retryAfter`。必填且非空的 `origins` 配置必须包含账号提供方选中的已校验环境 origin；每个额外的标准或自定义元组 origin 都会被精确校验，带路径的 origin 与 opaque `null` 会在路由注册前被拒绝。请求体上限为 64 KiB，经 `@deepseek-ai/dsh-host-webserver` 的 JSON 助手解析，错误码与文案仍由 Account 持有；访问令牌操作通过专用请求头携带品牌化的单次证明 id。

回调返回中英文完成页，绝不会把 OAuth code 或提供方令牌重定向到应用 URL。

## 模型体验

无。这些路由由安装界面消费，不由 agent 消费。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- TLS 终止、原始 IP 日志保留、限流和部署可观测性归 Platform edge 所有。
- 本消费方假定 Platform composition 已挂载唯一权威账号提供方。
