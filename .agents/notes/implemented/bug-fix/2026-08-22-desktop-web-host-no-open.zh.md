# Agent Note: Desktop Web Host `--no-open`

Status: implemented

[English](2026-08-22-desktop-web-host-no-open.md) | 中文

## 问题

除非调用传入 `--no-open`，`dsh web` 会在 Loader 配置树结算后打开操作系统默认浏览器。Desktop Host 已经在自己的 Electron 窗口加载该环回 URL，因此默认的 Web Host spawn 会把 Session Surface 再复制到系统浏览器。

## 决策

Desktop Host 的 spawn argv 在打包与源码启动中均为 `web --patch <overlay> --no-open --host 127.0.0.1 --port 0`。`--patch` 写在应用 flag 之前，以便启动器消费叠加层，Web 应用接收 `--no-open`。Desktop 叠加层把 `web-runtime` 行配置替换为 `openBrowser: false`，同时保留 `printUrl`、`surfaceContext` 与 `trustedHosts`。普通 `dsh web` 仍保持 `openBrowser: true`，见 [打开已就绪 Web UI 的 Agent Note](../feature/2026-08-12-open-ready-web-ui.md)。[Desktop Host Agent Note](../architecture/2026-08-16-deepseek-gestalt-desktop-host.md) 记录 spawn flags。

## 考虑过的替代方案

**把 `dsh web` 默认改成 `--no-open`。** 否决，因为本机 CLI 启动仍然没有窗口，仍然需要操作系统浏览器；Desktop 才是已经拥有窗口的调用方。

**只在叠加层把 `openBrowser` 设为 false，不传 `--no-open`。** 否决作为唯一控制，因为无人值守调用方把 `--no-open` 写成调用退出方式，且 spawn argv 是打包二进制约定。

**只传 `--no-open`，不改叠加层。** 否决作为唯一控制，因为漏掉该 flag 的 Desktop Host 二进制仍会从 extraResources 加载此叠加层，而叠加层替换完整 `web-runtime` 配置，因此 `ctx.webStartup.openBrowser` 无法再打开操作系统浏览器。

## 后果

Desktop 启动会打印 `dsh web:` URL 行，且不会打印 `dsh web: opening the default browser; pass --no-open to disable`。仅浏览器的 `dsh web` 保持不变。Desktop 窗口里的普通 HTTP 链接仍走 `shell.openExternal`。

## 测试

`apps/desktop/tests/runtime-paths.spec.ts` 固定打包与源码 argv 中 `--no-open` 位于 `--patch` 之后。`apps/desktop/tests/overlay-isolation.spec.ts` 固定 Desktop 叠加层上的 `openBrowser: false`，以及仅浏览器 Web 图上的 `!!js ctx.webStartup.openBrowser` 默认值。
