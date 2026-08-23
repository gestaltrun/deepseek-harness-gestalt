# Agent Note: 通过 Companion 承载共享 Session 展示

Status: implemented

[English](2026-08-23-encrypted-companion-session-surface.md) | 中文

## Problem

[共享 Mobile Web 展示](2026-08-22-shared-mobile-web-presentation.md)可以重建 Desktop 展示值，但加密产品 channel 只提供 foreground authority、搜索与 attachment operation。Session 发现、history、mutation、待处理人工 interaction 与历史图片字节仍缺少一套有界协议和 Host owner，因此渲染共享组件并不能证明其 authority 来自配对 Desktop。

## Decision

Encrypted Companion Protocol major 3 是配对 endpoint 之间的 allowlist。Desktop 把 Session 与 Workspace 发现投影为连续的有界 page，并提供完整 conversation page；每个发现 request 都携带从零开始的 offset，每个 response 会重复该 offset 并说明是否还有下一页。authenticated Mobile receiver 会自动请求直至耗尽，拒绝间隙与重复 Session id，并在发布完整 browse list 前合并 page-scoped Workspace membership。Mobile 发送带不透明 operation correlation 的 history、prompt、取消、Approval、Ask User 与图片读取 operation。每项 mutation 都经 pairing-scoped 持久 ledger 执行。同一 operation 的并发重试共享一次 Host effect；commit save 失败会保留 terminal result 供持久化重试；记录在七天后过期；容量不足时先驱逐最旧 terminal 记录，再拒绝 unresolved work。持久记录会解析品牌化 identity 与完整 v3 result，并要求 record 与 result 的 operation id 一致。Desktop owner 只调用具名 Web Host 方法，并把 HTTP、wire、业务与超时失败转换为关联的协议 result；它永不接受任意 Host RPC 名称或 payload。

一个物理 Snow generation 拥有 Mobile decoder、mutation adapter、content adapter 与共享 `MobileCompanionSurface` 绑定。已接受的 replacement 会使旧 generation 的待处理 settlement、prompt confirmation、图片工作与已追踪操作失效。peer replacement 会保留 foreground Relay socket，立即使 authenticated generation 失效，并且只在 replacement IK 成功后建立新 generation；它不会等待第二次 socket-ready event。composer 会等待 Desktop prompt confirmation；关联失败会 reject 该 Promise、保留草稿，并且只在所属 Session 中保持可见。tail history response 会替换 conversation；`loadOlder` 则把最旧可见 sequence 作为 `beforeSeq` 发送，并 prepend 通过连续性校验的 single-flight page。只有匹配的已认证 conversation projection 或 operation failure 才会释放该 history request；aggregate refresh 不会释放它，transport rejection 则会释放并显示失败。Desktop 会随每次 history response 刷新真实 Host running 状态，因此共享 Stop 控件反映权威状态。重试生命周期事件使用共享 `model-retry` node，并隐藏被该次重试接管的终态错误。确认后的 prompt、取消与 interaction mutation 会请求一次有界的权威 history 与列表刷新，而不是增加另一条 live transport；两个自动刷新操作都会持续追踪，直到其精确 projection 或 failure 到达。待处理 Host rpc id 留在 Desktop；Mobile 接收 pairing-private HMAC interaction id，并在本地重建共享 `PendingWait` responder。Session 创建不属于 major 3，因此 shipped entry 不提供 New Session handler。

历史图片使用 Session 的按内容寻址 attachment id。Desktop 经 Host attachment 方法读取确切字节，把最多 16 MiB 拆成有序 32 KiB 协议分片，并重复同一个 SHA-256 摘要。Mobile 会关联每个分片的 operation、Session、attachment、media type、generation、index、count 与 digest，全部通过后才向共享 `ImageGallery` 返回 data URL。loopback RPC 对普通方法保留 60 KiB 响应上限，只对 `session.attachment` 使用 operated attachment deadline 与固定的最大图片响应上限。

## Verification

Desktop assembled 测试启动真实文件 Session persistence、Workspace storage、attachment storage、Host API 与随机端口 HTTP，建立 endpoint-owned XKpsk3 与 fresh IK Snow channel，再把发现、history、prompt、取消、Host Ask User 与 Approval settlement，以及多分片图片字节送入 `MobileCompanionSurface`。codec 测试拒绝可选字段错误、额外字段、格式错误的 attachment id、无效 page offset 与超限值。Mobile 测试固定连续发现分页与 Workspace 合并、operation correlation、history prepend 连续性、digest 校验、generation replacement、等待 prompt 失败、关联失败 settlement、隐藏的创建控件与 mutation 后刷新。产品证据不使用 `prototype-companion`、5173/5174 端口、Memory authority 或 keyless 密码实现。

## Alternatives considered

**通过 Snow 透传 Host RPC。** 否决，因为这会向独立发布的 Mobile client 授予当前及未来所有 Host 方法，并把 Companion 兼容性耦合到 Host envelope。

**发送 Client Runtime class 与 responder。** 否决，因为 map、closure 与 Host rpc id 是进程本地 authority。JSON 协议只携带数据，由已认证 Mobile adapter 重建[共享展示](2026-08-22-shared-mobile-web-presentation.md)。

**增加通用 live event stream。** 否决，因为 foreground synchronization、mutation confirmation 与有界刷新已经提供所需 ownership，无需再增加一套 multiplexed transport 和 replay model。

## Consequences

Mobile 为真实配对 Desktop Session 使用同一套 Web renderer，Desktop 仍是 Session、搜索、interaction 与 attachment authority。Major 3 采用严格限制并拒绝未知字段，因此扩展产品必须显式变更下一版协议，而不能由偶然新增 Host 方法完成。Session 创建仍不可用。发布证据会在 Node 22 与 24、iOS Simulator WKWebView 和 Android Emulator WebView 中执行确切 Snow 实现；产品验收仍须执行实际组装的 Platform、Desktop 与 Mobile 链路。
