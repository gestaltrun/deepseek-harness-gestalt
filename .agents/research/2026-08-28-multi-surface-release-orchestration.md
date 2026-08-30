# DSH 多端版本与发布编排调研

日期：2026-08-28

## 结论

DSH 应把 Desktop、Mobile 和 Platform 视为三个独立发布单元，保留各自版本和渠道，但由一份仓库内、可审查的发布计划统一判断本次要发布哪些端。版本与影响判断不应存在于技能提示词或 GitHub Actions YAML 条件中；它们应由有测试的仓库脚本读取明确的 PR 发布意图、工作区依赖图和少量跨端输入映射后生成。GitHub Actions 只负责在精确提交上构建一次、验证、等待 Environment 审批并把同一份产物推广到外部渠道，技能只负责帮助人执行和解释这套确定性流程。

移动端应补一条独立的 GitHub prerelease。Release 页面直接提供签名 APK、校验和、构建来源与验收链接，并把 iOS 的标准安装入口写成公开 TestFlight 链接 <https://testflight.apple.com/join/pKCZtn7q>。不要把会过期的 Actions artifact 当开源用户的下载页；GitHub 将 workflow artifact 定义为工作流之间和运行结束后的临时构建输出，仓库当前 Mobile workflow 也只保留 30 天，而 GitHub Release 是带标签、说明和二进制资产的正式可发现发布对象。[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) [Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) [仓库 Mobile Release](../../.github/workflows/mobile-release.yml)

