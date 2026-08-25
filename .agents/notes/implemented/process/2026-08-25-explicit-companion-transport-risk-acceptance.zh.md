# Agent Note：每次发布都显式接受 Companion transport 风险

状态：已实现

[English](2026-08-25-explicit-companion-transport-risk-acceptance.md) | 中文

## 问题

Mobile release validation 要求一个声称已完成独立 Noise security review 的 boolean，但 signing workflow 不消费这份 evidence。第一次分发已有 operator decision：使用仓库的 cross-runtime、vector、tamper、replay、ordering、resource-limit 与真实 product-path evidence 推进，不另行委托外部评审。保留未验证 boolean 会错误陈述 evidence，也无法控制 TestFlight 或 APK production。

## 决策

Repository 与 real-device transport test 仍是强制 release evidence。独立外部评审不是第一次分发的前置条件。每次 Mobile Release dispatch 都必须设置 candidate-scoped `accept_transport_risk` input；该 input 为 false 时，authorization job 会在 Android 或 iOS 获得 signing secret 之前失败。

进程内 release helper 执行相同规则。Product flow、两个 native platform matrix、upgrade preservation、phone-size UI 和 assembled failure acceptance 决定 readiness。授权 TestFlight 或 Android APK 的请求还必须包含 `transportRiskAccepted: true`。

## 考虑过的替代方案

**把 operator decision 当成已完成的独立评审。** 拒绝，因为接受风险的授权与独立 reviewer 提供的 evidence 是不同事实。

**删除 review boolean，但不增加可执行 acknowledgment。** 拒绝，因为 signing 将没有 candidate-specific record 来证明 release owner 接受剩余的外部评审缺口。

**保留 workflow 不消费的 helper-only gate。** 拒绝，因为 workflow 从不调用的 pure utility 无法控制 signing 或 upload。

## 后果

第一次 TestFlight 与 signed APK candidate 可以在记录 operator decision 后推进，无需虚构独立评审结果。GitHub 会为每次 dispatch 记录 exact candidate SHA 与显式 transport-risk input。未来的独立评审可以增加 evidence 或恢复更强的 release prerequisite，而无需改变 endpoint-owned Snow protocol。

## 测试

Release-helper coverage 会在缺少显式 risk acceptance 时拒绝 distribution，同时保留全部 product 与 device evidence requirement。Workflow coverage 要求 manual input，并让两个 signing job 都依赖 authorization job。
