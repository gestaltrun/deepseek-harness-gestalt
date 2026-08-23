# 远程访问 HTTP

[English](README.md) | 中文

公开远程访问服务的 HTTP 与 WSS 消费方。一个固定 HTTP 路由接收当前安装的账号证明请求头、校验操作输入，并且只通过 `ctx.remoteAccess` 委派。配对挑战请求把 TCP 对端地址交给每 IP 小时配额。`QUOTA` 与 `PLATFORM_CAPACITY` 映射为 HTTP 429，JSON 含 `retryAfter`，并带 `Retry-After` 响应头。附件准入操作（`admit-blob`、`release-blob`）按声明大小执行对应配额。精确 WSS 路径只接收 Relay Transport frame，并通过 `ctx.remoteRelay` 委派已鉴权 attachment。JSON 请求体与错误信封走 `@deepseek-ai/dsh-host-webserver` 助手，错误码与文案仍由 Remote Access 持有。

消费方不读取账号数据库字段，也不自行授予权限。远程访问提供方会在任何配对生命周期变更前，通过平台账号公开服务鉴别账号、安装标识及安装类型。

WSS 消费方要求端点自有的 challenge request 与签名 attach proof 先于任何 Relay 密文，执行显式 pending-challenge／attach deadline 与协议消息字节上限，关闭压缩，串行处理 frame，并且只在鉴权与目录注册完成后发送 ready。它随 socket 一起清理 Relay attachment，并且只返回不含内容的稳定 transport error。组装测试启动两套由独立 Loader 持有的 WebServer／HTTP composition，经 non-sticky TLS endpoint 到达两者发布的 WSS upgrade handler，并以独立撤销运行两项端点自有 Snow 配对。其中的 localhost 证书与内存适配器是确定性测试输入；TLS 终止与已运营基础设施仍由部署负责。

## 模型体验

无。HTTP 消费方在模型请求之外处理配对状态。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- WSS 消费方只转发不透明 Relay 密文；它从不接受 Host request 或 Companion 明文。
- 部署 TLS、边缘限制与审计策略仍由 Platform 组合负责。
