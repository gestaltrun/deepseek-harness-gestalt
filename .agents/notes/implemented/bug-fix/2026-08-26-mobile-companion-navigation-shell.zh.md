# Agent Note: Mobile Companion 导航 shell

Status: implemented

[English](2026-08-26-mobile-companion-navigation-shell.md) | 中文

## Problem

登录后的 Mobile 根节点把当前 Installation 账号、Personal Pairing 与 Session 浏览器挂载在同一份滚动文档中。账号与配对控件和 Session 产品并排出现，而没有各自的导航目的地；打开配对还会把 controller lifecycle 所有权交给一个可能与 home 同时挂载的视图。

## Decision

`MobileAccount` 拥有一个登录后页面状态：home、account 或 pairing。Home 包含一个 40 像素的 Account 菜单入口、所选 Desktop 状态，以及共享 Workspace 与 Session 行，不会在 Session header 中暴露账号身份。Account 与 Personal Pairing 分别占用独立的全高页面，并提供显式返回导航。初始配对任务把扫码作为主操作，只把粘贴完整链接作为显式备用入口；handshake 进度、安全词、重试与不可用状态会替换该任务，而不是堆叠在它下面。Desktop 拒绝会清除已经终止的 attempt，并提供新完整邀请的入口；可能已经提交但结果不确定的 attempt 仍然只能重试。它的 ready 页面把 hero、相机预览与完整链接表单放在同一个有界 method stage 中；切换方式会原位替换这个 stage，操作按钮紧跟任务说明，而不是固定在 viewport 底部。React 挂载前的 composition failure 会把空 root 替换为双语启动警告及其精确错误消息。搜索占用一个聚焦页面，只渲染 Desktop 权威结果，并可返回 Session 列表。Workspace 与 Ungrouped 创建会占用带标签的等待页，直到 Desktop 发布新 Session id；Remote Offline 或失败不能暴露可编辑 conversation。Remote Offline 时仍可进入搜索与创建页面，但在 foreground synchronization 恢复前，Desktop 操作保持 fail-closed。物理 Relay attachment 打开后，重复的前台通知保持幂等。仍然连接的 Relay 上出现 peer-offline 错误时，只会让同步失效并保留 socket，使已鉴权 peer 返回后不必制造物理重连即可恢复。Home viewport 拥有一个覆盖在底部的操作 dock，每个 Workspace header 可独立折叠其 Session 行，每个分组拥有独立的有界行窗口与加载更多控件。Desktop 归档 authority 会从初始列表、实时 replacement 与全文搜索结果中移除 Session。原生应用只允许竖屏展示。完整的未登录页面会让保留期事实、同意文案、进度、操作与 footer 跟随所选中文或英文 locale，同时保留两份隐私说明。Shell 会在每次 Account transition 提交 activation 与 deactivation；pairing controller 会按 generation 串行化这些操作，因此旧的慢 activation 与 cleanup 无法停止下一次登录 generation。`MobilePairing` 挂载在该 shell 中时会禁用自身 lifecycle 所有权。

Account 页面把 GitHub identity 放在头像右侧，并拥有对整个已挂载 Mobile 产品生效且持久化的中英文选择器。Session 列表只允许从滚动起点下拉刷新。Remote Online 会发送一项 offset 为零的加密 `refresh-surface` 操作，并用关联的 Desktop projection 替换列表；Remote Offline 不发送操作，而会说明必须先重新连接，包括 Companion Cache 已清除后的情况。

对话详情继续作为全屏目的地，复用共享 `ui-conversation` 组件与共享 `ui-workspace` Session 行。空白详情显示“新会话”而不暴露不透明的 Session id；手机 header 拥有图标返回操作，加密附件操作位于共享 InputBar 前方的工具行。设计 prototype 只提供布局参考。打包入口 snapshot 与仓库内 Capacitor 应用仍是产品验收入口；`prototype-companion` 与端口 5173/5174 不提供验收证据。

## Alternatives considered

**保留单页滚动的登录后页面。** 不采用，因为它会移除手机使用所需的信息层级与导航目的地，还会让账号或配对工作与 Session 列表争用同一视口。

**把 prototype runtime 恢复成产品代码。** 不采用，因为其中的 fixture identity、本地状态与仅用于证明的 transport 都不是产品 authority。发布 shell 包裹实际运行的 Account、Personal Pairing、Relay 与 Desktop 权威 projection。

**用 prototype markup 重建对话详情。** 不采用，因为 Desktop 与 Mobile 会有意复用 Session 行、conversation node、Approval、Ask User、image、Tool 与 composer presentation。Mobile shell 拥有导航与手机布局，而不是第二套对话实现。

## Consequences

登录后导航属于本地 presentation state，并会在退出登录时重置为 home。搜索会在打开结果详情期间保留 query 与结果，并在返回 Session 列表时清除 Desktop 搜索状态。创建会返回列表，或仅进入 Desktop 已确认的 Session 详情。配对进度与所选 Desktop authority 会在导航期间保留，因为其 controller 独立于可见页面持续 active。聚焦 lifecycle coverage 会让慢 activation、退出登录与立即重新登录发生竞态，并保证只有最新 generation 保持 active。390 像素打包入口 snapshot 会验证相互分离的账号、配对、搜索、创建与共享详情目的地以及零横向溢出；原生 WebView 与实际运行的端到端验收仍是另外必需的证据。
