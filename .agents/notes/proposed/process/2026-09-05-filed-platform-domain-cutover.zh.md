# Agent Note: 备案域名 Platform 切换至 beikejiedeliulangmao.top

Status: proposed

[English](2026-09-05-filed-platform-domain-cutover.md) | 中文

## 问题

运营中的 Platform 通过一个 ALB HTTPS 监听器在 `https://www.gestaltrun.com/` 上提供 `apps/platform/public` 的内容，而 gestaltrun.com 的 ICP 备案仍在进行中。运营该部署的已认证阿里云账号下，备案域名 `beikejiedeliulangmao.top` 已以 辽ICP备19017854号-1 获批。在 origin 迁到备案域名之前，中国大陆的生产服务在当前名称上带有备案风险。

迁移 origin 不是一次 DNS 编辑。Environment `production` 的 `PLATFORM_ORIGIN` 是 Desktop 配置生成器、Mobile 构建和 Platform 监听进程共同推导身份的输入：Desktop 配置生成器把 Relay WSS 地址推导为 `wss://<origin>/v1/remote-access/relay`；Mobile 构建在构建期固化 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL` 和 `VITE_REMOTE_RELAY_WSS_URL`；Platform 监听进程从同一值推导 CORS 允许的 origin 与 `/pair` 链接 origin；`production-env.ts` 强制 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 共享同一个 HTTPS origin，且回调路径为 `/v1/account/oauth/github/callback`。已安装的 Desktop 客户端与已发布的 Mobile 构建携带旧 origin，而 GitHub OAuth App 的回调 URL 注册在仓库之外。

#480 记录了当前 ALB/TLS 边界以 `net_error -101` 拒绝 Android System WebView 83。切换会替换该边界上呈现的 TLS 证书，因此 #480 的诊断必须对照新域名证书重新验证，不能作为证据或阻碍直接沿用。#415 跟踪一条发布列车对齐，需等其自身发布证据完成后才关闭。

用户还明确要求以足够服务运行的最低配置按月（包月）订阅 ECS，并降低包括负载均衡在内的其他云成本，因此迁移方案必须携带必需的成本右尺寸依赖，而不是假设当前拓扑——ALB 之后的两个 ECS 实例——固定不变。成本决策不可触碰的是持久基底：身份、数据库与数据。

旧客户端过渡已在代码中验证而非假设。登录 POST 只携带安装身份（`packages/platform/platform-account-client/src/index.ts` —— `beginLogin` 发送 `InstallationLoginIdentity` 与公钥）；服务器用它配置的 `redirect_uri` 与固定回调生成 GitHub `authorizationUrl`（`packages/platform/platform-account-core/src/index.ts` —— `authorizeUrl` 以 `client_id`、环境的 `callbackUrl`、`state` 与 S256 code challenge 构造 `https://github.com/login/oauth/authorize`）；客户端解析器只校验返回的 `authorizationUrl` 的 HTTPS scheme（`packages/platform/platform-account/src/parsers.ts` —— `parseLoginAttemptView` 要求 `httpsUrl(record.authorizationUrl)`）。推论：只要两个主机名带着同一身份到达同一后端，旧客户端可以在旧主机名上继续 POST 登录尝试并轮询，而服务器发出新域名的 OAuth 回调；Environment 的 origin 变更不会关停旧主机名；也不需要第二个 OAuth App。

## 提案

通过下述分阶段序列，将运营 Platform 切换到 `https://www.beikejiedeliulangmao.top` 并支持裸域（`beikejiedeliulangmao.top`）。用户已确认以 www 为规范 origin，且已同时授权域名部署与正式的 Desktop/Mobile 重新发布；这些工作无需每步重新征求整体批准。仍需基于各自具体证据等待用户显式批准的范围更窄：所选 ECS 形态的具体待定报价与采购，以及其他报价支出（续费、计费模式变更）、破坏性资源变更（释放、删除、数据存储移除）和高可用性取舍。用户现已显式选定目标架构——两台按月订阅的 `ecs.e-c1m2.large`（2 vCPU、4 GiB）实例，保留 RDS 与 Redis 并优化其计费，负载均衡以双节点形态保留并优化成本；单节点替代方案经评估未被选择。本说明与其 PR 不执行任何变更：各阶段是授权执行遵循的持久计划，且在确认经过验证的成本方案之前所有云上工作保持只读。

