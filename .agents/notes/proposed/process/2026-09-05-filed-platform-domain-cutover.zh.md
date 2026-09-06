# Agent Note: 备案域名 Platform 切换至 beikejiedeliulangmao.top

Status: proposed

[English](2026-09-05-filed-platform-domain-cutover.md) | 中文

## 问题

运营中的 Platform 通过一个 ALB HTTPS 监听器在 `https://www.gestaltrun.com/` 上提供 `apps/platform/public` 的内容，而 gestaltrun.com 的 ICP 备案仍在进行中。运营该部署的已认证阿里云账号下，备案域名 `beikejiedeliulangmao.top` 已以 辽ICP备19017854号-1 获批。在 origin 迁到备案域名之前，中国大陆的生产服务在当前名称上带有备案风险。

迁移 origin 不是一次 DNS 编辑。Environment `production` 的 `PLATFORM_ORIGIN` 是 Desktop 配置生成器、Mobile 构建和 Platform 监听进程共同推导身份的输入：Desktop 配置生成器把 Relay WSS 地址推导为 `wss://<origin>/v1/remote-access/relay`；Mobile 构建在构建期固化 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL` 和 `VITE_REMOTE_RELAY_WSS_URL`；Platform 监听进程从同一值推导 CORS 允许的 origin 与 `/pair` 链接 origin；`production-env.ts` 强制 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 共享同一个 HTTPS origin，且回调路径为 `/v1/account/oauth/github/callback`。已安装的 Desktop 客户端与已发布的 Mobile 构建携带旧 origin，而 GitHub OAuth App 的回调 URL 注册在仓库之外。

#480 记录了当前 ALB/TLS 边界以 `net_error -101` 拒绝 Android System WebView 83。切换会替换该边界上呈现的 TLS 证书，因此 #480 的诊断必须对照新域名证书重新验证，不能作为证据或阻碍直接沿用。#415 跟踪一条发布列车对齐，需等其自身发布证据完成后才关闭。

用户已选择两台按月 `ecs.e-c1m2.large` 实例与一台新 ALB Basic，并授权本任务范围内的阿里云操作来分阶段完成替换。迁移必须保留持久基底——RDS、Redis、数据库身份、签名密钥、命名空间、账号与数据——且旧资源必须保留到替换路径通过验证并结束回滚窗口之后。

旧客户端过渡已在代码中验证而非假设。登录 POST 只携带安装身份（`packages/platform/platform-account-client/src/index.ts` —— `beginLogin` 发送 `InstallationLoginIdentity` 与公钥）；服务器用它配置的 `redirect_uri` 与固定回调生成 GitHub `authorizationUrl`（`packages/platform/platform-account-core/src/index.ts` —— `authorizeUrl` 以 `client_id`、环境的 `callbackUrl`、`state` 与 S256 code challenge 构造 `https://github.com/login/oauth/authorize`）；客户端解析器只校验返回的 `authorizationUrl` 的 HTTPS scheme（`packages/platform/platform-account/src/parsers.ts` —— `parseLoginAttemptView` 要求 `httpsUrl(record.authorizationUrl)`）。推论：只要两个主机名带着同一身份到达同一后端，旧客户端可以在旧主机名上继续 POST 登录尝试并轮询，而服务器发出新域名的 OAuth 回调；Environment 的 origin 变更不会关停旧主机名；也不需要第二个 OAuth App。

## 提案

