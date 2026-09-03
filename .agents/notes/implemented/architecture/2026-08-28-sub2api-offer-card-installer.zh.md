# Agent Note：Sub2API Offer 卡与一键安装器归于 Desktop Host

Status: implemented

English | [中文](2026-08-28-sub2api-offer-card-installer.md)

## Problem

Sub2API sidecar（#346，bundle 源码在 sidecar 仓）需要一条 Desktop-only 的启用路径。Web Host 是被拉起的子进程，它的组合内部没有任何一方能拥有下载、profile 写入与自身生命周期，而卡片要渲染的状态机必须由真正拥有这些工作的一方推送。基于 Release 的启用路径还必须跟随 GitHub 资产跳转、流式处理超过 Platform HTTP 响应上限的 runtime pack，并允许受监督的首次启动在 Desktop Host 启动期限前完成。

## Decision

一切归于 Desktop Host 主进程；卡片只渲染。[`DesktopSub2ApiController`](../../../../apps/desktop/src/sub2api.ts) 运行 `missing → downloading → verifying → installed → starting → running / error` 相位机，经新增的 `sub2api:snapshot-changed` IPC 事件推送每次迁移（与 updater、pairing 快照同一姿态），五个生命周期动词全部走 preload 桥。Host 探测轮询 `GET <web-host>/plugins/dsh-sub2api/quota-snapshot`——2xx 即证明 bundle 已挂载且被监督链路健康，因为 sidecar 只在健康启动之后注册该路由；主进程发出的无 Origin 请求能通过 sidecar 的 loopback-peer + loopback-Host 准入。

[安装器](../../../../apps/desktop/src/sub2api-install.ts)绝不调用用户 PATH 上的 pnpm 或 `dsh` CLI：Electron session-aware 的流式 `net.fetch` 把两个归档写入 OS 临时 staging 目录并承担环回健康探针，每个归档对照各自的 `SHA256SUMS` 校验（runtime pack 解压后再验其内部 sums），bundle 包落到 `$DSH_HOME/profiles/web/node_modules/<name>`，profile manifest 恰好新增一行 `dsh.profile.bundles`——遵循 [profile 发布](../../../../docs/user/develop/basic/publish.zh.md)语义：其余条目逐字节保留，写入经 `withFileLock` 加锁、`writeFileAtomic` 原子落盘。Platform Account、pairing 与附件流量继续使用独立的禁跳转、HTTPS-only、有界 system-Node helper。runtime pack 剥掉顶层目录解压到 `$DSH_HOME/sub2api/runtime`，即 sidecar supervisor 的 `binaryDir` 默认值。

有两个决定与票面文字不同，值得记录：

- **Pack 解压到 `sub2api/runtime`，不是 `sub2api/run`。** 已合并的 supervisor 契约把 `<runtimeDir>/runtime` 作为 `binaryDir` 默认，`run/` 留给它可随时清掉重建的 ephemeral 状态；把二进制放进 `run/` 会破坏 replace-on-upgrade，并与 `admin-password`、日志混在一起。
- **停用写 profile patch 行，而非 config 覆盖。** patch 行会整体替换目标行的 config，`enabled: false` 覆盖必须重述 sidecar 全量 config。安装器改写自身独占的精确行 `{ id: 'dsh-sub2api-sidecar', disabled: true }` 到 profile 自己的 `cordis.patch.yml`——条目级停用、用户层优先生效、其余不碰——并对同一 id 的用户自有行拒绝共存。

回滚：manifest patch 之后的任何安装失败都恢复先前的 manifest 文本并删除本次解压产物，Web Host 永远不会启动一个装了一半的组件。若全新安装后的第一次重启失败，控制器移除该行与解压文件、再重启一次，并以回滚前缀上报失败原因。

下载源来自 `DSH_DESKTOP_SUB2API_SOURCES`（JSON 文件路径；缺省取打包主入口旁的 `sub2api-sources.json`），内含四个产物 URL。`build:main` 按被打包的 os/arch（`--platform`/`--arch` 或 `DSH_DESKTOP_SUB2API_PLATFORM`/`DSH_DESKTOP_SUB2API_ARCH`，否则用当前进程）从仓库内已批准清单（`apps/desktop/sub2api-sources.catalog.json`）写出该文件，electron-builder 在文件存在时把它打进与 `operated-platform.json` 同级的位置。清单目前只列出 sidecar pin `v0.1.25` 的 darwin-arm64 公开 GitHub Release 资产；Windows 与 darwin-x64 在对应 runtime pack 发布前没有条目，因此那些包省略该文件。没有该文件即表示部署没有经批准的组件源：卡片照常渲染 offer，启用则报告缺少配置。文件存在但非法则降级为携带原因的 unavailable 控制器，而不是砸掉 Desktop 启动。官方 URL 从不写进 Host `src/`。