切换后的规范权威：

- Environment `production` 的 `PLATFORM_ORIGIN` 变为 `https://www.beikejiedeliulangmao.top`；`PLATFORM_GITHUB_CALLBACK` 变为 `https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback`。
- Environment `desktop-release` 更新同两个名称 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK`——Desktop 配置投影读取的是 `PLATFORM_*` 名称而非 `VITE_*`。Environment `mobile-release` 将 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL` 与 `VITE_REMOTE_RELAY_WSS_URL` 更新为同一 www origin，并保持 `VITE_REMOTE_RELAY_WSS_URL = wss://www.beikejiedeliulangmao.top/v1/remote-access/relay` 与 Desktop 推导的 relay 地址一致。
- GitHub OAuth App（client id `Ov23lip9LTmnFuFpFeeV`）的回调 URL 重新注册到新回调路径。该 App 区别于仓库的自动化 GitHub Apps，不被替换；经代码验证的过渡不需要第二个 OAuth App。
- 无条件保留：`PLATFORM_POSTGRES_DATABASE`（数据库身份）、`PLATFORM_IDENTITY_NAMESPACE`、`PLATFORM_TOKEN_SIGNING_KEY`、`PLATFORM_POLLING_SIGNING_KEY` 与全部持久数据。账号、安装、配对与持久状态得以保留，因为为其提供键的身份未变。RDS 与 Redis 保留；仅优化其计费。
- 已选拓扑（用户选择，待验证总额）：两台按月订阅的 `ecs.e-c1m2.large`（2 vCPU、4 GiB）ECS 实例替换现有实例——用户目录价每台每月 47.52，而含磁盘的实际总额有待对照含磁盘的 67.52 数字验证；负载均衡保留双节点并优化成本；单节点经评估未选择。待定报价与采购获得显式批准后，迁移按该形态执行。
- 区域上的三条 TXT 记录及其他所有 DNS 记录逐字保留；仅替换两条旧 A 记录（裸域与 www 的 `120.77.49.2`），并记录变更前的值用于回滚。两个主机名都迁移；规范权威保持为 www origin。此前已停用的 `www.gestaltrun.com` 记录不会被静默重新启用。
- gestaltrun.com 证书保持挂载，旧主机名在旧客户端过渡证据关闭之前持续服务；origin 切换不会退役旧主机名，为其提供服务的身份命名空间保持不变。
- 对高可用性的削减（单实例部署、移除负载均衡层）与每一笔计价采购（新实例、升配、预留或包年包月计费）都逐项以用户显式决策为闸门，且决策发生在只读评估报告实际账单、利用率与报价之后。本说明不授权任何下单、续费、规格变更或破坏性变更。
- 品牌名称、README、历史发布说明及引用 gestaltrun.com 的文档不改名。官网 SEO canonical 默认保持 `https://www.gestaltrun.com/`，等待显式决策，因为 `apps/platform/public/index.html` 及其发现元数据同时服务于两个主机名，过早切换 canonical 会在新域名积累权重之前丢弃已索引的 origin。

裸域行为：裸域主机名获得有效证书与 DNS 可达性，使裸域 HTTPS 不失败，但规范权威是 www origin。裸域是重定向到 www，还是直接提供产品，在 Stage 1 验证中观察现有 ALB 的监听器与证书行为后决定；OAuth POST 回调与 Relay WSS 永远不指向裸域。

## 分阶段切换

Stage 0 —— 冻结并记录（不改生产）。记录当前裸域/www A 值（`120.77.49.2`，TTL 600 秒）、三条 TXT 记录、ALB 监听器 id 及其当前证书、服务器组、ECS 实例 id，以及当前 GitHub OAuth App 回调 URL。重新拉取 `origin/master` 并确认发布列车状态（PR #584 / 计划 0012 选择 Desktop 0.1.16），使本次切换不与该列车交错。

