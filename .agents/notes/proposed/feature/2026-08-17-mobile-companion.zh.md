# Agent Note: 面向在线已配对 Desktop 的 Mobile Companion

Status: proposed

[English](2026-08-17-mobile-companion.md) | 中文

真实产品链路与仅前台生命周期由[使用真实 Companion 产品链路](../architecture/2026-08-22-real-companion-product-path.zh.md)所有；该提案取代本文的推送投递与证明链路验收条款。[以有界替换投影实时 Session](../../implemented/architecture/2026-08-24-companion-live-session-projection.zh.md)实现了这里描述的已打开 transcript 与隐藏摘要 projection；提案的其余部分继续有效。

## 问题

DeepSeek Gestalt 仅通过 Desktop Host 加载其回环 Web Host 来展示 Session Surface。用户无法在另一网络上通过手机检查正在进行的工作、回答交互请求或继续 Session。现有 Web Host 不是远程访问服务：直接暴露它会让 agent 能力在缺少设备认证、传输安全、撤销机制与面向独立发布客户端的版本化协议时被访问。

## 提案

增加 **Mobile Companion**：一款由人操作的移动产品，在已配对 Desktop 在线时，可从任意网络访问它。每个实时操作都要求已配对 Desktop 在线；Desktop 离线后继续运行 agent 不属于首版产品承诺。

Companion Surface 在轻量原生容器中，通过移动端专用组合与 overlay 复用 DeepSeek Harness Client Runtime 和页面组件。它不独立重新实现 Session 状态模型，也不把现有 Desktop 布局压缩到狭窄视口中。

首版产品范围包括 Workspace 与 Session 浏览、历史与实时流、提示词提交与取消、附件、审批和人机问题。Desktop 设置、凭证、插件配置、Workspace 管理、终端使用、完整工具检视、组织共享和 agent 操作的移动设备自动化均不属于此范围。

Platform 提供通过 GitHub 登录创建的简单 Platform Account。每个 GitHub 账号都可注册并获得服务，不设试点白名单。Platform Account 是各 Platform Capability 可识别的共享人员身份，但它本身不授予任何 Session、Desktop、设备或未来 capability 权限。

GitHub 登录使用 GitHub OAuth App Authorization Code flow，通过系统浏览器执行 PKCE，使用不可猜测的 `state`，并只允许一个固定 HTTPS Platform callback；Device Flow 保持关闭。它不请求 OAuth scope，在 Platform 交换 code，调用一次 `GET /user`，并把身份记录为 `account_identity(provider, subject)`；首版唯一允许的 provider 是 `github`，subject 是 GitHub 不可变 numeric user id。Login 和 avatar 是可刷新的展示字段；不请求 email、repository、organization 或其他 GitHub 数据。Platform 在身份校验后丢弃 GitHub access token。首版一个账号恰好拥有一个外部身份，不提供身份绑定、解绑或账号合并。

每个 Desktop 或 Mobile 安装拥有一个 proof-of-possession Account Session，且同一时间只保留一个 Platform Account。P-256 ECDSA Account Session Key 独立于 Noise X25519 配对密钥；Mobile 在受支持时通过原生 Secure Enclave 或 Android Keystore 适配器创建它，Desktop 则使用操作系统凭证存储保护其密钥。Platform 签发十五分钟 access token 和最长三十天的轮换 refresh token；刷新和配对操作都要求该密钥签名。退出登录会关闭该安装的 Platform 连接并撤销其 Account Session，但保留 Personal Pairing；重新登录同一账号后无需再次配对即可恢复使用。切换账号必须先退出，不同账号的配对、密钥、缓存和 operation receipt 保持隔离。更换 Account Session Key 要求重新 GitHub 登录，但不会替换有效 Personal Pairing 密钥。

当前安装退出会在 PostgreSQL 中提交更高的 `sessionRevision`，更新 Redis 并发布跨实例失效事件。Access token 携带 account id、session id 和 revision；HTTP 请求、WSS 挂接、配对操作与心跳都会比较该 revision，每个 Platform Instance 在收到失效后关闭匹配的活跃 socket。Redis 无法确认时，新认证操作 fail closed，活跃 Account Session 也会在下次心跳时关闭。首版没有 account-wide authentication epoch、跨安装 Account Session 列表、远程退出或退出全部操作。

原生登录使用五分钟失效且仅使用一次的 Login Attempt，而不使用 callback token 或自定义 URL scheme。安装创建 PKCE 材料、256-bit attempt secret 和 Account Session 公钥，然后打开系统浏览器。固定 Platform callback 校验 GitHub 并将 attempt 标记完成；安装通过签名轮询，并证明 PKCE verifier 与私钥后领取 Account Session。Token 永远不会出现在浏览器 URL 中。

撤销 GitHub 授权会阻止之后的 GitHub 登录，但不会立即撤销已签发 Account Session。首版不保留 GitHub token、不轮询 GitHub，也不消费授权撤销事件；Platform session 会一直有效到显式退出、Platform 停用或最长三十天到期。

Desktop 和 Mobile 必须认证同一个 Platform Account，Personal Pairing 才能完成。Platform 在创建和兑换 challenge 时检查账号，然后 Personal Pairing 才把移动安装作为可独立撤销的 Device Principal 授权给该 DeepSeek Gestalt 安装。Pairing Challenge 不能把 Desktop 分享给另一个 Platform Account，账号身份也永远不会替代 Noise 配对密钥的持有证明。

首版没有 Platform Account 删除、跨安装 Account Session 管理或安装丢失恢复流程。Desktop 和 Mobile 显示 GitHub login 与 avatar、当前安装 session、当前安装退出以及现有 Personal Pairing 控制；HTTPS OAuth callback 页面只报告成功或失败。退出登录后，账号身份和元数据仍遵循已接受的保留规则。

开放注册使用已校验资源配额，而不是白名单。一个账号最多保留十个 Desktop 安装、十个 Mobile 安装、五十条 Personal Pairing 和二十条并发 Platform 连接。每账号每小时最多创建十个 Pairing Challenge，每个 IP 每小时最多创建三十个。一个账号同时最多保留五个密文 blob，并在现有单 blob 100 MiB 上限下每天最多上传 1 GiB。超过配额会返回稳定错误与重试时间。IP 限制只保护认证和配对，不限速已建立的密文流。

双实例部署不设置账号总数上限，也不自动扩缩容。整体连接或资源水位达到上限时，Platform 保留现有连接，并以 `PLATFORM_CAPACITY` 和 `retryAfter` 拒绝新的登录、配对、blob 上传或 WSS 挂接；CloudMonitor 告警运维人员扩容。首版没有运营侧账号停用控制或管理控制台。

