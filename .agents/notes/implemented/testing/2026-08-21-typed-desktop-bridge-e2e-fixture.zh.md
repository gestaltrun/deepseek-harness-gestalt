# Agent Note: Type-complete DesktopBridge Web E2E fixture

Status: implemented

[English](2026-08-21-typed-desktop-bridge-e2e-fixture.md) | 中文

## 问题

Desktop chrome Web E2E 在组装后的 client apply 之前安装 `window.dshDesktop`。apply 路径会同步绑定 Account 与 Pairing 订阅。只提供 updater 与窗口控件的桩会在 drag strip 绘制之前抛错；一份未做类型检查、漏掉后来新增的必需 preload 成员的内联 mock，会以三十秒选择器超时失败，而不是类型错误。

## 决策

`packages/client/ui-desktop/tests/desktop-bridge-fixture.client.ts` 拥有惰性 Desktop Host preload。`installDesktopBridgeFixture` 的返回类型是 `DesktopBridge`，因此缺少必需成员时类型检查失败。Account 与 Pairing 订阅在 subscribe 时立即投递应答前的 `unavailable` 快照；unsubscribe 移除监听器，使后续惰性动词不再通知它。`apps/web/tests/desktop-chrome.e2e.ts` 动态导入该函数并交给 Playwright `addInitScript`，因此 host 类型检查程序不会加载 `packages/client/*/src`。[web GUI 浏览器 e2e 车道](2026-07-24-web-gui-browser-e2e-lane.zh.md) 仍拥有组装回放车道；本说明拥有这份带类型的 fixture。

## 考虑过的替代方案

**把完整 mock 留在 `desktop-chrome.e2e.ts` 内联。** 页面脚本可以保持自包含，但对象不对照 `DesktopBridge` 检查，因此新增必需成员会退化成浏览器超时。

**把内联对象类型断言为 `DesktopBridge`。** 断言会接受不完整的字面量；缺成员的失败仍然是超时。

**从 `@deepseek-ai/dsh-client-ui-desktop` 的 `/client` 导出这份 fixture。** 这会为仅供 Playwright 使用的安装器扩大公共插件 API。

**再提交一份用 `addInitScript({ path })` 加载的 JavaScript 文件。** 带类型的 TypeScript fixture 与序列化后的安装器会漂移。

## 结果

在 preload 接口上新增必需的 `DesktopBridge` 成员时，必须在同一变更中写入 fixture。Playwright 会把安装器序列化进页面，因此函数体不能闭包导入的运行时值；仅类型导入会被擦除。client 类型检查程序拥有该 fixture；host 程序不得静态导入它。

## 测试

- `pnpm exec vitest run packages/client/ui-desktop/tests/desktop-bridge-fixture.client.spec.ts`
- `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/desktop-chrome.e2e.ts`
