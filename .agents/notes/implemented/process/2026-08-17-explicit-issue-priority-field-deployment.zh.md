# Agent Note: 显式部署 Issue Priority 字段

Status: implemented

[English](2026-08-17-explicit-issue-priority-field-deployment.md) | 中文

## 问题

PR 策略会为每个被引用 Issue 读取 `priorityField` 配置指定的组织 Issue field，以比较 Issue 与 PR 的 Priority。GitHub 不为用户账户拥有的仓库提供组织 Issue fields；即使请求使用具有仓库权限的用户 token，字段值端点仍会返回 `404`。如果把任意 `404` 都视为未设置值，还会掩盖计划使用 Priority 同步的仓库配置了不受支持的字段、缺少权限或部署目标错误。

Issue Priority 同步与组织 Project 生命周期投影使用不同的 API、凭据和效果。一项部署开关无法准确表示这两种能力。

## 决策

`.github/issue-management/config.json` 通过 `priorityField` 声明 Issue Priority 集成。非空字符串会启用该集成并指定组织 Issue field。策略会为每个被引用 Issue 请求字段值；任何 API 失败仍是致命错误。`null` 会关闭该集成、阻止字段值请求，并在 PR 校验中把被引用 Issue 的 Priority 记录为未设置。

个人账户 tracker 把 `priorityField` 设为 `null`。其 PR 策略继续校验 Issue 引用与 PR 标签，但不执行 Priority 同步。该设置不会合成原生 Issue Type，也不会启用 Project 生命周期投影；独立的部署选项由[仓库相对 Issue policy 决策](2026-08-17-repository-relative-issue-policy.zh.md)负责。

策略在启动时拒绝 `null` 或非空字符串以外的任何 `priorityField` 值，因此错误配置无法静默关闭强制校验。

## 验证

Issue management 测试使用不同配置文件，在本地 fake GitHub API 上执行真实的 `policy.mjs pr` CLI。关闭路径在不发出 Issue field 请求的情况下完成。启用路径会观察字段值请求，并验证 `404` 仍使命令以 API 错误终止。

## 考虑过的替代方案

**把 `404` 视为未设置 Priority。** 否决，因为相同响应也可能表示已启用的部署配置错误或缺少权限，而这类情况必须明确失败。

**使用 Project 生命周期选项关闭 Priority 读取。** 否决，因为 PR Priority 比较不会修改 Project 状态，而且未运行生命周期自动化的部署仍可能需要该能力。

**根据仓库 owner 类型推断支持情况。** 否决，因为可用性与授权属于部署配置，而 owner 分类不能证明特定组织字段存在或可读。

## 后果

个人账户 PR 检查不再依赖不可用的组织 API。组织部署通过字段名选择启用，并保留严格失败行为。关闭部署会放弃 PR Priority 自动对齐，因为每个被引用 Issue 进入校验时都没有 Priority。
