# Agent Note: Declared Electron Browser Runtime e2e launcher

Status: implemented

[English](2026-08-20-electron-runtime-e2e-launcher.md) | 中文

## 问题

`packages/browser/browser-runtime-electron/tests/runtime.e2e.ts` 已经能驱动真实页面并证明两个 partition 的 Chromium cookie 隔离，但 `describe.skipIf(!isElectronProcess())` 让这些用例在每次 Node vitest 运行中都被跳过。没有任何包脚本、CI 作业或 Desktop smoke 在 Electron 内启动 vitest，因此 #69 的 cookie 罐验收在本地与 CI 中都未执行。

## 决策

`pnpm run test:electron-runtime-e2e` 是这些用例唯一声明的启动模式。Node 包装器 `scripts/run-electron-runtime-e2e.ts` 从 `@deepseek-ai/dsh-browser-runtime-electron` 解析 Electron 二进制，并以应用程序方式启动 `scripts/electron-runtime-e2e-main.mjs`。Linux 附加 `--no-sandbox` 与 `--disable-dev-shm-usage`；Windows 附加 `--no-sandbox` 与 `--disable-gpu`。子进程环境会丢掉 `NODE_OPTIONS`，以免父进程 `pnpm run` 带来的 `tsx --import` 变成 Electron argv。包装器用 `tsx` 锁定的 esbuild 打包 `packages/browser/browser-runtime-electron/tests/runtime.e2e.cases.ts`，把 `electron` 留作 external，并通过 `DSH_ELECTRON_RUNTIME_E2E_CASES` 传入路径。主进程设置隔离的 `userData`，并在没有 top-level await 的情况下订阅 `app.whenReady()`——Electron 只在主模块求值结束后才发出 ready。ready 之后导入该打包结果，并在该 Electron 主线程运行 `runElectronRuntimeE2eCases()`，使 `session.fromPartition` 与隐藏 `BrowserWindow` 保持可用。隔离 `userData` 的清理会重试，然后忽略 Chromium 残留文件，因此仍打开的 LevelDB 句柄不能把已通过的运行变成红。`ELECTRON_RUN_AS_NODE` 会被拒绝：该模式无法承载 `BrowserWindow`。Node 上的 `pnpm run test:e2e` 仍记录具名跳过，且不得 spawn Tandem.app。若本进程已经是 Electron，Electron 门控的 `runtime.e2e.ts` describe 会运行同一份 cases 模块。

Windows 的必需所有者是 `ci-windows-complete`（`windows node 24 / native complete` 与自托管 Windows standby）。macOS pull request 运行 `macos electron runtime e2e`；`desktop-release.yml` 的 pack-mac 与 pack-win 运行同一脚本。Linux 清单省略该启动器，因为 Desktop Host 不在 Linux 上交付此 Provider。

## 考虑过的替代方案

**`ELECTRON_RUN_AS_NODE=1` 加上 vitest forks。** `process.versions.electron` 可以保持设置，但 `BrowserWindow` 与 `session` 不可用，因此跳过门会变绿，而 cookie 用例仍不会运行。

**在 Electron 内调用 `startVitest`，对 `app.whenReady()` 使用 top-level await，把 Node 的 `--import tsx/esm` 放进 Electron argv，或在 ready 之后使用 tsx load hook。** Electron 只在主模块求值结束后才发出 ready，因此对该 Promise 的 top-level await 会死锁。进程内 vitest pool 有同样的握手死锁。Chromium 把 `--import` 当成开关，该 argv 不会加载 TypeScript，还可能让 `app.whenReady()` 一直不 settle。此 Electron 版本上，tsx 的 load hook 对 `electron:` scheme 返回 null source。

**把用例改写成 Playwright Electron 远程驱动。** 现有测试在进程内组合 `ElectronBrowserRuntime` 并断言本进程的 partition；远程驱动会改变被测对象。

**启用已禁用的 `serial / macos` 聚合。** 该作业是完整的主 Node 清单，不是 Desktop/Electron 所有者，会把本通道藏进无关的串行运行。

## 结果

cookie 罐隔离在原生 Windows complete 与 macOS Electron e2e 作业上是必需的绿/红结果。贡献者只运行一条脚本；按次即兴 spawn Electron 不符合策略。[进程内 Electron Runtime 说明](../feature/2026-08-19-electron-browser-runtime.zh.md) 记录 Provider；本说明记录启动模式。

## 测试

- `pnpm exec vitest run scripts/run-electron-runtime-e2e.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts`
- 在已安装工作区 `electron` 二进制的主机上运行 `pnpm run test:electron-runtime-e2e`
- Node 上的 `pnpm exec vitest run --config vitest.e2e.config.ts packages/browser/browser-runtime-electron/tests/runtime.e2e.ts` 仍记录跳过
