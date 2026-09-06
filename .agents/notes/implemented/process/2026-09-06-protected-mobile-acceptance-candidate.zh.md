# Agent Note: 受保护的 Mobile 签名验收候选

Status: implemented

[English](2026-09-06-protected-mobile-acceptance-candidate.md) | 中文

## Problem

Mobile 签名要求已完成实际运行验收，但物理 Android 对正式签名应用的验收又需要由受保护发布密钥生成的可安装候选。导出该密钥或弱化验收要求，都会把签名权限移出 `mobile-release` Environment，或伪造发布证据。

## Decision

`Mobile Release` 提供显式的 `candidate_build_only` 模式，默认值为 false。该模式只接受当前 `master` 上精确的 Product Release Plan 候选、源码拥有的版本与 build，以及候选范围的显式 transport-risk 接受。它会在签名前拒绝 acceptance run id、artifact recovery、TestFlight 上传与 GitHub 发布。

受保护的 `mobile-release` Environment 通过现有打包脚本构建一个正式签名 Android APK。workflow 将 APK 与 manifest 上传为仓库读者可访问的 `mobile-acceptance-candidate-<candidate_sha>` Actions artifact。manifest 绑定候选 commit、plan、版本、build、APK 摘要、签名证书摘要和实际运行 Platform origin 的摘要，不包含凭据或 origin 值。Candidate-build-only 不生成 iOS artifact、tag、Release、TestFlight 上传、发布验收或发布证据。

普通 Mobile 签名、TestFlight、GitHub prerelease 发布与 artifact recovery 仍要求成功的候选绑定 Mobile Companion Acceptance run，以及 dispatch 范围的 transport-risk 接受。Recovery producer allowlist 不包含 acceptance-candidate artifact，因此 build-only run 不能成为发布输入。Product Release 显式保持 `candidate_build_only` 为 false。

## Alternatives considered

**导出 Android 正式发布密钥用于本地物理构建。** 不采用，因为发布凭据仍由受保护 Environment 拥有，绝不能进入本地工作站或用户可见 artifact。

**使用 debug application id。** 不采用，因为这会测试不同的原生身份与受保护存储命名空间，不能证明正式应用的原地升级。

**允许 candidate artifact 进入发布恢复。** 不采用，因为签名 artifact 在推广前必须先产生独立且不可变的物理验收 verdict。

## Consequences

正式签名 APK 可以在不发布、不上传 iOS build 的情况下用于物理验收。拥有 Actions artifact 读取权限的仓库读者可以下载候选；GitHub Actions artifact 没有 private 开关。精确 current-master 限制防止对分支或陈旧候选签名，而最终发布仍会被阻塞，直到同一候选具有实际运行证据。候选发生变化后，必须重新生成 build-only artifact 与验收证据。

## Testing

Workflow 测试固定默认 false 模式、受保护 Environment、仅 Android artifact、身份 manifest、不包含发布命令，以及 Product Release 的显式默认值。可执行 mode-matrix 测试会在 candidate-build-only 模式下拒绝缺失 transport-risk 接受，以及每项 acceptance、recovery、TestFlight 或 GitHub 发布输入，同时保留普通模式的 acceptance-run 要求。