Stage 0.5 —— 成本方案验证（只读，然后待定采购决策）。架构方向已由用户选定：两台按月订阅的 `ecs.e-c1m2.large`（2 vCPU、4 GiB）ECS 实例，保留 RDS 与 Redis 并优化计费，负载均衡保留双节点并优化成本——单节点经评估未选择。本阶段仍以只读方式验证：47.52 的每台目录价对照含磁盘的 67.52 数字，使用户批准的是确认后的含磁盘总额；2 vCPU/4 GiB 形态相对观测负载的利用率匹配；负载均衡与 NAT 的报价降幅；以及 RDS/Redis 计费优化选项。账单报告的分歧已由带时间戳的更正报告在方向上解决——2026-09-05T16:04Z 时余额 +86.52 且 ALB 无财务锁定——取代此前 FinancialLocked/−13.48 的读数；既定规则仍然成立：任何变更前立即进行当前的带时间戳复核，因为账户状态是时敏输入而非既定事实。随后由用户批准具体的待定报价与采购；只有该批准才释放对应的 Stage 1/3 变更——在用户看到并确认具体方案与金额之前，不发生任何计价采购、破坏性资源释放或数据存储删除。负载均衡保留，因此 Stage 1 按原文在监听器上挂载证书；与最初投影相比仅经验证的成本不同。

Stage 1 —— 证书与 DNS（阿里云控制台，经授权操作者，按 Stage 0.5 选定的架构）。保留 ALB 时：签发一张同时覆盖 `beikejiedeliulangmao.top` 与 `www.beikejiedeliulangmao.top` 的 HTTPS 证书（在现有 DNS 上完成 DCV），将其与当前 gestaltrun.com 证书一并挂到现有 ALB HTTPS 监听器（多证书监听器，而非替换），然后仅替换两条旧 A 记录，使裸域与 www 解析到现有 ALB 前端地址。选择了其他前端时：签发同一张证书，按该架构的方案完成终止，并将两个主机名指向它。两种情况都在记录中保留 TXT 记录与 TTL 值。验证：两个名称的权威与公共 DNS 解析、普通客户端对两个名称的 TLS 握手与主机名校验，以及本阶段期间 gestaltrun.com 服务不中断（旧证书仍挂载）。

Stage 2 —— Platform origin 切换（仅 GitHub Environment `production`；暂不部署）。更新 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 变量；重新注册 OAuth App 回调。运行 platform-deploy 的 validate 作业（源码 CLI `production-env-cli.ts` 在任何 ECS apply 之前拒绝不匹配的 origin/回调）。在继续之前，对照仍在运行的旧部署验证新 www origin 上的 `/readyz`。本阶段可通过恢复两个 Environment 变量与 OAuth App 回调 URL 回滚。该切换改变的是新服务端响应所携带的内容：在消费这些变量的部署之后，任一主机名上发起的登录尝试都会收到服务器生成的 `authorizationUrl`，其 `redirect_uri` 是新域名回调，而客户端解析器接受任何 HTTPS 的 `authorizationUrl`。该切换不会让旧主机名停止服务，过渡期间也不创建第二个 OAuth App。切换时刻已在等待中的登录尝试引用切换前的回调；它们可能需要客户端重启以对切换后的流程重新发起，Stage 5 将该重启作为过渡的一部分覆盖，而非服务保证。

gestaltrun.com 上的旧 DNS 记录当前处于 DISABLED 状态 —— 这是本说明之外持有的、未决的刻意状态。本说明不会重新启用它们：对该状态的任何改变都是单独的显式用户决策并有其自身记录。在旧主机名保持停用期间，旧客户端无法直接访问 Platform；Desktop 更新器独立于 Platform origin（它通过 GitHub Releases 更新），因此即使旧 DNS 停用，已安装的旧 origin Desktop 仍可更新到重发布版本并由此采用新 origin。

