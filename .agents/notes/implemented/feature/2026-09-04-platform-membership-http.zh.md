# Agent Note: 生产 Platform 挂载 Project Membership HTTP

Status: implemented

[English](2026-09-04-platform-membership-http.md) | 中文

## 问题

Desktop Cloud Projects 会在生产 origin 上调用创建与 presence heartbeat。运营镜像已经挂载 Account HTTP、Personal Pairing、Relay 与附件，但未挂载 Project Membership，因此这些路由在 gestaltrun.com 上返回 405。

## 决策

`launchOperatedPlatform` 在 Account HTTP 之后立即挂载 `@deepseek-ai/dsh-project-membership-core`，再挂载 `@deepseek-ai/dsh-project-membership-http`，origin 与 Account 相同（`environment.origin`、`https://localhost`、`capacitor://localhost`）。文件持久化 Provider 使用运营身份中的 `environment: 'production'`，`storagePath` 来自 `PLATFORM_MEMBERSHIP_STORAGE`，缺省为 `/var/lib/dsh/projects`。仅空白字符的覆盖会大声失败。持久状态位于 `<storagePath>/production/project-membership.json`。镜像为 uid 10001 创建该目录并声明为 `VOLUME`；host script 只在长期运行的 `dsh-platform` 容器上挂载 named volume `dsh-platform-membership`，因此 loopback candidate 不共享 writer。镜像内默认路径可写，故 `PLATFORM_MEMBERSHIP_STORAGE` 保持可选。

放置、角色门与单进程 writer 仍由[成员权威决策](2026-08-27-project-membership-core.zh.md)拥有。本变更只把该 Provider 及其 HTTP Consumer 接到运营监听进程。

## 备选方案

**在共享后端出现前，把 membership HTTP 留在仅 Desktop 的无密钥组合里。** 否决：生产创建与 heartbeat 已经 405；Desktop Cloud Projects 现在就需要 gestaltrun.com 上的路由。

**把 `PLATFORM_MEMBERSHIP_STORAGE` 做成必填部署密钥。** 否决：镜像可以写入 `/var/lib/dsh/projects`；只有该路径不可写时才需要额外密钥。

**也给 loopback candidate 挂上同一 named volume。** 否决：两个进程写同一文件没有跨进程锁；candidate 只做就绪探测，不是服务 writer。

**在本工单把文件 Provider 换成 PostgreSQL。** 否决：Service Definition 已允许后续替换后端；本工单只挂载现有文件 Provider。

## 后果

未认证的 `POST /v1/projects` 与 `POST /v1/projects/presence/heartbeat` 返回 Account `401 AUTH_REQUIRED`，而不再是 404/405。presence 在共享 `PresenceStore` 出现前仍是进程本地，与 [HTTP Consumer](../../../../packages/platform/project-membership-http/README.zh.md) 一致。两台 ECS 实例不共享 membership 写入；扩容仍需 core 包记录的后端替换。无密钥覆盖用假 PostgreSQL/Redis adapter 与临时存储启动 `launchOperatedPlatform`；不访问实际 ECS。
