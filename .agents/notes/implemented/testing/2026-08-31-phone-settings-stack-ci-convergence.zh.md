# Agent Note: 手机设置交付栈 CI 收敛

Status: implemented

[English](2026-08-31-phone-settings-stack-ci-convergence.md) | 中文

## 问题

「手机设备」设置分区会改变组装后的 Web 设置导航，并从「插件」中移除手机卡片。既有 Web golden 描述的是旧组合，因此首个不一致会让设置弹窗保持打开，后续用例再因指针被遮挡而失败，掩盖最初的快照差异。

release family fixture 还会创建缺少 source map 的动态 client bundle，不满足 client build record 的要求。分区 coverage 会让 Desktop overlay boot 与普通插桩测试竞争资源，尽管该套件会启动完整 Host 子进程。Electron runner 日志测试则假设父进程退出后后代仍保留继承 pipe；这是 POSIX 行为，不是可移植的 Windows 日志契约。

## 决定

受影响的 Web golden 包含顶层「手机设备」导航行，并且不再在「插件」中包含手机卡片。刷新后以 replay 模式运行全部受影响文件，证明更新 golden 没有掩盖交互失败。

release family fixture 会先创建动态 client bundle 与最小有效 source map，再记录产物摘要。Desktop overlay 组合启动 coverage 归入 `coverageProcessBoundSuites`，coordinator 因此将它从并发分区排除，并与其他串行 process-bound 套件一起只运行一次。

`runLogged` 在所有平台验证直接子进程的延迟 stdout 与 stderr 都完成持久化。独立的 POSIX-only 测试保留更强的后代继承 pipe 义务；Windows 进程树终止继续通过 `taskkill /t` 行为覆盖，不依赖 pipe 继承假设。

## 考虑过的替代方案

**提高 Host URL timeout。** 拒绝，因为不与普通 coverage 分区竞争时，两条 overlay 场景都能快速完成。

**保留旧 Web golden。** 拒绝，因为「手机设备」有意成为顶层设置分区，也不再属于「插件」。

**为测试 fixture 放宽 source map 校验。** 拒绝，因为 release fixture 必须代表生产构建所要求的完整产物。

## 结果

修复后的门禁描述已交付的设置组合，验证完整的 client 产物 fixture，并按资源归属调度真实 Host 子进程测试。这些变更只影响测试证据，不授权发布或合入 `master`。
