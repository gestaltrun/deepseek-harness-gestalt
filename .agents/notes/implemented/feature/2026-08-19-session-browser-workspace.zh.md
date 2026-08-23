# Agent Note: Session 持有的 Browser Workspace

Status: implemented

[English](2026-08-19-session-browser-workspace.md) | 中文

## 问题

Session 可以打开 Browser Profile，但 Runtime 仍把 Workspace、实例与标签页当作进程全局身份。因此切换 Session、重新加载或打开第二个 Session 时，无法在不暴露另一 Session 页面的情况下恢复该 Session 的 Dock、实例与标签页。

## 决策

`dsh-browser-workspace` 把 Browser Runtime 身份绑定到一条 Session 日志。每个 Session 独立拥有零个或多个 Workspace。每个 Workspace 使用一个 Browser Profile，并包含多个浏览器实例与标签页。`browser/workspace` 是仅日志、后写覆盖的完整值 Session 事件。折叠会在 Session 切换与重新加载后恢复实例、活动实例、标签页、每个标签页最近一次提交的修订号与活动标签页。

Browser Runtime 页面仍是 live 进程状态。保留身份的 Profile 匹配遇到当前 Runtime 以 `BROWSER_NOT_FOUND` 报告的已记录 target 时，Binder 会遗忘该 target，并继续匹配与创建；其他 observe 失败仍是致命错误。因此 Runtime 进程重启后，下一次 create 会替换缺失页面，而不会把已记录所有权当作页面仍 live 的证明。

Runtime `create` 可以把新实例附加到已有 Workspace，或把新标签页附加到已有实例。命名 Profile 仍以 `BROWSER_PROFILE_BUSY` 拒绝第二个独立写入方；附加到已打开的命名 Profile 属于同一写入方再增加实例或标签页。当调用 Agent Session 存在且 Binder 已组合时，Consumer 经 Binder 路由。跨 Session 页面转移以 `BROWSER_TRANSFER_UNSUPPORTED` 拒绝。附加到另一 live Session 的 Workspace 或实例同样是 `BROWSER_TRANSFER_UNSUPPORTED`；附加到本 Session 未知的层级是 `BROWSER_SESSION_MISMATCH`。Session 释放会返回遗留标签页清理，并从 Session 快照中遗忘这些标签页。

无密钥 Browser Runtime 快照保持不含 Binder，因为它们证明 Consumer 发现与已渲染 Runtime 事实，而不是 Session 隔离。只有组合了 Binder 的路径才宣称 Session 本地所有权。

每个标签页最近一次提交的修订号是 Session 事实，供投影恢复乐观并发；[标签页修订号 Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md)持有这条列表规则。工作台面板可见性与宽度属于 better-sidebar。[删除报告式 Browser 控制权与 Dock 状态](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md)持有收窄后的 payload 与隐式 Profile 匹配复用。

## 考虑过的替代方案

**只把 Workspace 所有权保存在 live Runtime 内存中。** 否决，因为 Session 切换与重新加载必须从持久 Session 事实恢复相同实例与标签页。

**再加一套账号或页面转移服务。** 否决，因为工单禁止跨 Session 转移和第二套身份概念。

**在 Browser payload 中持久化工作台面板几何状态。** 否决，因为 better-sidebar 已经持有每个 Session 的展示状态；第二个权威来源可能在切换或重新加载后产生分歧。

## 后果

两个 Session 可以在同一 Runtime 上拥有隔离 Workspace。重新加载从 Session 日志重建标签页所有权以及每个标签页最近一次提交的修订号。Runtime 进程重启后，下一次保留身份 Profile create 会清除缺失 target。命名 Profile 仍是隔离身份。

## 验证

- `pnpm exec vitest run packages/browser/browser-workspace packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/tool-browser`
- `pnpm exec vitest run packages/browser/browser-workspace packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/tool-browser --coverage --coverage.include='packages/browser/browser-workspace/src/**/*.ts' --coverage.include='packages/browser/browser-runtime/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-deterministic/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-tandem/src/**/*.ts' --coverage.include='packages/browser/tool-browser/src/**/*.ts'`
- `pnpm run test:snapshot -t 'temporary Browser Profile|Tandem Browser Profile'`
