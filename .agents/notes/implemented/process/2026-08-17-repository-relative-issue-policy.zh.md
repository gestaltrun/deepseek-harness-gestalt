# Agent Note: 仓库相对的 Issue 策略部署

Status: implemented

[English](2026-08-17-repository-relative-issue-policy.md) | 中文

## 问题

Issue 策略同时包含仓库检查和可选的组织 Project 生命周期投影。静态仓库坐标会在工作流安装到其他 tracker 时把检查路由到错误仓库，而无条件创建 Project token 会使未配置对应组织 Project 的部署在仓库策略运行前失败。

仓库 GitHub App installation 权限与组织 ProjectV2 权限彼此独立。把仓库 installation token 当作未配置 Project 的访问凭证，会掩盖缺失的授权路径。

## 决策

仓库策略从工作流提供的 `GITHUB_REPOSITORY` 派生仓库 owner 和名称。PR 策略使用仓库 `GITHUB_TOKEN`，对每个非 Draft 的人工 PR 生效，并因该部署没有配置 Issue field 授权而禁用 Priority 同步。Project 配置仅把 `projectOrganization`、`projectNumber` 和 `projectTitle` 作为部署标识；Project-local 字段名仍是可选生命周期配置，而不是仓库坐标。

仅当仓库变量 `DSH_ISSUE_PROJECT_LIFECYCLE_ENABLED` 严格等于 `true` 时，组织 Project 生命周期投影才会运行。禁用此选项时，owner 校验、token 创建和 mutation step 都会跳过，而生命周期 job 保持成功。启用该选项的部署要求 `projectOrganization` 与事件仓库 owner 一致；工作流会在 checkout 可信策略之后、创建 token 之前检查此约束，生命周期入口则会在任何 API 请求前再次检查。随后，部署会用已配置的 App 凭证创建仓库范围的 installation token，并使用同一 owner 的组织权限执行 ProjectV2 操作。

Gestalt 组织 tracker 保持禁用 Project 生命周期投影，因为其 Project 与 GitHub App 授权尚未配置。`projectOrganization` 为未来可选部署标识 `gestaltrun`；仅 owner 对齐不会在缺少仓库变量和凭据时启用生命周期。

部署启用投影后，[事件驱动的评审状态决策](2026-08-10-event-directed-pr-review-status.zh.md)继续负责生命周期事件和状态迁移语义。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)使用本地 GitHub API 运行策略 CLI，验证相对当前仓库的 REST 路径和 GraphQL 变量，执行审计评论查询，并拒绝 Project 与仓库 owner 不一致的生命周期部署。[工作流测试](../../../../scripts/ci-workflow.spec.ts)验证显式生命周期选项、token 范围以及创建 token 前的 owner 校验。

## 考虑过的替代方案

**在策略文件中配置 fork 的仓库坐标。** 这会修复一个部署，但仍为每个 GitHub Actions 事件已经提供的值保留第二个真源。

**在未配置部署时使用单独的 Project 凭据。** 第二项凭据会带来独立的权限与轮换义务，同时仍让 Project 标识含糊。采用它需要明确配置 Project 所有权与凭据。

**为不同的 Project owner 创建单独的 installation token。** 仓库策略与 Project 修改将依赖两个 App installation 和两套权限范围。跨 owner 生命周期投影需要显式的认证与失败设计，不能依赖隐式 token 选择。

**尝试同步 Project 并忽略授权失败。** 静默降级会使 Project 状态不可靠，并掩盖部署错误。

## 后果

仓库 Issue 和 PR 策略会跟随发出事件的仓库。Gestalt tracker 可以执行仓库策略而不依赖未配置的 Project 集成；任何启用生命周期投影的部署都必须提供 owner 匹配的 Project 与 GitHub App 配置。