GitHub 授权前，Platform 会展示中英文隐私说明，涵盖 GitHub id、login 与 avatar、安装和配对元数据、七天原始 IP 日志、三十天无内容安全事件、会失效密文 blob，以及产品内不存在 Platform Account 删除流程。继续登录即接受该说明，无需单独勾选框。

已配对 Desktop 是 Session 事件、Workspace、凭证和 agent 执行的唯一权威。移动端修改只有在 Desktop 提交或确认后才成功；Mobile Companion 和云端都不保留可写 Session 副本。

云服务提供设备发现、路由、在线状态、撤销强制与不透明流量中继。Mobile Companion 与已配对 Desktop 之间的应用层端到端加密，使中继无法获取 transcript、提示词、工具参数、审批和附件，但路由与流量元数据仍可见。

每个 Personal Pairing 都创建一个可独立撤销、仅限 Companion Surface 操作的 Device Principal。提示词提交仍使用 Session 现有的工具与审批策略，同时设置、凭证、插件、终端和原生 Desktop 操作均不可用。远程修改和交互回答在 Desktop 审计记录中标识 Device Principal。

每次 Mobile Companion 安装都生成自己的非对称设备密钥对，并将公钥绑定到 Device Principal。一个精简 Capacitor 原生适配器会在可用时使用操作系统硬件支持的 wrapping key 保护静态私钥材料，并在解除配对时将其删除。标准 Noise X25519 运算仍可能在应用内存中使用已解包密钥材料；产品不会声称 Secure Enclave 或 StrongBox 执行这些运算。短时中继凭据可授权建立连接，但任何长期 bearer token 都不能单独证明 Device Principal。

Personal Pairing 使用 `Noise_XKpsk3_25519_ChaChaPoly_SHA256`，Mobile Companion 为 initiator，Desktop 为 responder。Desktop 为该 Personal Pairing 创建独立静态 Noise 密钥；两分钟失效、仅使用一次的 Pairing Challenge 携带 256-bit 邀请 secret、Desktop 公钥与完整指纹、Relay rendezvous id、失效时间和协议 major。两个端点从 Noise handshake hash 派生出相同短认证词，Desktop 用户确认后配对及其密钥才生效。完整一次性链接是无摄像头时的回退方式；首版不包含低熵手输码。成功兑换保持幂等，失效、取消、拒绝或一次成功使用都会销毁邀请 secret，并让挑战不再可用。

后续连接使用 `Noise_IK_25519_ChaChaPoly_SHA256` 以及该 Personal Pairing 保留的双方公钥。每次连接生成新的临时密钥，且永不复用邀请 secret。Noise handshake hash 为应用版本协商和对等端认证提供 channel binding。

协议目标不会预先锁定产品依赖库。两个有界原型分别验证编译为 WASM 的 `snow` 是否适合目标 XKpsk3-to-IK 流程，以及 `@chainsafe/libp2p-noise` 是否可作为经 Relay duplex stream 运行的受维护 XX 回退。候选方案只有通过 Noise 官方向量、Node 22 与 24、iOS WKWebView、Android WebView、篡改、重放、顺序、跨配对、重连和资源限制检查，以及独立安全评审后才能发布。产品代码不会 fork 密码库内部握手实现，也不会用原语拼装新密码协议。

设备私钥不存在云备份或中继恢复路径。重新安装 Mobile Companion 或迁移到另一台手机会创建新 Device Principal，并要求再次 Personal Pairing。旧 principal 仍会被独立显示且可撤销，直到 Desktop 用户将其移除。

首版不包含全局密码 Desktop Principal。启用远程访问会创建不透明路由 id 和可轮换的高熵 Relay 凭据；Desktop 在挂接其出站 WSS 连接时证明该凭据，永远不会单独使用路由 id 或查询参数。每条 Personal Pairing 分别验证加密应用对等端，因此被窃取的路由凭据可干扰路由可用性，但无法通过配对密钥认证或解密 Companion 流量。

Companion Surface 源码在当前 monorepo 中共享 DSH Client Runtime 和页面组件，每个移动版本则捆绑其编译后的页面资源。已配对 Desktop 和中继都不会在连接时向应用提供可执行页面代码。

`apps/mobile` 使用 Capacitor 作为本地捆绑 Companion Surface 的原生容器。Web Client 拥有页面渲染；原生适配器拥有摄像头访问、设备密钥、深链、文件选择和本地加密存储。之前的 Expo 与 React Native 实现仅作为行为参考材料，不作为页面代码来源。

新的 Remote Access Platform Capability 替换之前的明文 Java 网关。它作为一个深模块拥有 Personal Pairing registry、Remote Relay 和加密 blob capability。Mobile Companion 和 Desktop 都与其中的 Remote Relay 建立出站 WSS 连接；其接口不包含 Workspace、Session、提示词、工具、模型、审批或其他 DSH 业务类型。

`apps/platform` 是当前 monorepo 中可独立部署的 Cordis 组合根，用于承载中心化 Platform Capability，且不挂载 Harness Engine。Account 和 Remote Access 是其初始能力，而不是应用的部署身份。拟新增的 `@deepseek-ai/dsh-platform-account` package 是深 Account plugin，拥有 GitHub OAuth、Platform Account、Account Session、安装密钥绑定和当前安装退出。Remote Access 消费其 Account Service 来校验 session 和同账号配对，不读取账号表或 GitHub 字段。Platform 其他共享内容仅包括进程生命周期、已校验配置、健康端点，以及 PostgreSQL、Redis、OSS、日志和 secret 适配器；每个 capability 分别拥有其授权、数据表、Redis namespace、路由和可观测字段。后续 capability 可以识别 Platform Account 身份，但不能在没有新决策时复用 Remote Access Device Principal、数据或解密值。

Remote Access 使用四个拟新增的深 package。`@deepseek-ai/dsh-remote-protocol` 拥有 wire codec、版本与 capability 协商、稳定错误、branded id、解析限制和 Noise 向量。`@deepseek-ai/dsh-remote-platform` 拥有完整 Platform plugin，并将配对、Relay、blob 和跨实例协调保留为内部实现。`@deepseek-ai/dsh-remote-desktop` 拥有 Desktop 连接生命周期、DSH 投影、操作幂等和审计归因。`@deepseek-ai/dsh-remote-client` 拥有 Mobile 同步状态机、operation receipt 和缓存接口。各 app 目录只组合这些模块，不复制其状态机。

