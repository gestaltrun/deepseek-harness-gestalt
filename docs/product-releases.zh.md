# 产品发布

[English](product-releases.md) | 中文

本参考定义 Desktop、Mobile 与 Platform 版本如何从普通 pull request 进入持久公开或生产证据。它不治理相互独立的 dsh、vendor、native 或 Python 发布族。

## 发布单元与版本所有者

Desktop、Mobile 与 Platform 是相互独立的产品发布单元。`apps/desktop/package.json`、`apps/mobile/package.json` 和 `apps/platform/package.json` 分别拥有各自的 SemVer 版本。`apps/mobile/release.json` 另行拥有正数且单调递增的构建号，并把它投影到 Android `versionCode` 与 iOS `CFBundleVersion`。

Desktop 使用 `gestalt-v<version>`，Mobile 使用 `mobile-v<version>`，Platform 使用 `platform-v<version>`。一份 Product Release Plan 可以选择任意子集；它不会强制共享版本或发布日期。

## Pull request 意图与影响校验

每个影响产品的 pull request 都会新增一条符合 `.release-intents/schema.json` 的 `.release-intents/<issue>-<slug>.json` 记录。每个发布单元分别请求 `major`、`minor`、`patch` 或 `none`；`summary.en` 与 `summary.zh` 提供面向用户的双语发布说明。非发布的产品变更会显式地为三个单元全部选择 `none`；只有文档或测试的变更不需要 intent。

`pnpm product-release:validate --base <base> --head <head>` 会比较全部新增、唯一且未消费的 intent 与变更路径、每个 app 的生产/构建依赖闭包，以及显式的原生、打包、工作流、lockfile、部署与 wire-protocol 输入。Pull request 校验通常只看到一条新增记录；merge-group 校验会确定性汇总组内的全部新增记录。修改、删除、重复身份、复用已消费 intent 或少报都会使 CI 失败；保守多报有效。兼容例外会指定一个发布单元和非空的已评审理由；未知生产输入会保守地选中全部单元。

## Product Release PR

Intent 到达 `master` 后，`Product Release Plan` 会运行 `pnpm product-release:prepare --write`，并创建或更新 Draft `automation/product-release` pull request。仓库变量 `DSH_RELEASE_APP_CLIENT_ID` 与 secret `DSH_RELEASE_APP_PRIVATE_KEY` 标识一个对仓库 Contents 和 Pull requests 具有写权限、对 Issues 具有读权限的 GitHub App 安装；与工作流 `GITHUB_TOKEN` 产生的变更不同，它的 commit 与 PR 事件会触发普通 CI。生成器只消费每条已合并 intent 一次，为各发布单元应用最高请求 bump，在选中 Mobile 时只递增一次构建号，按每条 intent 选中的端过滤双语摘要，并提交带序号的 `product-releases/NNNN.json` 计划与 `product-releases/state.json`。

CI 会根据基线 ledger、基线版本、受跟踪的 Mobile build 和全部未消费 intent 重算生成的 Product Release PR。提交的 plan、选中端、bump、版本、tag、摘要、已消费 intent 状态、Mobile build 与 Desktop notes 必须与重算结果一致；手工修改生成事务不能漏掉或伪造发布。

合并 Product Release PR 会批准版本、发布说明和选中集合。它不会授权签名、TestFlight 上传、GitHub Release 发布、镜像发布或生产部署。

## 推广与证据

派发 `Product Release` 时提供完整候选 commit 与其受跟踪的 plan 路径。在任何发布 lane 启动前，协调器会 checkout 该 commit，验证它可从 `master` 到达，并拒绝 Desktop、Mobile 或 Platform 版本、Mobile build、ledger 序号或已消费 intent 状态与最新有效 master ledger 不一致的计划。没有 product intent 的后续 commit 不会使候选失效；任何后续未消费 product intent 都会使其失效。Desktop 保留原子的安装包、blockmap 与 updater feed 事务。Mobile 消费计划中的精确版本与 build，只产生一份签名 APK 与 IPA，可选择把 IPA 上传到滚动的 [TestFlight beta](https://testflight.apple.com/join/pKCZtn7q)，然后通过先 draft 后发布的 GitHub prerelease 提供 APK 与 `SHA256SUMS`。Platform 只构建一个绑定候选的 image，把完整 OCI digest 与记录的源码 commit 传给生产部署，并且永不推广 tag 或短 digest。

`desktop-release`、`mobile-release` 和 `production` Environment 分别保留自己的凭据与审批。可复用工作流的调用 job 只授予各 lane 所需的最小 token 权限。协调器会上传 `product-release-manifest-<sequence>`，其中包含每个发布单元的已选中、已跳过、已发布或受阻状态；每个受阻状态的原因；版本与 tag；精确候选 commit；产物或 image digest；GitHub Actions run URL；独立的 GitHub Release URL 与部署证据。只有当前或经过校验的先前上传实际运行时才会出现 `testFlightBuild`。GitHub Release asset 是持久公开下载；Actions 产物只用于临时构建与证据传递。

## 恢复与回滚

手动 `Desktop Release`、`Mobile Release`、`Platform Image` 与 `Platform Deploy` dispatch 继续作为恢复入口。恢复由显式类型化模式选择，绝不根据触发事件推断。每项先前 run 恢复都会通过 GitHub API 校验仓库相同、工作流受允许、run 已完成、命名生产 job 成功且候选命名产物未过期。工作流 head 必须是候选本身，或当前可从 `origin/master` 到达的完整 commit；后续可信协调器因此可以生成可复用字节，未合并分支则无法伪造恢复证据。后续 lane 失败不会否定已经成功生成的字节。下载的候选 manifest 与重新计算的 digest 会单独把将被推广的精确字节绑定到请求候选。Mobile 可以用经过校验的 IPA 重试 TestFlight；不请求新上传时会保留经过校验的先前 TestFlight 证据。Platform Image 恢复校验绑定候选的完整 digest 元数据，绝不把请求提供的 digest 当作证据。Platform 仅发布恢复会在创建 Release 前校验命名部署产物及其精确候选、image、版本和部署元数据。请求的 GitHub Release、TestFlight 上传或 Platform 发布在外部渠道失败时会让直接工作流失败；Product Release 协调器仍通过最终 manifest 汇总 lane 失败。中断的 Platform 部署继续使用持久生产阶段与滚动回滚事务。
