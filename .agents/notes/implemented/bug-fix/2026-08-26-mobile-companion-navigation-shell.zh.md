# Agent Note: Mobile Companion 导航 shell

Status: implemented

[English](2026-08-26-mobile-companion-navigation-shell.md) | 中文

## Problem

登录后的 Mobile 根节点把当前 Installation 账号、Personal Pairing 与 Session 浏览器挂载在同一份滚动文档中。账号与配对控件和 Session 产品并排出现，而没有各自的导航目的地；打开配对还会把 controller lifecycle 所有权交给一个可能与 home 同时挂载的视图。

## Decision

`MobileAccount` 拥有一个登录后页面状态：home、account 或 pairing。Home 包含已认可的手机密度账号 header、所选 Desktop 状态、共享 Workspace 与 Session 行、权威搜索，以及 Workspace 或 Ungrouped Session 创建。Account 与 Personal Pairing 分别占用独立的全高页面，并提供显式返回导航。Shell 会在每次 Account transition 提交 activation 与 deactivation；pairing controller 会按 generation 串行化这些操作，因此旧的慢 activation 与 cleanup 无法停止下一次登录 generation。`MobilePairing` 挂载在该 shell 中时会禁用自身 lifecycle 所有权。

对话详情继续作为全屏目的地，复用共享 `ui-conversation` 组件与共享 `ui-workspace` Session 行。设计 prototype 只提供布局参考。打包入口 snapshot 与仓库内 Capacitor 应用仍是产品验收入口；`prototype-companion` 与端口 5173/5174 不提供验收证据。

## Alternatives considered

**保留单页滚动的登录后页面。** 不采用，因为它会移除手机使用所需的信息层级与导航目的地，还会让账号或配对工作与 Session 列表争用同一视口。

**把 prototype runtime 恢复成产品代码。** 不采用，因为其中的 fixture identity、本地状态与仅用于证明的 transport 都不是产品 authority。发布 shell 包裹实际运行的 Account、Personal Pairing、Relay 与 Desktop 权威 projection。

**用 prototype markup 重建对话详情。** 不采用，因为 Desktop 与 Mobile 会有意复用 Session 行、conversation node、Approval、Ask User、image、Tool 与 composer presentation。Mobile shell 拥有导航与手机布局，而不是第二套对话实现。

## Consequences

登录后导航属于本地 presentation state，并会在退出登录时重置为 home。配对进度与所选 Desktop authority 会在导航期间保留，因为其 controller 独立于可见页面持续 active。聚焦 lifecycle coverage 会让慢 activation、退出登录与立即重新登录发生竞态，并保证只有最新 generation 保持 active。390 像素打包入口 snapshot 会验证相互分离的账号与配对目的地、共享详情行为以及零横向溢出；原生 WebView 与实际运行的端到端验收仍是另外必需的证据。