网络使用两种协议。Relay Transport Protocol 对路由挂接、密文、心跳、撤销、传输错误以及 Relay 可读的传输版本协商进行分帧。Encrypted Companion Protocol 在该密文内运行，仅携带 Companion Surface 允许的投影、操作、结果和应用版本协商。Desktop 适配器将该精简协议映射到现有 DSH Session 和 Host 能力；远程路径永远不隧道传输完整 `/api/*` 或 Host WebSocket 接口。

每条 Noise 消息遵循协议固定的 65,535-byte 上限，一条加密应用 payload 最大为 60 KiB。Transcript page 最多包含五十个事件或 48 KiB 编码内容，以先达到者为准；单个事件超过 page allowance 时使用现有有界投影和 spill 行为。Platform 初始已校验默认值把单个密文 blob 限制为 100 MiB、生命周期十五分钟，把单连接限制为六十四个排队 frame 或 4 MiB，并设置二十秒发送心跳、六十秒无有效心跳判定离线。Noise 消息大小、解析深度和编码值安全上限是协议不变量；blob、生命周期、队列、心跳和在线状态值是已校验部署配置。

Remote Access 永远不保留离线消息队列。目标不存在时返回 `REMOTE_OFFLINE`。跨实例转发和每连接队列不会静默丢弃或重排已接受 frame；慢消费者超过任一队列上限时会断开，双方随后重连并从 Desktop 权威恢复。结果未知的修改使用 operation id 查询，而不依赖 Relay 重放。

两种协议独立协商。每个对等端都声明支持的版本区间和 capability 集合；附加功能在同一 major 内保持可协商。Desktop 在不削弱必需安全 capability 的前提下支持当前和紧邻的前一个 Companion major。没有安全交集的对等端快速失败，并标识需要升级的端点。

Relay 数据库变更采用 expand-contract migration，在滚动部署期间同时兼容两个应用 revision；不支持自动 down migration。Mobile 将有版本的配对密钥记录与可丢弃 Companion Cache 分开存储，因此升级失败最多要求重建缓存，不要求重新配对。超出受支持 Companion 协议区间的应用必须升级，不能通过协商取消必需安全能力。

一台移动设备可保留多个 Personal Pairing，一台 Desktop 也可授权多台设备；每次操作选择一台已配对 Desktop，且配对关系永不合并跨 Desktop 的 Session。远程访问默认关闭，只有 Desktop 用户启用并完成 Personal Pairing 后才开始。

DeepSeek Gestalt 设置包含 Mobile Access 页面，用于启用、添加设备、展示 Pairing Challenge，以及列出每台设备的名称、平台、在线状态、配对时间、最近认证访问、单独撤销和全部撤销操作。Mobile Companion 的已配对 Desktop 列表显示连接状态和最近连接，并提供解除配对和按 Desktop 清除缓存。两个界面都不显示设备 IP 地址。

只有在移动访问已启用且 DeepSeek Gestalt 窗口保持打开时，已配对 Desktop 才是 Remote Online。关闭窗口、退出应用、计算机休眠或停用移动访问都会使其进入 Remote Offline。Mobile Companion 在离线时可显示上次由 Desktop 确认的 Companion Cache，但不能排队提示词、取消、审批或其他修改。首版不包含后台 Host、系统守护进程或远程唤醒。

Companion Cache 保留静态加密的 Workspace 和 Session 元数据，以及用户在该设备上打开过的 transcript。它不会自动保留附件字节、终端内容、spill 文件或凭证，用户也可清除一台已配对 Desktop 的全部缓存内容。

附件使用端到端加密 blob 传输，而不是在实时流中传输应用明文或大消息。Mobile Companion 在上传前加密字节；Relay 签发限制 Personal Pairing、大小和期限的 capability；Desktop 验证密文哈希、下载并解密。失效、撤销或成功领取都会移除 blob。WSS 路径仅携带控制消息和有界小帧。

Mobile Companion 只在用户打开应用或把应用切回前台后获取当前状态。进入后台会暂停 WSS；回到前台会重连到选中的 Paired Desktop，并在启用任何 mutation 前完成鉴权与 Desktop 权威同步。产品不提供后台通知投递。

首个部署是单区域初始服务，按约五十台 Desktop 的规模准备，但向每个经过 GitHub 认证的账号开放。它从首版起就支持多个并发 Platform Instance。当 Mobile 和 Desktop 挂接到不同 Platform Instance 时，Remote Relay 实时路由和密文转发仍可工作。多区域路由不属于首个部署，部署也可让对等端重连，而不迁移实时 socket。

试点在两个独立阿里云计算实例上部署恰好两个无状态 Platform Instance，位于一个无连接亲和的 TLS 负载均衡器之后。阿里云托管 PostgreSQL 存储持久配对、撤销、blob 元数据和无内容安全审计记录。托管 Redis 保存会失效的在线连接目录，并通过跨实例密文 Pub/Sub 转发消息，但不成为离线队列。OSS 通过对象存储适配器只保留会失效的密文 blob。当一个 Platform Instance 退出或滚动部署替换它时，已连接对等端会通过另一实例重连并重新同步。

阿里云 SLS 和 CloudMonitor 接收无内容运维信号：连接数、认证失败类别、跨实例转发延迟、重连、撤销传播、blob 字节与失效总量、依赖健康和结构化错误码。日志和 trace 永远不包含密文 body、公钥、设备名称、Pairing Challenge、完整链接或完整 route 和 pairing id。跨实例关联使用随机 request id；暴露给聚合遥测的标识使用定期轮换部署密钥生成的 HMAC 假名。

Platform 配置引用阿里云 KMS 或 Secrets Manager 值，或由部署注入的 secret。PostgreSQL、Redis、OSS 和 GitHub 凭证永远不会进入数据库、仓库、`cordis.yml` 或日志。缺少必需凭证的 capability 会用明确诊断加载失败，而不是静默停用或削弱行为。

首版依赖阿里云托管备份和容灾能力。它不实现应用层 restore epoch、恢复后暂停全部配对、跨地域故障切换编排、Redis 连接状态备份或会失效密文 blob 恢复。Desktop 删除相应 Personal Pairing 密钥后，陈旧 Relay 记录仍无法认证已撤销设备；云恢复流程和可用性目标属于部署配置，而不是产品协议。

开发和生产分别使用独立 GitHub OAuth App、Platform origin、callback、client credential、数据库和身份 namespace。每个构建只信任对应 Platform origin。首版没有预发环境，也不接受用户或 Pairing Challenge 提供的任意服务器 URL；QR 和完整链接只标识该可信 origin 内的 rendezvous 与 challenge。自托管 Platform 选择和自定义信任根需要后续部署决策。

Capacitor 项目保持 iOS 和 Android 构建可用。初始分发使用 TestFlight 和已签名 Android APK；公开 App Store 与 Google Play 发布要等待真实设备的配对、密钥存储、深链、前台同步、缓存和升级验收。

