# `@deepseek-ai/dsh-remote-access`

[English](README.md) | 中文

远程访问 Service Definition 与个人配对 Service Provider。`ctx.remoteAccess` 对每个 Desktop Installation 默认关闭手机访问，直到用户在设置中开启；它创建两分钟单次邀请，通过 `AccountService.currentInstallation()` 鉴别每个 Account Session 的 Installation id、类型与 Mobile 展示，要求两个 Installation 解析到同一账号，并且仅在 Desktop 明确确认后授予 Device Principal。配对完成请求不携带调用方提供的设备元数据；待确认与已确认记录会复制已鉴别 Mobile Installation 展示。开放注册配额限制安装、配对与附件；容量水位会以 `PLATFORM_CAPACITY` 和 `retryAfter` 拒绝新的登录、配对、附件或 WSS 接入，已建立的密文流继续。`createChallenge` 要求非空客户端 IP；配对挑战 HTTP 使用 TCP 对端地址并忽略 `x-forwarded-for`。每小时挑战、并发附件和每日上传窗口位于共享配对事务状态中，因此共用一个 `PersonalPairingAuthorityStore` 的两个提供方执行同一份账号完整上限。硬上限返回 60 秒 `retryAfter`；滑动窗口返回剩余窗口秒数。`admitAttachmentBlob` / `releaseAttachmentBlob` 按声明大小执行附件上限，不存储密文。开发与生产使用独立的 origin、OAuth App、回调、凭据、数据库与身份命名空间；密钥只来自部署托管引用，缺失则该能力失败关闭。`PersonalPairingAuthorityStore` 原子持有共享的 Desktop access-to-route 关联、已确认 Mobile 配对结果以及这些配额窗口；内存适配器只用于无密钥测试，部署必须向每个 Platform Instance 提供同一个持久适配器。

QR 载荷与完整的一次性 HTTPS 链接完全相同，携带 256 位邀请密钥、Desktop 指纹、rendezvous id、过期时间与协议主版本。握手完成后保持待确认，两个安装显示由握手哈希派生的同一组六个认证词。过期、取消、账号不匹配、拒绝、一次成功完成与关闭手机访问都会销毁对应的密码提供方能力。只有保留的 SHA-256 commitment 与账号、Mobile Installation、全部邀请字段及 Mobile 握手字节相符时，完成 id 才会重放；请求内容变化会按 id 碰撞拒绝。共享事务文档使用格式版本 1。无版本文档会保留受 digest 约束的重放记录与已确认配对；缺少 digest 的完成或待确认记录会转为不可重放且持有清理责任的终态记录。系统拒绝未知的显式版本与格式错误的带版本记录。确认 id 保证确认重试幂等，串行变更保证并发完成只有一个获得邀请。

系统先提交终态，再清理提供方资源。挑战或待确认密钥销毁失败时，资源会保留在可重试清理记录中；客户端重试仍观察原有的完成、确认、取消、拒绝或过期结果，不会重复握手或激活。每个已鉴权安装最多持有四个存活挑战、四个待确认配对，以及合计十六条存活或为重放保留的生命周期记录。清理完成的幂等重放投影在五分钟后淘汰；清理失败的终态记录会继续占用容量，直到销毁成功。失去流程记录的待确认密钥会同时计入所属桌面安装和移动端安装，但不会与已结算记录重复计数。挑战创建时就调度过期任务。共享 authority 的释放仍会结算本实例创建的存活挑战，避免创建进程退出后永久占用每安装上限。提供方释放资源时会排空实例本地的未完成工作，但保留已确认配对与 route 权限，使滚动替换能够重连；只有显式关闭才负责持久撤销。生成的不透明 id 或密钥引用发生碰撞时会立即失败且不覆盖既有记录；激活分配在解析公开引用或生成 id 之前就归清理流程持有。

