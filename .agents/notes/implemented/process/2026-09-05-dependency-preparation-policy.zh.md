# Agent Note：仓库检查的显式依赖准备

Status: implemented

[English](2026-09-05-dependency-preparation-policy.md) | 中文

## 问题

pnpm 11 默认 `verify-deps-before-run` 为 `install`。任何已安装状态过冷或过旧的 `pnpm run`/`pnpm exec` 都会先隐式执行一次完整的 `pnpm install`：它会运行根 `postinstall`（`install-lefthook`），并重放上次安装的参数——上次以 `--prod`/`pnpm_config_production=true` 安装过的检出会得到 `pnpm install --production`，裁掉检查所需的 dev 依赖。设置漂移（例如 `publicHoistPattern`）会把隐式安装引向 modules 清除，而清除在没有 TTY 时无法确认，以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 失败；`verifyDepsBeforeRun: prompt` 则以 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 失败。这是两条不同的非交互失败路径。`CI=true` 本身不是其中任何一个：它只默认 `frozen-lockfile` 并禁用清除确认提示。

## 决策

`pnpm-workspace.yaml` 声明 `verifyDepsBeforeRun: error`。仓库检查保留依赖一致性检查，在已安装状态过冷或过旧时响亮失败；准备永远是同一环境类的显式 `pnpm install --frozen-lockfile`（CI 下安装的状态携带 `enableGlobalVirtualStore: false`，非 CI 运行会将其报告为已更改的设置）。`scripts/verify-dependency-policy.ts` 是被执行的门：它在默认、`CI=true` 和冷状态下用离线 `file:` 依赖 fixture 走 `pnpm run` 与 `pnpm exec`，断言错误码、保留的 dev 依赖哨兵、未变的 lockfile 和零隐式安装生命周期，再证明负控——去掉该策略的同一 fixture 会静默安装。门会剥离继承的 `pnpm_config_verify_deps_before_run`（pnpm 的脚本启动器为子脚本将其设为 `false`），使 fixture 由自己的 workspace 配置治理，并单独演示故意环境覆盖依然生效。

## 备选方案

**保留 pnpm 默认并写文档。** 无需改动配置。但每个过冷或过旧的检出都会在第一次检查时副作用式地改动依赖，生产重放清除距一个环境变量之遥。

**设置 `verifyDepsBeforeRun: prompt`。** 交互贡献者获得选择。非交互检查运行——CI、钩子、调度器派生的门——以提示专属错误失败，而验收要求非交互失败携带可操作的安装指引而非确认请求。

**包装每个仓库 pnpm 调用来强制该策略。** 由脚本启动的包装器在 pnpm 自身的 pre-run 钩子之后运行，保护不了那个钩子；通过环境消毒强制该设置会把优先级伪装成安全边界。门改为记录并测试覆盖优先级。

## 后果

例行检查永不改动已安装依赖；冷 worktree 和过旧检出以 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 失败，文档化的 frozen 安装即修复。刻意用 `--prod` 安装的生产与部署工作流继续可用——该策略只治理 pre-run 校验，不治理安装模式。用户刻意导出 `pnpm_config_verify_deps_before_run` 或传 CLI 标志时，按 pnpm 文档化优先级覆盖仓库默认；这是选择的环境，不是本策略声称要阻止的缺陷。由另一个 pnpm 脚本启动的每个脚本都继承 `pnpm_config_verify_deps_before_run=false`，嵌套 `pnpm run` 不会再次校验——该策略的保证作用于顶层调用。
