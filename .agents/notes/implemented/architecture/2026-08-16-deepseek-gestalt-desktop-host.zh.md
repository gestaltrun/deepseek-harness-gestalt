# Agent Note: DeepSeek Gestalt Desktop Host

Status: implemented

[English](2026-08-16-deepseek-gestalt-desktop-host.md) | 中文

## Problem

只有 `dsh web` 会注入 `window.__DSH_BOOT__` 并提供 Session Surface。用户若要可安装窗口、GitHub 版本发现和自动更新，既不能靠 CLI，也不能打开 Vite 入口。在 Electron 里重做 Host 会分叉引擎，并破坏现有的工作区、选目录和会话模型。

## Decision

DeepSeek Gestalt 是 Desktop Host：Electron 拥有窗口、应用菜单、进程寿命和更新检查。启动时拉起捆绑的官方 Node 加上锁死的 `dsh web` Web Host（`--host 127.0.0.1 --port 0 --no-open`），并打开该环回 URL。Desktop Host 已经拥有窗口，因此 spawn 与叠加层都让操作系统默认浏览器保持关闭（[Desktop Web Host `--no-open`](../bug-fix/2026-08-22-desktop-web-host-no-open.md)）。Web Host 保留全部 Host 能力，包括原生选目录。

Electron 在退出阶段继续监管 Web Host。窗口退出、终止信号和 smoke 结束都会取消尚未完成的启动、停止子进程，并等待进程退出后才终止 Desktop Host；主动关闭不会触发一次性崩溃重启。可信主窗口停留在当前环回 origin，普通网页链接交给系统浏览器，并拒绝其他导航和所有新 Electron 窗口。