Stage 3 —— Platform 部署（受保护工作流，显式批准，按所选架构执行）。本阶段包含已批准的向两台按月 `ecs.e-c1m2.large` 实例的 ECS 替换：platform-deploy 派发以候选 SHA 对新实例对执行，在新实例加入服务器组后保留工作流已拥有的双实例滚动替换、回滚记录与附件存储切换。验证新 origin 上的账号登录与新 origin 上的 Relay WSS。旧客户端行为在 Stage 5 验证，不在此处假设：仍指向 gestaltrun.com 的已安装客户端会继续到达双证书前端，但其登录是否完成是 Stage 5 的证据问题，不是 Stage 3 的断言。

Stage 4 —— 客户端重发布（从一个经评审候选发布正式 Desktop 与 Mobile）。在 `master` 上通过新的 Product Release Plan 提升 Desktop 与 Mobile 版本；新 origin 在该候选上固化进 Desktop 运营配置与两个 Mobile 构建。Desktop 经 desktop-release 发布（签名、公证、`--latest`）。用户的正式 Mobile 诉求是面向 Mobile 用户的产品分发，工作流将其拆为两个分别取证的渠道：签名 Android APK 作为持久的产品分发，以及 iOS TestFlight 上传作为独立的受闸步骤，仅当请求过 `upload_testflight` 且存在已校验构建号时才报告为已发布。任一渠道单独都不满足正式诉求：仅 GitHub 预发布不构成正式 Mobile 发布，而 TestFlight 上传是独立的产品分发闸门，不是对诉求的降级。任何 Mobile 发布之前，从物理 Android 路径（WebView，而非仅桌面浏览器）验证新域名的 TLS/就绪，因为 #480 的故障正发生在那里。

Stage 5 —— 物理验收与旧客户端过渡证据。手机侧：有效 TLS、全新 GitHub 登录准备、同账号认证、WSS 附件、显式链接配对、Remote Online、手机侧发起的 ping/pong —— 保留用户设备与 Desktop 实例，并通过 `gif-assets` 发布脱敏证据。Desktop 侧：通过 GitHub 更新器（其可达性独立于 Platform origin）将一台安装了旧 origin 的构建更新到新版本，并确认重发布渠道。旧客户端过渡在此处基于已验证的机制证明，先于任何旧证书退役：一台安装了旧 origin 的客户端在旧主机名上（当旧 DNS 启用时）POST 登录并轮询，完成服务器生成的新域名回调对应的 OAuth 流程；否则该发现被记录为过渡缺口，阻止 Stage 4 声称一次不破坏性的重发布。切换后未能完成的切换前挂起登录尝试由客户端重启重新发起处理，且该重启要求被记录为过渡证据。gestaltrun.com 证书保持挂载、其命名空间不变，直至该证据关闭；只有显式的后续决策才会摘除它。各阶段回滚：Stage 1 恢复旧 A 值并摘除新证书；Stage 2 恢复两个 Environment 变量与 OAuth App 回调；Stage 3 使用工作流自身的回滚记录；Stage 4 不下架旧版本 —— 旧安装包仍是有效的下载目标，回滚方式是重指 origin 变量并从上一候选重新发布。

## 与进行中发布列车的排序

PR #584 携带选择 Desktop 0.1.16 的 Product Release Plan 0012（分支 `automation/product-release`），已只读核验其 head 为 `3ac00a04805a3415b68a8d4e69d5c45af816c4f3`（OPEN，Draft）。本规范不修改该 PR，且本分支的规划对照其状态协调，不依赖其 head 移动。排序规则是账本碰撞而非版本依赖：本切换的 Product Release Plan（Stage 4）仅在计划 0012 合并或被显式处置后才在 `master` 上创建，因为两个开放计划会争夺 `product-releases/` 的 `nextSequence` 与发布意图账本。在该规则之外，版本序列保持灵活 —— 此处不要求 Desktop 重发布必须构建在 0.1.16 之上，本任务也不会因为一条无关建议而派发 #584 的发布：任何发布派发都由持有该决策的人对照最新的发布列车状态协调，以避免不必要的付费或发布变更。Platform-deploy 派发（Stage 3）不与仅 Desktop 的计划冲突；若 0012 已提升 Desktop，Stage 3 可在 Stage 4 的计划合并之前或之后运行，但 mobile 验收运行（Stage 4）必须绑定到确切的新域名候选 SHA。

