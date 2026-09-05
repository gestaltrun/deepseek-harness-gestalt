# Agent Note: 受保护的 Platform 自举部署

Status: proposed

[English](2026-09-06-platform-bootstrap-deployment.md) | 中文

## Problem

生产 Platform 工作流假定两台目标主机都已经运行一个可被重命名并恢复的前任版本。[已备案域名切换](2026-09-05-filed-platform-domain-cutover.zh.md)使用的替换 ECS 是空主机，因此该假设要么会拒绝部署，要么会诱使操作者在不可变 Product Release 路径之外进行未经评审的手工安装。

DNS 切换前的验收还必须在不削弱证书或主机名校验的前提下分别证明每个新地址，并且一次运维自举可能需要先完成部署、之后才发布 GitHub Release。

## Proposal

Platform Deploy 增加显式 `bootstrap` 模式，默认值为 false。工作流会先在两台主机上检查不存在 `dsh-platform`、`dsh-platform-candidate`、`dsh-platform-rollback` 和候选环境文件，然后才在任一主机上准备候选。自举激活绝不重命名前任版本。失败路径只删除候选容器、带有本次自举候选所有权标签的 Platform 容器和候选环境。滚动部署保留原有的前任校验、替换、回滚、切换与清理顺序。

自举 readiness 只接受恰好两个互不相同的 IPv4 EIP 地址。每个请求直接连接对应 EIP，同时保持 Platform 正典主机名作为 HTTPS authority、TLS SNI 名称、证书校验名称和 HTTP Host。两份响应必须依次报告 `ok`、OSS 附件存储和 `relay-1`、`relay-2`。该证明不使用公网 DNS。

独立的 `publish_release` 布尔值控制 GitHub tag 和 Release 创建。Product Release 传入 `publish_release: true`，直接自举派发默认 false。候选 SHA、镜像来源与执行工作流信任继续使用现有的已合并候选校验；包含本工作流的候选会构建新的不可变 Platform 镜像，因此不新增第二个工作流 commit 输入。

持久部署状态升级到版本 2，并记录 `mode: rolling | bootstrap`。恢复流程只把自举状态派发到候选清理或候选收尾，同时保留版本 1 的滚动恢复。未知 mode 与 phase 组合会失败，而不会通过推断选择回滚策略。

## Alternatives considered

**增加独立的工作流 commit 输入。** 否决，因为经过评审的 Product Release 候选同时包含脚本和镜像源码。第二个 commit 权威允许候选与工作流错配，却不会强化现有的 `github.sha` 与候选都必须可从 master 到达的要求。

**创建专用自举工作流。** 否决，因为它会重复生产 Environment 权威、OIDC、Cloud Assistant、产物暂存、来源证明与恢复逻辑。

**自动把缺少前任版本视为自举。** 否决，因为缺失或部分损坏的部署具有歧义。自举保持显式受保护模式，滚动行为继续关闭失败。

**只设置 Host header 请求 `https://<EIP>`。** 否决，因为 TLS SNI 与证书主机名校验仍会使用 IP 地址。

## Acceptance criteria

- 自举默认 false，Product Release 显式保留发布 Release 的滚动行为。
- 两台主机都通过空主机检查后，任一候选才会开始准备。
- 自举失败会达到静止状态，不删除或重命名前任版本及无关资源。
- 自举 readiness 只接受恰好两个不同地址，并以正典主机名执行普通 TLS 校验，证明 `relay-1`、`relay-2` 与 OSS。
- 持久恢复拒绝有歧义的 mode 或 phase 数据，并保留版本 1 滚动恢复。
- 仅部署模式记录绑定候选的证据，不创建或移动 Platform tag。

## Risks

主机清理依赖自举激活时写入的容器所有权标签；标签丢失时，清理会关闭失败并保留持久恢复状态供操作者处理。EIP 对是窄化的派发输入，不是全局 inventory（清单），仅对经过评审的自举事务有效。基础设施、NAT、Redis、证书和 EIP 路由仍是外部前提；本工作流不会配置这些资源。
