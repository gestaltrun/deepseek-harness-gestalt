# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Gestalt 的 Desktop Host。Electron 拥有窗口、菜单、GitHub 自动更新，以及进程内 Browser Runtime `webContents`。它启动捆绑的官方 Node 加上 `dsh web --patch ./cordis.patch.yml --no-open --host 127.0.0.1 --port 0`，并打开该环回 URL。`--no-open` 阻止再唤起系统默认浏览器，因为 Desktop Host 已经拥有窗口。叠加层加入 Schedule、GESTALT 次标、拖拽带、Update Control，以及指向 Host loopback Browser origin 的 Tandem 形态 HTTP 客户端；只有更新可操作或发现版本后发生错误时，控件才会出现。浏览器 `dsh web` 不加载这层，并继续使用确定性 Browser Runtime。

在所有平台关闭最后一个窗口时，会先以 `window-close` 原因排空 Relay；Ctrl+C、quit 与 smoke 测试结束都会取消尚未完成的启动，停止 Personal Pairing 与受生产 gate 保护的 Relay owner，停止 Web Host，释放隐藏 Browser 窗口，并等待其工作排空后再终止 Electron。系统 sleep 会停止 Remote Access；resume 只为仍处于登录状态的账号重新加载。源码 Electron smoke 会在 sleep、关闭手机访问、关闭窗口与 quit 后读取各次 Relay owner 状态，再检查 Web Host 子进程 PID 已消失。首次启动或后续 Host 崩溃共允许一次重试，之后窗口才显示 Host 错误。不存在无窗口 daemon、后台 Host 或 remote wake 路径。Chromium 持久 partition 位于 Electron `userData/Partitions/<name>`；loopback API token 放在 `userData/browser-runtime` 下，绝不写入 Tandem Browser Application Support。Dock 仍是截图、标题与文本的原生窗格。

主窗口只接受当前环回 Host 同源导航。包括 GitHub 授权在内的普通 HTTP 链接交给系统浏览器；其他来源和 scheme 不能替换 Session Surface，也不能创建另一个 Electron 窗口。Platform 账号签名密钥和令牌保存在 Electron userData 下、按环境分开的文件中：生产身份使用 `safeStorage`，环回开发使用仅所有者可读的文件字节，以免授权卡在操作系统加密上；preload 只暴露当前状态与生命周期动词。Account 的 `beginLogin` 立即返回当前快照，因此 Settings 不会在 Host Account HTTP 期间被堵住。

个人配对只在真实的 `手机配对` 设置区中配置。preload 暴露手机访问、挑战、待确认决策与已配对设备操作，不会向普通 Session 标题栏、侧栏、审批、输入框或离线视图增加状态。账号登录后，由 Host 拥有的控制器为每项远程访问操作签署新的当前安装证明，在设置中的配对开关开启时轮询待确认决策，并在调用变更前校验 renderer 传入的布尔值与带品牌的待确认 id。同一个 owner 只在手机访问开启时启动注入的 Relay lifecycle，并在关闭开关、退出账号、sleep、关闭窗口或 quit 时停止。开发环境只有同时设置 `DSH_PERSONAL_PAIRING_KEYLESS=1` 与 `DSH_REMOTE_RELAY_WSS_URL`、`DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS`、`DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS`、`DSH_REMOTE_RELAY_RECONNECT_DELAY_MS`、`DSH_REMOTE_RELAY_INBOUND_MAX_BYTES`、`DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES`，才会选择真实 HTTP 与 WSS 控制器；完整配置会在创建窗口或获取网络资源前校验。无密钥开发以 `desktop-development-keyless` 附着，并把 Mobile 寻址为 `mobile-development-keyless`。一字节入站帧回开发同步帧，以便 Mobile 标记 Desktop 权威同步。更长的帧按 Encrypted Companion 消息打开；Host 拥有的开发权威确认 `create-session`、`submit-prompt`、`cancel-prompt`、`offer-attachment`、`settle-approval`、`answer-ask-user` 和 `query-operation-status`。`submit-prompt` 先投影带 `streaming: true` 的用户行，再在 `DEVELOPMENT_COMPANION_STREAM_DELAY_MS` 之后投影助手行以及待结算的审批与 Ask User 卡片，除非先收到 `cancel-prompt`。未过期的 `offer-attachment` 投影 `image` 条目或 `Attached:` 文本行；过期 capability 返回 `attachment-rejected`。该权威不是产品 Host Session 适配器，也不是经过评审的 Companion 密码实现。生产环境在独立 Noise 评审接纳经过评审的握手与 Companion channel provider 前保持不可用。Host 永远不会组装仅用于证明的 Snow 实现或任一 keyless provider。