远程操作归因可持久，但不对模型可见。已配对 Desktop 记录 operation id、Device Principal、操作类别、接受和结果；普通会话展示保持不变，设备来源可在详情中查看。模型永远不会收到设备名称、IP 地址或网络来源。

首个 Encrypted Companion Protocol 目录可列出已配对 Desktop、Workspace、Session、历史、实时投影、共享消息与工具卡片、配对状态和待处理交互。它可在现有 Workspace 中使用 Desktop 默认值创建 Session，也可在没有 Workspace 时创建 Ungrouped Session；此外还可提交提示词和附件、取消活跃执行、回答人机问题、结算审批并撤销自己的配对。它不能管理 Workspace、选择 preset 或模型、编辑通用设置、重命名、归档、删除或 fork Session，也不能提供终端输入。

Mobile 审批渲染 Desktop Approval Service 授权的相同精确参数、cwd、diff、终端摘要和决策选项。它不会移除持久授权或其他有效 Desktop 选择，也不创建移动端专用策略层。Desktop 仍是提交该决策及其 Device Principal 归因的权威。

Deep link 永远不携带交互权威。配对链接只标识一个短期 Pairing Challenge；Mobile Companion 重连并同步后，才展示当前 Desktop 拥有的操作或已结算结果。

Mobile Companion 进入后台时暂停 WSS 连接。打开应用或把应用切回前台后会重连并同步权威状态。首版不依赖 silent background task，也不保持后台 socket。

Mobile 导航不复制 Desktop 多列。根页面选择一台已配对 Desktop，Workspace 筛选其 Session 列表，一个 Session 占据完整对话视图。显眼的交互收件箱和会话内卡片暴露审批和人机问题。只有已打开 transcript 接收实时详情；隐藏 Session 更新摘要。

Companion Surface 复用共享 Markdown、代码、图片、普通工具、diff、审批和 Ask User 渲染器。终端输出只按现有截断和 spill 规则显示有界只读摘要，且不提供终端输入。未知工具仍通过通用只读卡片显示，在没有专用渲染器时也不会隐藏可用参数和结果。

Ungrouped Session 行为与 Desktop 保持一致。Mobile Companion 可查看和继续已有 Ungrouped Session；其 Session 新建流程中的 Workspace 是可选项，不选择时会通过已配对 Desktop 的正常创建行为新建 Ungrouped Session。

Mobile Companion 没有单独的生物特征或应用锁功能。它依赖操作系统设备访问控制、受保护密钥存储和本地加密存储。

撤销会先在 PostgreSQL 中提交更高的 pairing revision，再更新 Redis 当前 revision 并发布跨实例撤销事件。每个 Relay 会立即关闭匹配的活跃 socket，并在心跳时再次验证当前 revision，使遗漏的 Pub/Sub 事件不能保留访问权。Redis 无法确认有效性时，新挂接会 fail closed，活跃配对也会在下次检查时关闭。单独撤销会删除该配对的 Desktop 密钥；全部撤销或停用 Mobile Access 还会轮换 Desktop Relay 凭据并关闭 Desktop 路由。

Relay 持久保留公钥、配对状态和 revision 以及撤销记录。它在领取或失效时删除密文 blob。在线状态、心跳、路由和密文帧只存在于进程内。无内容安全事件保留三十天，原始 IP 访问日志最长保留七天。

已配对 Desktop 按权威接受与提交顺序排列并发的本地和移动端操作。每个远程修改都携带全局唯一的 operation id 和 Device Principal，使重试保持幂等。一次性交互、取消或其他 first-commit-wins 操作会向后到调用方返回已结算的权威结果，而不是覆盖它。

Mobile Companion 仅在修改已发送但结果未知时持久保存 operation receipt。重连会按 operation id 查询已配对 Desktop：已提交操作返回原始结果，明确不存在的操作标记为未提交，并等待用户决定是否重试。应用永远不会自动重放陈旧 receipt，receipt 也不是离线修改队列。

系统与商店名称为 **DeepSeek Gestalt**，Mobile Companion 仍是其移动端角色的领域术语。移动应用使用 bundle identifier `com.gestalt.deepseek.mobile`。它继承 DSH 设计 token、共享渲染器、中英文术语以及明暗主题，而不保留之前移动应用的米色和橙色身份。初始主题和语言跟随操作系统，之后由与 DSH 相同的显式用户选择优先。

交付按依赖顺序推进：有界密码原型和安全评审入口；Remote Protocol 与跨运行时向量；Platform Remote Access plugin 和双实例路由；Desktop 适配器、Mobile Access 设置和审计；Mobile Client Runtime 加 Capacitor 密钥与缓存适配器；最后才是组装页面、blob、真实设备验收和故障测试。后续层不能用 mock 替代尚未完成的下层验收路径。

Keyless 组装应用 snapshot 覆盖未登录时拒绝 Pairing Challenge、跨账号拒绝配对、同账号创建 Workspace Session 与 Ungrouped Session、Mobile prompt 归因且设备数据不对模型可见、Mobile 完成 Approval 与 Ask User、Remote Offline 加结果未知操作恢复，以及撤销后拒绝。Package 与 integration test 拥有 OAuth、Noise、解析上限、幂等、revision 失效和双实例故障路径；iOS 与 Android 真实设备拥有原生密钥、前台生命周期、缓存和页面验收。

## 曾考虑的替代方案

**将产品限制在同一局域网。** 不采用，因为核心价值是人离开该网络后仍能回应 Desktop 上正在进行的工作。

**Desktop 断开连接后继续在云端执行。** 不纳入首版产品承诺，因为这需要第二个 Harness Engine，以及 Workspace、凭证、执行环境和 Session 权威的迁移，而不再只是远程访问一台 Desktop。

**将页面重新实现为独立 React Native 产品。** 不采用，因为第二套 Session 状态模型和交互渲染会与现有 Client Runtime 和页面组件产生偏离。

**在手机宽度下原样渲染现有 Desktop 页面。** 不采用，因为 Desktop 导航和信息密度无法定义可用的移动交互模型。

**从组织共享或 Desktop 完整同权体验起步。** 不采用，因为共享主体和特权配置操作会在个人远程工作流成立之前扩大授权模型。

**在没有 Platform Account 时使用 Personal Pairing。** 不采用，因为首版要求先通过 GitHub 认证账号，随后才能配对。账号标识人员，但不会替代 Device Principal 授权，也不会创建组织共享。

**允许 Pairing Challenge 跨 Platform Account。** 不采用，因为首个账号模型用于限制个人设备，而不是共享 Desktop；Noise 配对授权创建前，两个端点必须认证同一账号。

