# Agent Note: 持久 Browser Profile

Status: implemented

[English](2026-08-19-persistent-browser-profiles.md) | 中文

## 问题

用户可以在真实浏览器中登录，但 Browser Runtime tracer 只接收一个一次性临时 Profile。之后恢复该身份需要产品并不拥有的第二套账号池概念，而同一 Electron partition 的并发写入可能损坏 cookie 与存储。

## 决策

`ctx.browserRuntime.create` 接收临时、命名持久或共享 Browser Profile。持久 Profile 复用稳定的 `persist:session-${idPrefix}-${name}` partition 与同一 `BrowserProfileId`。无密钥测试用带名称的存储 token 证明隔离。`pnpm run test:electron-runtime-e2e` 在 Electron 内证明两个 partition 的 cookie 隔离（[启动器说明](../testing/2026-08-20-electron-runtime-e2e-launcher.zh.md)）。临时 Profile 获得唯一的 `tmp-N` session 名、空存储，且没有地址栏标签。

产品词汇只有 Browser Profile。打开页面状态携带供 Dock 放在地址栏旁的 `chrome`，以及作为模型可见身份证明的 `storage`。临时 chrome 省略 `name`。Dock 页眉、页脚与账号选择器均不存在。

Provider 串行执行操作，并以 `BROWSER_PROFILE_BUSY` 拒绝同一命名 Profile 的第二个打开写入方。写操作仍要求 `expectedRevision`，并以 `BROWSER_REVISION_CONFLICT` 拒绝过期写入。close 丢弃临时身份并保留命名 partition。无效名称以 `BROWSER_PROFILE_NAME` 拒绝。

确定性 Provider 是持久化、隔离、清理与单写入方测试的无密钥存储。Electron Provider 把这些事实映射到本 Desktop Host 进程的 `session.fromPartition`。Tandem 形态 HTTP 客户端把同一 partition 方案映射到 Desktop 发布的 loopback 引擎，且从不启动 Tandem.app。Consumer 可以创建临时、命名持久或共享 Profile。省略 `browser_create` 的 `profile` 会打开共享 Profile；该默认由 [默认共享 Browser Profile Agent Note](2026-08-20-shared-default-browser-profile.zh.md) 持有。

## 考虑过的替代方案

**在 Browser Profile 之外再加账号池或账号选择服务。** 否决，因为工单禁止第二套身份概念。命名 Profile 就是身份。

**把 Tandem session 名当作调用方可见的账号 id。** 否决，因为不透明的 `BrowserProfileId` 已随每次操作传递。调用方选择 Profile 名；Provider 持有 partition 键。

**允许同一命名 Profile 后写覆盖。** 否决，因为 Electron persist partition 是单写入方存储。明确的 `BROWSER_PROFILE_BUSY` 失败比静默损坏更安全。

**从 Dock chrome 投影 Profile 标签。** 否决，因为 Dock 是后续 Desktop 界面。运行时状态携带 Dock 将消费的事实，包括无密钥 snapshot 中未标注的临时 Profile。

## 后果

命名 Profile 可在没有账号选择器的情况下恢复隔离身份。临时 Profile 仍可丢弃且无标签。并发写入方会明确失败。持久化、清理、修订冲突与带名称 token 的隔离在公开运行时 seam 上测试。Electron 与 Tandem HTTP fixture 记录 `persist:session-*` partition。`pnpm run test:electron-runtime-e2e` 在 Electron 内证明 cookie 隔离。

## 验证

- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-electron packages/browser/browser-runtime-tandem packages/browser/tool-browser`
- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-electron packages/browser/browser-runtime-tandem packages/browser/tool-browser --coverage --coverage.include='packages/browser/browser-runtime/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-deterministic/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-electron/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-tandem/src/**/*.ts' --coverage.include='packages/browser/tool-browser/src/**/*.ts'`
- `pnpm run test:snapshot -t 'Browser Profile'`
- `pnpm run test:electron-runtime-e2e` 在 Electron 内运行 `packages/browser/browser-runtime-electron/tests/runtime.e2e.ts`；Node 上的 `test:e2e` 保留具名跳过。生产环境从不启动 Tandem.app。
