# `@deepseek-ai/dsh-platform-account-client`

[English](README.md) | 中文

本包是 Desktop 与 Mobile 共用的安装客户端。它在授权前展示唯一规范的中英文数据保留说明，创建 P-256 密钥，在用户激活打开系统浏览器前准备好五分钟登录尝试，再以签名轮询完成授权。`load()` 会先向 Platform 确认已存储会话再发布账号；若没有会话但存在仍有效的待完成登录，则恢复为轮询；过期的待完成登录会被清除。

`PlatformAccountHttpTransport` 只接受从已校验开发／生产环境对中选出的身份，把默认 Fetch 实现绑定到全局以便浏览器调用，并把请求头复制为记录以免 Host 调用方构造 Chromium `Headers`，再从 `unknown` 解析每种响应，包括带可选 `retryAfter` 的 `QUOTA` 与 `PLATFORM_CAPACITY`。`PlatformAccountInstallation.authorizeCurrentInstallation()` 会在需要时刷新，并在不暴露安装私钥的情况下签署新的 `current` 证明；Desktop 在 Electron Host 拥有的账号控制器内实现相同权限。`IndexedDbInstallationAccountStore` 解析持久化记录，要求真正的 P-256 私有签名 `CryptoKey`，并保存不可导出的 Mobile WebCrypto 密钥与账号会话；Desktop 复用相同传输，但使用加密存储。一个可关闭的 `AccountLifecycleTransitions` owner 串行化加载、登录、轮询、刷新、切换、退出与当前安装鉴权，避免并发恢复清除或复活较新的会话，并让关闭过程排空已经接纳的工作。快照发布会分别隔离每个订阅方，并在后续订阅方运行后才报告失败。单个安装切换账号时，`accountStorageNamespace` 为配对密钥、缓存与回执提供按账号和环境隔离的前缀。

## 模型体验

无。控制器不会贡献模型可见状态。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 本库向个人配对提供当前安装账号鉴权，但不授予 Desktop 或 Companion 权限。
- Mobile 原生打包必须提供稳定的 WebView 存储 origin；Mobile composition 自己拥有 Capacitor Browser 适配器。
