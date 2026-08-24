# Agent Note：hosted CI 缓存生产者

状态：已实现

[English](2026-08-24-hosted-ci-cache-producer.md) | 中文

## 问题

PR job 会恢复依赖和浏览器缓存，但没有默认分支 owner 生产其 namespace。旧的 merge-ref 条目可能暂时存活，随后被逐出，使所有 restore 在没有可见解释的情况下转冷。宽泛 fallback key 还可能跨越 Node、pnpm、架构或 lockfile 变化，而缓存 workspace 依赖会带入可变构建状态。

## 决策

`CI cache producer` 会在每次 master push、每日以及手动 dispatch 时，针对 hosted Linux x64 和 Windows x64 运行。它固定 Node 24 与 pnpm 11.7.0，配置平台的内容寻址 pnpm store，执行 immutable install，准备 Playwright Chromium，并且只保存这两个自有缓存目录。

PowerShell setup 会先在当前进程设置 `PNPM_CONFIG_STORE_DIR`，再解析 `pnpm store path`，同时通过 `GITHUB_ENV` 将它导出给后续步骤。因此 cache action 拥有的版本化目录正是后续 install 写入的目录；如果只写入 `GITHUB_ENV`，当前步骤仍会解析到 `pnpm/action-setup` 的临时 store，而该目录会在 job 收尾时被删除。

Producer 与 consumer 使用完全相同的 key 形式：仓库 namespace、OS、架构、Node、pnpm、缓存种类和 lockfile 摘要。Restore fallback 只移除最后的 lockfile 摘要，因此不会跨越任一环境组件。PR worker 使用仅恢复 action，并保留无条件 install 与 Playwright 准备，使未命中或 lockfile 过期只会进入冷启动但正确的路径。

Gate 报告会解析 workflow 提供的带版本 cache-evidence 数组，并记录每个 cache id、primary key、matched key 和精确命中布尔值。Workflow contract tests 会固定 producer trigger、平台矩阵、key、fallback 前缀、干净 install、consumer restore、PowerShell 在解析路径前完成当前进程配置，以及 cache path 中不存在 `node_modules`。

## 考虑过的替代方案

**让 PR 保存自己的缓存。** 拒绝，因为 merge-ref cache scope 无法建立稳定的默认分支 producer，而且上传延迟不应进入反馈关键路径。

**使用只包含 OS 的宽泛 restore 前缀。** 拒绝，因为架构、Node 或 pnpm 变化可能复用不兼容 store。

**缓存 workspace `node_modules`。** 拒绝，因为链接 workspace 与生成输出属于可变状态，而不是内容寻址的依赖下载。

## 后果

温启动 install 与浏览器准备现在拥有显式 producer 和可审计 consumer 结果。冷缓存仍是受支持路径，而不是失败。首轮 hosted run 会提供优化前后的 setup 样本；未来 Node、pnpm 或平台变化会自动创建新 namespace。