**使用 GitHub Device Flow 或保留 GitHub token 作为 Platform session。** 不采用，因为系统浏览器 Authorization Code flow 支持 PKCE，而 Platform 只需要用 GitHub 校验一个不可变用户 id。服务访问由它自己的 proof-of-possession Account Session 拥有。

**通过自定义应用 URL scheme 返回账号 token。** 不采用，因为其他已安装应用可能声明该 scheme。短时 Login Attempt 会让 OAuth callback 和 token exchange 留在 Platform，并把领取绑定到 PKCE 与安装密钥。

**将 Noise X25519 密钥复用为 Account Session 签名密钥。** 不采用，因为配对加密与 Platform 登录具有不同轮换和存储生命周期。独立 P-256 签名密钥可让原生平台使用其支持的硬件密钥运算，而无需更改标准 Noise suite。

**请求 GitHub email、repository 或 organization 权限。** 不采用，因为公开 profile 身份足以支持首个 Platform Account，无关 OAuth scope 只会扩大凭证暴露。

**移除 GitHub 授权时立即撤销 Platform session。** 延后，因为首版会丢弃 GitHub token，且不增加 GitHub 轮询或授权 webhook。现有 Platform session 保留其有界生命周期。

**在一个应用安装中同时支持多个账号。** 不采用，因为单账号安装状态可隔离配对、密钥、缓存和 operation receipt，无需增加账号切换状态矩阵。

**建设完整 Web 账号控制台。** 不纳入首版，因为 Desktop 和 Mobile 拥有账号与设备控制；Platform Web surface 只完成 OAuth。

**提供跨安装 Account Session 恢复、远程退出或退出全部。** 不纳入首版；一个安装只能退出自己的当前 Account Session，Personal Pairing 控制保持独立。

**提供 Platform Account 删除。** 不纳入首版。登录前隐私说明会明确产品内不存在账号删除流程。

**通过 GitHub id 白名单限制账号创建。** 不采用，因为首个服务向每个经过认证的 GitHub 账号开放，而不是封闭试点群体。

**把开放注册视为无限资源权限。** 不采用，因为按账号、安装、配对、blob 和认证的配额可限制单个身份的成本，同时不关闭注册。

**自动扩缩 Platform 或在容量不足时终止现有连接。** 不纳入首个部署，因为已采购的两个实例保持固定；load shedding 会保护现有连接，并报告明确重试时间，直到运维人员扩容。

**增加运营侧账号停用命令或管理控制台。** 首版延后；用户保留当前安装退出与 Personal Pairing 撤销控制，配额与容量 shedding 提供已接受的服务保护。

**在多个环境间共享一个 GitHub OAuth App 或账号 namespace。** 不采用，因为开发和生产分别拥有 origin、凭证、callback、数据库与身份；首版没有预发环境。

**让 Remote Access 直接读取账号表。** 不采用，因为 Account 是独立 Platform Capability；它的 service 会授权 session 和同账号关系，而不导出提供方专用存储。

**发布只读查看器。** 不采用，因为继续提示词、取消、审批和人机问题正是通过手机使用该产品的时效性价值。

**将 Mobile Companion 与移动设备自动化合并。** 不采用，因为投影 DeepSeek Gestalt Session 的人类客户端与操作移动应用的 agent 工具具有不同的参与者、权限和生命周期。

**让云网关处理应用明文。** 不采用，因为中继无需 transcript、工具、审批或附件内容即可路由个人连接，而持有这些内容会创建另一个特权数据处理方。

**将可写 Session 状态复制到 Mobile Companion 或云端。** 不采用，因为双写权威会引入冲突与恢复规则，而 Desktop 拥有的仅追加 Session 日志已避免这些问题。

**将已配对设备当作完整 Desktop 用户。** 不采用，因为拥有一个移动凭据不得暴露配置、凭证、终端访问或原生 Desktop 操作。

**Remote Offline 时对移动端修改排队。** 不采用，因为提示词可能依赖陈旧上下文，延迟的取消或审批也可能指向已结算的工作。

**将数据模型限制为一台手机和一台 Desktop。** 不采用，因为可独立撤销的配对关系保留同一个人信任模型，无需把单例假设写入身份和存储格式。

**保持后台 Host 或安装远程唤醒支持。** 不纳入首版，因为关闭窗口是用户简单明确的停止控制；在前台远程路径成立之前，后台生命周期、操作系统集成和唤醒授权只会增加复杂性。

**安装时默认启用远程访问。** 不采用，因为一个可执行代码的产品在 Desktop 用户有意启用并配对之前，不得建立互联网可达路由。

**将长期服务器签发 JWT 作为设备身份。** 不采用，因为仅凭 bearer 即可让签发服务或 token 泄漏在无需证明私钥的情况下伪装为已配对设备。

**用密码原语拼装自定义认证握手。** 不采用，因为 X25519、KDF 和 AEAD 库并不定义 transcript 绑定、角色认证、重放处理或降级行为。实现以已注册 Noise pattern 为目标，并且必须通过其标准向量。

**在跨平台原型验证前选择或 fork Noise 实现。** 不采用，因为已评估的受维护 JavaScript 包没有一个直接满足所选 pattern、运行时和原生密钥限制。有界原型和独立安全评审必须先于产品依赖决策。

**承诺所有 X25519 私钥运算都留在安全硬件中。** 不采用，因为 Secure Enclave 和 StrongBox 不提供这种可移植 Noise 保证。可用时由硬件支持的 wrapping 保护静态存储，但不会夸大运算隔离能力。

**从已配对 Desktop 下载可执行 Companion Surface 代码。** 不采用，因为独立审核的移动版本需要确定的应用代码和离线可用外壳；兼容性应由明确的远程协议承担。

**在产品具备原生投递链路前增加后台通知。** 不采用，因为休眠的 token、凭证、持久化、隐私、配额与兼容性表面不能投递提醒。前台同步是已接受的生命周期。

**用客户端时钟或 last-writer-wins 解决并发操作。** 不采用，因为只有已配对 Desktop 才能排列已提交的 Session 和交互状态，且重试不得复制修改。

**为离线使用缓存每个已同步字节。** 不采用，因为附件、终端输出、spill 文件和凭证会扩大本地暴露，却无助于核心只读历史工作流。

**保留六位手输配对码。** 不采用，因为低熵码无法在没有 PAKE 或另一认证机制时验证加密对等端；完整一次性链接以更少协议复杂性保留 QR 挑战的熵。

**通过 Relay 备份或恢复设备私钥。** 不采用，因为恢复权会让云端可以替换 Device Principal。设备替换改为创建新 principal 和配对。

