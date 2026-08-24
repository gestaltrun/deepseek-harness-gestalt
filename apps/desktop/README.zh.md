# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Gestalt 的 Desktop Host。Electron 拥有窗口、菜单、GitHub 自动更新，以及进程内 Browser Runtime `webContents`。它启动捆绑的官方 Node 加上 `dsh web --patch ./cordis.patch.yml --no-open --host 127.0.0.1 --port 0`，并打开该环回 URL。`--no-open` 阻止再唤起系统默认浏览器，因为 Desktop Host 已经拥有窗口。叠加层加入 Schedule、GESTALT 次标、拖拽带、Update Control，以及指向 Host loopback Browser origin 的 Tandem 形态 HTTP 客户端；只有更新可操作或发现版本后发生错误时，控件才会出现。浏览器 `dsh web` 不加载这层，并继续使用确定性 Browser Runtime。

在所有平台关闭最后一个窗口时，会先以 `window-close` 原因排空 Relay；Ctrl+C、quit 与 smoke 测试结束都会取消尚未完成的启动，停止 Personal Pairing 与受生产 gate 保护的 Relay owner，停止 Web Host，释放隐藏 Browser 窗口，并等待其工作排空后再终止 Electron。系统 sleep 会停止 Remote Access；resume 只为仍处于登录状态的账号重新加载。源码 Electron smoke 会在 sleep、关闭手机访问、关闭窗口与 quit 后读取各次 Relay owner 状态，再检查 Web Host 子进程 PID 已消失。首次启动或后续 Host 崩溃共允许一次重试，之后窗口才显示 Host 错误。不存在无窗口 daemon、后台 Host 或 remote wake 路径。Chromium 持久 partition 位于 Electron `userData/Partitions/<name>`；loopback API token 放在 `userData/browser-runtime` 下，绝不写入 Tandem Browser Application Support。Dock 仍是截图、标题与文本的原生窗格。

主窗口只接受当前环回 Host 同源导航。包括 GitHub 授权在内的普通 HTTP 链接交给系统浏览器；其他来源和 scheme 不能替换 Session Surface，也不能创建另一个 Electron 窗口。Platform 账号签名密钥和令牌保存在 Electron userData 下的 `safeStorage` 加密文件中；preload 只暴露当前状态与生命周期动词。Account 的 `beginLogin` 立即返回当前快照，因此 Settings 不会在 Host Account HTTP 期间被堵住。

个人配对只在真实的 `手机配对` 设置区中配置。preload 暴露手机访问、挑战、待确认决策与已配对设备操作，不会向普通 Session 标题栏、侧栏、审批、输入框或离线视图增加状态。每个已配对设备行会展示经过鉴别的 Mobile 名称与平台，以及由 lease 推导的在线状态、配对时间和最后一次经过鉴别的 Relay 访问时间。账号登录后，由 Host 拥有的控制器为每项操作签署新的当前安装证明，在本地创建 XKpsk3 邀请状态，并且只转发不透明 mailbox 消息。确认时，Desktop 为该配对分别创建 Desktop 与 Mobile P-256 credential 以及随机 32 字节 attachment key，只向 Platform 提交 credential 的 SHA-256 公钥 digest，并以第一条 Snow transport payload 密封 Mobile grant 与 attachment key。可恢复确认事务会在重试期间保留同一把 key；active record 将它与 IK reconnect record 分开保存在 `safeStorage` 保护且 owner-only 原子替换的文件。同一个 owner 只在手机访问开启时按配对运行独立的 Desktop credential 与 WSS lifecycle，并在关闭开关、退出账号、sleep、关闭窗口或 quit 时停止。`SnowDesktopAttachmentOwner` 只接纳当前投影且绑定 route/selector/attachment/generation 的 IK 请求。grant 轮换、撤销、attachment 替换和 connection loss 都会取消 pending accept；迟到结果在任何 channel 发布或 Relay 发送前被释放。只有 IK2 与版本化加密的 `foreground-sync` 都送达当前 attachment 后，候选 channel 与 Desktop revision 才会生效；任一次发送失败都会释放候选项，并允许新的 IK 重试。开发环境不选择 keyless 产品控制器。

