# `@deepseek-ai/dsh-platform`

[English](README.md) | 中文

Platform 监听进程以容器发布。GitHub Actions 会为触及 Platform 树的拉取请求以及匹配的 master 推送构建镜像。推送到 GHCR 必须显式派发 Platform Image 并勾选 **push**。ECS 拉取已发布的 tag。密钥在部署时从 GitHub Environment `production` 注入，不会写入镜像层。

实际运行的监听进程与产品客户端只接受一套生产身份。`PLATFORM_ORIGIN`、固定回调、GitHub client id 与 credential reference、PostgreSQL database identity、identity namespace、Redis ACL identity 和 Relay Redis key prefix 都是必填项；不存在开发、staging 或默认身份。

`GET /` 提供 DeepSeek Gestalt 产品首页。在所需部署密钥齐备后，`GET /healthz` 与 `GET /readyz` 返回 `{ ok: true }`。身份、Relay、TLS、`PORT` 或 `PLATFORM_LISTEN_HOST` 配置缺失或不一致时，会在连接 PostgreSQL 或 Redis 前失败；监听 host 只能是 `0.0.0.0` 或 `127.0.0.1`。可执行入口调用 `launchOperatedPlatform`，由它拥有校验、事务式 PostgreSQL 与 Redis 资源获取、迁移、GitHub OAuth、Account HTTP、健康路由和排空式关闭。每个 Redis owner 在活动期间保留 error listener，连接失败时销毁 client，并在失败或关闭后移除 listener。并发的 `SIGINT` 与 `SIGTERM` 请求会共享一次关闭；进程只在 HTTP 与持久 store owner 都关闭后退出，关闭失败则会报告错误并产生非零退出码。`OperatedRemoteAccessResources` 会在监听前用 Redis Relay coordinator 构造 PostgreSQL Personal Pairing authority 与 Relay route store。Account HTTP 挂在 `/v1/account/*`，配对 HTTP 与 Relay WSS 分别挂在 `/v1/remote-access/personal-pairing` 和 `/v1/remote-access/relay`。PostgreSQL 持有持久配对与 credential digest authority；Redis 只持有会过期的 attachment directory，以及 content-free 或 ciphertext coordination。Platform 不提供产品配对 cipher，也不会收到端点私钥或 Mobile Relay bearer。

```sh
docker build -f apps/platform/Dockerfile -t dsh-platform .
```

发布：Actions → Platform Image → Run workflow → 勾选 **push**。部署：Actions → Platform Deploy；工作流先校验 Environment `production` 中的名称，仅在勾选 **deploy** 时才把镜像应用到两台 ECS。ECS 将主机 80 映射到容器 8080，供 ALB 443 转发到 VPC 80。应用步骤使用 Docker `json-file` 轮转（`20m` × `3` 个文件），容器 stdout/stderr 不会占满主机磁盘。同时运行 LoongCollector（`dsh-loongcollector`），把 `dsh-platform` 的 stdout/stderr 送到杭州 SLS 项目 `gestalt` 的 Logstore `application`。采集器以用户自定义机器组标识 `gestalt-platform` 注册，并从加固模式 ECS 元数据读取阿里云账号 ID，空则回退 `PLATFORM_SLS_ACCOUNT_ID`。在该 Logstore 的 Docker 标准输出 Logtail 配置里绑定这个机器组。ECS SSH 与运行密钥放在 Environment `production`。

部署会为每台 ECS 提供不同的 `PLATFORM_RELAY_INSTANCE_ID`，并通过 `PLATFORM_RELAY_*` 变量提供正数的容量、确认等待、directory TTL、heartbeat timeout、ciphertext buffer、连接数、待投递数与 attach timeout。PostgreSQL 同时拥有共享的加密附件表：Platform 实例以事务处理一次性 capability digest、密文、pairing id、过期与容量，但不会收到端点密钥或明文。每次读取持久行时都会校验 digest 长度、品牌化 pairing id、非空且有界的密文，以及正数安全整数 expiry，校验通过后该行才能进入产品 authority。附件 HTTP 会鉴别当前 Mobile Installation 与确切的已确认 pairing selector；selector 本身没有 authority。应用会在监听前校验完整配置。

## 已知限制与暂缓事项

- 发布验收前仍需要独立安全评审与物理 WKWebView/Android WebView 证据。
- 产品配置不能关闭 Redis 与 PostgreSQL 的证书校验。产品入口测试会先校验实际运行的 TLS 配置，再用临时非 TLS store adapter 驱动 `launchOperatedPlatform`；这不构成实际运行验收。
