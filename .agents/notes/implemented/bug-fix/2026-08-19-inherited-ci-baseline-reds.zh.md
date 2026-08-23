# Agent Note: 修复基线上既有的 CI 红灯

Status: implemented

[English](2026-08-19-inherited-ci-baseline-reds.md) | 中文

## 问题

交付基线上存在四处独立的红色 lane，均非任何在途 PR 引入。第一，两条执行 coverage 清单的 lane——Linux coverage 与原生 Windows——都以默认的 depth-1 浅拉取检出，Desktop release-notes 测试因此无法通过 Git 图谱解析其锁定的 manifest 区间，在每台全新的托管 runner 上确定性失败。第二，Web 浏览器 replay 套件在几十个场景中失败：已录制的 aria 金标早于 composer 的图片接入按钮；两处 scroll-contract 流太短，在负载较高的 CI runner 到达增长断言之前就已流完；Desktop chrome 场景的 `window.dshDesktop` mock 不再覆盖 Desktop UI 插件所绑定的 preload 面；Models 设置页只列出 `configured` 的 provider 行——在 whole-section 占用判定变更之后，未配置密钥的 DeepSeek 路由连同其首启 setup 卡片一起消失。同一 snapshots-and-artifacts lane 还回放了一份仍期望上游 “DeepSeek Harness” README 标题的 translation-prompt 快照，以及 `DSH_EXAMPLE_MODE=lib` 下的 two-instance-relay 示例：tsdown 在 `relay-provider.js` 内发出了第二个构造函数，于是每个 provider 侧的 `RemoteRelayError` 都被映射成 `RELAY_ATTACHMENT_REJECTED`。第三，四个 Desktop 测试断言了在 Windows 主机上不可能成立的 POSIX 路径与权限位写法；另有一个 subagent teardown 测试依赖 `vi.waitFor` 的一秒默认超时去等待一个异步结算告警。必过的 `all-checks-passed` 聚合跟随 coverage、snapshots 与所列 `needs`；`windows-native` 是独立检查，不在 `all-checks-passed.needs` 中。

## 决策

**coverage lane 拉取完整历史。** `ci.yml` 中每个运行包含 coverage 门禁的聚合的 lane 都以 `fetch-depth: 0` 检出；workflow 契约测试钉死这些 job id（`node-24-coverage`、`windows-native` 及其余 coverage 聚合 job）并拒绝浅检出，使改名或包一层脚本的 job 无法悄悄离开完整历史集合。release-notes CLI 保持离线：验证仍然只读本地 Git 图谱。

**fixture 跟随产品；行为缺陷则修复。** composer 的图片接入按钮是已发布的产品界面，因此通过受认可的 refresh 模式重新录制金标，并逐行审阅 diff。同一次 aria refresh 还录下两行 `删除 DeepSeek (deepseek-official)`，这是 ticket #120 的 occupancy / `removable` 语义为官方 DeepSeek 路由露出的操作。两条未设闸门的 scroll-contract 流从 120/240 个 paced chunk 增至 960 个，使流的持续时间超过最慢的 CI 交互间隙，而不再依赖时序运气。Desktop chrome e2e 安装 `installDesktopBridgeFixture`（[带类型的 DesktopBridge fixture](../testing/2026-08-21-typed-desktop-bridge-e2e-fixture.zh.md)），它实现完整的 `DesktopBridge` preload 面，account 与 pairing 均返回惰性的 `unavailable` 快照。Models 设置页再次列出所有已挂载的 whole-section provider——首启形态下渲染为打开的 setup 卡片，其余情况渲染为普通行——因为 `configured` 现在的含义是用户层占用该 section，而这在首启卡片必须渲染时恰好为 false。

**Desktop 测试断言平台语义。** 图标与运行时路径的期望改为按主机平台拼接路径，并在 Windows 上期望 `node.exe`；copy-tree 测试比较解析后的链接指向，而非某一平台的 `readlink` 写法；owner-only 权限位只在暴露 POSIX mode 语义的平台上断言。teardown 失败的观察窗口放宽到其同类断言已在使用的十秒。

