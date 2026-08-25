# Agent Note：每次发布都显式接受 Companion transport 风险

状态：已实现

[English](2026-08-25-explicit-companion-transport-risk-acceptance.md) | 中文

## 问题

Mobile release validation 要求一个声称已完成独立 Noise security review 的 boolean，但 signing workflow 不消费这份 evidence。第一次分发已有 operator decision：使用仓库的 cross-runtime、vector、tamper、replay、ordering、resource-limit 与真实 product-path evidence 推进，不另行委托外部评审。保留未验证 boolean 会错误陈述 evidence，也无法控制 TestFlight 或 APK production。

## 决策

Repository 与实际运行的 native transport test 仍是强制 release evidence。已批准的 Android Emulator 与 iOS Simulator 可以提供 device evidence；fixture Web page 与 `prototype-companion` 不可以。独立外部评审不是第一次分发的前置条件。成功的 Mobile Companion Acceptance run 会校验确切的 flow 与 device vocabulary、upgrade preservation、phone-size UI、assembled failure 与 transport decision，然后发布一份以已测试 `master` commit 命名的 immutable artifact。

每次 Mobile Release dispatch 都要提供该 acceptance run id 与 candidate-scoped `accept_transport_risk` input。authorization job 会先把 source run 的 workflow id 与 path 绑定到 `.github/workflows/mobile-companion-acceptance.yml`，再在 Android 或 iOS 获得 signing secret 前校验 event 与具名 verdict、唯一且未过期的 artifact、repository、source run id、commit、Git tree、完整 evidence 与 risk acceptance。verifier 会调用进程内 distribution helper；其他 workflow 与 workflow syntax 都无法绕过相同的 readiness rule。

## 考虑过的替代方案

**把 operator decision 当成已完成的独立评审。** 拒绝，因为接受风险的授权与独立 reviewer 提供的 evidence 是不同事实。

**删除 review boolean，但不增加可执行 acknowledgment。** 拒绝，因为 signing 将没有 candidate-specific record 来证明 release owner 接受剩余的外部评审缺口。

**保留 workflow 不消费的 helper-only gate。** 拒绝，因为 workflow 从不调用的 pure utility 无法控制 signing 或 upload。

## 后果

第一次 TestFlight 与 signed APK candidate 可以在记录 operator decision 后推进，无需虚构独立评审结果。GitHub 会保留 candidate-bound 的实际运行 acceptance artifact，以及确切 release dispatch 与 transport-risk input。Stale、foreign、partial、duplicated 或扩展 vocabulary 的 evidence 都无法进入 signing。未来的独立评审可以增加 evidence 或恢复更强的 release prerequisite，而无需改变 endpoint-owned Snow protocol。

## 测试

Release-helper coverage 会拒绝 missing、duplicated、unknown、stale-candidate、foreign-repository、foreign-workflow、wrong-run 与 risk-unaccepted evidence，同时保留全部 product 与 device requirement。CLI behavior coverage 会通过 `gh` 解析 workflow identity、source run、具名 verdict、artifact listing 与 download。Workflow coverage 要求 acceptance run id、执行 verifier、只在具名 verdict 成功后发布 evidence，并让两个 signing job 都依赖 authorization。