Desktop Platform 账号从打包 main 入口旁的 `operated-platform.json` 读取一套实际运行的生产身份。构建必须显式指定源文件，拒绝缺失或未知字段，并根据 `production` 标记、六个公开身份字段与最大尺寸 Companion 附件的正数 Host deadline 重建应用 archive 中的产物；它绝不复制调用方提供的 JSON，也不会嵌入 OAuth secret。localhost、非 HTTPS origin、回调不匹配或 deadline 无效会在 Electron 创建窗口、启动 Web Host、读取账号存储或发送流量之前使模块启动失败。操作系统加密不可用仍会作为明确的能力失败显示。加密记录通过 `dsh-atomic-write` 的随机独占同级文件、仅所有者权限、符号链接安全 rename 与失败清理完成替换。

Window Chrome 在 Desktop 侧栏、Session 内容与顶部 Workbench 上统一使用一条 36px 行。在 macOS 上，侧栏与 Session 区域可在 traffic lights 周围拖动窗口；Workbench 只把 `+` 后的未占用空间作为拖拽区，标签与控件仍可交互。Windows 使用同一行，最小化、最大化和关闭按钮各占 46px。纯浏览器 `dsh web` 保留 34px Workbench 标签栏，且不渲染窗口拖拽区。未支持平台的开发运行保留系统窗口框架。

Desktop 将 `build/icon.icns`、`build/icon.ico` 和 `build/icon.png` 作为自有资源，其字节与千机·Gestalt 已跟踪的生产图标一致。electron-builder 在 macOS 使用 ICNS，并将 ICO 资源写入未签名的 Windows 可执行文件；发布 workflow 会校验该 PE 文件包含最大的源 ICO 帧。main build 会把 PNG 复制到未打包 Electron application path 下，供 macOS Dock 与 Windows 窗口使用；打包则把同一 PNG 安装为显式 extra resource。

Dock / 开始菜单的 cwd 是 Launch Directory（Application Support / `%APPDATA%` 下的 `defaultWorkspace`）。用户数据仍在 `~/.dsh`。

## Schedule 与能力默认值

每个新 Desktop Session 都会提供 `schedule_create`、`schedule_list` 和 `schedule_delete`。绝对时间 `schedule_create.at` 必须带显式偏移量或 `time_zone`。Desktop 不挂载 `@deepseek-ai/dsh-time-context`；逐 step 时间读数仍由 Schedule Web overlay 注入。

当前 Session 保留提醒时，会话标题栏会在后台任务之后紧接显示 Schedule 任务板。其计数包含等待中与待补跑提醒，但排除已暂停提醒。任务板读取独立 Session projection，并支持持久化暂停、恢复与行内二次确认删除；它没有创建表单，也不从工具 transcript 卡片推断状态。

Schedule 交付为 `session-local`：只有原 Session 处于 live 状态时才会运行提醒，重新打开该 Session 会尝试处理逾期任务。关闭 DeepSeek Gestalt 不会产生操作系统、浏览器、邮件、短信或其他外部通知。

锁定的 Web Host 快照包含一些 Desktop 默认不激活的包。默认配置不设置任何 MCP server；Cordis 自修改与 Code Mode / PTC preset 仍可选择，但都不是默认 preset；standard preset 中的 `subagent_codex` 与 `subagent_claude_code` 模板保持关闭；Web 能力提供 `web_search`，但不提供 `web_fetch`。production HMR 保持关闭。浏览器 `dsh web` 仍让 `session-query-sqlite` 使用 `openAt: never`；Desktop 专用 overlay 则选择 `openAt: first-search`，并把派生索引放在 `DSH_HOME/session-search.sqlite`，因此 Companion 搜索会委托给权威 `session.search`，而不是扫描 Mobile 缓存。Desktop Host 会针对当前 Web Host loopback origin 安装 `DesktopCompanionProductOwner`，在 Web Host 重启时替换该 RPC，并在关闭前移除。该 owner 只暴露 Companion 批准的 Session 与 Workspace 发现、conversation history、prompt、取消、当前 Approval 与 Ask User settlement、attachment 准入、图片读取与搜索 operation；它不会透传任意 Host RPC。普通响应保留固定的 60 KiB Companion 上限；`session.attachment` 则使用 operated attachment deadline，以及按协议最大摘要校验图片结果配置的独立响应上限。Companion 文件准入经 `AttachmentStore.saveFile` 持久保存确切字节，追加只写入日志的 `session/attachment-admitted` 引用，不会把文件字节或文件名占位文本加入模型历史。同一 operation id 与元数据的重试返回已记录引用；冲突复用会失败。headless、ACP 与 JSON-RPC example 是其他应用组合，不是 Desktop 插件。