**构建后的 Relay 共用公开错误构造函数。** 仅主机侧的 provider 从 `@deepseek-ai/dsh-remote-access` 导入 `RemoteRelayError`，且该 provider 的 tsdown 入口将该包列入 `deps.neverBundle`，因此 WSS Consumer 的 `instanceof` 检查与 provider 抛出的是同一个类。translation-prompt 快照通过受认可的 snapshot refresh 从 Gestalt README 重新生成。

**浅检出红灯消失后，露出 companion 基线其余门禁。** Linux coverage lane 现在能跑完全部测试，并在 Gestalt 的 client / schedule / remote-access / search 等从未达到 per-file 100% 的文件上失败。可测的 Schedule decode/replay/时间校验（`domain.ts`、`projection.ts`）、抽出的 DeepSeek `postSearch` 路径，以及 Models 的 occupancy / `configured` / `removable` store 补上归属测试并达到 per-file 100%。#185 列出的产品路径在归属测试达到 per-file 100% 后离开该排除清单（[覆盖率清单恢复](../testing/2026-08-21-coverage-inventory-restore.zh.md)）。未点名的其它 `TODO(gui)` 排除保持不动。`revokeCredential` 与 Desktop Account source 也补上归属测试。consumers lane 的 oxlint 与 jscpd 失败属于同一块 companion 表面：已弃用的 `escape`/`unescape`、未绑定的 input-action 方法、未类型化的 `ctx.get('web')`，以及快照/HTTP/tab/字段的克隆块。Platform Account 与 Remote Access 的 HTTP JSON 解析和错误写出共用 `@deepseek-ai/dsh-host-webserver` 上的参数化助手（[零克隆抽取](2026-08-21-zero-clone-duplication-gate.zh.md)）。`pwsh-tool-turn` 的 header sidecar 刷新为当前的 sandbox 句、`job_*` 的 “job” 用词，以及 Linux 组装发出的 job-then-pwsh 工具顺序。Schedule board 快照把 Playwright `timezoneId` 钉在 `Asia/Shanghai`（issue #95），使本地时间的 AM/PM 与宿主时区无关；`{{clock}}` 正规化器不再吞掉子午标记。workspace-management 在普通 click 之前对仅 hover 可见的行操作重新 hover。assembled-boot 的 jsdom 安装文件级内存 `indexedDB`，因为 Composer 持久化（`putStagedImage`）可能在测试与 afterEach 结束后才打开数据库；request 助手不加类型参数，以免触发 oxlint `no-unused-type-parameters`。process-exit 的 host-exit 套件先等宿主 `ready` 握手再读 `tree.json`，因为托管子进程可以在宿主仍阻塞于 `node-pty.spawn` 时写出进程树；已发布记录本身是原子 rename 加上合法 JSON 等待（[票级重跑握手](2026-08-20-ci-ticket-rerun-flakes.zh.md)）。DeepSeek-defaults 无头 mock 在请求到达时写出第一条 SSE 注释，而不是等到 `end`。

## 验证

