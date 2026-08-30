# Agent Note：Sub2API Offer 卡与一键安装器归于 Desktop Host

Status: implemented

English | [中文](2026-08-28-sub2api-offer-card-installer.md)

## Problem

Sub2API sidecar（#346，bundle 源码在 sidecar 仓）需要一条 Desktop-only 的启用路径。Web Host 是被拉起的子进程，它的组合内部没有任何一方能拥有下载、profile 写入与自身生命周期，而卡片要渲染的状态机必须由真正拥有这些工作的一方推送。基于 Release 的启用路径还必须跟随 GitHub 资产跳转、流式处理超过 Platform HTTP 响应上限的 runtime pack，并允许受监督的首次启动在 Desktop Host 启动期限前完成。

## Decision

一切归于 Desktop Host 主进程；卡片只渲染。[`DesktopSub2ApiController`](../../../../apps/desktop/src/sub2api.ts) 运行 `missing → downloading → verifying → installed → starting → running / error` 相位机，经新增的 `sub2api:snapshot-changed` IPC 事件推送每次迁移（与 updater、pairing 快照同一姿态），六个动词全部走 preload 桥。Host 探测轮询 `GET <web-host>/plugins/dsh-sub2api/quota-snapshot`——2xx 即证明 bundle 已挂载且被监督链路健康，因为 sidecar 只在健康启动之后注册该路由；主进程发出的无 Origin 请求能通过 sidecar 的 loopback-peer + loopback-Host 准入。

[安装器](../../../../apps/desktop/src/sub2api-install.ts)绝不调用用户 PATH 上的 pnpm 或 `dsh` CLI：Electron session-aware 的流式 `net.fetch` 把两个归档写入 OS 临时 staging 目录并承担环回健康探针，每个归档对照各自的 `SHA256SUMS` 校验（runtime pack 解压后再验其内部 sums），bundle 包落到 `$DSH_HOME/profiles/web/node_modules/<name>`，profile manifest 恰好新增一行 `dsh.profile.bundles`——遵循 [profile 发布](../../../../docs/user/develop/basic/publish.zh.md)语义：其余条目逐字节保留，写入经 `withFileLock` 加锁、`writeFileAtomic` 原子落盘。Platform Account、pairing 与附件流量继续使用独立的禁跳转、HTTPS-only、有界 system-Node helper。runtime pack 剥掉顶层目录解压到 `$DSH_HOME/sub2api/runtime`，即 sidecar supervisor 的 `binaryDir` 默认值。

有两个决定与票面文字不同，值得记录：

- **Pack 解压到 `sub2api/runtime`，不是 `sub2api/run`。** 已合并的 supervisor 契约把 `<runtimeDir>/runtime` 作为 `binaryDir` 默认，`run/` 留给它可随时清掉重建的 ephemeral 状态；把二进制放进 `run/` 会破坏 replace-on-upgrade，并与 `admin-password`、日志混在一起。
- **停用写 profile patch 行，而非 config 覆盖。** patch 行会整体替换目标行的 config，`enabled: false` 覆盖必须重述 sidecar 全量 config。安装器改写自身独占的精确行 `{ id: 'dsh-sub2api-sidecar', disabled: true }` 到 profile 自己的 `cordis.patch.yml`——条目级停用、用户层优先生效、其余不碰——并对同一 id 的用户自有行拒绝共存。

回滚：manifest patch 之后的任何安装失败都恢复先前的 manifest 文本并删除本次解压产物，Web Host 永远不会启动一个装了一半的组件。若全新安装后的第一次重启失败，控制器移除该行与解压文件、再重启一次，并以回滚前缀上报失败原因。

下载源来自 `DSH_DESKTOP_SUB2API_SOURCES`（JSON 文件路径；缺省取打包主入口旁的 `sub2api-sources.json`），内含四个产物 URL。没有该文件即表示部署没有经批准的组件源：卡片照常渲染 offer，启用则报告缺少配置。文件存在但非法则降级为携带原因的 unavailable 控制器，而不是砸掉 Desktop 启动。

受控重启（[`replaceWebHost`](../../../../apps/desktop/src/main.ts)，崩溃重走路径同样使用）停掉子进程、走既有 [`spawn-web-host`](../../../../apps/desktop/src/spawn-web-host.ts) seam 重新拉起、把窗口与原生 overlay 重载到新的 port-0 URL 并重接 Companion RPC；会话在磁盘天然保活。仅全新安装后的第一次重启使用与受监督 bootstrap 预算一致的 180 秒启动期限；重新启用、停用、卸载、普通启动与崩溃恢复仍使用 30 秒期限。desktop 包新增 `tar`、`js-yaml`、`@deepseek-ai/dsh-home-paths` 三个依赖——安装全部发生在应用内部，安装包体积永远不携带 runtime pack。

## Alternatives considered

**把安装器放进 Web Host 组合。** bundle 插件要自下载、自挂载，只能在运行中的 Loader 背后改自己的 profile 再重启自己——重启仍归 Host，下载又会随它所控制的子进程一起死掉。拒绝：Desktop 主进程本就拥有子进程生命周期，且比 Web Host 重启活得更久。

**Web Host RPC 控制 start/stop。** sidecar bundle 需要新增控制服务，而 Renderer 将经页面传输层触达特权安装动词。A2 拒绝：它引入卡片无法假设旧 bundle 具备的 bundle 侧 API；profile patch 行用的是文档化的覆盖杠杆，bundle 零改动。

**状态机放 renderer。** 卡片必须跨越它自己触发的重启、在窗口重载后存活，且主窗口与 overlay 文档两个面都在渲染它。拒绝：Host 推送快照正是 updater 与 pairing 快照已遵循的纪律。

## Consequences

浏览器 `dsh web` 没有入口（ui-desktop 只随 Desktop overlay 挂载），没有 `window.dshDesktop` 时卡片不渲染。可见的组合证据包括 Desktop composition 的 overlay 文档 golden、[offer 卡场景](../../../../apps/web/tests/settings-chrome.e2e.ts)，以及 `pnpm test:e2e-sub2api`：Electron lane 强制构建当前源码，把公开 Release 产物安装到全新且已初始化的 profile，经 Host 注入面创建临时 Z.AI 账号与 composite route，观察原生 Settings overlay 与嵌入控制台，在产品输入区选择 Sub2API 模型，要求真实模型回答，核对公开 sidecar Release tag 与 checksum 输入，记录精确的 Gestalt/sidecar 身份，并在恢复干净环境前拒绝自然 teardown 后仍存活的产品自有进程。只读 credentials 文件只盲拷贝到临时 `0700` DSH home 并设为 `0600`；lane 会拒绝任何含其 provider key 的 artifact，并删除该 home。`web` profile 按名钉死：Desktop Web Host 是 `dsh web`（`--profile web` 的别名），安装器只改这一个 profile。挂载 bundle 后 Web Host 启动失败仍会显示无卡片的 Host 错误页——恢复手段是等一次可用启动后卸载，或手工移除 bundles 行——可以接受，因为安装器的回滚已覆盖自身失败模式，fail-loud 的启动错误会点名插件。