Pairing-scoped Companion operation ledger 会 single-flight 并发重试，在运行另一项 Host effect 前重试保存失败的 terminal result，七天后淘汰记录，并在达到容量时驱逐最旧 terminal 记录而保留 unresolved work。其持久 codec 会解析品牌化 pairing 与 operation id 及完整 v3 result，并拒绝 record/result operation id 不一致。

Desktop owner 也会消费权威 Host mux 与 Session event stream。Companion major 4 的 Mobile attachment 通过 `observe-session` 最多选择一个已打开 Session：该 Session 中已经记录的输出会产生有界 conversation 替换，隐藏 Session 的权威变化则只产生摘要、位置与 Workspace 归属替换。pairing-scoped projection source 会在最多包含 32 个 Session 的有界队列内合并同一 Session 的重复变化，Snow owner 会按 channel 单调递增的 Desktop revision 串行发送所有 projection。Host 替换、stream 失败、projection 失败、队列超限、peer 替换、sleep、关闭功能、退出账号、关闭窗口与 quit 都会在重连或 teardown 前清除 listener 和 pending work。重连会建立新的 generation 与权威 baseline，而不会重放 transport event。

## 开发

```sh
pnpm install
DSH_DESKTOP_OPERATED_PLATFORM_CONFIG=/absolute/path/to/operated-platform.json pnpm gestalt:dev
```

配置文件包含 `production` 标记与上文所述六个公开身份字段；它不包含其他字段或 OAuth secret。进程还需要 `DSH_NODE` 或 `npm_node_execpath` 上的真正 Node（pnpm 会设置后者）。不要让 Electron 用自己的 execPath 去跑 `dsh`。

## 发布

从 `master` 运行 `Desktop Release` workflow，填写包版本并选择 `publish`。两个打包 job 都会从 Platform 部署所用的同一组 GitHub Environment 变量投影公开的实际运行 Platform 身份，并要求打包应用在没有运行时 Platform 环境变量时正常启动。macOS arm64 与 x64 会先在匹配架构的 GitHub runner 上安装依赖；发布构建通过 `desktop-release` environment 完成签名和公证，dry run 不接收发布凭据。Windows NSIS 未签名但仍更新。workflow 会校验每个官方 Node 归档、启动每个打包目标、通过 Desktop bridge 往返读取 disabled 更新状态、等待 renderer 应用该状态、要求未激活的 Update Control 保持缺席、检查 Mac app 的签名和已装订公证票据，在已测试提交上创建 `gestalt-v<version>` 标签与 draft Release，上传并核验精确的安装包、blockmap 与更新 feed 集合，然后发布 Release。交接失败或中断时，workflow 会删除本次运行拥有的标签和 draft。macOS 在 zip 落地后由 Squirrel 把包拷到临时目录，Update Control 显示“正在准备更新”；该阶段结束后才出现“安装并重启”。普通退出仍不会安装。

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
- **Companion 发布证据由仓库门禁持有** — Node 22 与 24、iOS Simulator WKWebView 和 Android Emulator WebView 会执行仓库内确切的 Snow JS/WASM 包及其有界攻击用例。验收表面仍是组装后的 Desktop/Mobile 产品链路；本地 Vite、测试证书与 `prototype-companion` 不是产品验收。