该 workflow 契约测试对旧的浅检出 workflow 失败、在每个 coverage lane 都使用 `fetch-depth: 0` 后通过。四个 Desktop spec 与 continuation spec 在本地通过；仅 Windows 相关的断言交由原生 Windows lane 判定。完整 Web 浏览器 replay 套件在只读 replay 模式下全绿，包括此前失败的 scroll-contract、onboarding、Desktop chrome、minimal-preset 与 shipped-composition 场景。Schedule board 金标在钉死的 `Asia/Shanghai` 上下文下重新录制一次并可回放。对 `schedule` 的 `domain.ts` / `projection.ts`、`web-search-deepseek` 的 `provider.ts` 与 Models `store.ts` 的 scoped coverage 为 per-file 100%。`a745fbceb7` 上的 snapshots-and-artifacts lane 随后在三处独立门禁失败：新增的 moonshot 不可解析响应体测试把 `expect.stringContaining` 赋给字段（oxlint `no-unsafe-assignment`）；DeepSeek-defaults headless fixture 推迟了第一条 SSE 注释，负载高的 runner 因此重试了 one-shot（2 个请求）；annotation-persistence 在发送后用一次性 count 断言草稿 chip 已清除。这三处在 `cf08318d15` 上已通过；同一 lane 接着因 `image-display.snapshot.ts` 在拆卸后 persist 留下三处 `indexedDB is not defined` 未处理拒绝，在 138/269 条测试通过后以 exit 1 结束。该次 wine-blocking job 在 15 分钟超时被取消：Wine apt 安装耗时 14.5 分钟，门禁尚未开始；本分支更早的 head 上 wine 在 3–8 分钟内完成。在 `4434e21c41` 上 `test:snapshot` 与 web browser snapshot 已通过（无残留 `indexedDB` 错误）；lint 随后因未使用的 `MemoryIdbRequest<T>` 参数失败。coverage 仅失败 `process-exit.spec.ts` 的 `removes a terminal root and descendant after direct exit`（30 秒后 `ready` 上 `ENOENT`）——同一文件在同日其它 coverage job 以及本分支 round 4–5 上于 2.3–2.5 秒通过。`DSH_EXAMPLE_MODE=lib` 的 two-instance-relay 回放与构建后 provider 的类身份测试均通过；translation-prompt 快照在 refresh 后与 Gestalt README 一致。companion 的 lint 与克隆修复后，本地 `pnpm run lint:contracts-ready` 与 `pnpm run duplication` 通过。本机无 `pwsh`，`pwsh-tool-turn` 会 skip；sidecar 与 Linux consumers lane 收到的 header、以及 `packages/shell/tool-pwsh` 与已刷新的 `job_*` 金标一致。

## 曾考虑的替代方案

**在测试中不依赖 Git 历史解析 release-notes 区间。** 否决：CLI 的祖先检查本身就是被测的产品行为，且所验证的区间是真实的仓库历史；错误出在 lane 上，而不是断言上。

**缩减 scroll-contract 的断言，而不是加长流。** 否决：增长断言正是被测行为——读者滚动离开后流式输出仍在继续——缩短观察窗口等于描述一个更弱的约定。

**回退 Models store 中 whole-section 的占用判定变更。** 否决：`configured` 与 `removable` 的占用语义是刻意设计且有单测钉住的；缺陷在于视图层只从 `configured` 推导列表。

**用 `error.name` 或 `code` 代替 `instanceof` 检测 Relay 失败。** 否决：Consumer 已经按公开类分支，provider 可以共用该构造函数而无需改 HTTP 映射约定。

**继续从 `./relay.ts` 导入 `RemoteRelayError`，并把 `./relay.js` 标为 external。** 否决：已发布运行时是 `lib/index.js`，不是同级的 `lib/relay.js`；Consumer 从公开包入口加载该类。

**把 AM/PM 吞进 `{{clock}}` 正规化器。** 否决：这会掩盖 issue #95 的时区 fixture 缺陷；Schedule 快照必须声明 `timezoneId`，并保持产品的本地时间格式化。

**把 Schedule domain/projection、DeepSeek `postSearch` 与 Models store 当作 GUI 债务排除出 coverage。** 否决：这些文件是本基线已经拥有的可测逻辑。

## 影响

基于该基线的 PR 不再继承 coverage、snapshots 与原生 Windows 红灯。native complete 仍是独立必过检查，不在 `all-checks-passed.needs` 中。Models 设置页在保留 provider 行改造引入的基于占用判定的 `configured` 与 `removable` 语义的同时，让首启用户重新可达 setup 卡片。scroll contract 的流长度现在是明示的容量约定（`LIVE_STREAM_CHUNKS`），而不再是隐式的竞速。lib 模式下的 two-instance-relay 回放通过同一个 `RemoteRelayError` 构造函数映射 `REMOTE_OFFLINE`。Schedule board 快照在托管 UTC 与 `Asia/Shanghai` 宿主上时区稳定（issue #95）。#185 清单不再把这些产品路径藏进 `coverage.exclude`。
