# `@deepseek-ai/dsh-client-ui-desktop`

[English](README.md) | 中文

本包提供仅 Desktop 的 Session Surface chrome 和手机配对 Settings。Desktop Host 的 `--patch` 叠加层插入这一行；浏览器 `dsh web` 不加载。它在 `sidebar.brand` 上选中 GESTALT 字标，填充 `sidebar.chrome.drag`，在 `sidebar.footer.action` 注册 Update Control，并贡献 `手机配对` Settings section。该 section 投影 Host 拥有的当前安装账号与 Personal Pairing 状态，在授权前同时显示中英文隐私说明，并通过 `window.dshDesktop` 发起账号与配对操作；私钥和 pairing key 都不会进入 renderer。配对 panel 拥有 Mobile Access toggle、完整 QR/link invitation、authentication-word confirmation、拒绝与 paired-device list。普通 sidebar 不新增账号或配对入口。发现可用版本后，Update Control 会在 available、downloading、preparing、downloaded、installing 阶段及后续 error 阶段挂载；disabled、idle、checking 和发现版本前的 error 不占侧栏 seat。非活跃阶段只通过隐藏的 `data-desktop-updater-state` marker 暴露 phase，该 marker 没有文本或无障碍角色；可见阶段在按钮上暴露 `data-desktop-update-control`。更新和窗口操作也都走 preload bridge。

macOS chrome 在未改动的 DSH 侧栏标题行和中间 Session 内容上方为原生 traffic lights 保留 28px 空间。Windows 拖拽行横跨视口，三个 caption 按钮位于不可拖拽区域，但不改变 Session 内容的顶部间距。其他开发平台不绘制自定义 Window Chrome，并保留系统窗口框架。

## Model Experience

无。本包只画 Desktop 铬，不进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **没有 `window.dshDesktop` 时插件空转** — 手机配对账号状态、Update Control 与 Window Chrome 不渲染，各自 source 保持初始状态。
- **组装后的 Desktop Web E2E 安装 `installDesktopBridgeFixture`** — 该 fixture 缺少必需 preload 成员时类型检查失败，而不是浏览器超时（[带类型的 DesktopBridge fixture](../../../.agents/notes/implemented/testing/2026-08-21-typed-desktop-bridge-e2e-fixture.md)）。
- **产品配对由端点持有** — Host 挂载不透明 mailbox、端点 Snow owner、持久 key vault、密封 Mobile authority 投递和真实 Relay 生命周期。独立评审与 WebView 真机运行仍是发布证据。
