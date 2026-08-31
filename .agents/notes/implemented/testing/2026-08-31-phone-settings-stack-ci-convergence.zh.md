# Agent Note: 手机设置交付栈 CI 收敛

Status: implemented

[English](2026-08-31-phone-settings-stack-ci-convergence.md) | 中文

## 问题

「手机设备」设置分区会改变组装后的 Web 设置导航，并从「插件」中移除手机卡片。既有 Web golden 描述的是旧组合，因此首个不一致会让设置弹窗保持打开，后续用例再因指针被遮挡而失败，掩盖最初的快照差异。

release family fixture 还会创建缺少 source map 的动态 client bundle，不满足 client build record 的要求。Desktop overlay boot 会启动完整 Host 子进程，V8 插桩 coverage 无法观测这些子进程；在该插桩下，托管 Linux 与 Windows 都未到达 URL 宣布。第一版非插桩设计仍共享资源窗口：Linux 让 heavy 配套门禁与插桩 coverage 并行，Windows 则把 overlay、编译、Git 和 Oxlint fixture 放进同一 worker pool；两个托管平台随后都耗尽了既有 Host URL 时限。Electron runner 日志测试则假设父进程退出后后代仍保留继承 pipe；这是 POSIX 行为，不是可移植的 Windows 日志契约。

手机二进制发现测试还使用 POSIX 分隔符拼接临时 `PATH`，让 POSIX npm prefix 与 Homebrew 预期继承 runner 平台，并在未解析服务场景中保留 `USERPROFILE` 和 `npm_config_prefix`。这些输入导致 Windows coverage 实际检查的搜索空间与各测试声明的不一致。

## 决定

受影响的 Web golden 包含顶层「手机设备」导航行，并且不再在「插件」中包含手机卡片。刷新后以 replay 模式运行全部受影响文件，证明更新 golden 没有掩盖交互失败。

release family fixture 会先创建动态 client bundle 与最小有效 source map，再记录产物摘要。Desktop overlay 组合启动归入 `coverageExemptIsolatedSuites`：插桩门禁排除它，等插桩 coverage 与共享 heavy 门禁都结束后，再启动全新的单 worker 进程。原生 Windows owner 也会在共享 heavy 门禁结束后按相同顺序执行。该套件不会贡献子进程覆盖率；它在当前进程导入的 launcher 源码仍由各自所属测试保持完整覆盖。client apply 套件还覆盖 ready 设置快照缺少 Phone namespace 值时的组合启用回退。

`runLogged` 在所有平台验证直接子进程的延迟 stdout 与 stderr 都完成持久化。独立的 POSIX-only 测试保留更强的后代继承 pipe 义务；Windows 进程树终止继续通过 `taskkill /t` 行为覆盖，不依赖 pipe 继承假设。

二进制发现 fixture 使用宿主分隔符拼接 `PATH`。验证 POSIX npm prefix 与 Homebrew 规则的测试显式选择 POSIX 行为；未解析服务测试则清空并恢复 resolver 会读取的所有 home 与 prefix 环境输入。

## 考虑过的替代方案

**提高 Host URL timeout。** 拒绝，因为不与其他 heavy worker 竞争时，两条 overlay 场景都能在既有时限内完成。

**保留旧 Web golden。** 拒绝，因为「手机设备」有意成为顶层设置分区，也不再属于「插件」。

**为测试 fixture 放宽 source map 校验。** 拒绝，因为 release fixture 必须代表生产构建所要求的完整产物。

## 结果

修复后的门禁描述已交付的设置组合，验证完整的 client 产物 fixture，在没有无关父进程插桩的情况下运行真实 Host 子进程测试，并让二进制发现断言不受 runner 无关环境状态影响。这些变更只影响测试证据，不授权发布或合入 `master`。
