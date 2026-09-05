# Agent Note：仓库检查的显式依赖准备

Status: implemented

[English](2026-09-05-dependency-preparation-policy.md) | 中文

## 问题

pnpm 11 默认 `verify-deps-before-run` 为 `install`。顶层 `pnpm run` 或 `pnpm exec` 遇到过冷或过旧的已安装状态时，可能会在请求的命令之前隐式执行 `pnpm install`，包括安装生命周期。重放的安装设置还可能裁掉检查所需的 dev 依赖。非交互失败有不同原因：`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 表示依赖校验拒绝，`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 表示安装需要确认清除 `node_modules`。`CI=true` 会影响安装默认值和确认行为；它本身既不选择生产依赖，也不修复过旧状态。

## 决策

`pnpm-workspace.yaml` 声明 `verifyDepsBeforeRun: error`。仓库检查保留 pnpm 的一致性校验，在已安装状态过冷或过旧时失败；贡献者使用同一环境类中的 `pnpm install --frozen-lockfile` 准备依赖。`scripts/verify-dependency-policy.ts` 以相互独立的离线 `file:` fixture，在本地与 `CI=true` 环境中执行顶层 `pnpm run` 和 `pnpm exec`。它隔离 home、store、cache、用户配置和 global 目录，限制每个进程时长，比较 lockfile 字节，并验证过旧与过冷拒绝、dev 依赖保留、请求命令与生命周期未运行、frozen 安装恢复、默认隐式安装，以及刻意的环境和 CLI 优先级。门还证明等长内容得到不同 hash，避免仅比较大小形成伪证据。

## 备选方案

**保留 pnpm 默认并写文档。** 无需改动配置。但每个过冷或过旧的检出都会在第一次检查时副作用式地改动依赖，生产重放清除距一个环境变量之遥。

**设置 `verifyDepsBeforeRun: prompt`。** 交互贡献者获得选择。非交互检查运行——CI、钩子、调度器派生的门——以提示专属错误失败，而验收要求非交互失败携带可操作的安装指引而非确认请求。

**包装每个仓库 pnpm 调用来强制该策略。** 由脚本启动的包装器在 pnpm 自身的 pre-run 钩子之后运行，保护不了那个钩子；通过环境消毒强制该设置会把优先级伪装成安全边界。门改为记录并测试覆盖优先级。

## 后果

例行检查永不改动已安装依赖；冷 worktree 和过旧检出以 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 失败，文档化的 frozen 安装即修复。刻意用 `--prod` 安装的生产与部署工作流继续可用——该策略只治理 pre-run 校验，不治理安装模式。用户刻意导出 `pnpm_config_verify_deps_before_run` 或传 CLI 标志时，按 pnpm 文档化优先级覆盖仓库默认；这是选择的环境，不是本策略声称要阻止的缺陷。由另一个 pnpm 脚本启动的每个脚本都继承 `pnpm_config_verify_deps_before_run=false`，嵌套 `pnpm run` 不会再次校验——该策略的保证作用于顶层调用。
