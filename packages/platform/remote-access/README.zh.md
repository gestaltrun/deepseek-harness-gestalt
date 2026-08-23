# `@deepseek-ai/dsh-remote-access`

[English](README.md) | 中文

远程访问 Service Definition 与个人配对 Service Provider。`ctx.remoteAccess` 对每个 Desktop Installation 默认关闭手机访问，直到用户在设置中开启；它分配两分钟端点 mailbox 路由，通过 `AccountService.currentInstallation()` 鉴别每个 Account Session 的 Installation id、类型与 Mobile 展示，要求两个 Installation 解析到同一账号，并且仅在 Desktop 明确确认后授予 Device Principal。端点完成请求不携带调用方提供的设备元数据；待确认与已确认记录会复制已鉴别 Mobile Installation 展示。开放注册配额限制安装、配对与附件；容量水位会以 `PLATFORM_CAPACITY` 和 `retryAfter` 拒绝新的登录、配对、附件或 WSS 接入，已建立的密文流继续。配对挑战 HTTP 使用 TCP 对端地址并忽略 `x-forwarded-for`。每小时挑战、并发附件和每日上传窗口位于共享配对事务状态中，因此共用一个 `PersonalPairingAuthorityStore` 的两个提供方执行同一份账号完整上限。硬上限返回 60 秒 `retryAfter`；滑动窗口返回剩余窗口秒数。`admitAttachmentBlob` 会在返回前提交带绝对过期时间的账号 quota lease；之后每次成功的 pairing 事务都会把旧 reservation 迁移为有界 lease，并淘汰已过期 lease。实际运行的 lease 时长是已配置 attachment capability lifetime 的两倍，attachment store 会拒绝早于 blob authority 结束的 lease。因此结果不明的 publish 只会造成有界 orphan overcount，不会造成 active blob undercount。`releaseAttachmentBlob` 负责主动清理，且不存储密文。开发与生产使用独立的 origin、OAuth App、回调、凭据、数据库与身份命名空间；密钥只来自部署托管引用，缺失则该能力失败关闭。`PersonalPairingAuthorityStore` 原子持有共享 Desktop route 关联、端点 mailbox、prepared publication 与补偿记录、已确认 Mobile 结果及配额窗口；内存适配器是确定性测试适配器，部署必须向每个 Platform Instance 提供同一个持久适配器。

Platform 返回不含邀请 PSK 的路由元数据。Desktop 在本地创建完整 XKpsk3 QR 或 HTTPS 载荷，把私有状态保存在受保护存储中，并且只通过 Platform 发送不透明握手消息与端点公钥摘要。握手完成后保持待确认，两个 Installation 显示由本地 transcript 派生的同一组六个认证词。只有保留的 SHA-256 commitment 与账号、Mobile Installation、完整邀请及 Mobile 握手字节相符时，完成 id 才会重放；请求内容变化会按 id 碰撞拒绝。共享事务文档使用格式版本 1。无版本文档会保留受 digest 约束的重放记录与已确认配对；缺少 digest 的完成或待确认记录会转为不可重放且持有清理责任的终态记录。系统拒绝未知的显式版本与格式错误的带版本记录。确认 id 保证确认重试幂等，串行变更保证并发完成只有一个获得路由挑战。

系统先提交终态，再执行清理。每个已鉴权安装最多持有四个存活挑战、四个待确认配对，以及合计十六条存活或为重放保留的生命周期记录。清理完成的幂等重放投影在五分钟后淘汰；清理失败的终态记录会继续占用容量，直到销毁成功。端点 publication 在 Relay 登记前按 route generation 持久化；拒绝、过期、关闭手机访问、发布失败与显式撤销个人配对都会在更改 authority 前，把两个凭据摘要与已确认 Mobile 结果移入分步补偿记录。每次 credential 撤销、Mobile authority 删除和 stored pairing 清理都独立提交，因此另一 Platform 进程可在崩溃后继续清理且不会丢失 digest。除非 Relay 同时提供登记与撤销能力，否则端点 mutation 会在更改状态前失败。提供方释放资源时保留已确认配对与 route 权限，使滚动替换能够重连；只有显式关闭才负责持久撤销。

