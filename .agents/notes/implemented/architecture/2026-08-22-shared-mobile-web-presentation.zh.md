# Agent Note: Share Web presentation with Mobile Companion

Status: implemented

[English](2026-08-22-shared-mobile-web-presentation.md) | 中文

## Problem

Mobile Companion 曾用私有 `MobileContentBlock` union 分别实现 Markdown、code、image、Tool、diff、Approval、Ask User、terminal 与 composer markup。共享颜色可以让这棵树看起来像 Desktop Session Surface，但行为、无障碍、失败处理、未知内容与之后的 render-intent 变化仍有两套 implementation。prototype projection 还接受 Desktop 权威 Client Runtime projection 从未产生的标签与文本行。

## Decision

Web presentation owner 提供显式 `./presentation` 入口。`ui-workspace` 拥有 `SessionListState` 分组与 `SessionNodeItem` 行；`ui-conversation` 拥有覆盖全部终态 `ConversationNode` 的权威 keyed router、Approval 与窄版 `InputBarPresentation` interface；`ui-tool` 拥有递归 Tool presentation、内置 keyed roster 与未知 Tool fallback；`ui-user-questions` 拥有 Ask User；`ui-attachment` 拥有消息图片。`ui-theme` 提供稳定的 stylesheet subpath。这些入口是公共产品 interface，plugin 专用 skeleton path 与 CSS Module 仍为私有。

动态 Client 插件包使用 `browserSubpath` 构建这些浏览器 ESM 入口。该构建面把裸依赖与输出的 CSS 留给导入它的产品 shell，但不会把该包归类为 Desktop 静态链接包；它的主 `dsh.client` 模块表入口保持不变。

加密 channel 传输 JSON Mobile projection，而不是 Client Runtime object。conversation collection 与 turn index 使用数组，pending interaction 只携带 id 与 domain payload。唯一的 authenticated adapter 会在本地构造原始 `SessionListState`、`WorkspaceView`、`ConversationSnapshot`、`ConversationNode`、`ToolCallBlock` 与 `PendingWait` presentation 值。每条物理连接都会原子绑定 receiver、content adapter 与 mutation adapter；本地 pending responder 返回 generation 绑定 channel 的 settlement receipt，旧 responder 无法在重连后 dispatch。

`MobileBrowse` 保留手机导航，但既不拥有 Session 摘要／列表 renderer，也不拥有 conversation-node router。共享 Session 行拥有键盘 focus 与 activation 语义。订阅式 presentation clock 更新相对时间，按 Session 寻址的 history request 会替换权威 page。生产 surface 只有在当前物理 generation 已同步且其 authenticated channel 处于活动状态时才允许 mutation；仅凭 lifecycle state 不能启用回调。`main.tsx` 只选择实际运行的 Account、配对、Relay 与 Snow 产品 adapter。component 与 browser snapshot 通过显式 composition input 注入测试 transport，无法选择 development 产品环境。Mobile 不挂载 Desktop columns、Settings、model selection、plugin configuration 或 terminal input。

完整 Desktop `InputBar` 与 `ConversationComposer` 使用同一套由 owner 定义的 editor 与 primary-action presentation implementation。Desktop 与直接 composition 还共用 owner-defined 窄版 Approval 和 question component，而不伪造 framework kit 或 Session hook。`ConversationComposer` 拥有本地 `InputMachine` 草稿，把同步 transport throw 结算为被拒提交，并把获准的 prompt 与 cancellation operation 委托给调用方；它不提供 annotation、attachment、slot、projection、command 或 Host stand-in。加密 Companion Session transport 仍负责向打包 Mobile 入口提供权威 snapshot 与回调。

Desktop keyed slot 与 `ToolPresentation` 使用同一份内置 Tool roster。Bash、read、write/edit、grep/glob、Web、todo 与 question 调用挂载各自专用 owner row；`GenericToolCard` 只渲染未被认领的 wire 名称。直接 composition 把权威 `ToolCallBlock`、cwd 与 home 值送入 `DirectToolCallTree`，不会构造 Chat Node 或 Host description。

## Verification

Mobile component test 通过 authenticated adapter 转换 JSON projection，并覆盖有代表性的终态 conversation node、共享键盘 Session 行、专用普通与未知 Tool、image、Approval、Ask User、accepted 与 rejected settlement receipt、generation replacement、多页 history、订阅式时间、InputBar submit、locale、theme、overflow 与 Host error。keyless browser snapshot 构建打包后的 `main.tsx` 入口，通过拦截的 HTTPS 响应完成 Account lifecycle，再以 390 px 的英文／dark 与中文／light 环境执行共享 conversation、Approval、Ask User 与 input component。该 snapshot 使用注入的测试 transport，不运行 model round，既不证明实际运行的 Platform，也不证明真实 Paired Desktop。`verify-companion-product-entry` 与 Mobile 产品纯度测试会拒绝产品入口文件中的 development 产品 selector、仅供证明的 Companion example、禁用的 prototype 端口、固定 attachment id、一字节同步帧和明文 Relay authority。原生发布证据会在 iOS Simulator WKWebView 与 Android Emulator WebView 中执行仓库内确切的 Snow JS/WASM 包。所有验收都不使用 `prototype-companion` 或 5173/5174 端口。

## Alternatives considered

**只共享 CSS 与 domain label。**不采用，因为两棵 rendering tree 会继续在语义、键盘行为、未知内容与结构化 Tool output 上产生偏差。

**在手机宽度挂载完整 Desktop slot tree。**不采用，因为 Desktop navigation、details columns、Settings、model selection、plugin configuration 与 terminal affordance 超出 Companion Surface authority，且会形成不可用的窄屏布局。

**在 Runtime 与 React 之间新增通用 Mobile transcript model。**不采用，因为它会复制权威 Client projection，并要求每次 Conversation Node 或 render intent 变化时再做一层转换。

## Consequences

一处 presentation 修复可以同时触达 Desktop 与 Mobile component，Mobile test 也会执行 Desktop 使用的同一 implementation file。公共 presentation 入口扩大了受支持的 package interface，因此需要 package 文档、build/export check，以及经过审慎决定的 compatibility change。Mobile bundle 还会包含共享 Markdown 与 syntax-highlighting asset，增大初始 artifact。JSON adapter 是 transport representation，而不是第二套 presentation model：它只负责在不传输 runtime class 或 closure 的前提下重建共享 carrier。加密 Companion v3 channel 会提供权威 projection 以及 generation 绑定的 content 与 mutation adapter；产品验收仍须执行实际组装的 Platform、Desktop 与 Mobile 链路，component snapshot 不能替代。
