# Agent Note: 用 Git submodule 钉住树外 Gestalt 插件

Status: proposed

[English](2026-08-27-external-plugin-submodules.md) | 中文

## Problem

Gestalt 在独立 GitHub 仓库中开发可安装的 DeepSeek Harness 插件，使每个插件都能独立于 Desktop Bundle 做版本、发布和原生运行时包。贡献者仍需要仓库内对「当前开发所针对的精确修订」的耐久指针，而不能把源码拷进 `packages/`，也不能把 Docker 当成 Desktop 安装路径。

对话里的浮动 URL、checkout 旁一份未记录的克隆，或把外部历史改写入本仓库的 git subtree，都会丢掉该指针：各克隆不一致，`packages/` 的门禁开始拥有外部代码，Desktop 打包也无法区分源码钉住点和安装载荷。

## Proposal

新增顶层 `plugins/` 目录，用 Git submodule 做目录。每个子项是一个树外插件仓库。记录的 submodule SHA 就是钉住点。`plugins/README.md` 是目录契约。

第一个子项是 [`gestaltrun/dsh-sub2api-sidecar`](https://github.com/gestaltrun/dsh-sub2api-sidecar)，路径 `plugins/dsh-sub2api-sidecar`。该插件仍是独立产品：它监督本机 Sub2API 进程，签发一把 `admin-` key 供 Host 侧 admin HTTP、一把 `sk-` key 供 Composite 推理，并通过 `dsh-llm-pi-ai` 登记 Composite 端点。Gestalt Desktop 随后展示 Offer 卡，启用时下载已构建组合包和平台运行时包。submodule 不成为该载荷，也不加入 `pnpm-workspace.yaml`。

`vendor/` 仍是树内 Cordis 源码。`packages/` 仍是 `@deepseek-ai/dsh-*` workspace。Gestalt 之后作为一等 harness 包交付的插件仍迁入 `packages/`。

默认 `git clone` 在执行 `git submodule update --init --recursive` 前让目录子项保持为空。需要插件源码的 CI 任务在 `actions/checkout` 上设置 `submodules: recursive`。只需要 harness 源码的任务保持默认空 checkout。

## Alternatives considered

**Git subtree。** subtree 把插件历史拷进本仓库，使 `git log` 和 `git blame` 混入两个产品。更新变成 subtree 合并提交，而不是一行 SHA 移动。插件无法把独立 GitHub 默认分支当作权威源。

**只在 README 里写 GitHub URL。** 克隆不会拉取插件，CI 无法复现钉住点，记录的修订只活在散文里。

**把插件放进 `vendor/` 或 `packages/`。** `vendor/` 是带 rescope 和本地修改日志的 Cordis 框架层。`packages/` 是 CI 做 typecheck、覆盖率和发布的 pnpm workspace。sidecar 的 Go 运行时、Postgres 和 Redis 包不得进入那些门禁。

**从 Gestalt 的 package.json 用 npm `file:` 或 git 依赖。** 这会让每个 Desktop 开发者的安装都绑上插件 workspace，并且仍不能给需要在 harness 旁阅读插件源码的 agent 一份可浏览的仓内 checkout。

**把 Docker Compose 当 Desktop 默认。** Gestalt 交付 Electron 加自带 Node。再要求 Docker Desktop 是第二次产品安装，不是启用下载。

## Acceptance criteria

- `plugins/` 存在，记录目录，并把 `dsh-sub2api-sidecar` 记为 `https://github.com/gestaltrun/dsh-sub2api-sidecar.git` 的 submodule。
- 不带 `--recurse-submodules` 的全新克隆仍是有效的 harness checkout；初始化 submodule 会检出记录的 SHA。
- `pnpm-workspace.yaml` 和 TypeScript 工程引用不包含目录子项。
- Agent Note 写明 Sub2API 的两套凭据（`admin-` 用于 admin HTTP，`sk-` 用于 Composite 推理），以免后续 Desktop 工作把它们收成一把 token。

## Risks

忘记 `git submodule update` 的贡献者会看到空目录，并可能把目录当成缺失。README 写明初始化命令。之后要 typecheck 插件源码的 CI 必须选择递归 checkout；静默的空目录会掩盖这次遗漏。

submodule 钉住点会落后于插件默认分支，直到一次 Gestalt 提交移动它。这种落后正是钉住的意义：Desktop 和 agent 复现的是一个 SHA，不是 `main` HEAD。
