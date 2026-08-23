# Agent Note: 不含第二浏览器的工作台快照

Status: implemented

[English](2026-08-21-workbench-snapshot.md) | 中文

## 问题

产品需要在 Web 与 Desktop 上挂上 DSH-better-sidebar 的文件树、编辑器、终端、Git、子代理与 Jobs 工作台。上游插件还带一个沙箱 iframe 浏览器。官方 Session 浏览已经由 `browserRuntime` + `browserWorkspace` + [`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md) 持有。GitHub fork 或第二个 monorepo 会拆开唯一的产品树。在快照里删 `BrowserView` 会在每次 `git subtree pull` 时冲突。

## 决策

本仓库仍是唯一 monorepo。上游 `omdsh-dev/DSH-better-sidebar` 的 `50a888845fc614f63dfbf4d2b3704cc1004cd5c0` 作为钉死源码快照放在 [`packages/client/better-sidebar/`](../../../../packages/client/better-sidebar/README.md)，并收成 `@deepseek-ai/dsh-client-better-sidebar`。它不是 `vendor/` 下的 Cordis 包。更新方式是 `git subtree pull`，再重放 [`LOCAL-MODIFICATIONS.md`](../../../../packages/client/better-sidebar/LOCAL-MODIFICATIONS.md) 中的条目。

[`packages/client/ui-workbench/`](../../../../packages/client/ui-workbench/README.md) 是本仓适配层。快照注册设置命名空间 `dsh-better-sidebar` 之后，宿主 apply 写入 `tabsEnabled.browser: true` 与 `browserInterceptLinks: false`，让官方 chrome 占用快照浏览器标签。缺少 `tabsEnabled.browser` 键表示启用；第一期留下的 `false` 必须写成 `true`。快照保留文件、编辑器、终端、Git、子代理、Jobs 与官方 Browser 标签。[`dsh-web-app`](../../../../packages/bundle/web-app/README.md) 先插入快照行，再插入适配层，并保留 `id: ui-browser`。官方 chrome 的占用关系由 [工作台官方浏览器 Agent Note](2026-08-21-workbench-official-browser.md) 持有。

[`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md) 在命名空间 `ui-browser` 注册设置分区 `id: 'browser'`：`namedProfiles`、`defaultKind`（`shared` / `temporary` / `persistent`）与 `defaultPersistentName`。省略 `profile` 的 `browser_create` 与侧栏 `+ → 浏览器` 读取该默认值。设置页不会创建 Browser Workspace。

## 考虑过的替代方案

**Fork 再开第二个 monorepo。** 否决，因为本仓库已经组合 Host 与 Client 包，第二棵树会重复工作区约束、覆盖率与发布版本。

**把快照放进 `vendor/`。** 否决，因为 `vendor/` 是 Cordis／基础钉死集。这个插件是带自有宿主路由的产品 UI overlay。

**在快照里删 `BrowserView` 来禁 iframe。** 否决，因为每次上游拉取都会把该文件带回来并与删除冲突。

**让 iframe 浏览器与官方 Dock 同时当产品浏览器。** 否决，因为 Session 持有的浏览已经有一个占用方和一个 Runtime。

**在本次把快照 `/sidebar` 的 pty、git、fs 迁到官方能力缝。** 否决，因为工作台可以先挂在快照栈上；能力缝迁移是后续变更。

## 后果

官方 Browser chrome 现在占用快照 `browser` 标签；Dock 不再占用 `details`。快照宿主路由仍走 `/sidebar`。宿主 apply 在 prefs 命名空间尚未注册时加入快照 loader fiber；调用 `entry.init()` 会把快照 apply 两遍并重复注册 `/sidebar` 路由。源码启动从包内 `lib/` 提供惰性分块，而不是 `dirname(import.meta.url)`。覆盖率、Oxlint、jscpd 与 knip 跳过快照树；适配层与官方 Browser 测试持有产品行为。快照不是 `tsconfig.client.json` 工程，因为它的 references 会把宿主 Context 键合并进客户端程序；`tsdown` 用 `noCheck` 写出 `lib/types`。
