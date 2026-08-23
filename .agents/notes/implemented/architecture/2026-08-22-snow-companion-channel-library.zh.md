# Agent Note: Snow Companion channel library

Status: implemented

[English](2026-08-22-snow-companion-channel-library.md) | 中文

## 问题

已选 Snow proof 会执行 XKpsk3 与 IK，但只暴露稳定报告。Personal Pairing 需要可复用的端点库，同时不能把公开的握手哈希当作秘密、不能用无关的 AES-GCM 构造包装 Relay authority，也不能把无类型字节接纳为 Foreground Synchronization。如果 Platform 持有 Desktop 或 Mobile 私钥，产品 composition 同样不能声称端到端加密。

## 决策

`@deepseek-ai/dsh-noise-channel` 把锁定的 Snow 0.10.0 编译为一个已提交的 WebAssembly 模块。XKpsk3 完成三条消息，并使用其 responder transport state 密封 Mobile Relay grant。握手哈希只提供认证词。grant 转换后，每个端点保留本端静态密钥与已认证的对端静态公钥；邀请 PSK、临时密钥与 transcript 状态都会清零。

每条物理 Relay attachment 都用 Snow 生成的新临时密钥建立新的 IK 握手。其 prologue 绑定 Relay route、非秘密 Personal Pairing selector、相互独立的 Desktop 与 Mobile attachment id，以及 connection generation。所得有序 transport 只加密版本化 Encrypted Companion Protocol 值。Foreground Synchronization 是带有正数 connection generation 与 Desktop revision 的 `foreground-sync` projection。

每个 Personal Pairing 分别拥有独立的 Desktop 与 Mobile P-256 credential，两条 Relay 记录都在公开公钥摘要旁绑定同一个 pairing selector。Platform API 只接收 digest 与公开 SPKI，不生成、接收或返回端点 PKCS#8。每条物理 socket 都会请求一份包含 route、attachment id、端点类型、公开 SPKI、challenge id、nonce 与过期时间的新鲜挑战，再用端点私钥签名完整的域隔离元组。WSS owner 在生成 nonce 前占用配置化 pending-challenge 容量，并在 proof、超时、拒绝、关闭与 shutdown 的所有路径释放。Relay 不持久化可重放 bearer authority。完成 proof 认证后，Relay `ready` 会投影 route、本端 attachment，以及当前对端 attachment、selector 与 connection generation。generation 从两个临时 directory connection token、route 与 selector 派生。Platform 只看到既有的不透明路由 metadata 和非秘密 selector；所投影对端是否持有已配对端点密钥，仍由 Snow static authentication 判定。

首次配对使用端点自有的不透明 mailbox。Platform 先分配不含邀请 payload 的 challenge id 与 routing link。Desktop 随后创建并保留 XKpsk3 静态密钥、临时密钥与邀请 PSK，并且只在本地 QR projection 中追加完整邀请；Mobile 在本地解码邀请并创建消息 1 与消息 3。Platform 只存储路由元数据与不透明握手字节，并执行账号所有权、过期、顺序、单次使用、幂等、每安装容量、终态保留与禁用清理约束。Desktop 在本地认证消息 3 后创建两端 Relay 签名 credential，登记与 attachment 授权都从各自公开 SPKI 派生相同摘要。Platform 先提交 prepared publication record，再原子登记两个 digest 或发布 Mobile authority，并在每个外部效果与最终提交前重新校验启用中的 route generation；陈旧 publication 会得到补偿撤销。撤销操作会先提交包含两个 digest 的 tombstone，再分别持久记录 Desktop credential 撤销、Mobile credential 撤销、已确认 authority 删除和 stored pairing 清理。任一步失败都能在进程替换后重试，且不会丢失 authority identity。Desktop 在发布前持久化私有 pending owner 与 confirmation transaction，并能在进程重启后继续。Mobile 在 mailbox 外部效果前持久化 prepared 或 finished 握手状态，并在擦除一次性邀请前把打开的 grant 与 reconnect state 一起提交。之后即使 Relay 启动失败或进程重启，也会使用该持久结果而不重新打开 grant。

生产 Platform 挂载持久 PostgreSQL pairing authority、PostgreSQL Relay route store、Redis directory 与 coordination adapter、pairing HTTP 和 Relay WSS。Platform 不提供配对密码实现：旧的 Platform 中介操作 fail closed，产品端点只使用 mailbox 操作。Desktop 把 reconnect state 保存到 Electron `safeStorage` 保护且 owner-only 原子替换的文件；Mobile 把 reconnect state 与 Mobile-only Relay grant 保存到账号隔离的 IndexedDB 记录。每次物理重连都使用新的 attachment id 与新的 IK 临时密钥。

Relay 在 attachment 登记、替换和关闭后，向已连接的对端发送 content-free `peer-update`，包括跨 Platform Instance 的情况。新投影只启动候选 IK；只有 Snow 认证准确的 route、selector、双方 attachment id 与 generation 后，候选 channel 才能替换 active channel。Desktop 会在 grant 轮换或撤销前使 pending accept 失效，并让它们与物理 lifecycle 取消竞争；每次 await 后都重新校验 projection identity 与 generation，因此迟到的 IK 结果只会被释放，不会安装或发送，controller stop 也不会等待一个反向等待 lifecycle queue 的 callback。Desktop 只有在当前 generation 上成功发送 IK 响应与版本化加密的 `foreground-sync` 后，才发布候选 channel 并推进 revision。发送或 generation 失败会恰好释放候选项一次，下一次 IK 尝试保持独立。Mobile mutation authority 在同步 projection 认证前保持关闭。

## 考虑过的替代方案

**把 XKpsk3 握手哈希用作配对密钥材料。** 拒绝，因为 transcript hash 会认证交换，但不是秘密 transport key。

**用在 Snow 外派生的另一把 Web Crypto AES-GCM 密钥密封 Relay authority。** 拒绝，因为这会另建应用 cipher 与密钥派生构造，而不是使用受审查的 Noise transport。

**把 Snow provider 挂载到 Platform 并把结果称为端到端加密。** 拒绝，因为 Platform 会持有端点私有状态，并能派生 Companion channel。

**保留 1 字节同步信号。** 拒绝，因为一个字节没有应用版本、认证字段、Desktop revision 或 connection-generation binding。

## 后果

发布的 Desktop、Mobile 与 Platform 入口现在选择端点自有的配对与 attachment channel。仓库证据覆盖不透明 mailbox 的响应丢失与重放、只登记 digest 的 Relay authority、两个 Mobile selector、跨实例 late attachment 与 replacement、端点状态持久化、真实 XKpsk3 grant 打开、fresh IK、陈旧 transcript 拒绝和认证 Foreground Synchronization。发布验收仍需要针对确切实现的独立审查，以及物理 WKWebView 与 Android WebView 证据；package tests、本地 Vite 和 proof 可执行程序不能替代这些外部记录。
