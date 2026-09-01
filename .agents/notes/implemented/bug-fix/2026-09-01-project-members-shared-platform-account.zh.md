# Agent Note：Project Members 由共用 Platform Account 门控

Status: implemented

[English](2026-09-01-project-members-shared-platform-account.md) | 中文

## 问题

Desktop 安装没有有效 Platform Account session 时，Workspace Settings 仍可能渲染 Project Membership 操作。此时发起 membership 请求会把 Account 传输故障暴露在产品界面中，且没有为该安装授权的入口。

## 决策

`@deepseek-ai/dsh-project-membership-client` 持有无凭据的 `ProjectMembershipAccess` 组合接口。它把当前安装投影为不可用、已退出、登录中、已登录或退出中，发布状态变化，并提供前往属主登录界面的导航。

Desktop client 把既有 Account source 适配到该接口，并在 Account source 改变前保持每个投影 snapshot 对象不变。Workspace plugin 仅通过注入的 hooks compartment 接收该 observable；业务组件接收已由框架绑定的 hook 结果，不直接订阅外部 store。登录操作打开已有的手机配对 Settings section；隐私确认、GitHub 授权、Account session key 与退出登录仍由该 section 持有。共用 source 报告 `signed-in` 前，Workspace Settings 不发起任何 Project Membership 读取；状态到达后，无需重开弹窗即可恢复已绑定 Project。每个恢复出的 Project 都与发起该请求时的精确授权 snapshot 绑定，因此 Account 状态一旦变化，前一个 Account 的 roster 与操作控件会在替代请求完成前隐藏。Account 故障在授权门控中渲染，不会伪装成 Project 查询故障。

提供 Project Membership 操作、但在 Desktop 之外持有授权的组合可以省略 access 接口，保持其预先授权行为。

## 考虑过的替代方案

- **在 Workspace Settings 中加入第二套 GitHub 登录流程** —— 拒绝，因为一个 Desktop 安装只持有一份 Platform Account session，且既有 Settings section 持有授权和隐私披露。
- **在 membership 请求开始后翻译 `SESSION_REVOKED`** —— 拒绝，因为传输错误不表达完整 Account 生命周期，且仍然没有登录入口。
- **在全局侧边栏加入 Account 入口** —— 拒绝，因为 Workspace Settings 需要局部恢复操作，既定 Account 界面仍是手机配对 Settings。

## 后果

手机配对与 Project Members 观察并修改同一份当前安装 Platform Account session。退出登录或切换 Account 会立即门控 Project Membership，登录会恢复仍在打开的设置界面，Account 凭据不会进入 renderer state。聚焦 UI 与组合测试覆盖全部投影状态、稳定 snapshot 身份、登录导航、查询抑制、Account 切换和恢复；运行态验收仍需在真实 Platform 与 Electron 界面上使用两个真实 GitHub 账号。