产品 endpoint 流程把 XKpsk3 适配器、邀请 PSK、P-256 私有凭据与重连状态留在 Desktop 和 Mobile。Platform 只保存不透明 mailbox 消息、过期与幂等元数据、route generation、按配对划分的公钥摘要与补偿进度。确认会拒绝相同或跨配对复用的端点摘要，并在同一 selector 下原子发布两端摘要。Desktop 受保护存储在发布前最多接纳十六项存活或待确认配对；sleep、关闭窗口和普通 quit 只让 Relay 静默，不删除 vault。Mobile 在擦除一次性邀请状态前提交已打开的密封 authority 与 reconnect state。进程重启会恢复同一事务，或者直接从已提交 grant 启动 Relay，不会再次打开该 grant。账号变化会等待上一账号的 Companion 释放与 Relay 撤销完成，再继续激活。Mobile 解除配对会鉴别当前 Mobile Installation，在 UI 发布 ready 前持久撤销它自己的已确认配对、Device Principal 与两端 Relay credential。它还会分别尝试清理握手、配对密钥、Companion 与 Relay，并汇总报告全部失败；清理被拒绝时会保留明确且可重试的失败状态并由 React 所有者报告。两个 controller 都会在退出账号或卸载时停止计时器，排空包括浏览器相机扫码在内的进行中工作，并拒绝之后的配对 operation。生成的 Device Principal 只有 `companion-surface` 权限。开发 keyless 适配器仅供测试，受运维 Platform 组合与产品快照都不包含它。

`ctx.remoteRelay` 拥有无状态多实例 Relay 生命周期。Desktop 与 Mobile 分别持有独立 P-256 签名凭据，持久 `RelayRouteStore` 只保留公钥摘要。每条物理连接都证明一份绑定 route、端点、attachment 与过期时间的新鲜挑战，因此观察到的 attach 交换无法授权另一条连接，仅凭不透明 route id 也无法 attach。Personal Pairing authority 会把 Mobile 公钥摘要对应的不含内容 fingerprint 绑定到已确认设备。每个已鉴别 Mobile attachment 会登记连接 token 与过期 lease；attach、heartbeat 和 ciphertext 访问推进 `lastAccessAt`，close 只删除该 token。只要任一当前 lease 存在，presence 就为在线，因此旧连接延迟 close 不会清除替换连接，进程崩溃也会在 lease 到期后转为离线。Desktop Settings 读取该状态，而不是使用确认时写死的值。每个 Platform Instance 先鉴权 attachment 并刷出 ready，再把它注册到会过期的共享目录，并直接发布到目标实例。跨实例事件只包含有界 Relay 密文、带品牌 transport id、连接 token 与 route revision。目标缺失时返回 `REMOTE_OFFLINE`，不存在离线密文或 mutation queue。容量限制只拒绝新 attachment，慢消费者在配置的字节上限处断开，心跳重新验证 route 权限，轮换或撤销会跨实例使旧在线 attachment 失效。仅主机侧的 `relay-provider` 包从本包的公开入口导入 `RemoteRelayError`，使按该类做 `instanceof` 映射的 HTTP Consumer 与 provider 共用同一个构造函数。

部署持久状态仅限 route identity、credential digest、单调 revision 与撤销／关联状态。临时协调仅限会过期的 attachment 位置、失效事件与直达密文 Pub/Sub。实例退出会关闭其 socket；Mobile 与 Desktop 获取新的 non-sticky 连接，Desktop 发送权威加密 resync，而不迁移在线 socket。容量、目录、心跳、缓冲、连接与 attach timeout 都是组合中显式校验的配置值。

## Model Experience

无，因为配对元数据、设备主体来源与设置状态从不进入模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- 产品组合已组装仅端点 mailbox、持久 authority store、密封 Mobile authority 与 Snow channel。独立安全评审以及 WKWebView／Android WebView 真机证据仍是发布证据，而不是运行时功能开关。
- 已运营 Platform 通过 PostgreSQL 持久化 mailbox、publication、pairing-to-route 与 Relay 摘要权限，并且只用 Redis 处理会过期的 attachment discovery 与密文投递。本仓库不供应 PostgreSQL、Redis、TLS 或云实例。
- 产品 Desktop 与 Mobile 使用 endpoint-owned Snow mailbox 和 Companion channel；Platform 不挂载配对密码实现。物理 WebView 证据与针对确切实现的独立评审仍是 release blocker。
