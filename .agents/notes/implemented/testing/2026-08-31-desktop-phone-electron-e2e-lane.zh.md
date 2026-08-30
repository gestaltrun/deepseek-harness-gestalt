# Agent Note：桌面手机 Electron 端到端测试通道

状态：已实施

[English](2026-08-31-desktop-phone-electron-e2e-lane.md) | 中文

## 问题

手机 tab 横跨 Desktop 主进程、Host 子进程、两个渲染面、HTTP 路由、手机运行时、流代理与 mobilecli。仅浏览器测试和 Electron 启动冒烟不能证明这条组装链能渲染已解码的 H264 画面并转发设备输入。只断言 H264 响应字节的测试可能通过，而 Chromium 仍不显示画面。

## 决定

`pnpm run test:e2e-electron` 构建当前源码，并通过 WebdriverIO Electron service 对 `apps/desktop/out/main.mjs` 运行两个场景。运行器使用 operated-platform fixture、全新的 `DSH_HOME`、Electron 用户数据与 Workspace 根目录、临时 mobilecli 服务端口，并把 Desktop smoke 日志作为 Host URL 权威。Session Surface 与 Desktop overlay 保持为两个 WebDriver 窗口，通过 overlay 文档标记选择。

实时场景把真实 Desktop Host 与仓库 fakemobilecli fixture 的临时可执行副本组装起来。fixture 返回当前设备信封与 390×844 H264 流。场景通过产品 RPC 路由创建带 Workspace 的 Session，经 overlay 菜单选择手机 tab，检查可用设备分组和仅在线选择器，打开设备，并同时要求 H264 传输有效与 390×844 已解码画面实际渲染。随后在单例 tab 中切换设备，把中心点按与主屏幕按钮转发给 fake，并打开独立的「手机设备」设置分区。

降级场景用不可解析的 mobilecli 路径启动同一 Desktop 组合，要求 Host 保持存活并显示安装指引。两个场景都要求 URL 宣布、入口 HTTP 200、Session Surface 已渲染，并且稳定等待后 Desktop smoke 日志中没有错误。

运行器在启动前强制重建所有被消费的 Host、client、web 与 Electron main 产物。它移除环境中的凭证与 Platform Relay 变量，提供 keyless 回环模型端点，并且只把验收产物写入 gitignored 的 `.artifacts/e2e-electron/`。每轮记录归属的 Electron、Host 与 fake PID；teardown 要求这些进程、临时根目录与分配端口全部消失。Electron main/renderer 错误行与 Desktop smoke 错误会让通道失败，并写入 `log-audit.json`。

`DSH_PHONE_SERVER_PORT` 是 Desktop overlay 中可随部署调整的 mobilecli 服务端口设置。默认值仍为 `12000`；端到端运行器传入临时值，避免并行开发服务破坏证据。

## 考虑过的替代方案

**仅浏览器自动化。** 拒绝，因为它绕过 Electron 主进程、overlay WebContentsView、Host 子进程生命周期与 Electron 特有的解码行为。

**只断言 H264 传输。** 拒绝，因为有效的 Annex-B 字节不能证明 Chromium 已解码并绘制可见画面。

**固定 mobilecli 服务端口。** 拒绝，因为无关的本地进程可能让正确测试失败，或者把测试路由到错误服务。

## 结果

该通道无需密钥，但仍是完整的本地 Electron 验收检查，不替代单元测试。证据分别标明 Host 启动、传输字节、解码画面可见性、输入转发与清理。仓库 Electron runtime 冒烟通过不能替代本通道；本通道通过也不授权产品发布或合入 `master`。
