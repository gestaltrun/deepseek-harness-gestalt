# Agent Note: Platform 仅生产环境的发布 CI

Status: implemented

[English](2026-08-20-platform-production-release-ci.md) | 中文

## 问题

Platform 监听进程及其 GitHub Actions 工作流只需要一套实际运行的环境。再准备一套开发用 origin、OAuth App、数据库和身份命名空间，只会增加 staging 选择器和第二套凭证空间，而没有人会去运营它们。部署工作流也会在 Environment `production` 一获批准就应用到 ECS，因此缺名称或只想干跑时仍可能 SSH。

## 决策

实际运行的 Platform 只有生产环境。[`apps/platform/src/production-env.ts`](../../../../apps/platform/src/production-env.ts) 列出监听进程所需密钥，将未设置的 `PLATFORM_ENVIRONMENT` 视为 production，并在 `loadPlatformEnvironment` 运行前拒绝任何其他选择。[`boot.ts`](../../../../apps/platform/src/boot.ts) 仍保留虚假的 development 身份，以便客户端成对校验拒绝共享身份；它们不是第二套监听进程。本地模拟器使用的无密钥 Account、配对与 Relay 监听在 [`examples/local-companion-platform`](../../../../examples/local-companion-platform/README.md)（[本地 Companion Platform](../architecture/2026-08-21-local-companion-platform.md)）。

GitHub Actions 只使用 Environment `production`。[Platform Image](../../../../.github/workflows/platform-image.yml) 会在拉取请求和匹配的 master 推送上构建，仅在 `workflow_dispatch` 且 `inputs.push` 为真时推送到 GHCR。[Platform Deploy](../../../../.github/workflows/platform-deploy.yml) 始终通过 [`production-env-cli.ts`](../../../../apps/platform/src/production-env-cli.ts)（`node --experimental-strip-types`）校验生产和 ECS 名称，仅在 `inputs.deploy` 为真时 SSH。该 CLI 入口不会打进 `boot.mjs`。

Desktop 与 Mobile 仍解析完整环境对（[账号安装会话](../feature/2026-08-17-platform-account-installation-sessions.md)）。这条成对隔离规则并不要求存在一套在线的 development Platform。

## 考虑过的替代方案

**再运营一套 development Platform。** 否决：产品运营不会再准备第二套 origin、OAuth App、数据库或身份命名空间。staging 选择器也会重新打开 Companion 打包已经禁止的任意端点选择。

**在同一主机上跑 development 以保留成对校验。** 否决：共享主机会把成对校验要隔开的身份命名空间叠在一起，监听进程仍需要一套 development 密钥。

**只在工作流里用 bash 清单校验生产名称。** 否决：监听进程与工作流会漂移。名称由一个 TypeScript 入口拥有；工作流调用它，测试同时钉住函数与 YAML。

**每次 master 构建都推送镜像。** 否决：推送到 GHCR 属于发布变更，必须显式派发。

## 后果

缺少生产名称时校验失败，且不会打印值。设置 `PLATFORM_ENVIRONMENT=development` 会使监听进程失败。镜像发布和 ECS 应用仍是手动、受 Environment 保护的步骤。监听进程把启动和错误行写到容器 stdout/stderr；Docker `json-file` 轮转（`20m` × `3` 个文件）限制每台 ECS 上的体积。应用步骤还会以用户自定义标识 `gestalt-platform` 启动 LoongCollector，把这些行送到 SLS 项目 `gestalt` 的 Logstore `application`。采集器从加固模式 ECS 元数据 `100.100.100.200` 读取阿里云账号 ID，元数据为空时回退到 Environment `production` 的 `PLATFORM_SLS_ACCOUNT_ID`。在挂载相应能力之前，APNs、FCM、OSS blob、CloudMonitor 以及配对/Relay HTTP 都不在本工作流内。监听进程会迁移共享的 pairing-authority 与 route 表，但不挂载配对 HTTP 或 Relay WSS。

## 测试

[`apps/platform/tests/production-env.spec.ts`](../../../../apps/platform/tests/production-env.spec.ts) 钉住运行环境选择、缺失名称顺序、十六进制密钥拒绝、只列出名称不打印值的 CLI stderr、`boot.ts` 调用 `assertOperatedPlatformEnvironment` 且不导入 CLI 入口、监听进程迁移 pairing 与 route store 且不导入配对或 Relay provider、Deploy 工作流的先校验再按 `inputs.deploy` 应用、`json-file` 轮转选项以及 LoongCollector 向 SLS `gestalt`/`application` 的注册，以及 Platform Image 在 master 推送上构建但不推送到 GHCR。