第一个 Desktop Bundle 是 `0.1.0`，与 npm `dsh` 版本线独立。app id 为 `com.gestalt.deepseek`。显示名为 DeepSeek Gestalt。更新源是 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt` 上的 GitHub Releases（`gestalt-v*` 标签，非 prerelease）。每个 macOS 目标都先在匹配架构的 runner 上安装与部署，再使用千机团队身份公证；Windows 发未签名 NSIS 仍更新。普通退出不会安装已下载更新。Update Control 显示截断后的整数下载百分比。在 macOS 上，zip 落地后控件保持 `preparing`，直到原生 Squirrel 完成 stage，然后才提供「安装并重启」。updater 处于 installing 时，`before-quit` 不取消 Electron 退出，以便 `quitAndInstall` 能替换应用。在 macOS 上，`autoInstallOnAppQuit` 只在下载后把 zip 预取进 Squirrel。

Desktop 在 `apps/desktop/build/` 下拥有 ICNS、ICO 与 512x512 RGBA PNG 应用图标。这些文件保留千机·Gestalt 源提交 `70ddb80bdfc713493dea8c3fc451817365a63f06` 中已跟踪生产资源的字节；固定的 SHA-256 摘要依次为 `da6a1174df80af2efadf763b22f8bc37f355680f8315f9ab78a8c59991c60e25`、`46a26b6a0e98e4a96e6151d7627b3a779af57c9214ff960a8447c618cfd88387` 和 `8eb4eb7cc767a5d929fee6715e78d5360ebca184996d757ffef18db90319c802`。electron-builder 在 macOS 使用 ICNS，并将 ICO 资源写入未签名的 Windows 可执行文件。发布 workflow 要求 PE 文件在 smoke 和上传前包含每个最大分辨率的源 ICO 帧。PNG 是打包后的运行时资源、未打包的 macOS Dock 图标和 Windows BrowserWindow 图标；打包后的 macOS 保留由 ICNS 生成的应用图标。

Desktop Release 从 `master` 手动运行，并显式指定 Desktop Bundle 版本。发布运行会先用 `apps/desktop/package.json` 校验该版本并拒绝已有标签；macOS 发布打包只在 `desktop-release` environment 中进行，该 environment 的分支策略只允许 `master`，并提供证书与 Apple 公证 secrets。无凭据运行使用另一个 environment，显式关闭 macOS identity 选择和公证。CLI 组装显式提供 Web 和 headless provider 使用的服务定义，让 production-only 部署保留与源码启动相同的插件导入闭包。每个平台都部署注入工作区包的 hoisted 生产快照，再实体化剩余的文件链接；因此 Windows 安装器不会收到供 7zip 遍历的 pnpm 目录 junction 图。每个发布构建都强制签名，并在上传 artifact 前验证 app 签名和已装订的公证票据。两个 macOS 架构和 Windows 都通过已打包 smoke 后，发布 job 校验精确的版本化安装包、blockmap 和更新 feed 集合，按受测 Git 历史校验仓库内双语 release-note manifest（元数据清单），并在创建本次运行拥有的 `gestalt-v<version>` 标签与 draft GitHub Release 之前渲染 notes file。每个 manifest 都显式指定基线类型、仓库和提交，Git 提供发布目标和提交数。第一个 bundle 使用 `official-upstream` 基线 `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`，并比较该提交与 `gestalt-v0.1.0`；后续 bundle 可以使用 `previous-release` 基线。job 随后上传资产、核对远端文件名，再发布非 prerelease Release。交接失败或中断时会删除本次运行拥有的 draft 和标签，使同一候选版本可以重试。

Desktop 在 Web profile 之后只加一层 `--patch`：`@deepseek-ai/dsh-time-context` 与 `@deepseek-ai/dsh-schedule` 位于其所需的 persistence 和 Agent 服务之后，随后把 GESTALT 次标、拖拽带与 Update Control 加入 Session Surface。每个新 Desktop Session 都会提供 `schedule_create`、`schedule_list` 与 `schedule_delete`。提醒交付仅限 Session 内：只有原 Session 处于 live 状态时才会运行，重新打开该 Session 会重试逾期任务，并且不会发送操作系统或外部通知。浏览器 `dsh web` 不加载该 overlay，因此其中的 Schedule 与 time-context 仍需显式启用。

Update Control 只在可操作的更新阶段和发现版本后的 error 阶段占用侧栏 seat；disabled、idle、checking 和发现版本前的 error 阶段不渲染。从 Dock 启动时，Web Host 的 cwd 是 `~/Library/Application Support/DeepSeek Gestalt/defaultWorkspace`（Windows：`%APPDATA%\DeepSeek Gestalt\defaultWorkspace`），进程 cwd 不是安装目录。Session Surface、`~/.dsh` 和 web profile 仍然共用。

锁定 Web Host 快照中存在某个包，并不表示相应能力已经激活。Desktop 不配置任何 MCP server；Cordis 自修改与 Code Mode preset 可供选择但不是默认值；standard preset 保留关闭的 Codex 与 Claude Code subagent 模板；Web 能力提供搜索但不提供 fetch。production HMR 保持关闭；因为 `session-query-sqlite` 使用 `openAt: never`，全文 Session 搜索仍需显式启用。headless、ACP 与 JSON-RPC example 是其他应用组合，不是 Desktop 插件。

Window Chrome 在 Desktop 侧栏、中间 Session 内容与顶部 Workbench 上统一使用一条 36px 行。在 macOS 上，侧栏与中间区域围绕 traffic lights 构成连续拖拽区。Workbench 只用 `+` 后可伸缩的未占用空间拖动窗口；标签、控件与标签投放仍可交互。Windows 使用同一行，把三个 caption 按钮设为不可拖拽区域，并把中间 Session 栏同步下移 36px，使 Session 顶栏留在拖拽条下方（[Windows Desktop Session 顶栏下移](../bug-fix/2026-08-22-windows-desktop-session-header-inset.md)）。纯浏览器 Web 保留紧凑的 34px Workbench 标签栏，且不渲染窗口拖拽空间。未支持平台的开发运行保留系统窗口框架。

右侧和底部 Workbench 在关闭时保留各自的偏好尺寸，但只在可见时独立占用布局空间。拖动底部 Workbench 不会应用已关闭右侧 Workbench 保留的宽度，窄屏浮动抽屉也不占用布局空间。

## Alternatives considered

**用 Electron 当 Web Host（`ELECTRON_RUN_AS_NODE`）。** 所有原生插件都要按 Electron ABI 重编，引擎行为和 CLI `dsh web` 会分叉。

**像千机·Gestalt 那样一工作区一窗口。** 现有 Session Surface 已经在一个侧栏里列出全部 Workspace。

**第一代 feed 用官方 `deepseek-ai/deepseek-harness` Releases。** 当前 origin 是个人 fork；以后改 feed 会让已装包断更。

**Windows 先 Authenticode 再发更新。** electron-updater 可以更新未签名 NSIS；代价是 SmartScreen。Mac 仍然必须公证。

**用 Electron 对话框替换原生选目录。** 那会改 Web Host 能力。Desktop 只补 Apple Events entitlement，让现有 osascript 选择器在 Hardened Runtime 下能跑。

**在运行 workflow 前先创建发布标签。** 该标签会指向未经检查的候选版本，并在打包或 smoke 失败后残留。发布 job 只在所有目标通过后才与 Release 一起创建标签。

**启用 Desktop Bundle 中存在的每一个包。** 锁定快照中的包属于解析清单，而不是产品授权。默认启用可信 MCP 命令、自修改、其他工具呈现方式或特定产品 subagent provider，会在没有用户决策的情况下扩大 Desktop 能力集合；overlay 只激活本产品所需的 Session 内提醒插件对。

**使用 GitHub 自动生成的 Desktop release notes。** 自动生成的说明会枚举已合并 PR，却不能确定官方上游基线、完整产品分类或同等完整的中英文内容。这些事实由仓库内 manifest 和经过验证的 renderer 负责。

## Verification

- `pnpm gestalt:dev` 启动 Desktop Host，由它启动 Web Host，并在环回 URL 上加载带 `window.__DSH_BOOT__` 的页面（不是裸 Vite）。
- 浏览器 `dsh web` 仍是 HARNESS 次标，没有拖拽带，也没有 Update Control。
- Desktop 组合显示 GESTALT 次标和 logo 行上方的拖拽带。Update Control 渲染测试确保不活跃阶段不出现，可操作阶段与设置位于同一脚部行。
- macOS 展开和收起布局让侧栏、中间 Session 内容与顶部 Workbench 在 36px Window Chrome 上对齐；中间区域与 Workbench 未占用空间可以拖动窗口，且不会吞掉标签或控件。Windows 把 caption 按钮放在同一行右侧，并把中间 Session 内容下移 36px。纯浏览器 Web 保留可交互的 34px 标签栏，且没有窗口拖拽节点。
- 右侧 Workbench 关闭时拖动底部 Workbench 会保持 Session 列表宽度和中间列的水平边界；各面板保留的尺寸只在该面板可见时影响布局。
- Dock 式启动把 Launch Directory 当作 cwd，并且不把该路径登记为 Workspace。
- Desktop 退出会等待尚未启动完成和正在运行的 Web Host 进程退出；smoke 测试会拒绝遗留子进程、缺失的 Desktop 组合或 updater bridge、尚未到达 renderer 的更新状态，以及可见但尚未激活的 Update Control。打包 smoke 会排空 Electron 的 stdout/stderr，避免 Windows 管道填满后卡住启动，并在进程于写入 `ok` 前退出时失败。缺少或无效的 Platform Account 部署配对会停用 Account 与 Pairing，但仍启动 Web Host。首次启动的 Platform Account 只在内存中保留 installation id，直到登录尝试才加密写入记录，且 Web Host 启动不等待这次 start。
- 无密钥浏览器 golden 会启动已交付 Web profile 与 Desktop overlay；release job 会校验 Node 归档摘要，在 macOS 签名前将打开文件数限制提升到 runner 硬限制，并对 `@electron/osx-sign` 应用有界的资源遍历。发布构建必须通过代码签名和已装订公证票据校验，并在上传前 smoke 每个打包目标。
- 无需启动 Host 的无密钥 CLI 检查会组合真实 Web profile 与 Desktop overlay，要求 time-context 和 Schedule 位于其依赖服务之后，并证明浏览器默认树不含这两个插件。组装出的无密钥 Desktop turn 会快照两条 time-context 消息、全部三个 Schedule schema、`schedule_list` 调用与结果，以及最终 assistant 回复。
- Desktop 图标测试固定三个源文件摘要及其容器签名，要求 512x512 RGBA PNG，检查 macOS、Windows、打包资源、Dock 与 BrowserWindow 的接线，并拒绝缺少最大分辨率 ICO 载荷的 Windows PE 文件。
- 发布计划测试覆盖版本、分支和已有标签校验；release-note 测试覆盖双语渲染、manifest 完整性、版本与标签一致性、Git ancestry、提交数计算和工作流顺序；发布资产测试要求两个更新 feed、全部版本化 macOS 与 Windows 安装包及其 blockmap，并排除未打包应用内部文件。
- 单测覆盖从 `dsh web:` 行发现 URL、Launch Directory 解析、不下载的更新阶段转换、整数下载百分比，以及 quitAndInstall 运行时不拦截 `before-quit`。

## Consequences

- 一次 Desktop 发布是 `dsh` 加 Electron 的快照。私有 Desktop app 不属于 npm `dsh` 发布家族，因此两条版本线保持独立。
- Desktop 用户默认获得仅限 Session 内的提醒；纯浏览器 Web 用户需要显式启用，而且两种宿主都不会因此获得外部通知。
- 公证后的 Mac 身份属于千机 Apple 团队。以后改 app id 等于新应用。
- 在有 Authenticode 证书之前，Windows 用户会看到 SmartScreen。
- 个人 GitHub feed 就是产品 feed；没有能保住已装包更新的迁仓路径。
- 发布运行必须先在 `desktop-release` environment 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，才能开始打包。
