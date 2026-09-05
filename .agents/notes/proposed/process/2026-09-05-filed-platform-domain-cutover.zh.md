# Agent Note: 备案域名 Platform 切换至 beikejiedeliulangmao.top

Status: proposed

[English](2026-09-05-filed-platform-domain-cutover.md) | 中文

## 问题

运营中的 Platform 通过一个 ALB HTTPS 监听器在 `https://www.gestaltrun.com/` 上提供 `apps/platform/public` 的内容，而 gestaltrun.com 的 ICP 备案仍在进行中。运营该部署的已认证阿里云账号下，备案域名 `beikejiedeliulangmao.top` 已以 辽ICP备19017854号-1 获批。在 origin 迁到备案域名之前，中国大陆的生产服务在当前名称上带有备案风险。

迁移 origin 不是一次 DNS 编辑。Environment `production` 的 `PLATFORM_ORIGIN` 是 Desktop 配置生成器、Mobile 构建和 Platform 监听进程共同推导身份的输入：Desktop 配置生成器把 Relay WSS 地址推导为 `wss://<origin>/v1/remote-access/relay`；Mobile 构建在构建期固化 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL` 和 `VITE_REMOTE_RELAY_WSS_URL`；Platform 监听进程从同一值推导 CORS 允许的 origin 与 `/pair` 链接 origin；`production-env.ts` 强制 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 共享同一个 HTTPS origin，且回调路径为 `/v1/account/oauth/github/callback`。已安装的 Desktop 客户端与已发布的 Mobile 构建携带旧 origin，而 GitHub OAuth App 的回调 URL 注册在仓库之外。

#480 记录了当前 ALB/TLS 边界以 `net_error -101` 拒绝 Android System WebView 83。切换会替换该边界上呈现的 TLS 证书，因此 #480 的诊断必须对照新域名证书重新验证，不能作为证据或阻碍直接沿用。#415 跟踪一条发布列车对齐，需等其自身发布证据完成后才关闭。

## 提案

通过下述分阶段序列，将运营 Platform 切换到 `https://www.beikejiedeliulangmao.top` 并支持裸域（`beikejiedeliulangmao.top`）。用户已批准替换两条旧 DNS A 记录（`120.77.49.2`）以及正式的 Desktop/Mobile 重新发布，但本说明与其 PR 不执行任何变更：以下全部步骤是由另行授权的发布执行的持久计划。

切换后的规范权威：

- Environment `production` 的 `PLATFORM_ORIGIN` 变为 `https://www.beikejiedeliulangmao.top`；`PLATFORM_GITHUB_CALLBACK` 变为 `https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback`。
- Environment `desktop-release` 与 `mobile-release` 将 `VITE_PLATFORM_ORIGIN` / `VITE_PLATFORM_CALLBACK_URL` / `VITE_REMOTE_RELAY_WSS_URL` 集合更新为同一 www origin，并保持 `VITE_REMOTE_RELAY_WSS_URL = wss://www.beikejiedeliulangmao.top/v1/remote-access/relay` 与 Desktop 推导的 relay 地址一致。
- GitHub OAuth App（client id `Ov23lip9LTmnFuFpFeeV`）的回调 URL 重新注册到新回调路径。该 App 区别于仓库的自动化 GitHub Apps，不被替换。
- 完全不变的是：`PLATFORM_POSTGRES_DATABASE`（数据库身份）、`PLATFORM_IDENTITY_NAMESPACE`、`PLATFORM_TOKEN_SIGNING_KEY`、`PLATFORM_POLLING_SIGNING_KEY`、两台 ECS 实例、ALB 服务器组及其余全部生产名称。账号、安装、配对与持久状态得以保留，因为为其提供键的身份未变。
- 区域上的三条 TXT 记录及其他所有 DNS 记录逐字保留；仅替换两条旧 A 记录（裸域与 www 的 `120.77.49.2`），并记录变更前的值用于回滚。
- 品牌名称、README、历史发布说明及引用 gestaltrun.com 的文档不改名。官网 SEO canonical 默认保持 `https://www.gestaltrun.com/`，等待显式决策，因为 `apps/platform/public/index.html` 及其发现元数据同时服务于两个主机名，过早切换 canonical 会在新域名积累权重之前丢弃已索引的 origin。

裸域行为：裸域主机名获得有效证书与 DNS 可达性，使裸域 HTTPS 不失败，但规范权威是 www origin。裸域是重定向到 www，还是直接提供产品，在 Stage 1 验证中观察现有 ALB 的监听器与证书行为后决定；OAuth POST 回调与 Relay WSS 永远不指向裸域。

