# `@deepseek-ai/dsh-remote-protocol`

[English](README.md) | 中文

Remote Access 的纯 codec 与协商器。本包拥有两个独立版本化的协议，不导入 Harness Workspace、Session、prompt、tool、model、approval、Host API 或 WebSocket 类型。

## Relay Transport Protocol

版本 1 只暴露路由 attachment、不透明密文转发、心跳、撤销、稳定 transport 错误与 transport 版本协商。Attachment 授权使用端点持有的 P-256 签名密钥：Relay 签发绑定 route、attachment id、端点类型、公钥、challenge id、nonce 的新鲜限时挑战，并只接受对完整元组的一次签名。Platform 只持久化公钥摘要；attach 帧不携带可重放 bearer authority。认证完成后，`ready` 会绑定本地 route 与 attachment，并投影当前对端 attachment id、credential-bound 非秘密 pairing selector 和 connection generation。selector 用于选择端点本地 Snow static state，但不授予 Relay 或应用 authority。Relay 标识符是协议原生的品牌化值。`REMOTE_OFFLINE` 报告在线目标缺失，但不表示存在排队投递。解码会拒绝未知消息类型、重复的 ready peer 和额外字段，因此完整 Host 请求不能夹带在 transport 元数据旁。

Mobile endpoint 会在 attachment 前选择一个已保留 Personal Pairing。每个 pairing 都拥有独立 Mobile route grant、pairing selector、Snow static state 与 Companion projection。选择属于 endpoint 本地行为，不会新增 Relay 或 Companion wire operation。切换会先让上一条物理 channel 失效并排空，再只用所选 grant attach；Relay 绝不跨 Paired Desktop multiplex 或合并 Session authority。

## Encrypted Companion Protocol

Companion major 4 和 3 是当前及紧邻的前一应用版本。双方 endpoint 必须在所选 major 上声明已认证加密、配对密钥隔离与重放保护。协商不受 offer 数组顺序影响，始终选择最高的安全共同 major，因此不安全的共同 major 只能降级到安全的紧邻前一 major。每条逻辑 endpoint 连接拥有一个 negotiation channel。在该 channel 上开始新协商时，会在求值 offer 前让此前的应用 codec token 失效；失败的协商会让 channel 保持未激活，而其他 channel 仍然有效。不存在安全版本交集时，会在编码应用明文前失败，并指出必须更新的 endpoint。

Major 3 新增有界 Session 与 Workspace 发现、完整 conversation page projection、Session history、Workspace 所有或 Ungrouped 的 Session 创建、prompt 提交、取消、Approval 与 Ask User settlement，以及按内容寻址的历史图片读取。图片字节以有序 32 KiB 分片传输，共用一个摘要且最多 512 个分片；Mobile endpoint 只接受与原 operation、Session、attachment、media type、generation、index、count 和 digest 全部匹配的分片。catalog 继续包含 attachment offer、权威 `search-sessions`、重连用的 `query-operation-status`、Desktop confirmation、attachment rejection、关联的 `session-search`、类型化 `operation-failed`，以及携带原始终态 mutation result 或明确未提交状态的 `status` 应答。成功的 `create-session` 返回携带品牌化 Host Session id 的 `session-created`；已提交的 status 应答会重放这一原始结果。Mobile 只能在接收该结果的 connection generation 中，并且只能在认证的 Desktop resync 已包含该空白 Session 后选择此 id。它会跨 surface 分页与重复 refresh 保留选择，直到 detail view 已提交，或权威行报告该 Session 不再空白；replacement connection 会清除选择。Host failure 会保留 4 种闭合类别之一：HTTP 状态、无效 wire response、类型化业务错误或超时。`foreground-sync` 在认证解密后携带正数 physical-connection generation 与 Desktop revision；原始字节不能解码为同步 authority。解码会拒绝不支持的 operation、额外字段、格式错误的按内容寻址 attachment id 与超限值。

Major 4 新增 `observe-session` 与主动发送的 `session-live` 替换。每个 pairing 最多观察一个已打开 Session；只有操作的 observation epoch 仍为当前值时，该替换才可以携带有界 conversation，而每个发生变化的隐藏 Session 只携带权威摘要、位置与 Workspace 归属。移除消息只携带 Session id。Workspace 与归档权威变化会请求完整分页 baseline；其 cursor 绑定冻结的 Host snapshot 与 physical generation，而不绑定后续发送 revision。每个替换都标明 physical generation 与单调递增的 Desktop revision；Mobile 对每个 revision 最多应用一次，忽略更旧的重复项，并且在分页 baseline 完成前最多排队 32 个不同 Session 的替换。同一 Session 的变化会在同一个有序 Snow sender 后合并。加密前，超大的 live conversation 会丢弃最旧 node，并按 UTF-8 截断单个超大的最新文本 node，直到完整 major 4 message 符合 48 KiB projection 上限。队列超限、Host stream 失败、无效的有界输出或投影失败都会淘汰 channel，使重连建立新的 generation 与完整 baseline。