不建议现在用 Release Please 替换现有发布实现，也不建议让 Changesets 接管全仓 npm 版本。Release Please 的标准生命周期是合并 release PR 后创建 GitHub Release，但它明确不负责真正发布应用；DSH 在 Release 之前还必须完成签名、原生 smoke、TestFlight、不可变镜像和生产验收。[Release Please design](https://github.com/googleapis/release-please/blob/main/docs/design.md#lifecycle-of-a-release) Changesets 的“每个改动携带发布意图、汇总为版本 PR”模型很适合本问题，并且官方支持私有应用、Docker image 等非 npm 产物，但它以 `package.json` 和全仓 private-package 配置为中心，会和 DSH 已有的 dsh/vendor 独立版本族增加重叠控制面。[Changesets detailed explanation](https://github.com/changesets/changesets/blob/main/docs/detailed-explanation.md) [Changesets non-npm applications](https://github.com/changesets/changesets/blob/main/docs/versioning-apps.md) 建议复用 Changesets 的流程形态，先在现有 `scripts/release/` 体系内实现三个产品发布单元，而不是立即引入第二套全仓版本器。

## 当前仓库的发布单元

| 发布单元 | 当前版本来源 | 当前外部渠道 | 已有可靠部分 | 当前缺口 |
|---|---|---|---|---|
| Desktop | [`apps/desktop/package.json`](../../apps/desktop/package.json) 和逐版本 `release-notes/*.json` | `gestalt-v*` GitHub Release，macOS/Windows updater | 同一 workflow 构建、smoke、上传并核对 Release assets；失败时清理本次创建的 draft/tag | 是否需要发布仍由人判断，版本说明要手工准备 |
| Mobile | `apps/mobile/package.json` 与 Environment 中的 `MOBILE_VERSION`、`MOBILE_BUILD_NUMBER` 并存 | TestFlight；签名 APK/IPA 只在 30 天 Actions artifact 中 | 精确 master SHA、Mobile Acceptance run、签名与 TestFlight 上传已有候选绑定 | GitHub 没有可发现的 Mobile Release；可变 Environment 变量不是可审查版本来源；没有自动 release plan |
| Platform | `apps/platform/package.json`，实际镜像另用 `sha-*`/`latest` | GHCR image，再由生产 deployment workflow 部署 ECS | 镜像构建与生产部署已分离，生产有 Environment 和恢复流程 | 发布影响判断只覆盖一组手写 paths；部署输入允许 `latest`，没有产品版本到不可变 image digest/deployment 的统一记录 |

三个 `apps/*/package.json` 已经分别携带独立版本，说明仓库事实上使用独立版本，而不是一个产品总版本。不要为了“统一流水线”强迫三端每次一起 bump；统一的是 release plan 和证据格式，不是版本号或发布时间。

## GitHub Release 的标准展示

GitHub 将 Release 定义为基于 Git tag、带 release notes 和二进制文件链接的可部署软件迭代；每个 Release 最多可带 1000 个、单个小于 2 GiB 的 assets。[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) 这正适合 Desktop 安装包和 Android APK。Actions artifacts 则默认受保留期约束，可用于 job 间传递、诊断和待推广候选，但不应成为 README 面向用户的稳定下载链接。[Store and share workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data) [Artifact retention](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)

建议每个独立发布单元拥有自己的 tag 和 GitHub Release：

- Desktop 继续使用现有 `gestalt-v<version>`，避免破坏 updater feed 和历史链接。
- Mobile 使用 `mobile-v<version>`，标题同时写明 `<version> (<buildNumber>)`。一个 Marketing Version 只发布一条公开 prerelease；若以后允许同一 Marketing Version 发布多个 build，则从新版本开始统一采用 `mobile-v<version>-build.<buildNumber>`，不能覆盖旧 APK。
- Platform 使用 `platform-v<version>` 记录发布说明和精确 OCI digest；容器本体继续放 GHCR，不再额外把 `platform.tar.gz` 当公共 Release asset。

Mobile GitHub Release 正文建议固定为下面的短结构：

```markdown
## 安装

- iPhone: [通过 TestFlight 安装](https://testflight.apple.com/join/pKCZtn7q)
- Android: 下载本页 Assets 中的 `Gestalt-<version>-<build>.apk`

## 构建身份

- 版本: `<version> (<build>)`
- Application ID / Bundle ID: `com.gestalt.mobile`
- Source: `<exact Git SHA>`
- Acceptance: `<Mobile Companion Acceptance run>`
- Release workflow: `<Mobile Release run>`

## 其他发布单元

| Target | 本次状态 | 入口 |
|---|---|---|
| Desktop | Not included / Released separately | `<latest Desktop Release>` |
| Platform | Not deployed in this release | `<latest production deployment or —>` |

## 校验

- `SHA256SUMS`
- GitHub artifact attestation verification command
```

公开 IPA 不是必要安装入口。TestFlight 官方流程是把 build 添加到 external group，通过审核后用邮件或 public link 邀请测试者；public link 可以开放给所有人或按设备/OS 条件限制，外部测试人数上限为 10,000。[Apple external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers) 因此 GitHub Release 对 iOS 展示 TestFlight 链接和版本/build 状态即可，签名 IPA 可继续作为受限的短期候选证据，不必放到公开 Release。

TestFlight build 最多可供测试 90 天，public link 又会随 external group 中的当前 build 滚动，所以这个链接是长期 beta 渠道，不是历史 GitHub Release 的不可变 iOS 二进制。[Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview) Release 正文必须同时写明当次 version/build，并说明链接现在可能安装更新 build；Android APK 和 SHA-256 才是该 GitHub prerelease 自身固定的可下载资产。

APK 应作为正式 Release asset 上传并在上传后比较本地与远端文件名及 SHA-256，复用 Desktop workflow 已有的 draft → upload → verify → publish 事务顺序。可再为 APK 和 Desktop binaries 生成 GitHub artifact attestation；GitHub 官方支持对 binary 和 container digest 建立 build provenance，并能用 `gh attestation verify` 验证。[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

若仓库启用 immutable releases，GitHub 官方同样建议先创建 draft、上传完整 assets，再发布；发布后的 tag 和 assets 不能继续变更。[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) 因而某次 TestFlight build 或 APK 修复必须使用新 build number 和新 prerelease，不能替换旧 Release 中的同名文件。

Electron updater 需要安装包旁边有平台/架构对应的 release metadata，macOS 自动更新还要求签名。Electron 官方也把公开 GitHub Releases 列为其开源更新服务的前提之一。[Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates) 因此 Desktop Release 的 installers、blockmaps 和 update metadata 必须继续作为一个原子资产集合发布，不能把 Desktop 合并进一个只放说明、不保持 updater 文件约定的 Mobile 或全产品 Release。

## 如何判断哪些端需要发布

只靠 `.github/workflows/*` 的 `paths` 不能成为发布判断权威。GitHub 的 path filter 只回答“要不要创建某个 workflow run”，不理解 pnpm 依赖或协议兼容；官方还说明 filter 使用 push 的 two-dot diff、PR 的 three-dot diff，并受大 diff 文件列表限制。[GitHub workflow path filters](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore) 仓库中 Desktop、Mobile 和 Platform 都依赖 `packages/platform/*`、Remote Access、Remote Protocol、Client UI 或 Host package，单看 `apps/<surface>/**` 会漏掉传递影响。

建议使用“两层证据、失败时宁可要求人确认”的发布影响算法：

1. 每个有产品影响的 PR 增加一份小型 release intent，明确列出 `desktop`、`mobile`、`platform` 各自的 `major | minor | patch | none` 和一段用户可见摘要。纯测试、文档、内部构建改动可以明确写 empty intent，而不是靠没有文件来猜。
2. 仓库脚本从三个 app 的 `package.json` 出发读取 pnpm workspace 依赖闭包，把 diff 中的源码、构建配置、原生项目、打包脚本和 lockfile 映射到可达的 app。再叠加一份很小的非 package 输入表，例如 Desktop/Mobile workflow、Capacitor native project、Platform Dockerfile/部署脚本。
3. CI 比较“计算得到的可能受影响端”和 PR release intent。intent 少报就失败；多报允许，因为产品兼容、运营或重新签名需求无法完全从文件推导。共享协议或鉴权变更若进入三端闭包，默认要求三端 intent，除非一个有理由、可审查的兼容例外证明旧端仍可工作。
4. 合并到 master 后，release planner 汇总尚未消费的 intent；同一端取最高 SemVer bump，生成或更新一条 release PR。人只需要审查版本、说明和将要发布的端，不再手改 Environment 变量。

这套算法让自动化负责发现遗漏，但不让它从文件名武断决定 SemVer。Changesets 官方同样把 changeset 定义为改动发生时记录的发布意图，随后在 version 阶段汇总 bump、更新依赖和 changelog；它还明确说明并非每个改动都需要 release。[Changesets overview](https://github.com/changesets/changesets) [Changesets intro](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)

建议的默认映射如下，最终应由依赖图验证而不是永久复制成大 YAML：

| 变化 | 最小可能影响 |
|---|---|
| `apps/desktop/**`、Desktop 打包/updater workflow | Desktop |
| `apps/mobile/**`、Mobile Acceptance/Release workflow | Mobile |
| `apps/platform/**`、Platform image/deploy 脚本 | Platform |
| 某 app 的 workspace 生产依赖或被打进发行包的 dev/build 依赖 | 所有可达 app |
| Remote Protocol、Platform Account、Remote Access 等跨端 wire/API 变更 | 至少协议生产者和消费者，通常 Desktop + Mobile + Platform |
| 仅 docs/tests 且没有进入发行物 | empty intent |
| root lockfile、构建器、Node/Electron/Capacitor/Gradle/Xcode 输入 | 由可达依赖和打包输入决定；无法证明时要求显式选择 |

## 自动版本、release PR 与审批

版本号应由 release PR 自动改写并提交到仓库，CI 只读取，不在发布运行中临时算出或写回。这个原则与仓库现有 npm release 注释“版本可从仓库读取、CI 不写仓库”一致。[现有 bump 实现](../../scripts/release/bump.ts)

建议新增一份 source-owned product release manifest，或者让三个 app 的 `package.json` 加上一份 Mobile build-number 文件成为唯一版本来源：

- Desktop：SemVer 继续写 `apps/desktop/package.json`，release PR 同时生成下一份 Desktop release-notes manifest。
- Mobile：用户版本写 `apps/mobile/package.json`；`CFBundleShortVersionString` 与 Android `versionName` 从这里读取。独立 build number 写入受测的仓库文件，release PR 自动递增；它同时投影到 iOS `CFBundleVersion` 和 Android `versionCode`。
- Platform：SemVer 写 `apps/platform/package.json`；发布时把该版本、Git SHA 和最终 OCI digest 一起记录，生产部署只接受 digest 或唯一的 `sha-*` tag，不接受可移动的 `latest` 作为晋级身份。

Android 官方要求每次后续发布使用更高的正整数 `versionCode`，而 `versionName` 才是用户看到的版本。[Android app versioning](https://developer.android.com/studio/publish/versioning) Apple 把 `CFBundleVersion` 定义为标识一次 bundle 迭代的 build version，并用 `CFBundleShortVersionString` 表示用户版本；对 iOS，同一 app version 下每次上传必须有唯一的 version/build 组合。[Apple CFBundleVersion](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion) [Apple build numbers](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds) 因此可以让 iOS build number 与 Android `versionCode` 共用一个单调整数，但不能把它当 SemVer，也不能只存在于 GitHub Environment variable。

Release PR 是“这次发布什么、版本是什么、说明是什么”的人工审批点，但不应自动授权所有外部副作用。建议按风险设置 Environment：

| 阶段 | 自动执行 | 人工审批 |
|---|---|---|
| release intent 校验、版本 PR 生成、普通 CI | 是 | PR review/merge 审查版本和说明 |
| 候选构建、keyless tests、无密钥 smoke | 是 | 无 |
| Desktop 签名/公证、Mobile 签名、TestFlight 上传、GitHub Release 发布 | 在 exact release-plan SHA 上执行 | `desktop-release` / `mobile-release` Environment required reviewer |
| Platform image build/push | 自动生成 exact SHA tag 和 digest | 可不需要生产审批 |
| Platform production deploy | 只推广已验证 digest | `production` Environment required reviewer，禁止自审时由另一维护者批准 |

GitHub Environments 原生支持 required reviewers、禁止自审、branch/tag restrictions，并且 Environment secrets 在批准前不可用。[GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) 这比把“用户同意过”永久写入技能更可审计。测试或内部 beta 可以按仓库政策降低审批，但生产 Platform 和公开签名发布应保持可见的 Environment 审批。

## 流水线结构

建议用一个确定性的 planner 加三个 reusable workflow，而不是一个巨大 workflow 或多层 `workflow_run` 链：

```text
ordinary PR
  -> release-intent check (intent vs dependency impact)
  -> merge to master
  -> release planner opens/updates Product Release PR
  -> maintainer reviews versions + notes + selected surfaces
  -> merge exact release-plan commit
      -> plan job emits desktop/mobile/platform booleans + versions
      -> desktop reusable workflow: package -> smoke -> approve -> GitHub Release
      -> mobile reusable workflow: acceptance -> sign -> approve -> TestFlight + GitHub prerelease
      -> platform reusable workflow: build/push digest -> approve -> rolling deploy
  -> final manifest records tags, run ids, digests and deployment state
```

GitHub reusable workflows 用 `on.workflow_call` 声明类型化 inputs、secrets 和 outputs，调用方用 job-level `uses`，适合保留 Desktop/Mobile/Platform 各自独立而经过验证的工作流，同时由一个 orchestrator 选择调用。[GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) 不建议把主流程拆成四五层 `workflow_run`；GitHub 限制这种链最多三层，并提醒后续有 secrets/write token 的 workflow 不要直接信任前一层不可信 artifact。[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)

每条 lane 都应遵循 build once, promote exact artifact：候选 job 输出 SHA-256/digest 和 metadata；发布 job 下载同一 workflow 的候选，复验身份后推广，不在审批后从移动的 master 或 `latest` 重建。Desktop 当前已接近这个模型。Mobile 应让创建 GitHub prerelease 的 job 下载同一 run 的签名 APK；Platform 应把 `docker/build-push-action` 的 digest 传给 deploy，而不是把 `latest` 传下去。

## 技能、Actions 和仓库代码的职责

| 位置 | 应负责 | 不应负责 |
|---|---|---|
| 仓库代码 | release intent schema；依赖/影响计算；版本 bump；release note/asset manifest；候选身份和兼容校验；单元测试 | 读取生产 secret；点击审批；凭自然语言猜测本次发布端 |
| GitHub Actions | 在 exact SHA 上调用仓库脚本；并行构建；保存候选；Environment 审批；签名、上传、GitHub Release、GHCR 和部署；记录 run/deployment evidence | 在 YAML 中复制依赖图；用 paths 当发布权威；运行时悄悄修改版本；用 `latest` 代表已审批候选 |
| Agent skill | 引导创建 release intent；解释 planner 结果；选择最小验证；检查审批和失败恢复；汇总链接与状态 | 保存版本号、build number 或发布状态；绕过 Environment；替代确定性影响分析 |

因此主改动是仓库代码和 GitHub Actions。现有 `orchestrate-dsh-delivery` / `dsh-pre-push-checks` 技能随后只需增加两项操作说明：产品 PR 必须通过 release-intent check；release PR 合并后要读取 orchestrator 输出并分别报告三端状态。先改技能无法修复当前“Mobile artifact 30 天后消失、版本藏在 Environment、Platform 是否发布靠人记忆”的结构问题。

## 渐进落地顺序

### 第 1 步：补齐本次 Mobile GitHub prerelease

从已经成功并绑定到同一 candidate SHA 的 Mobile Release run 下载签名 APK，复验 `com.gestalt.mobile`、版本 `0.1.0`、build/versionCode `5`、签名和 SHA-256；在该 SHA 创建 [`mobile-v0.1.0`](https://github.com/gestaltrun/deepseek-harness-gestalt/releases/tag/mobile-v0.1.0) prerelease，上传 APK 与 `SHA256SUMS`，正文放 TestFlight public link、Acceptance run 和 Release run。不要从 master 重建，也不要把 30 天 artifact URL 当 Release 链接。

### 第 2 步：让未来 Mobile workflow 原生发布 GitHub Release

给 `mobile-release.yml` 增加一个依赖 Android、iOS 成功的 publish job。它下载本次 APK，渲染 release notes，先建 draft prerelease，上传并比对资产与 hash，再 publish；iOS 只显示 TestFlight URL 和 build 状态。把 `MOBILE_VERSION`、`MOBILE_BUILD_NUMBER` 从 Environment variable 迁到仓库版本文件，Environment 只保留渠道配置和 secrets。

### 第 3 步：实现产品 release intent 与影响检查

在 `scripts/release/` 增加三个 app 的依赖闭包和非 package 输入映射，定义 release intent 文件，添加 PR check 和 invalid cases。先只提示漏报，再转为 required check；历史 npm dsh/vendor release family 不变。

### 第 4 步：生成 Product Release PR

master 上有未消费 intent 时自动创建或更新 release PR，按端汇总最高 bump、修改 package version、Mobile build number 和 release notes。Release PR 合并是版本决定，不直接等同于生产部署批准。

### 第 5 步：抽 reusable workflows 与统一 orchestrator

把现有 Desktop/Mobile/Platform workflow 逐个增加 `workflow_call`，保持原手动入口作为恢复通道。统一 orchestrator 读取 exact release plan，只调用选中的端；三个 protected environments 各自审批和恢复，最终产出一份包含 tag、Release URL、TestFlight build、image digest、deployment run 的机器可读结果。

## 需要单独决定的策略

- Mobile TestFlight build 是否每次都同时发布 Android APK。默认建议是“同一 Mobile product build 同时发布”，若只修 iOS 原生层则 release intent 需要允许 `mobile-ios-only`，但仍共用 Mobile 用户版本并独立递增 build number。
- Platform 版本是否在“镜像已推送”还是“生产已部署”时算 released。建议 GitHub `platform-v*` Release 在 image digest 验证后可创建为 prerelease，生产部署成功后转 stable 或写 deployment status；不要把未经部署的镜像描述为生产已发布。
- 是否引入完整 Changesets。只有当仓库希望所有 npm/private app 都统一为 changeset 管理时再评估；当前更小的方案是复用其 intent/version-PR 模型，并保留已验证的 DSH 自有 release family。

## 最终建议

本次 Mobile `0.1.0 (5)` 已发布为 GitHub prerelease，并把 TestFlight 公测链接作为 iOS 的首要安装入口。后续实现由 [Issue #414](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/414) 跟踪，按“source-owned release intent + tested impact planner + generated release PR + reusable surface workflows + protected promotion”实施。这个方案能让后续每次发布自动回答 Desktop、Mobile、Platform 哪些需要发布并自动生成版本修改，同时把最终签名、TestFlight 和生产部署保留在 GitHub 可审计的人工审批点。