**改造之前的 Java 应用网关。** 不采用，因为它解析明文业务 envelope、存储明文附件、使用永久 bearer JWT、假定每个设备行只有一台 Desktop、在 WebSocket 挂接时信任 Desktop id 查询参数，且依赖 Alibaba 专用部署基础设施。

**让 Platform 变成共享业务网关，或让 capability 继承全部账号权限。** 不采用，因为组合根共享基础设施，而不是权限或明文。每个 Platform Capability 分别授权 Platform Account 可以执行的操作。

**把配对、Relay 和 blob 拆成独立的浅 Platform 服务。** 不采用，因为它们共同实现一个 Remote Access 生命周期和授权模型；深 capability 将这些实现保留在内部，而 Remote Relay 仍是精简传输组件。

**保留 Expo 和 React Native 作为页面运行时。** 不采用，因为已接受的 Companion Surface 共享现有 React Web Client；Capacitor 可提供所需原生适配器，且不创建另一个页面渲染器。

**通过实时 WebSocket 发送附件或存储明文。** 不采用，因为大帧会干扰交互流量，明文存储则与不透明 Relay 的角色相矛盾。

**隧道传输完整现有 Host 接口。** 不采用，因为其锁步且面向回环的操作包含 Device Principal 授权之外的能力。精简的加密协议会显式定义可允许的远程接口。

**在首版中引入全局 Desktop Principal。** 延后，因为每条配对密钥已验证加密应用对等端。可轮换 Relay 凭据已足以挂接试点路由，同时接受其泄漏可干扰可用性。

**信任 Desktop 路由 id 或查询参数。** 不采用，因为标识符不能证明路由所有权；即使是简化试点，出站连接挂接时也必须提供高熵凭据。

**使用一个共享协议版本。** 不采用，因为 Relay 必须在不知道加密应用版本的情况下拒绝不兼容传输帧，而 Mobile 与 Desktop 必须端到端协商独立发布的 Companion capability。

**为试点发布单实例 Relay。** 不采用，因为即使是受控规模，首个可部署架构也必须能在并发实例之间路由。多区域路由和实时 socket 迁移仍无必要。

**要求 sticky session 或在部署时迁移实时 socket。** 不采用，因为连接目录和跨实例转发允许任一对等端使用任一 Platform Instance，而重连与重新同步无需迁移传输连接即可保持应用权威。

**增加应用自有的跨地域容灾编排。** 延后，因为首个部署使用阿里云托管备份和容灾能力。Redis 路由和会失效密文 blob 可重建或丢弃，端到端配对认证仍由 Desktop 拥有。

**在 Pairing Challenge 中放入任意 Relay URL。** 不采用，因为首个分发应用拥有配置好的可信 origin；接受不受信服务器地址会把服务器选择和信任根策略引入个人配对。

**以 Remote Relay 命名云端应用。** 不采用，因为 Relay 是首个 Platform Capability 中的一个组件，而同一个中心化部署以后还会承载其他分别授权的能力。

**在同一个计算实例上运行两个 Platform 进程。** 不采用，因为已接受的阿里云部署会购买两个独立实例并置于负载均衡器后。

**立即通过公开移动应用商店发布。** 不采用，因为受控的 TestFlight 和已签名 APK 分发可在创建公开升级义务之前验证原生安全与生命周期行为。

**让设备来源对模型可见或在视觉上突出。** 不采用，因为来源归因是审计和详情问题，不是模型上下文或主会话内容。

**持久化实时路由、心跳、密文帧或无期访问日志。** 不采用，因为重连会重建实时路由，加密帧不是应用权威，无限期元数据保留也不服务于试点。

**为离线或缓慢对等端排队密文。** 不采用，因为 Relay 不是应用权威；目标不存在会明确失败，有界慢消费者会重连并从 Desktop 状态重新同步。

**为诊断记录密文、持久标识、设备名称、密钥、token 或 Pairing Challenge。** 不采用，因为无内容指标和定期轮换假名可提供运维关联，而无需把敏感值变成可观测性数据集。

**将云提供方或 OAuth 凭证存入应用数据或仓库配置。** 不采用，因为 Platform 消费部署管理的 secret 引用，并在必需 secret 不可用时 fail loud。

**将 Relay 保留在独立仓库或在其中挂载 Harness Engine。** 不采用，因为同一源码树才能完成同变更协议验证，不透明 Relay 也不拥有 agent 执行或 Session 语义。

**暴露 Workspace 管理、模型选择、Session 重命名、归档、删除、fork 或终端输入。** 不采用，因为这些操作超出已接受的 Companion Surface；Session 仍可在现有 Workspace 中创建，也可创建为 Ungrouped Session。

**在 Mobile 限制持久审批选择。** 不采用，因为 Desktop Approval Service 已拥有哪些决策有效。Mobile 不增加另一策略层地渲染该接口，并保留 Desktop 提交权威与设备归因。

**从外部 deep link 执行审批或取消。** 不采用，因为链接状态可能陈旧；每次修改前都会打开应用并重新同步。

**在后台保持移动 WebSocket 或执行 silent synchronization。** 不采用，因为前台重新同步可处理已接受生命周期，无需依赖受平台限制的后台执行。

**复用 Desktop 多列导航。** 不采用，因为移动导航围绕一台选中 Desktop 和一个活跃 Session，摘要和交互通过移动端专用路由提供。

**在 Mobile 隐藏不支持的工具输出。** 不采用，因为没有专用移动渲染器时，通用只读卡片仍会保留可检查性。

**要求每个新 Mobile Session 必须属于 Workspace。** 不采用，因为 Mobile 新建流程必须允许省略 Workspace，并与 Desktop 一致创建 Ungrouped Session。

**自动重放连接中断时结果丢失的修改。** 不采用，因为 Desktop 可能已经提交；operation id 查询会先消除不确定性，只有明确不存在时才由用户有意重试。

**使用自动数据库 down migration，或将配对密钥放入可丢弃缓存。** 不采用，因为滚动 Relay 版本需要兼容的扩展 schema，且 Mobile 缓存恢复不得销毁有效 Personal Pairing。

**保留之前的移动端名称、bundle id 或视觉身份。** 不采用，因为该应用是 DeepSeek Gestalt 的移动界面，会共享其设计和术语，而不是呈现为迁移后的千机产品。

**增加单独生物特征应用锁。** 从产品范围中拒绝；操作系统访问控制和加密存储拥有本地保护。

## 验收标准