conversation projection 会回显 history 请求中可选的 exclusive `beforeSeq`。cursor 缺失时替换 tail；cursor 存在时标识由 Mobile 进行连续性校验并 prepend 的旧 page。

## Endpoint attachment cipher

`deriveCompanionAttachmentKey`、`sealCompanionAttachment`、`openCompanionAttachment` 与 `hashCompanionCiphertext` 以 HKDF-SHA-256 密钥派生和 AES-256-GCM 实现加密 attachment 传输的 endpoint 侧。密封载荷是 `iv(12) ‖ ciphertext ‖ tag(16)`（`COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES` = 28）。两个 endpoint 链接这些函数；Platform blob store 只接收 `sealCompanionAttachment` 的输出及其 SHA-256，永不派生密钥。密钥材料由 Personal Pairing 层提供。100 MiB blob 上限是密文限制；Mobile 会拒绝加上该开销后无法放入上限的明文。

## Wire 限制与错误

| 限制 | 值 |
|---|---:|
| Parser 深度 | 16 层 |
| 单个对象或数组中的值 | 256 |
| 编码值总数 | 4,096 |
| 单个字符串的 UTF-8 字节 | 90,000 |
| 完整 Relay 消息 | 98,304 字节 |
| 不透明 Noise 消息 | 65,535 字节 |
| 加密前 Companion 应用数据 | 61,440 字节（60 KiB） |
| 完整编码 projection 消息 | 49,152 字节（48 KiB） |
| Transcript page | 50 条 |
| Session history 请求 | 20 条消息 |
| Session 或 Workspace 发现页 | 20 行 |
| 待处理实时 Session 替换 | 32 个不同 Session |
| 历史图片分片 | 32,768 个解码后字节 |
| 历史图片结果 | 512 个分片 |
| Session 搜索查询 | 500 个 UTF-16 code unit |
| Session 搜索结果 | 20 个唯一 Session |
| Session 搜索 snippet | 240 个 Unicode code point |
| Host 失败消息 | 4,096 个 UTF-8 字节 |
| 保留的 attachment blob | 104,857,600 密文字节（100 MiB） |
| Attachment capability 生命周期 | 900,000 毫秒（15 分钟） |
| Attachment 文件名 | 255 UTF-8 字节 |

`RemoteProtocolError` 为无效输入、超过限制、不兼容 Relay 版本、缺少 Companion 安全 capability、endpoint 必须更新及缺少协商提供稳定 code。诊断不会包含应用明文。二进制 wire 值只接受一种规范的无填充 base64url 拼写；能够解码成相同字节的别名也会被拒绝。60 KiB 应用上限在固定 65,535 字节 Noise 消息上限内为加密开销保留 4,095 字节；Relay frame 上限也能在该最大值下容纳 base64url 与 transport 元数据。

本包不加密 Companion 消息流量。Mobile 与 Desktop 提供 [`dsh-noise-channel`](../noise-channel/README.zh.md) endpoint channel，再在 Relay 转发前加密版本 offer 和已编码 Companion 消息。[无密钥 assembled example](../../../examples/remote-protocol/start.ts)保留仅限示例的 AES-GCM adapter，用于隔离验证 codec；它不是产品密码实现或安全评审证据。产品 Mobile 与 Desktop 已组装 endpoint-owned 首配、credential-bound peer discovery、fresh-ephemeral IK 与加密 Companion 消息。[双实例产品快照](../../../examples/two-instance-relay/start.ts)通过真实 WSS Relay 实例运行不透明 endpoint mailbox、密封 Mobile authority 与 Snow IK，而不是示例 adapter。

## 模型体验

无，因为 Remote Protocol 元数据与设备来源永不进入模型请求。

#### KV Cache 影响

无。

## 已知限制与延后工作

- Session 重命名、归档、删除与 fork、Workspace 管理、terminal 输入，以及 settings、credential、plugin、model 与 preset mutation 不属于 Companion major 4。
- 配对 handshake、凭据持久化、challenge lifecycle 与生产 Companion 消息加密属于服务或经评审的 endpoint 集成，不属于这些 codec。