`PairingHandshakeProvider` 是唯一的密码适配器。本包不实现 Noise。`DevelopmentKeylessPairingHandshakeProvider` 只在显式开发组合中用 SHA-256 派生配对密钥；生产组合不得导入它，生产路径也永远不会选择它。每次激活返回公开的带品牌密钥引用和一个独立的提供方私有分配句柄；回滚只销毁本次新分配，无法寻址既有配对密钥。确认配对后，系统先用配对密钥封装 Mobile 专用 Relay 权限，再由共享存储发布已配对结果。Mobile 通过自身的密码适配器打开该值并配置自己的 Relay 生命周期，绝不会收到或复用 Desktop Relay 凭据。生成的 Device Principal 只有 `companion-surface` 权限。HTTP Consumer 与共用 HTTP transport 把 `ctx.remoteAccess` 连接到 Desktop Settings 和 Mobile controller。Mobile 将尚未发送的准备结果保留到邀请过期，将可能已提交的请求保留到服务端重放期限，并将待确认结果保留到明确终态；每次重试都会复用同一个完成 id 和握手字节。账号变化会等待上一账号的 Companion 释放与 Relay 撤销完成，再继续激活。解除配对会分别尝试清理握手、配对密钥、Companion 与 Relay，并汇总报告全部失败。Mobile 只会在每项清理成功后发布已解除的 ready 状态；拒绝会保留明确且可重试的失败状态，由 React 所有者报告，绝不宣称权限已移除。两个 controller 都会在退出账号或卸载时停止计时器，排空包括浏览器相机扫码在内的进行中工作，并拒绝之后的配对 operation。Loader 示例通过 `DevelopmentKeylessPairingHandshakeProvider` 运行这条 controller／HTTP 路径；它不是产品密码学实现。

`ctx.remoteRelay` 拥有无状态多实例 Relay 生命周期。32 字节可轮换 Desktop 凭据在进入持久 `RelayRouteStore` 前会被哈希；已确认的 Mobile endpoint 在同一 route revision 获得独立签发的凭据，仅凭不透明 route id 无法 attach。Personal Pairing authority 会把不含内容的 credential fingerprint 绑定到已确认设备。每个已鉴别 Mobile attachment 会登记连接 token 与过期 lease；attach、heartbeat 和 ciphertext 访问推进 `lastAccessAt`，close 只删除该 token。只要任一当前 lease 存在，presence 就为在线，因此旧连接延迟 close 不会清除替换连接，进程崩溃也会在 lease 到期后转为离线。Desktop Settings 读取该状态，而不是使用确认时写死的值。每个 Platform Instance 先鉴权 attachment 并刷出 ready，再把它注册到会过期的共享目录，并直接发布到目标实例。跨实例事件只包含有界 Relay 密文、带品牌 transport id、连接 token 与 route revision。目标缺失时返回 `REMOTE_OFFLINE`，不存在离线密文或 mutation queue。容量限制只拒绝新 attachment，慢消费者在配置的字节上限处断开，心跳重新验证 route 权限，轮换或撤销会跨实例使旧在线 attachment 失效。仅主机侧的 `relay-provider` 包从本包的公开入口导入 `RemoteRelayError`，使按该类做 `instanceof` 映射的 HTTP Consumer 与 provider 共用同一个构造函数。

部署持久状态仅限 route identity、credential digest、单调 revision 与撤销／关联状态。临时协调仅限会过期的 attachment 位置、失效事件与直达密文 Pub/Sub。实例退出会关闭其 socket；Mobile 与 Desktop 获取新的 non-sticky 连接，Desktop 发送权威加密 resync，而不迁移在线 socket。容量、目录、心跳、缓冲、连接与 attach timeout 都是组合中显式校验的配置值。

## Model Experience

无，因为配对元数据、设备主体来源与设置状态从不进入模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- 在独立评审者接受 Snow 证明且组装经过评审的 `PairingHandshakeProvider` 之前，产品激活保持 fail-closed。
- 个人配对 challenge 与待确认握手记录仍使用随附的单进程提供方。已确认的 pairing-to-route/access 权限与 Relay route store 都是部署拥有的 seam；本仓库不供应 PostgreSQL、Redis、TLS 或云实例。
- Relay transport 可用不等于产品加密获批。在独立 Noise gate 接纳经过评审的握手与 Companion channel provider 之前，生产 Desktop 组合保持 fail-closed。