- 一台已个人配对且处于另一网络的手机，在已配对 Desktop 在线时，可浏览 Workspace 和 Session、打开历史、接收实时输出、提交和取消提示词、传输附件，并回答审批和人机问题。
- Companion Surface 通过移动端专用组合来消费现有 Client Runtime 与共享页面组件；它不拥有独立的 Session 状态模型。
- 可识别并撤销 Personal Pairing，无需引入组织成员或 Desktop 共享访问。
- GitHub 登录创建或认证简单 Platform Account，且 Desktop 或 Mobile 必须先认证账号才能使用 Personal Pairing；账号身份本身不授予 Desktop 或 Device Principal 权限。
- 每个 GitHub 账号都可创建 Platform Account，不设白名单；Pairing Challenge 兑换成功前，Desktop 和 Mobile 必须认证同一个账号。
- GitHub OAuth App 登录使用系统浏览器 Authorization Code flow、PKCE、随机 state、一个固定 Platform callback、零 OAuth scope、不可变 numeric GitHub id，且不保留 GitHub token。
- 一个安装同时持有一个 proof-of-possession Account Session 和一个账号，并在安全存储中使用十五分钟 access token 与最长三十天轮换 refresh token。
- Account Session 使用独立 P-256 安装签名密钥；五分钟签名轮询 Login Attempt 完成固定 Platform OAuth callback，且不使用携带 token 的自定义 URL scheme。
- 退出登录只撤销该安装 Account Session 并关闭其连接，同时保留 Personal Pairing；切换账号会隔离全部配对、密钥、缓存和 receipt 状态。
- 撤销 GitHub OAuth 会阻止以后登录，但首版不会使现有有界 Platform session 失效。
- 当前安装退出通过 PostgreSQL、Redis 和两个 Platform Instance 传播 `sessionRevision`；首版不提供 Account Session 列表、远程退出、退出全部、安装丢失恢复或 Platform Account 删除。
- Platform Account 使用一条 `account_identity(provider, subject)`，首版只接受 GitHub numeric id，且不支持身份绑定、解绑或合并。
- 开放注册使用已接受的账号、安装、配对、连接、challenge、blob、字节和认证配额，并返回稳定错误与重试时间。
- 整体容量会保留已建立连接，并以 `PLATFORM_CAPACITY` 拒绝新资源获取；双实例部署既不自动扩缩，也不提供运营侧账号停用控制。
- 登录前中英文隐私说明披露已接受的数据和保留类别，并明确首版没有产品内账号删除流程。
- 开发和生产使用不同 GitHub OAuth App、Platform origin、callback、凭证、数据库和身份 namespace；首版没有预发环境。
- 已配对 Desktop 保持 Session、Workspace、凭证和执行的唯一权威；每次成功的移动端修改都有 Desktop 确认。
- 中继路由端到端加密的应用流量，不获取 transcript、提示词、工具、审批或附件明文。
- 每个远程修改都携带 Device Principal，其允许的操作不包括设置、凭证、插件、终端和原生 Desktop 访问。
- 多台设备和 Desktop 使用独立的 Personal Pairing，每次操作选择一台已配对 Desktop，且不合并跨 Desktop 的 Session。
- 远程访问默认关闭；启用后显示设备状态、最近访问、单独撤销和全部撤销控制。
- 关闭 Desktop 窗口、退出应用、计算机休眠或停用移动访问会使 Desktop 进入 Remote Offline，且不存在后台 Host 或远程唤醒。
- Remote Offline 仅允许查看 Companion Cache；不存在等待之后执行的移动端修改。
- Device Principal 证明拥有其安装密钥；中继 bearer 凭据无法单独伪装它。
- 配对使用 Noise XKpsk3、两分钟失效且仅使用一次的 256-bit QR 或完整链接邀请、handshake-hash 认证词和显式 Desktop 确认；重连使用 Noise IK、新临时密钥且不复用邀请 secret。
- 产品密码依赖通过有界原型矩阵、Noise 官方向量、跨平台与攻击路径测试以及独立安全评审；产品代码既不 fork 握手内部实现，也不使用原语自创协议。
- 原生适配器在可用时使用硬件支持 wrapping 保护 Mobile 静态私钥材料，但不声称 X25519 在安全硬件中执行。
- Desktop 使用可轮换的高熵凭据挂接其不透明 Relay 路由，Personal Pairing 密钥则验证加密对等端；无需全局 Desktop Principal。
- 已安装应用从共享 DSH 源码捆绑其 Companion Surface 资源，不执行已配对 Desktop 或中继提供的页面代码。
- `apps/mobile` 使用 Capacitor 实现原生适配器，共享 Web Client 拥有 Companion Surface。
- 新 Remote Relay 仅接受 Desktop 和 Mobile 的出站连接，且不处理任何解密 DSH 业务值。
- Relay Transport Protocol 位于密文之外，Encrypted Companion Protocol 在密文内仅暴露 Companion 操作和投影；完整 Host 接口不可达。
- Transport 与 Companion 版本区间独立协商，Desktop 支持当前和前一个 Companion major，不兼容对等端快速失败并提示升级。
- Relay 在滚动部署中使用 expand-contract 数据库 migration；Mobile 配对密钥记录可经受可丢弃缓存重建，不受支持的客户端必须升级而不能安全降级。
- 附件明文仅存在于 Mobile Companion 和 Desktop，Relay 仅保留会过期且限定配对的密文 blob。
- 打开 Mobile 或将其切回前台会重连，并在任何 mutation 可用前完成 Desktop 权威同步；产品不提供后台通知投递。
- `apps/platform` 是中心化 Platform Capability 的 Cordis 组合根，且不挂载 Harness Engine；Account 和 Remote Access 是其初始独立授权 plugin，后续 capability 既不共享 Remote Access Device Principal，也不共享其明文。
- 拟新增的 `@deepseek-ai/dsh-platform-account` package 在 Account Service 后拥有 OAuth 与 Account Session 生命周期；Remote Access 校验 session 和同账号配对，但不读取账号存储。
- 深 package 划分让 protocol、Platform Remote Access、Desktop 适配和 Mobile 同步各有一个拥有模块；配对、Relay、blob 和跨实例行为保持为 Remote Access 内部实现，而不是独立浅服务。
- 试点通过阿里云单区域中恰好两个 Platform Instance 支持约五十台 Desktop，并使用 TestFlight 和已签名 Android APK 分发。
- 两个 Platform Instance 运行在独立阿里云计算实例上，位于一个无 sticky session 的 TLS 端点后；托管 PostgreSQL 存储持久元数据，托管 Redis 保存会失效的连接目录并转发密文 Pub/Sub，OSS 保留会失效的密文 blob；实例丢失只触发重连，不丢失已提交状态。
- 阿里云负责试点的备份和容灾能力；应用不增加 restore epoch、恢复时配对暂停、跨地域编排、Redis 备份或密文 blob 恢复。
- 每个版本信任其配置好的 Platform origin，Pairing Challenge 不能选择任意服务器或信任根。
- 每条 Noise 消息和 transcript page 都遵循固定协议上限，而已校验 Platform 配置拥有 blob、失效、队列、心跳和在线状态默认值。
- 离线目标以 `REMOTE_OFFLINE` 失败；慢消费者在有界队列处断开，而不是丢失、重排或持久排队 frame。
- 并发操作按已配对 Desktop 的提交顺序结算，重试 operation id 永远不会重复其修改。
- 持久远程操作归因不进入模型输入或普通会话内容，但可在 UI 详情中查看。
- PostgreSQL revision、Redis 发布、心跳重新验证和 fail-closed 挂接使单独撤销与全部撤销可跨 Platform Instance 终止活跃访问；全部撤销还会轮换 Desktop Relay 凭据。
- Desktop Mobile Access 与 Mobile 已配对 Desktop 页面暴露已接受的启用、配对、状态、最近访问、撤销、解除配对和缓存控制，且不显示 IP 地址。
- Relay 保留遵循已接受的持久配对、三十天安全事件、七天原始 IP、临时在线状态和 blob 失效规则。
- SLS 与 CloudMonitor 仅接收已接受的指标、健康、结构化错误、随机 request id 和定期轮换 HMAC 假名；敏感标识、设备数据、token、密钥、challenge、链接和密文 body 永远不进入遥测。
- Platform 只通过部署管理的 secret 引用加载 PostgreSQL、Redis、OSS 和 GitHub 凭证，并在必需 secret 缺失时使所属 capability 失败。
- 首个协议目录仅暴露已接受的查看、在现有 Workspace 中或作为 Ungrouped Session 创建 Session、提示词、附件、取消、交互、审批和自行撤销操作。
- Mobile 审批暴露 Desktop Approval Service 提供的每个决策，包括持久授权，而不增加移动端专用策略。
- 配对链接不携带交互权威，移动导航使用选中 Desktop 与单 Session 流，且只有已打开 transcript 接收实时详情。
- 进入后台会暂停 WSS；打开应用或将其切回前台会重连并同步，且不执行 silent background task。
- 共享 Markdown、代码、图片、工具、diff、审批和 Ask User 渲染器保持可用；终端内容有界且只读，未知工具使用可见通用卡片。
- Mobile 支持查看和继续 Ungrouped Session；新建时省略 Workspace 会与 Desktop 一致创建 Ungrouped Session。
- 结果未知的已发送修改只保留 operation receipt；重连会先解析其 operation id，再允许用户决定重试，不存在自动重放或离线 outbox。
- 应用名称为 DeepSeek Gestalt，使用 `com.gestalt.deepseek.mobile`，并继承 DSH 术语、token、渲染器、语言和主题选择。
- Mobile Companion 没有独立应用锁功能。
- Companion Cache 静态加密上次确认的元数据和已打开 transcript，不自动缓存附件、终端、spill 和凭证字节，并支持按 Desktop 清除。
- Mobile Companion 不暴露任何由 agent 操作的移动设备自动化。
- 远程路径不直接暴露当前未认证的 Web Host。
- 交付遵循已接受的原型、协议、Platform、Desktop、Mobile runtime 和组装真实设备顺序。
- Keyless snapshot、package 与 integration test、进程级故障测试以及 iOS 和 Android 真实设备验收，在各自层级拥有已接受的账号、协议、Desktop 和 Mobile 路径。