控制器先发布 `starting`，再由受控重启（[`replaceWebHost`](../../../../apps/desktop/src/main.ts)，崩溃重走路径同样使用）停掉子进程。重启走既有 [`spawn-web-host`](../../../../apps/desktop/src/spawn-web-host.ts) seam 拉起新子进程，把窗口与原生 overlay 重载到新的 port-0 URL 并重接 Companion RPC；会话在磁盘天然保活。因此 overlay 的 Models 请求只发给当前 Host。它的 Settings 文档以当前请求 id 发布分区选择；主进程只接受同一请求的 Settings 更新，在 Host 替换时保留所选分区，并先挂载视图再将其设为可见，使原生窗口立即展示所选内容。运行态默认展示当前 Host 的同源 Sub2API 原生账号工作区，状态与生命周期操作位于 Settings 标题区；工作区跟随 Desktop 主题和语言，绝不导航 Session Surface。Desktop 嵌入模式把原生账号表格、IP 管理与 Composite 路由对话框组成同一工作区，把账号表格固定为产品批准的列，移除搜索与筛选行、自动刷新、更多操作和批量更新入口，并把刷新、Composite 路由和添加账号右对齐。账号新增与编辑表单隐藏池模式、账号计费倍率同步、自动探测上游声明倍率和配额控制，同时保留 Sub2API 的既有默认值与保存 payload。无边框 frame 和中性的深浅色表面至少铺满 Settings 视口；内嵌账号表格保留表格横向滚动、纵向自然展开，因此页面级纵向滚动条只归 Settings 内容列所有，表格下方不会出现反差明显的底栏。sidecar 取组绑定推理 key 的实时 `/v1/models` 与该 Composite 组内每个账号最近一次成功同步所保存的完整模型 ID 列表的交集，派生 Provider 模型目录。能力元数据可以补充这些模型，但不能增删模型。管理面变更成功后会刷新，轮询负责覆盖缓存失效。刷新失败时保留最后一次 Provider 设置；交集为空时会移除 Provider，因此配置的平台默认值和运维配置都不能为账号池虚构订阅能力。每次由控制器发起的组件替换，以及已安装且已启用组件时的普通 Desktop 启动，都使用 180 秒启动期限；没有启用组件的普通启动与崩溃恢复仍使用 30 秒期限。desktop 包新增 `tar`、`js-yaml`、`@deepseek-ai/dsh-home-paths` 三个依赖——安装全部发生在应用内部，安装包体积永远不携带 runtime pack。

## Alternatives considered

**把安装器放进 Web Host 组合。** bundle 插件要自下载、自挂载，只能在运行中的 Loader 背后改自己的 profile 再重启自己——重启仍归 Host，下载又会随它所控制的子进程一起死掉。拒绝：Desktop 主进程本就拥有子进程生命周期，且比 Web Host 重启活得更久。

**Web Host RPC 控制 start/stop。** sidecar bundle 需要新增控制服务，而 Renderer 将经页面传输层触达特权安装动词。A2 拒绝：它引入卡片无法假设旧 bundle 具备的 bundle 侧 API；profile patch 行用的是文档化的覆盖杠杆，bundle 零改动。

**状态机放 renderer。** 卡片必须跨越它自己触发的重启、在窗口重载后存活，且主窗口与 overlay 文档两个面都在渲染它。拒绝：Host 推送快照正是 updater 与 pairing 快照已遵循的纪律。

**把四个 URL 编译进 Host 源码。** 拒绝：下载源是必须匹配被打包架构的部署配置，与 `operated-platform.json` 相同。写进 `src/` 会把 darwin-arm64 的源打进 Windows 与 darwin-x64 Host。

**清单没有对应条目时改用另一条已有架构。** 拒绝：缺少 runtime pack 时必须保持占位启用错误，而不是下载错误架构的二进制。

## Consequences

浏览器 `dsh web` 没有入口（ui-desktop 只随 Desktop overlay 挂载），没有 `window.dshDesktop` 时卡片不渲染。基于 Release 的 Electron 门禁会强制构建精确 Gestalt 源码，移除继承环境中带凭据语义的条目，只把经批准的凭据文件复制进私有的已初始化 profile，再安装一份公开且校验和匹配的 sidecar Release。它的 CDP bridge 对有界的公开校验和及标签查询给出 120 秒，而不是沿用驱动默认的 10 秒。它通过原生内嵌表单创建账号与 Composite 路由，要求实时网关与 Provider 设置公开完整的账号支持模型能力，并经所选路由发送一次真实模型请求。证据记录精确 Gestalt 与 sidecar 身份；产物含凭据、产品进程未自然退出、私有 runtime 根目录未删除或 CDP 端口未关闭时，门禁都会失败。

`web` profile 按名钉死：Desktop Web Host 是 `dsh web`（`--profile web` 的别名），安装器只改这一个 profile。挂载 bundle 后 Web Host 启动失败仍会显示无卡片的 Host 错误页；恢复手段是等一次可用启动后卸载，或手工移除 bundles 行。安装器回滚覆盖它所拥有的失败，fail-loud 的启动错误会点名插件。来源清单可以组合较新的 sidecar bundle Release 与较旧但未变化的 runtime-pack Release；每个资产仍与自己的校验和文档配对，E2E 会把 bundle 标签解析到精确 sidecar commit。
