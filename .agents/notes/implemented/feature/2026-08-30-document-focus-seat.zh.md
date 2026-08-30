# Agent Note：详情面板的文档聚焦席位

Status: implemented

[English](2026-08-30-document-focus-seat.md) | 中文

## 问题

路由来的成员问题会把引用文档列为材料 chip，但接收侧需要一个受控界面来阅读它们。详情面板否则只知道工具选择通道，没有文档聚焦的 chip 只是惰性文本——随路由带来的 `.md`/`.html` 正文无处渲染。

## 决策

详情面板获得第二个互斥的主体：文档聚焦。`ChatStoreState.documentFocus` 携带 `DetailsDocumentFocus`（path、filename、来源、可选内联正文）；写入并打开面板是经 ui-conversation 提供的可选服务 `ctx.get('detailsFocus')` 完成的一次手势——按会话绑定的 actions 由 details 注册的 inject 暂存（即 `LayoutController.attachPanels` 的装配模式），因此无法触及 chat store 的插件也能聚焦文档。贡献者会在用户激活 chip 时解析该可选服务，因此后注册的 provider 可以生效，provider 释放后联动恢复为无操作。面板关闭与下一次工具选择各自清除聚焦，两个主体保持互斥。

`conversation.details.document` 席位对照 `conversation.details.tool`：一个 session 作用域的占位者，覆盖面板按扩展名分派的三向 fallback——`.md`/`.markdown` 用 MarkdownText 渲染携带正文；`.html`/`.htm` 在不授予任何 sandbox 能力、使用惰性标记与属性允许列表、且文档首先安装 `default-src 'none'` 内容策略的情况下渲染受限预览（顶部保留琥珀色「受限预览 · 脚本与网络请求已禁用」条）；其余扩展名渲染纯文件 tab（图标、文件名、「来自 {name}」），不提供下载入口。清理会保留文本与惰性文档结构，同时丢弃主动、嵌套、表单、样式、refresh 与自导航能力；sandbox 阻止脚本、表单、弹窗与顶层导航；内容策略阻止幸存的被动图像源发出请求。

合成卡拥有两端的联动。chip 是调用 `focusDocument` 的按钮；详情面板打开时，卡通过观察常驻 `[data-details-panel]` 详情列（ui-layout）的 `aria-expanded` 折叠为收起条，这与观察共享呈现最小化开关是同一机制。激活该收起条会在不关闭面板的情况下恢复卡片，使文档与决策并排显示；关闭面板同样会让卡片保持恢复状态。`references` 携带可选内联 `content`（`askUserQuestionItemSchema` 镜像为可选），使可渲染正文随路由到达；没有 content 的引用退化为纯文件 tab，缺失 `detailsFocus` 服务时 chip 保持惰性。

## 已否决的替代方案

**聚焦状态放在 chat store 之外（layout 或插件本地 store）。** 已否决：详情面板已经从共享 chat-store 席位读取按会话的面板状态，第二条通道需要自己的会话作用域与持久化方案，却不带来新能力。

**由 conversation 把折叠状态推进卡片。** 已否决：卡片本就从观察到的 `aria-expanded` 事实推导折叠；详情列以同样方式暴露打开状态，让 ui-member-questions 无需依赖 layout。

## 后果

工具选择与文档聚焦互不相混：选择工具会替换被聚焦的文档，关闭面板后下一次打开回到工具选择。markdown/html 分派只渲染路由携带的内容——接收侧依然没有文件系统读取——因此发送方未附内联正文的引用退化为身份信息，而不是一次失败的加载。

## 测试

`packages/client/ui-conversation/tests/details-document-focus.client.spec.tsx` 钉住三向分派（markdown 标题、无授权 sandbox、已清理导航、全禁内容策略与无下载入口的纯文件 tab）、席位的 owner 货币与聚焦写入/清除通道。`packages/client/ui-member-questions/tests/member-questions-apply.client.spec.ts` 钉住 provider 的延迟注册、释放与贡献释放。卡片测试钉住 chip 载荷、在已打开面板旁恢复卡片、随后的原生最小化与再次打开详情面板。组装后的 Web 场景呈现恶意被动、主动、refresh 与链接导航请求，并由服务端 tripwire 证明没有请求到达；该场景会点击清理后的链接文本，在不关闭详情的情况下恢复卡片，并通过共享呈现作答。