## 风险

- 当前 Client 与 Host 协议假定两者锁步发布。独立发布的移动应用需要在首次持久分发前建立明确的兼容策略。
- 开放 GitHub 注册会把 Platform 计算、连接和 blob 资源暴露给每个已认证 GitHub 用户；有界协议限制不能替代账号级滥用控制。
- 首版没有运营侧停用或账号删除控制，因此恶意或废弃账号只能由自动配额、容量 shedding、Account Session 失效、GitHub 提供方对后续登录的动作以及 Personal Pairing 撤销来约束。
- 丢弃 GitHub token 会保持 Platform 凭证最小化，但也意味着外部 OAuth 撤销不会在现有 Platform session 有界失效前终止它。
- 首版无法远程退出一台丢失且已登录的安装；其 Account Session 会一直有效到 refresh token 生命周期结束，但仍可从一台可达的已配对 Desktop 单独撤销其 Personal Pairing。
- 首版没有用户触发的 Platform Account 身份与元数据删除路径，因此隐私说明和保留策略必须直接披露该限制。
- 远程提示词和交互操作可触发具有宿主文件系统和进程访问权的工具。设备认证和端到端加密不能取代 Session 的工具与审批策略。
- 即使采用已接受的保留策略，中继仍可观察路由、在线状态、时序和流量大小。
- 可用时，移动硬件可以保护配对密钥材料的静态存储，但不能假定标准 Noise X25519 运算始终留在 Secure Enclave 或 StrongBox 内；原生密钥适配器需要平台专用证明和精确表述。
- 被复制的完整配对链接与扫描其 QR 拥有相同的短时机会。Desktop 确认和挑战失效可限制却无法消除该暴露。
- 窃取简化的 Desktop Relay 凭据可占用或断开其路由，直到凭据轮换，但配对密钥认证仍保护应用机密性和完整性。
- 支持两个相邻 Companion major 会为每次破坏性协议变更产生持续的兼容与移除成本。
- 多实例路由使首个试点即使用户量很小，也要增加共享连接目录和跨实例转发路径。
- 滚动部署可断开实时 socket；重连路径必须在不复制修改或把传输连续性当作 Session 权威的情况下恢复。
- Capacitor 中的硬件支持密钥、加密存储和本地 Web 资源适配器，需要平台专用证明才能让容器选择不可逆。
- 密文 blob 删除依赖失效与领取处理；必须对废弃上传和丢失确认设置确定性清理。
- 没有后台投递时，用户必须打开 Mobile Companion 或将其切回前台，才能获知 Desktop 当前状态。
- 超出缓存与配对密钥记录兼容范围的 Mobile 回滚可能不可用；重新配对不是可接受的常规升级路径。
- 试点将基础设施备份与容灾交给阿里云，因此可用性和恢复点保证取决于采购的服务配置，而不是应用自有控制器。
- 要求 Desktop 窗口保持打开会让远程可用性有意保持脆弱；以后恢复后台可用性需要一项新的生命周期决策。
- 共享页面组件本身不能建立移动端可用性；仍需要组装完成的手机尺寸交互覆盖。