挂载 Account HTTP、无密钥个人配对和 Relay WSS 的环回双实例开发监听见 [`examples/local-companion-platform`](../../examples/local-companion-platform/README.md)。当所选 origin 是环回 HTTPS 时，Account 与 Remote Access Fetch 以及 Relay WSS 通过 Node `https.request` 接受捆绑的监听证书，GitHub 授权也在进程内完成且不跟随页面回跳 Location，因此系统浏览器不必出示该证书。Desktop Platform 账号会在创建窗口前校验完整开发与生产环境对：`DSH_PLATFORM_DEVELOPMENT_*` 和 `DSH_PLATFORM_PRODUCTION_*` 两侧分别提供 `ORIGIN`、`CALLBACK_URL`、`GITHUB_CLIENT_ID`、`CREDENTIAL_REFERENCE`、`DATABASE_IDENTITY` 与 `IDENTITY_NAMESPACE`，再由 `DSH_PLATFORM_ENV` 显式选择一侧。缺失、未知、共享、非 HTTPS 或回调不匹配的配置会在渲染与网络流量前使启动失败。操作系统加密不可用仍会作为明确的能力失败显示。加密记录通过 `dsh-atomic-write` 的随机独占同级文件、仅所有者权限、符号链接安全 rename 与失败清理完成替换。

Window Chrome 在 Desktop 侧栏、Session 内容与顶部 Workbench 上统一使用一条 36px 行。在 macOS 上，侧栏与 Session 区域可在 traffic lights 周围拖动窗口；Workbench 只把 `+` 后的未占用空间作为拖拽区，标签与控件仍可交互。Windows 使用同一行，最小化、最大化和关闭按钮各占 46px。纯浏览器 `dsh web` 保留 34px Workbench 标签栏，且不渲染窗口拖拽区。未支持平台的开发运行保留系统窗口框架。

Desktop 将 `build/icon.icns`、`build/icon.ico` 和 `build/icon.png` 作为自有资源，其字节与千机·Gestalt 已跟踪的生产图标一致。electron-builder 在 macOS 使用 ICNS，并将 ICO 资源写入未签名的 Windows 可执行文件；发布 workflow 会校验该 PE 文件包含最大的源 ICO 帧。main build 会把 PNG 复制到未打包 Electron application path 下，供 macOS Dock 与 Windows 窗口使用；打包则把同一 PNG 安装为显式 extra resource。

Dock / 开始菜单的 cwd 是 Launch Directory（Application Support / `%APPDATA%` 下的 `defaultWorkspace`）。用户数据仍在 `~/.dsh`。

## Schedule 与能力默认值

每个新 Desktop Session 都会提供 `schedule_create`、`schedule_list` 和 `schedule_delete`。绝对时间 `schedule_create.at` 必须带显式偏移量或 `time_zone`。Desktop 不挂载 `@deepseek-ai/dsh-time-context`；逐 step 时间读数仍由 Schedule Web overlay 注入。

当前 Session 保留提醒时，会话标题栏会在后台任务之后紧接显示 Schedule 任务板。其计数包含等待中与待补跑提醒，但排除已暂停提醒。任务板读取独立 Session projection，并支持持久化暂停、恢复与行内二次确认删除；它没有创建表单，也不从工具 transcript 卡片推断状态。

Schedule 交付为 `session-local`：只有原 Session 处于 live 状态时才会运行提醒，重新打开该 Session 会尝试处理逾期任务。关闭 DeepSeek Gestalt 不会产生操作系统、浏览器、邮件、短信或其他外部通知。

锁定的 Web Host 快照包含一些 Desktop 默认不激活的包。默认配置不设置任何 MCP server；Cordis 自修改与 Code Mode / PTC preset 仍可选择，但都不是默认 preset；standard preset 中的 `subagent_codex` 与 `subagent_claude_code` 模板保持关闭；Web 能力提供 `web_search`，但不提供 `web_fetch`。production HMR 保持关闭，全文 Session 搜索仍需显式启用（`session-query-sqlite` 使用 `openAt: never`）。headless、ACP 与 JSON-RPC example 是其他应用组合，不是 Desktop 插件。