## 分阶段切换

Stage 0 —— 冻结并记录（不改生产）。记录当前裸域/www A 值（`120.77.49.2`，TTL 600 秒）、三条 TXT 记录、ALB 监听器 id 及其当前证书、服务器组、ECS 实例 id，以及当前 GitHub OAuth App 回调 URL。重新拉取 `origin/master` 并确认发布列车状态（PR #584 / 计划 0012 选择 Desktop 0.1.16），使本次切换不与该列车交错。

Stage 1 —— 证书与 DNS（阿里云控制台，经授权操作者）。签发一张同时覆盖 `beikejiedeliulangmao.top` 与 `www.beikejiedeliulangmao.top` 的 HTTPS 证书（在现有 DNS 上完成 DCV），将其与当前 gestaltrun.com 证书一并挂到现有 ALB HTTPS 监听器（多证书监听器，而非替换），然后在新区域上仅替换两条旧 A 记录，使裸域与 www 解析到现有 ALB 前端地址。在记录中保留 TXT 记录与 TTL 值。验证：两个名称的权威与公共 DNS 解析、普通客户端对两个名称的 TLS 握手与主机名校验，以及本阶段期间 gestaltrun.com 服务不中断（旧证书仍挂载）。

Stage 2 —— Platform origin 切换（仅 GitHub Environment `production`；暂不部署）。更新 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK` 变量；重新注册 OAuth App 回调。运行 platform-deploy 的 validate 作业（源码 CLI `production-env-cli.ts` 在任何 ECS apply 之前拒绝不匹配的 origin/回调）。在继续之前，对照仍在运行的旧部署验证新 www origin 上的 `/readyz`。本阶段可通过恢复两个 Environment 变量与 OAuth App 回调 URL 回滚。

Stage 3 —— Platform 部署（受保护工作流，显式批准）。以候选 SHA 派发 platform-deploy，保留工作流已拥有的 ECS 双实例滚动替换、回滚记录与附件存储切换。验证新 origin 上的账号登录、旧客户端行为（仍指向 gestaltrun.com 的已安装客户端在其自行更新前保持可用），以及新 origin 上的 Relay WSS。

Stage 4 —— 客户端重发布（从一个经评审候选发布正式 Desktop 与 Mobile）。在 `master` 上通过新的 Product Release Plan 提升 Desktop 与 Mobile 版本；新 origin 在该候选上固化进 Desktop 运营配置与两个 Mobile 构建。Desktop 经 desktop-release 发布（签名、公证、`--latest`）。Mobile 需要一次绑定候选的 Mobile Companion Acceptance 运行，将签名 APK 发布为持久的 GitHub 预发布，并且只有当请求过 `upload_testflight` 且存在已校验的构建号时才把 TestFlight 报告为已发布；仅 GitHub 预发布不构成正式 Mobile 发布。任何 Mobile 发布之前，从物理 Android 路径（WebView，而非仅桌面浏览器）验证新域名的 TLS/就绪，因为 #480 的故障正发生在那里。

Stage 5 —— 物理验收与稳定。手机侧：有效 TLS、全新 GitHub 登录准备、同账号认证、WSS 附件、显式链接配对、Remote Online、手机侧发起的 ping/pong —— 保留用户设备与 Desktop 实例，并通过 `gif-assets` 发布脱敏证据。Desktop 侧：从已安装的旧 origin 构建更新到新版本并确认重发布渠道。各阶段回滚：Stage 1 恢复旧 A 值并摘除新证书；Stage 2 恢复两个 Environment 变量与 OAuth App 回调；Stage 3 使用工作流自身的回滚记录；Stage 4 不下架旧版本 —— 旧安装包仍是有效的下载目标，回滚方式是重指 origin 变量并从上一候选重新发布。

## 与进行中发布列车的排序

PR #584 携带选择 Desktop 0.1.16 的 Product Release Plan 0012（分支 `automation/product-release`）。本规范不修改该 PR。无碰撞规则：本切换的 Product Release Plan（Stage 4）仅在计划 0012 合并或被显式处置后才在 `master` 上创建，因为两个开放计划会争夺 `product-releases/` 的 `nextSequence` 与发布意图账本，且 Desktop 重发布应构建在 0.1.16 的更新器修复之上而非先于它。Platform-deploy 派发（Stage 3）不与仅 Desktop 的计划冲突；若 0012 已提升 Desktop，Stage 3 可在 Stage 4 的计划合并之前或之后运行，但 mobile 验收运行（Stage 4）必须绑定到确切的新域名候选 SHA。

## 备选方案

**等 gestaltrun.com 备案完成后继续使用它。** 否决：备案时间线无界，用户已明确批准迁移，期间生产服务带有备案风险。

**不移动 `PLATFORM_ORIGIN`，仅代理或重定向新域名。** 否决：OAuth 回调与 Relay WSS 必须终止在客户端与监听进程实际校验的 origin 上；无差别重定向 OAuth POST 或 WSS 会同时破坏两者，且议题明确禁止。

**替换而非追加第二张 ALB 证书。** 在 Stage 1 否决：多证书挂载让 gestaltrun.com 在灰度期间持续服务，回滚计划依赖这一点；旧证书仅在 Stage 5 稳定后摘除。

**把 `PLATFORM_ORIGIN` 指向裸域。** 否决：www 主机名是签发的规范权威；裸域支持的存在是为了让裸域 HTTPS 不失败，而不是第二个权威。两个 origin 会让 CORS 与回调面翻倍且无收益。

**把品牌表面与历史文档改名为新域名。** 否决：这次变更是 origin 迁移而非改品牌；品牌名称与历史 URL 保持不变。官网 canonical 保持 gestaltrun.com，等待显式 SEO 决策，此处记录为未决而非静默切换。

**在 Platform 服务新 origin 之前重发布客户端。** 否决：固化的客户端权威必须指向已通过 `/readyz` 与登录的 origin，否则每个升级后的安装在首次运行即损坏。

## 验收标准

- 一张同时覆盖裸域与 `www.beikejiedeliulangmao.top` 的有效 HTTPS 证书挂载到现有 ALB 监听器；现有 Platform 身份、数据库、签名密钥、命名空间、服务器组、ECS 实例与账号全部保留（不新建身份体系，不更换密钥）。
- 裸域与 www 通过 Stage 1 选定的阿里云 DNS 机制公共解析；三条 TXT 记录及所有无关 DNS 记录逐字保留；旧 A 记录值已记录用于回滚；两个名称的证书主机名校验通过。
- Environment `production` 的 `PLATFORM_ORIGIN` 与 `PLATFORM_GITHUB_CALLBACK`、运营 Desktop 配置及 Mobile 构建变量全部指向 `https://www.beikejiedeliulangmao.top` 且回调路径固定；WSS 与 `/pair` 链接由该 origin 推导；OAuth App `Ov23lip9LTmnFuFpFeeV` 的回调与之匹配。
- 新的正式 Desktop 与 Mobile 版本从一个经评审候选发布：Desktop 附签名/公证安装包与 `--latest` GitHub Release；Mobile 附签名 APK 预发布、绑定候选的验收运行，且 TestFlight 仅在存在已校验构建号时报告为已发布 —— 绝不仅凭预发布声称。各单元分别校验发布清单、签名产物、更新渠道与固化权威。
- 正式 Mobile 发布前，物理 Android 验收在新域名通过：TLS、GitHub 登录准备、同账号认证、WSS、显式链接配对、Remote Online、手机侧发起的 ping/pong；保留用户设备与 Desktop 实例；通过 `gif-assets` 发布脱敏证据。
- 旧客户端过渡与回滚得到演示：一台安装了旧 origin Desktop 的设备更新到重发布渠道；每一阶段的回滚路径连同确切的变更前值一并记录。
- 除非用户显式决定，官网 SEO canonical 保持 `https://www.gestaltrun.com/`；品牌名称与历史文档不变。
- 本次变更不关闭 #480 与 #415；#480 的 ALB/TLS 诊断对照新证书与其自身证据重新验证，#415 仅凭其自身发布证据关闭。

## 风险

- 600 秒的 DNS TTL 限定但不消除传播重叠：两个名称可能在 OAuth App 回调只接受一个 origin 的窗口内同时解析。阶段顺序（先证书与 DNS，后 Environment 切换）使每个区间都可服务。
- 物理 Android WebView 路径（#480）可能因不同于旧诊断的原因在新证书上失败；Stage 4 以该路径为发布闸门，因此风险是重发布受阻，而非已发布构建损坏。
- 两个主机名提供同一产品页会分割 SEO 权重；默认 canonical 保住已索引 origin，代价是新域名积累权重更慢。
- 保留身份意味着保留影响面：一次失败的 Stage 3 部署触及与旧域名相同的生产实例与持久状态。工作流既有的回滚记录与双实例替换持有这一点；此处不新增机制。
- 多证书监听器在 ALB 上有配额与匹配顺序行为；Stage 1 验证在切 DNS 之前观察实际监听器状态，计划不假设超出该观察所确认的 SNI 行为。
