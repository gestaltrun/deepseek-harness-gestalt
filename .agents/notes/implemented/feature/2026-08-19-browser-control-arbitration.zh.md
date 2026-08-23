# Agent Note: Browser 修订号仲裁

Status: implemented

[English](2026-08-19-browser-control-arbitration.md) | 中文

## 问题

人与 Agent 驱动的操作可能影响同一个真实标签页。如果没有共享修订号，基于过期观察的 Agent 写入会覆盖更新的页面状态，或丢失调用方所依赖的 Session、Profile、浏览器实例与标签页身份。

## 决策

每个打开或不可用页面状态都携带后续写入必须匹配的修订号。Provider 串行执行每次写入，并以 `BROWSER_REVISION_CONFLICT` 拒绝过期的 `expectedRevision`；冲突会写出当前修订号，并要求 Agent 重新 observe。`navigate`、`focus`、Agent 合成 `input` 与 `close` 推进修订号，`observe` 与 `screenshot` 只读。写入过程中，Session、Profile、浏览器实例与标签页身份保持稳定。

`dsh-browser-workspace` 把每个标签页的最新修订号持久化到 Session 的 `browser/workspace` 快照，供 Session 切换与重新加载后恢复乐观并发事实。Browser 工具不设置 `ask` 或权限分类器；只有组合挂上现有审批与权限能力时，那些能力才会生效。

报告式所有权及其接管、交还操作已由[删除报告式 Browser 控制权与 Workspace Dock 状态](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md)取代。Desktop 直接页面交互与 Runtime 状态相互独立；修订号仍是唯一并发机制。

## 考虑过的替代方案

**不做修订号检查，后写覆盖。** 否决，因为迟到的 Agent 或 Workbench 命令会静默覆盖更新的页面或 Provider 恢复状态。

**给每个写入方另开一个浏览器实例或转移页面。** 否决，因为调用方需要在写入序列中持续寻址完全相同的 Session、Profile、浏览器实例与标签页。

**在页面状态之外使用单独的写入版本。** 否决，因为页面状态与 Session Workspace 快照已经携带所有写入方都会观察和提交的修订号。

## 后果

过期写入会明确失败，并强制重新观察。Session 快照保留 Workbench 与工具写入需要的修订号，不报告控制权所有者。

## 验证

- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/browser-workspace packages/browser/tool-browser`
- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/browser-workspace packages/browser/tool-browser --coverage --coverage.include='packages/browser/browser-runtime/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-deterministic/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-tandem/src/**/*.ts' --coverage.include='packages/browser/browser-workspace/src/**/*.ts' --coverage.include='packages/browser/tool-browser/src/**/*.ts'`
- `pnpm run test:snapshot -t 'temporary Browser Profile|Tandem Browser Profile'`
- 真实 Tandem e2e 仍由 `DSH_TANDEM_CHECKOUT` 与 `DSH_TANDEM_BIN` 门控；两者都设置时覆盖两种到达顺序。