## 开发

```sh
pnpm install
pnpm gestalt:dev
```

需要 `DSH_NODE` 或 `npm_node_execpath` 上的真正 Node（pnpm 会设置后者）。不要让 Electron 用自己的 execPath 去跑 `dsh`。

## 发布

从 `master` 运行 `Desktop Release` workflow，填写包版本并选择 `publish`。macOS arm64 与 x64 会先在匹配架构的 GitHub runner 上安装依赖；发布构建通过 `desktop-release` environment 完成签名和公证，dry run 不接收发布凭据。Windows NSIS 未签名但仍更新。workflow 会校验每个官方 Node 归档、启动每个打包目标、通过 Desktop bridge 往返读取 disabled 更新状态、等待 renderer 应用该状态、要求未激活的 Update Control 保持缺席、检查 Mac app 的签名和已装订公证票据，在已测试提交上创建 `gestalt-v<version>` 标签与 draft Release，上传并核验精确的安装包、blockmap 与更新 feed 集合，然后发布 Release。交接失败或中断时，workflow 会删除本次运行拥有的标签和 draft。macOS 在 zip 落地后由 Squirrel 把包拷到临时目录，Update Control 显示“正在准备更新”；该阶段结束后才出现“安装并重启”。普通退出仍不会安装。

每个发布版本都必须在 `release-notes/` 下提供双语 manifest（元数据清单），并显式指定基线类型、仓库和提交。创建标签前，工作流会校验 manifest 版本及其派生标签，确认该基线是受测提交的祖先，从 Git 计算提交数，并把 draft 正文渲染到 notes file。`0.1.0` manifest 使用 `official-upstream` 基线 `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`；正文链接从该提交到 `gestalt-v0.1.0` 的完整比较。`0.1.1` manifest 使用 `previous-release` 基线 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@de2610c9590f2e5b33ab366eb338f7c42058b11b`（`gestalt-v0.1.0`）。`0.1.2` manifest 使用 `previous-release` 基线 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@a7482b9709e4631d624f6b471ef2aeec249baf7d`（`gestalt-v0.1.1`）。`0.1.3` manifest 使用 `previous-release` 基线 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@4bbbf74a07799fb681e033288fb55b3b16fc08c0`（`gestalt-v0.1.2`）。`0.1.4` manifest 使用 `previous-release` 基线 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@f5d133a9c00138b1a3e7ce180118b8262f38399a`（`gestalt-v0.1.3`）。`0.1.5` manifest 使用 `previous-release` 基线 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@a2a4c245c7a177891bdbf7238279136e63625a34`（`gestalt-v0.1.4`）。

本机未签名 arm64 排练（不做公证）：

```sh
node apps/desktop/scripts/fetch-node.mjs --platform darwin --arch arm64
pnpm --ignore-scripts --config.node-linker=hoisted --config.inject-workspace-packages=true \
  --filter @deepseek-ai/dsh deploy --prod apps/desktop/resources/dsh
node apps/desktop/scripts/isolate-dsh-snapshot.mjs
pnpm --filter @deepseek-ai/dsh-desktop package:unsigned
```

hoisted deploy 会纳入工作区包，但不带 pnpm 的链接式虚拟依赖图。`pnpm deploy` 仍会留下少量指向仓库的 `file:` 链接；isolate 一步把这些目标拷进快照，让打包后的 Web Host 能在仓库外解析 `dsh`，并确保 Windows 安装器不会归档目录 junction。

## Known Limitations and Deferred Work

- **安装包里的 Node + dsh 快照由发布 workflow 组装** — `gestalt:dev` 跑的是工作区源码树。
- **没有 Windows Authenticode** — SmartScreen 会警告；更新器仍会运行。
- **生产个人配对密码实现尚未组装** — 显式开发 keyless 配置可以执行真实 HTTP/WSS 生命周期，但不提供产品 Companion 密码实现；在独立 Noise 评审接纳产品提供方前，生产设置与 Host bridge 保持 fail-closed。
