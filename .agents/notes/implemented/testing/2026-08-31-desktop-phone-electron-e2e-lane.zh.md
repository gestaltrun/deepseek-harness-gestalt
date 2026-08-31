# Agent Note: 桌面手机 Electron 端到端测试通道

Status: implemented

[English](2026-08-31-desktop-phone-electron-e2e-lane.md) | 中文

## 问题

手机 tab 横跨 Desktop 主进程、Host 子进程、两个渲染面、HTTP 路由、手机运行时、流代理与 mobilecli。仅浏览器测试和 Electron 启动冒烟不能证明这条组装链能渲染已解码的 H264 画面并转发设备输入。只断言 H264 响应字节的测试可能通过，而 Chromium 仍不显示画面。

## 决定

`pnpm run test:e2e-electron` 构建当前源码，并通过 WebdriverIO Electron service 对 `apps/desktop/out/main.mjs` 运行两个场景。运行器使用 operated-platform fixture、全新的 `DSH_HOME`、Electron 用户数据与 Workspace 根目录，并把 Desktop smoke 日志作为 Host URL 权威。运行器会把 mobilecli 与 CDP 的不同回环端口租约持有到启动前，并通过一个所有权 token 验证临时 fake；该 token 随本次运行暂存的 fake 创建，并在端口交接重试之间复用。所有权请求会在 1 秒后超时，并通过同一种验证失败报告。只有已完成 drain 的运行器日志报告所有权或 bind 失败，且交接后的端口仍接受连接时，运行器才会改用一组全新端口重试。Session Surface 与 Desktop overlay 保持为两个 WebDriver 窗口，通过 overlay 文档标记选择。

实时场景把真实 Desktop Host 与仓库 fakemobilecli fixture 的临时可执行副本组装起来。fixture 返回当前设备信封与 390×844 H264 流。场景通过产品 RPC 路由创建带 Workspace 的 Session，经 overlay 菜单选择手机 tab，检查可用设备分组和仅在线选择器，打开设备，并同时要求 H264 传输有效与 390×844 已解码画面实际渲染。场景会记录全部 `/phone/stream/*` 资源，并要求集合非空、每条路径都以 `/h264` 结尾且不存在 `/mjpeg` 路径，否则测试失败。随后在单例 tab 中切换设备，要求每个 replacement 都绘制一幅 390×844 已解码画面，再把中心点按与主屏幕按钮转发给 fake，并打开独立的「手机设备」设置分区。

降级场景用不可解析的 mobilecli 路径启动同一 Desktop 组合，要求 Host 保持存活并显示安装指引。两个场景都要求 URL 宣布、入口 HTTP 200、Session Surface 已渲染，并且稳定等待后 Desktop smoke 日志中没有错误。

运行器在启动前强制重建所有被消费的 Host、client、web 与 Electron main 产物。Electron e2e TypeScript 源码使用专用 Desktop compiler face，所属 package 与仓库 typecheck 命令都会执行该编译面。运行器移除环境中的凭证与 Platform Relay 变量，提供 keyless 回环模型端点，并且只把验收产物写入 gitignored 的 `.artifacts/e2e-electron/`。每条已启动命令都持有独立进程树；中断或日志写入失败会终止整棵进程树并等待完全停稳。命令只有在 stdio 关闭且串行日志 writer 刷新完成后，才允许检查构建结果或审计日志。每个成功场景都会记录归属的 Electron 与 Host PID，并在适用时记录 fake PID；缺失证据会让清理失败。teardown 会强制终止残留进程，分别结算进程、临时根目录与端口义务，把所有结果写入 `cleanup.json`，并聚合报告错误。Electron main/renderer 错误行与 Desktop smoke 错误会让通道失败，并写入 `log-audit.json`。

`DSH_PHONE_SERVER_PORT` 是 Desktop overlay 中可随部署调整的 mobilecli 服务端口设置。默认值仍为 `12000`；端到端运行器传入临时值，避免并行开发服务破坏证据。

## 考虑过的替代方案

**仅浏览器自动化。** 拒绝，因为它绕过 Electron 主进程、overlay WebContentsView、Host 子进程生命周期与 Electron 特有的解码行为。

**只断言 H264 传输。** 拒绝，因为有效的 Annex-B 字节不能证明 Chromium 已解码并绘制可见画面。

**固定 mobilecli 服务端口。** 拒绝，因为无关的本地进程可能让正确测试失败，或者把测试路由到错误服务。

## 结果

该通道无需密钥，但仍是完整的本地 Electron 验收检查，不替代单元测试。证据分别标明 Host 启动、传输字节、解码画面可见性、输入转发与清理。仓库 Electron runtime 冒烟通过不能替代本通道；本通道通过也不授权产品发布或合入 `master`。