## 备选方案

**等 gestaltrun.com 备案完成后继续使用它。** 否决：备案时间线无界，用户已明确批准迁移，期间生产服务带有备案风险。

**不移动 `PLATFORM_ORIGIN`，仅代理或重定向新域名。** 否决：OAuth 回调与 Relay WSS 必须终止在客户端与监听进程实际校验的 origin 上；无差别重定向 OAuth POST 或 WSS 会同时破坏两者，且议题明确禁止。

**替换而非追加第二张 ALB 证书。** 在保留 ALB 的前提下否决：多证书挂载让 gestaltrun.com 在灰度期间以及旧客户端回调过渡证据未决期间持续服务，回滚计划与旧客户端群体都依赖这一点；旧证书仅在 Stage 5 证据关闭后由显式的后续决策摘除。成本右尺寸仍可能选择没有这张 ALB 的架构；那是 Stage 0.5 的用户决策，不是本条灰度规则。

**把当前双实例/ALB 架构视为固定。** 作为规划默认被否决，并已由显式用户选择解决：成本诉求打开了架构决策，单节点替代方案经评估未被选择，用户选定两台更小的按月 `ecs.e-c1m2.large` 实例、保留双节点负载均衡并优化 RDS/Redis 计费。无条件的数据库/身份/数据保留与对待定报价/采购的显式闸门仍是制衡。

**把 `PLATFORM_ORIGIN` 指向裸域。** 否决：www 主机名是签发的规范权威；裸域支持的存在是为了让裸域 HTTPS 不失败，而不是第二个权威。两个 origin 会让 CORS 与回调面翻倍且无收益。

**把品牌表面与历史文档改名为新域名。** 否决：这次变更是 origin 迁移而非改品牌；品牌名称与历史 URL 保持不变。官网 canonical 保持 gestaltrun.com，等待显式 SEO 决策，此处记录为未决而非静默切换。

**在 Platform 服务新 origin 之前重发布客户端。** 否决：固化的客户端权威必须指向已通过 `/readyz` 与登录的 origin，否则每个升级后的安装在首次运行即损坏。

## 验收标准

- 成本方案在变更前经只读验证并记录：对账 47.52 目录价与含磁盘 67.52 数字后的确认含磁盘每台总额、2 vCPU/4 GiB 形态的利用率匹配、双节点负载均衡与 NAT 的报价降幅、RDS/Redis 计费优化；所选双 `ecs.e-c1m2.large` 拓扑连同选定它的用户决策一并记录，且任何变更前立即进行当前的带时间戳账单复核（2026-09-05T16:04Z 的更正报告显示余额 +86.52 且 ALB 无锁定）。
- 一张同时覆盖裸域与 `www.beikejiedeliulangmao.top` 的有效 HTTPS 证书终止在所选前端上；无论成本决策选择哪种架构，现有 Platform 身份、数据库、签名密钥、命名空间与账号全部保留（不新建身份体系，不更换密钥）。
- 裸域与 www 通过 Stage 1 选定的阿里云 DNS 机制公共解析；三条 TXT 记录及所有无关 DNS 记录逐字保留；旧 A 记录值已记录用于回滚；两个名称的证书主机名校验通过。
- Environment `production` 的 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK`、运营 Desktop 配置及 Mobile 构建变量全部指向 `https://www.beikejiedeliulangmao.top` 且回调路径固定；WSS 与 `/pair` 链接由该 origin 推导；OAuth App `Ov23lip9LTmnFuFpFeeV` 的回调与之匹配。
- 新的正式 Desktop 与 Mobile 版本从一个经评审候选发布：Desktop 附签名/公证安装包与 `--latest` GitHub Release；Mobile 附绑定候选的验收运行，且两条产品分发渠道分别取证 —— 签名 APK 作为持久分发，TestFlight 仅在请求过上传且存在已校验构建号时报告为已发布。正式 Mobile 诉求只能由用户实际需要的渠道证据满足，绝不仅凭 APK 预发布。各单元分别校验发布清单、签名产物、更新渠道与固化权威。
- 正式 Mobile 发布前，物理 Android 验收在新域名通过：TLS、GitHub 登录准备、同账号认证、WSS、显式链接配对、Remote Online、手机侧发起的 ping/pong；保留用户设备与 Desktop 实例；通过 `gif-assets` 发布脱敏证据。
- 旧客户端过渡与回滚得到演示而非假设：一台安装了旧 origin Desktop 的设备经独立于 origin 的 GitHub 更新器更新到重发布渠道；一台安装了旧 origin 的客户端在旧主机名上（当旧 DNS 启用时）POST 登录并轮询，完成服务器生成的新域名回调对应的 OAuth；需要客户端重启的切换前挂起尝试被如实记录；每一阶段的回滚路径连同确切的变更前值一并记录。gestaltrun.com 证书保持挂载、其命名空间不变，直至该证据关闭。
- 当前处于 DISABLED 的旧 DNS 记录不会被本次变更隐式重新启用；对该状态的任何改变都是单独的显式用户决策。
- 除非用户显式决定，官网 SEO canonical 保持 `https://www.gestaltrun.com/`；品牌名称与历史文档不变。
- 本次变更不关闭 #480 与 #415；#480 的 ALB/TLS 诊断对照新证书与其自身证据重新验证，#415 仅凭其自身发布证据关闭。

