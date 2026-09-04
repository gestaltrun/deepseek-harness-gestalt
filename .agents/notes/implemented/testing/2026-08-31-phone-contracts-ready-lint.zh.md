# Agent Note: 手机交付 contracts-ready lint 收口

Status: implemented

[English](2026-08-31-phone-contracts-ready-lint.md) | 中文

## 问题

手机交付在全部涉及文件满足仓库类型感知 lint 规则之前，新增了源码、生命周期测试、生成目录 fixture 与组装 snapshot 覆盖。剩余诊断对应具体义务：未知拒绝值需要收窄、Promise 归属需要显式表达、void callback 需要 block body，生命周期事实需要在 await 后重新读取。

## 决策

手机交付面在不禁用规则、不排除文件、不弱化类型且不增加宽泛断言的前提下通过 `lint:contracts-ready`。wire 与 JSON 值在完成收窄前保持 `unknown`。测试等待异步端口 claim，以 `void` 标记有意不观察的 Promise，并在 callback 返回值不属于 contract 时使用 block body。生命周期检查在每个挂起点后调用 helper，以决策当下读取 fiber 状态。生成的手机 fixture 保留 Promise service interface，同时移除不必要的 `async` function。

## 考虑过的替代方案

**从类型感知 lint 中排除生成 fixture 与测试。** 否决：这些文件组装已交付 contract 与生命周期证据；即使产品源码不变，不安全值或 floating Promise 也会使证明失效。

**逐条压制诊断。** 否决：每条诊断都有可直接表达既有义务的局部写法。

## 后果

手机源码、测试、snapshot 与目录 fixture 和仓库其余部分使用同一套 contracts-ready 规则。后续变更必须保留显式拒绝收窄、Promise 归属与 await 后生命周期重读。

## 验证

`pnpm run lint:contracts-ready` 在最终手机交付堆叠上通过。聚焦的手机、workbench、snapshot 与目录测试保持原有行为。