通过下述分阶段序列，将运营 Platform 切换到 `https://www.beikejiedeliulangmao.top` 并支持裸域（`beikejiedeliulangmao.top`）。用户已确认以 www 为规范 origin，并授权域名部署、正式 Desktop/Mobile 重发布、双节点按月 ECS 替换、新建 ALB Basic 迁移、证书与 DNS 操作及本任务必需的阿里云成本优化，无需逐步再次确认。持久化批准包括[有上限的 ECS 采购](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/608#issuecomment-5553279192)、[ALB Basic 切换](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/608#issuecomment-5553317796)与[本任务范围的操作授权](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/608#issuecomment-5553326557)。两台按月 `ecs.e-c1m2.large`（2 vCPU、4 GiB）实例各带 40 GiB ESSD PL0 系统盘，首月合计上限 135.04，无年度承诺、无默认自动续费。RDS 与 Redis 实例、数据、数据库身份、命名空间、签名密钥、账号与持久状态保持不变。旧 ECS、Standard ALB、EIP 与其他共享资源仅在替换路径通过验收、依赖得到确认且回滚窗口结束后释放。本说明与其 PR 不执行云上变更；另行指派的基础设施执行器持有已授权的分阶段操作。

切换后的规范权威：

- Environment `production` 的 `PLATFORM_ORIGIN` 变为 `https://www.beikejiedeliulangmao.top`；`PLATFORM_GITHUB_CALLBACK` 变为 `https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback`。
- Environment `desktop-release` 更新同两个名称 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK`——Desktop 配置投影读取的是 `PLATFORM_*` 名称而非 `VITE_*`。Environment `mobile-release` 将 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL` 与 `VITE_REMOTE_RELAY_WSS_URL` 更新为同一 www origin，并保持 `VITE_REMOTE_RELAY_WSS_URL = wss://www.beikejiedeliulangmao.top/v1/remote-access/relay` 与 Desktop 推导的 relay 地址一致。
- GitHub OAuth App（client id `Ov23lip9LTmnFuFpFeeV`）的回调 URL 重新注册到新回调路径。该 App 区别于仓库的自动化 GitHub Apps，不被替换；经代码验证的过渡不需要第二个 OAuth App。
- 无条件保留：`PLATFORM_POSTGRES_DATABASE`（数据库身份）、`PLATFORM_IDENTITY_NAMESPACE`、`PLATFORM_TOKEN_SIGNING_KEY`、`PLATFORM_POLLING_SIGNING_KEY` 与全部持久数据。账号、安装、配对与持久状态得以保留，因为为其提供键的身份未变。RDS 与 Redis 保留；仅优化其计费。
- 已选拓扑与获授权的基础设施迁移：两台按月 `ecs.e-c1m2.large`（2 vCPU、4 GiB）ECS 实例，各带 40 GiB ESSD PL0 系统盘，位于一台新 ALB Basic 之后。官方 `DescribePrice` 将 47.52 计算费与系统盘 20 元对账为每台 67.52、两台 135.04。ECS 首月合计不得超过 135.04；更高结账金额必须停止并取得新决策。实例不使用年度周期与默认自动续费。Basic ALB 采用新建实例的分阶段切换，因为 Standard 不支持原地降级；获批的规划成本约为每 720 小时 67.56，包括 Basic 实例 35.28、两个 EIP 保有费 28.80 与估算 LCU 3.48，公网流量另计、LCU 用量可变、折扣未确认。RDS 与 Redis 实例及数据保留。旧 ECS 与 Standard ALB 在替换验收和回滚期间继续可用；已披露的短暂重叠费用属于安全迁移顺序。
- 区域上的三条 TXT 记录及其他所有 DNS 记录逐字保留；仅替换两条旧 A 记录（裸域与 www 的 `120.77.49.2`），并记录变更前的值用于回滚。两个主机名都迁移；规范权威保持为 www origin。此前已停用的 `www.gestaltrun.com` 记录不会被静默重新启用。
- gestaltrun.com 证书与 Standard ALB 作为旧前端保持不变，直至旧客户端过渡证据与回滚窗口关闭；origin 切换不会退役该路径，其身份命名空间保持不变。除非另行授权，旧 DNS 仍保持停用。
- 阿里云完整操作授权限于本任务：基础设施执行器可创建并配置所选 ECS 对与 Basic ALB、取得并挂载证书、更新两条已授权 DNS 记录、实施必要成本优化并分阶段切换，无需逐步询问。授权不包括无关支出、银行卡访问、任意删除、年度承诺与默认自动续费。ECS 金额超过上限、余额不足、owner 登录不可用或安全要求无法满足时必须阻塞，而不能绕过约束。
- 品牌名称、README、历史发布说明及历史文档中的 gestaltrun.com URL 不改名。由于裸域与 www 服务都迁移且 www 是规范 Platform 权威，实际服务的官网 canonical 与当前发现元数据迁移到 `https://www.beikejiedeliulangmao.top/`。

裸域行为：裸域主机名获得有效证书与 DNS 可达性，使裸域 HTTPS 不失败，但规范权威是 www origin。裸域重定向到 www 还是直接提供产品，由 Stage 1 对新 Basic 监听器的验证决定；OAuth POST 回调与 Relay WSS 永远不指向裸域。

## 分阶段切换

Stage 0 —— 冻结并记录（不改生产）。记录当前裸域/www A 值（`120.77.49.2`，TTL 600 秒）、三条 TXT 记录、ALB 监听器 id 及其当前证书、服务器组、ECS 实例 id，以及当前 GitHub OAuth App 回调 URL。重新拉取 `origin/master` 并确认发布列车状态（PR #584 / 计划 0012 选择 Desktop 0.1.16），使本次切换不与该列车交错。

Stage 0.5 —— 就绪与有界成本验证，随后进行获授权的分阶段准备。任何变更前立即复核时敏的账户余额与最终订单条款。仅当两台按月 `ecs.e-c1m2.large` 实例及其 40 GiB ESSD PL0 系统盘首月合计结账不超过 135.04，且无年度周期与默认自动续费时，才准备这两个实例；旧节点保持可用期间，对照观测利用率验证 2 vCPU/4 GiB 形态。确认当前条款与依赖归属后创建已获批的新 ALB Basic。Basic 已验证支持 HTTPS、WebSocket、HTTP/2、XFF append、双后端健康检查与 SYSTEM 预设 `tls_cipher_policy_1_2_strict_with_1_3`；不得削弱 TLS。规划成本约为每 720 小时 67.56，包括实例 35.28、两个 EIP 保有费 28.80 与估算 LCU 3.48，公网流量另计、LCU 用量可变、折扣未确认。保留 RDS 与 Redis；只有在保留其实例、数据与身份时，才可在本任务成本优化授权内变更计费。2026-09-05T16:04Z 的更正报告显示余额 +86.52 且 ALB 无财务锁定，但执行器使用当前复核，不把该观察视为持久事实。

Stage 1 —— 新 Basic ALB、证书与 DNS 准备（阿里云，由已指派基础设施执行器负责）。创建已获批的 Basic 实例，挂接两个替换 ECS 后端，复现已验证的 HTTPS、WebSocket、HTTP/2、XFF、健康检查与 `tls_cipher_policy_1_2_strict_with_1_3` 行为，并保留 Standard ALB 用于回滚。签发一张覆盖 `beikejiedeliulangmao.top` 与 `www.beikejiedeliulangmao.top` 的 HTTPS 证书，挂到 Basic HTTPS 监听器，并在 DNS 切换前验证两个名称。仅替换两条已授权 A 记录，使裸域与 www 通过新前端解析；保留三条 TXT、所有无关 DNS、TTL 与旧 A 值。继续前验证权威与公共解析、两个名称的 TLS 握手与主机名校验、后端健康、`/readyz`、Relay WebSocket 行为及不变的旧路径。本阶段不得释放 Standard ALB、其 EIP 或共享资源。

Stage 2 —— Platform origin 切换（仅 GitHub Environment `production`；暂不部署）。更新 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 变量；重新注册 OAuth App 回调。运行 platform-deploy 的 validate 作业（源码 CLI `production-env-cli.ts` 在任何 ECS apply 之前拒绝不匹配的 origin/回调）。在继续之前，对照仍在运行的旧部署验证新 www origin 上的 `/readyz`。本阶段可通过恢复两个 Environment 变量与 OAuth App 回调 URL 回滚。该切换改变的是新服务端响应所携带的内容：在消费这些变量的部署之后，任一主机名上发起的登录尝试都会收到服务器生成的 `authorizationUrl`，其 `redirect_uri` 是新域名回调，而客户端解析器接受任何 HTTPS 的 `authorizationUrl`。该切换不会让旧主机名停止服务，过渡期间也不创建第二个 OAuth App。切换时刻已在等待中的登录尝试引用切换前的回调；它们可能需要客户端重启以对切换后的流程重新发起，Stage 5 将该重启作为过渡的一部分覆盖，而非服务保证。

gestaltrun.com 上的旧 DNS 记录当前处于 DISABLED 状态 —— 这是本说明之外持有的、未决的刻意状态。本说明不会重新启用它们：对该状态的任何改变都是单独的显式用户决策并有其自身记录。在旧主机名保持停用期间，旧客户端无法直接访问 Platform；Desktop 更新器独立于 Platform origin（它通过 GitHub Releases 更新），因此即使旧 DNS 停用，已安装的旧 origin Desktop 仍可更新到重发布版本并由此采用新 origin。

Stage 3 —— Platform 部署（受保护工作流，已由本任务范围的操作批准覆盖）。platform-deploy 派发以候选 SHA 对新 Basic ALB 之后的替换 ECS 对执行，保留工作流持有的双实例滚动替换、回滚记录与附件存储切换。在旧 ECS 与 Standard ALB 继续可用于回滚时，验证新 www origin 的就绪、账号登录与 Relay WSS。旧客户端行为在 Stage 5 验证，不在此处假设；已停用的旧 origin DNS 不会被隐式恢复。

Stage 4 —— 客户端重发布（从一个经评审候选发布正式 Desktop 与 Mobile）。在 `master` 上通过新的 Product Release Plan 提升 Desktop 与 Mobile 版本；新 origin 在该候选上固化进 Desktop 运营配置与两个 Mobile 构建。Desktop 经 desktop-release 发布（签名、公证、`--latest`）。用户的正式 Mobile 诉求是面向 Mobile 用户的产品分发，工作流将其拆为两个分别取证的渠道：签名 Android APK 作为持久的产品分发，以及 iOS TestFlight 上传作为独立的受闸步骤，仅当请求过 `upload_testflight` 且存在已校验构建号时才报告为已发布。任一渠道单独都不满足正式诉求：仅 GitHub 预发布不构成正式 Mobile 发布，而 TestFlight 上传是独立的产品分发闸门，不是对诉求的降级。任何 Mobile 发布之前，从物理 Android 路径（WebView，而非仅桌面浏览器）验证新域名的 TLS/就绪，因为 #480 的故障正发生在那里。

Stage 5 —— 物理验收与旧客户端过渡证据。手机侧：有效 TLS、全新 GitHub 登录准备、同账号认证、WSS 附件、显式链接配对、Remote Online、手机侧发起的 ping/pong —— 保留用户设备与 Desktop 实例，并通过 `gif-assets` 发布脱敏证据。Desktop 侧：通过 GitHub 更新器（其可达性独立于 Platform origin）将一台安装了旧 origin 的构建更新到新版本，并确认重发布渠道。旧客户端过渡在此处基于已验证的机制证明，先于旧前端退役：一台安装了旧 origin 的客户端仅在旧 DNS 另行启用时于旧主机名 POST 登录并轮询，完成服务器生成的新域名回调对应的 OAuth 流程；否则该发现被记录为过渡缺口，阻止 Stage 4 声称一次不破坏性的重发布。切换后未能完成的切换前挂起登录尝试由客户端重启重新发起处理，且该要求被记录为过渡证据。gestaltrun.com 证书、Standard ALB、旧 ECS 与保留的命名空间持续可用，直至该证据和回滚窗口关闭。确认依赖归属后，获授权执行器可释放被替代资源；共享资源与无关 EIP 保留。各阶段回滚：Stage 1 恢复旧 A 值并将流量指回 Standard 前端；Stage 2 恢复两个 Environment 变量与 OAuth App 回调；Stage 3 使用工作流自身的回滚记录；Stage 4 不下架旧版本——旧安装包仍是有效下载目标，回滚方式是重指 origin 变量并从上一候选重新发布。

## 与进行中发布列车的排序

PR #584 携带选择 Desktop 0.1.16 的 Product Release Plan 0012（分支 `automation/product-release`），已只读核验其 head 为 `3ac00a04805a3415b68a8d4e69d5c45af816c4f3`（OPEN，Draft）。本规范不修改该 PR，且本分支的规划对照其状态协调，不依赖其 head 移动。排序规则是账本碰撞而非版本依赖：本切换的 Product Release Plan（Stage 4）仅在计划 0012 合并或被显式处置后才在 `master` 上创建，因为两个开放计划会争夺 `product-releases/` 的 `nextSequence` 与发布意图账本。在该规则之外，版本序列保持灵活 —— 此处不要求 Desktop 重发布必须构建在 0.1.16 之上，本任务也不会因为一条无关建议而派发 #584 的发布：任何发布派发都由持有该决策的人对照最新的发布列车状态协调，以避免不必要的付费或发布变更。Platform-deploy 派发（Stage 3）不与仅 Desktop 的计划冲突；若 0012 已提升 Desktop，Stage 3 可在 Stage 4 的计划合并之前或之后运行，但 mobile 验收运行（Stage 4）必须绑定到确切的新域名候选 SHA。

## 备选方案

**等 gestaltrun.com 备案完成后继续使用它。** 否决：备案时间线无界，用户已明确批准迁移，期间生产服务带有备案风险。

**不移动 `PLATFORM_ORIGIN`，仅代理或重定向新域名。** 否决：OAuth 回调与 Relay WSS 必须终止在客户端与监听进程实际校验的 origin 上；无差别重定向 OAuth POST 或 WSS 会同时破坏两者，且议题明确禁止。

**原地修改 Standard ALB。** 否决：Standard 无法原地降级为 Basic，修改唯一已验收前端会削弱回滚。获批路径新建 Basic 实例，并行验证后切换流量，仅在验收与回滚窗口结束后释放 Standard。

**使用单 ECS 节点或移除负载均衡层。** 否决：用户在审阅成本与可用性取舍后选择两台按月 `ecs.e-c1m2.large` 节点与 ALB Basic。RDS、Redis、数据、数据库身份、命名空间与签名密钥仍是无条件保留要求。

**把 `PLATFORM_ORIGIN` 指向裸域。** 否决：www 主机名是签发的规范权威；裸域支持的存在是为了让裸域 HTTPS 不失败，而不是第二个权威。两个 origin 会让 CORS 与回调面翻倍且无收益。

**把品牌表面与历史文档 URL 改为新域名。** 否决：这次变更是 origin 迁移，不是改品牌或重写历史。当前服务的官网 canonical 与发现元数据迁到规范 www 服务 origin；品牌名称与历史 URL 保持不变。

**在 Platform 服务新 origin 之前重发布客户端。** 否决：固化的客户端权威必须指向已通过 `/readyz` 与登录的 origin，否则每个升级后的安装在首次运行即损坏。

## 验收标准

- 所选替换拓扑依据持久化授权完成准备：两台按月 `ecs.e-c1m2.large` 实例与 40 GiB ESSD PL0 系统盘的首月合计结账不超过 135.04，无年度承诺、无默认自动续费；新 ALB Basic 的当前条款对照约每 720 小时 67.56 的规划基准；并验证 `tls_cipher_policy_1_2_strict_with_1_3`、HTTPS、WebSocket、HTTP/2、XFF 与双后端健康检查行为。任何变更前立即进行当前的带时间戳账户与价格复核。
- 一张同时覆盖裸域与 `www.beikejiedeliulangmao.top` 的有效 HTTPS 证书终止在新 Basic 前端上；现有 Platform 身份、RDS、Redis、数据库身份、签名密钥、命名空间、账号与持久数据全部保留，不新建身份体系、不更换密钥。
- 裸域与 www 通过 Stage 1 选定的阿里云 DNS 机制公共解析；三条 TXT 记录及所有无关 DNS 记录逐字保留；旧 A 记录值已记录用于回滚；两个名称的证书主机名校验通过。
- Environment `production` 的 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK`、运营 Desktop 配置及 Mobile 构建变量全部指向 `https://www.beikejiedeliulangmao.top` 且回调路径固定；WSS 与 `/pair` 链接由该 origin 推导；OAuth App `Ov23lip9LTmnFuFpFeeV` 的回调与之匹配。
- 新的正式 Desktop 与 Mobile 版本从一个经评审候选发布：Desktop 附签名/公证安装包与 `--latest` GitHub Release；Mobile 附绑定候选的验收运行，且两条产品分发渠道分别取证 —— 签名 APK 作为持久分发，TestFlight 仅在请求过上传且存在已校验构建号时报告为已发布。正式 Mobile 诉求只能由用户实际需要的渠道证据满足，绝不仅凭 APK 预发布。各单元分别校验发布清单、签名产物、更新渠道与固化权威。
- 正式 Mobile 发布前，物理 Android 验收在新域名通过：TLS、GitHub 登录准备、同账号认证、WSS、显式链接配对、Remote Online、手机侧发起的 ping/pong；保留用户设备与 Desktop 实例；通过 `gif-assets` 发布脱敏证据。
- 旧客户端过渡与回滚得到演示而非假设：一台安装旧 origin Desktop 的设备经独立于 origin 的 GitHub 更新器更新；一台安装旧 origin 的客户端仅在旧 DNS 另行启用时于旧主机名 POST 登录并轮询，完成服务器生成的新域名回调对应的 OAuth；需要重启的切换前挂起尝试被记录；每一阶段的回滚路径携带确切变更前值。gestaltrun.com 证书、Standard ALB、旧 ECS 与命名空间持续可用，直至证据和回滚窗口关闭；此后执行器才可释放已确认被替代的资源。
- 当前处于 DISABLED 的旧 DNS 记录不会被本次变更隐式重新启用；对该状态的任何改变都是单独的显式用户决策。
- 实际服务的官网 canonical 与当前发现元数据使用 `https://www.beikejiedeliulangmao.top/`；品牌名称与历史文档 URL 不变。
- 本次变更不关闭 #480 与 #415；#480 的 ALB/TLS 诊断对照新证书与其自身证据重新验证，#415 仅凭其自身发布证据关闭。

## 风险

- 600 秒的 DNS TTL 限定但不消除传播重叠：两个名称可能在 OAuth App 回调只接受一个 origin 的窗口内同时解析。阶段顺序（先证书与 DNS，后 Environment 切换）使每个区间都可服务。
- 旧客户端登录连续性依赖两个主机名带着同一身份到达同一后端，这是已验证机制的前提；Stage 0.5 中选出的前端或身份变更若破坏该配对，即使旧主机名仍在服务，也会破坏旧客户端的登录完成。切换时刻挂起的登录尝试引用切换前的回调，在客户端重启并重新发起之前可能无法完成；重启是被记录的过渡步骤，而非静默损失。
- 旧 gestaltrun.com DNS 记录的 DISABLED 状态是本说明之外持有的未决刻意决策：其持续期间，旧客户端没有直接的 Platform 路径，只有独立于 origin 的 Desktop 更新器能把旧安装带到重发布版本。任何阶段都不隐含重新启用，需要其自身的显式决策。
- 更小的 2 vCPU/4 GiB 替换规格可能不足以承载观测负载。在旧实例对保持可用时准备两个新节点可以限制回滚时间；利用率与服务验收必须在释放旧 ECS 之前通过。
- 互相矛盾的账单报告已由带时间戳的更正报告（2026-09-05T16:04Z，余额 +86.52，ALB 无财务锁定）在方向上解决，取代此前 FinancialLocked/−13.48 的读数；持久规则是账户状态属于时敏输入，因此任何变更前立即进行当前的带时间戳复核，而非把任何单一报告当作既定事实。
- 2 vCPU/4 GiB 的 `e-c1m2.large` 形态小于现有实例，其充分性在 Stage 0.5 对照观测利用率核验之前是待验证假设而非度量；报价的 135.04 两台总额仅在结账保持在上限之内时才是采购金额。形态误配会在替换后表现为服务降级，滚动替换可限制但不消除该影响。
- 已获批的 ALB Basic 路径需要新建实例切换。约每 720 小时 67.56 的规划基准不含公网流量，使用估算 LCU，且折扣未确认；执行器复核当前条款，安全约束无法满足时停止。Basic/Standard 与新旧 ECS 并行会产生已披露的临时重叠费用，但验收前释放旧资源会移除回滚。
- 物理 Android WebView 路径（#480）可能因不同于旧诊断的原因在新证书上失败；Stage 4 以该路径为发布闸门，因此风险是重发布受阻，而非已发布构建损坏。
- 把官网 canonical 与发现元数据迁到新 www origin，会在新域名积累权重前转移当前发现权威；其他位置保留历史 URL 可避免改写旧引用，但不能消除 SEO 过渡风险。
- 保留身份意味着保留影响面：一次失败的 Stage 3 部署触及与旧域名相同的持久状态。双实例滚动替换与工作流的回滚记录在实例替换过程中持有这一点；此处不新增机制。
- 新 Basic 监听器的证书挂载与 SNI 行为必须在 DNS 切换前实测；计划不会仅凭功能可用性推断生产行为。
