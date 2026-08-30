# Agent Note: Settings is one fullscreen page on web and Desktop

Status: implemented

[English](2026-08-27-settings-fullscreen-shell.md) | 中文

## Problem

Settings 原来是浮在 Session Surface 调暗遮罩之上的居中 800px 模态面板。这一形态把每个分区都锁在面板的小几何里——插件设置卡、模型编辑器，以及 Sub2API sidecar 票（#346）规划的账号管理整页都需要面板给不了的空间；而且两个产品端各自渲染一套外壳：浏览器 `dsh web` 在页内打开面板，Desktop 则请原生 overlay 视图把同一份面板标记画在另一份拷贝上。Codex 式全屏设置页需要同一个外壳——左侧导航加内容区随整窗缩放，两端一致——还不能破坏每个设置卡插件已在使用的注册协议。

## Decision

Settings 表面是归 ui-settings-general 所有的一个全视口页面：左列投影 `settings.section` 账本作导航，内容列承载头部操作、关闭控件和当前分区。页面是既有 `sidebar.settings` 占位者的输出，以固定定位图层渲染，打开时盖住 Session Surface；打开状态与当前分区 id 仍是组件本地 viewing state。三种 chrome 模式职责不变，从现在起只决定页面画在哪里，而不是画成什么样：

- **web**——侧栏触发器在文档内打开页面（浏览器 `dsh web`）。
- **desktop-host**——触发器继续调用 Host chrome（`chromeOverlayShow`），由 Host 抬起加载 overlay 文档的透明 overlay `WebContentsView`，因为官方页面是主窗口 DOM 无法覆盖的同级原生视图。
- **overlay**——页面订阅 Host chrome 状态，在 overlay 文档内绘制自身。

模态路径被整体移除，不留兼容层：遮罩、居中面板盒与 mask 点击关闭路径不复存在，而 Escape、头部关闭按钮、打开时聚焦、`dsh-overlay-lock` 握手和 Desktop 的 request/result 协议都保持不变。slot 契约（`settings.trigger/header/action/close/section/onboarding/plugins.tab/general.item`）逐字节相同，所以每个既有注册者——ui-settings-models、ui-settings-plugins、ui-settings-plugin-inventory、ui-agent-preset，以及 ui-desktop 的「手机配对」分区——无需任何改动即完成迁移。

## Alternatives considered

**保留模态、放大面板。** 面板仍会夹在视口内、背后垫着遮罩，账号管理整页要住进对话框里，两端也继续各画一套外壳。否决：全屏接管是产品要求。

**把页面注册进 `shell.overlay`。** AppFrame 的 overlay 层承载的是瞬态 chrome（Desktop `+` 菜单），页面就得把打开状态搬进 store、从 effect 里注册，或者给这层加一个设置领域并不想要的 keyed dispatch。`sidebar.settings` 占位者本来就渲染固定定位图层，不需要新路由。否决：与 slot 纪律相争而毫无收益。

**去掉 Desktop overlay 视图、在主窗口页内绘制。** 不改 Desktop Host 就做不到：官方页面以原生 `WebContentsView` 叠在主 web contents 之上，任何页内图层都够不着。overlay 视图仍是 Desktop 的绘制载体，变的只是它的内容。

## Consequences

两端交付同一个页面，组装证据覆盖两端：浏览器组合的 goldens 在 `apps/web/tests/snapshots/settings-chrome/`，Desktop 组合的 overlay 文档 golden 在 Host patch overlay 之下捕获。页面是不透明的 layer-2 表面，Settings 打开时完全盖住 Session Surface 而不是将其调暗——想在面板后面找到会话的用户找不到了，这正是有意的接管。在 Desktop 上关闭仍和从前一样经 `chromeOverlayResult` 上报，所以 `apps/desktop` 无需改动。