## 风险

- 600 秒的 DNS TTL 限定但不消除传播重叠：两个名称可能在 OAuth App 回调只接受一个 origin 的窗口内同时解析。阶段顺序（先证书与 DNS，后 Environment 切换）使每个区间都可服务。
- 旧客户端登录连续性依赖两个主机名带着同一身份到达同一后端，这是已验证机制的前提；Stage 0.5 中选出的前端或身份变更若破坏该配对，即使旧主机名仍在服务，也会破坏旧客户端的登录完成。切换时刻挂起的登录尝试引用切换前的回调，在客户端重启并重新发起之前可能无法完成；重启是被记录的过渡步骤，而非静默损失。
- 旧 gestaltrun.com DNS 记录的 DISABLED 状态是本说明之外持有的未决刻意决策：其持续期间，旧客户端没有直接的 Platform 路径，只有独立于 origin 的 Desktop 更新器能把旧安装带到重发布版本。任何阶段都不隐含重新启用，需要其自身的显式决策。
- 成本诉求下选出的更便宜形态可能把高可用性降到双实例/ALB 基线以下：单实例服务意味着部署期间与实例故障时的停机。本说明不选择这一取舍；它只把决策路由到显式用户闸门，并由部署证据记录放弃了哪些 HA。
- 互相矛盾的账单报告已由带时间戳的更正报告（2026-09-05T16:04Z，余额 +86.52，ALB 无财务锁定）在方向上解决，取代此前 FinancialLocked/−13.48 的读数；持久规则是账户状态属于时敏输入，因此任何变更前立即进行当前的带时间戳复核，而非把任何单一报告当作既定事实。
- 2 vCPU/4 GiB 的 `e-c1m2.large` 形态小于现有实例，其充分性在 Stage 0.5 对照观测利用率核验之前是待验证假设而非度量；在含磁盘总额确认之前，47.52 的目录价不是采购金额。形态误配会在替换后表现为服务降级，滚动替换可限制但不消除该影响。
- 物理 Android WebView 路径（#480）可能因不同于旧诊断的原因在新证书上失败；Stage 4 以该路径为发布闸门，因此风险是重发布受阻，而非已发布构建损坏。
- 两个主机名提供同一产品页会分割 SEO 权重；默认 canonical 保住已索引 origin，代价是新域名积累权重更慢。
- 保留身份意味着保留影响面：一次失败的 Stage 3 部署触及与旧域名相同的持久状态。双实例滚动替换与工作流的回滚记录在实例替换过程中持有这一点；此处不新增机制。
- 多证书监听器在 ALB 上有配额与匹配顺序行为；Stage 1 验证在切 DNS 之前观察实际监听器状态，计划不假设超出该观察所确认的 SNI 行为。
