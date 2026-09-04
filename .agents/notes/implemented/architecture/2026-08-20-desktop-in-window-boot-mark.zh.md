# Agent Note: Desktop in-window boot mark

Status: implemented

[English](2026-08-20-desktop-in-window-boot-mark.md) | 中文

## Problem

Desktop Host 会在 Web Host 打印环回 URL 之前就显示 BrowserWindow。Account 恢复与 Host 启动原先在该空白窗口上串行执行。web 外壳加载页只能在 `loadURL` 之后绘制，因此长时间等待是空白的，而插件加载转圈只在 Host 已经就绪后闪一帧。

## Decision

Desktop Host 拥有可见的冷启动标记。`createWindow()` 在同一窗口上用本地 `boot.html` 覆盖层（`WebContentsView`）绘制，并带 `-webkit-app-region: drag` 以及 `prefers-color-scheme` / `prefers-reduced-motion`。`loadURL` 之后，`revealHost` 轮询 `globalThis.__DSH_SHELL_READY__ === true`，并以 `[data-desktop-chrome]` 与 fail-loud 插件页为回退，避免过期前端把覆盖层钉住。`AppWebEntry` 在已 settle 的 Session Surface 挂载或 fail-loud 插件页绘制后设置该标志，然后撤下覆盖层。浏览器 `dsh web` 仍使用外壳加载页。没有第二扇 splash 窗口。`joinHostAfter` 仍是可测试的重叠 helper；冷启动目前先恢复 Account、Personal Pairing 与 sub2api，再启动 Host，因为 Host 启动超时取自 sub2api 快照。

## Alternatives considered

**维持 SPEC.md 的空白窗口冷启动。** 这避免了单独的 splash 窗口，但等待发生在 Host 启动，web 加载页覆盖不到。

**让主 `webContents` 从 `boot.html` 导航到 Host URL。** 导航会在 Session Surface 绘制前卸掉标记，空白或闪帧缺口仍在。

**在 `loadURL` 之前等待 Personal Pairing。** 已登录的 Remote Access 加载会卡住 Host URL，而 Session Surface 首次绘制并不需要 pairing。

**只把启动标记放在 `index.html` / AppWebEntry。** 它仍然在 Host 启动之后才出现，而这正是慢的那一步。

## Consequences

冷启动从第一帧起显示 GESTALT，直到真正的 UI（或 fail-loud 页面）上屏。Host 启动与 Account start 重叠。Host 侧错误页会替换该标记，因为 `showError` 在覆盖层 dispose 之前运行。web 加载页仍是浏览器与 fail-loud 门禁；Desktop 用户在成功启动过程中看不到 “Loading plugins…”。

## Testing

`apps/desktop/tests/boot-session.spec.ts` 钉住重叠的 Host 启动、就绪标志轮询，以及 `boot.html` 自包含且被打包。`packages/client/web/tests/boot.client.spec.ts` 钉住 settle 挂载与 fail-loud 提交后的 `__DSH_SHELL_READY__`。Desktop smoke 仍要求 `loadURL` 之后的 Session Surface 证据。
