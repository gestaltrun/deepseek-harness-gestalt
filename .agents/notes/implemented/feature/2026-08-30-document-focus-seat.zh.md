# Agent Note：详情面板的文档聚焦席位

Status: implemented

[English](2026-08-30-document-focus-seat.md) | 中文

## 问题

工单 #344 M3：路由来的成员问题把引用文档列为材料 chip，但接收侧没有阅读它们的面。详情面板只知道工具选择通道，chip 只是惰性文本——随路由带来的 `.md`/`.html` 正文无处渲染。

## 决策

详情面板获得第二个互斥的主体：文档聚焦。`ChatStoreState.documentFocus` 携带 `DetailsDocumentFocus`（path、filename、来源、可选内联正文）；写入并打开面板是经 ui-conversation 提供的可选服务 `ctx.get('detailsFocus')` 完成的一次手势——按会话绑定的 actions 由 details 注册的 inject 暂存（即 `LayoutController.attachPanels` 的装配模式），因此无法触及 chat store 的插件也能聚焦文档。面板关闭与下一次工具选择各自清除聚焦，两个主体保持互斥。

`conversation.details.document` 席位对照 `conversation.details.tool`：一个 session 作用域的占位者，覆盖面板按扩展名分派的三向 fallback——`.md`/`.markdown` 用 MarkdownText 渲染携带正文；`.html`/`.htm` 渲染沙箱受限预览（仅 `sandbox="allow-same-origin"`：无脚本授权、无网络路径，顶部有琥珀色「受限预览 · 脚本与网络请求已禁用」条）；其余扩展名渲染纯文件 tab（图标、文件名、「来自 {name}」），不提供下载入口。

合成卡拥有两端的联动。chip 是调用 `focusDocument` 的按钮；详情面板打开期间，卡通过观察常驻 `[data-details-panel]` 详情列（ui-layout）的 `aria-expanded` 折叠为收起条——与既有的共享演示最小化开关观察是同一机制——该列在宽度为 0 时也保持挂载，正是为了让打开状态以属性而非挂载为通道。关闭面板即恢复卡片。`references` 增加可选内联 `content`（`askUserQuestionItemSchema` 镜像为可选），使可渲染正文随路由到达；没有 content 的引用退化为纯文件 tab，缺失 `detailsFocus` 服务时 chip 保持惰性。

## 已否决的替代方案

**聚焦状态放在 chat store 之外（layout 或插件本地 store）。** 已否决：详情面板已经从共享 chat-store 席位读取按会话的面板状态，第二条通道需要自己的会话作用域与持久化方案，却不带来新能力。

**由 conversation 把折叠状态推进卡片。** 已否决：卡片本就从观察到的 `aria-expanded` 事实推导折叠；详情列以同样方式暴露打开状态，让 ui-member-questions 无需依赖 layout。

## 后果

工具选择与文档聚焦互不相混：选择工具会替换被聚焦的文档，关闭面板后下一次打开回到工具选择。markdown/html 分派只渲染路由携带的内容——接收侧依然没有文件系统读取——因此发送方未附内联正文的引用退化为身份信息，而不是一次失败的加载。

## 测试

`packages/client/ui-conversation/tests/details-document-focus.client.spec.tsx` 钉住三向分派（markdown 标题、无 `allow-scripts` 的 sandbox 属性、无下载入口的纯文件 tab）、席位的 owner 货币与聚焦写入/清除通道。`packages/client/ui-member-questions/tests/member-questions-card.client.spec.tsx` 钉住 chip → `focusDocument` 载荷与打开 → 折叠 → 关闭 → 恢复的往返。`packages/host/apiproxy/tests/rpc-schemas.spec.ts` 与 `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts` 覆盖线上字段与卡样式表新增的高程重绑定。
