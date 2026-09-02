# Agent Note: Desktop assemblies expose roster lookup and routed ask through a live-login resolver

Status: implemented

[English](2026-09-02-desktop-roster-routing.md) | 中文

## Problem

工单 #342 与 #343 已把 `project_members` 和 `ask_user_question.to_project_member` 作为可注入 Consumer 落地。真实 Desktop 组合仍未同时暴露它们：Account proof 留在 Electron main，Web Host Agent cwd 不是身份来源，而 T5 的 `originResolver` 会把模型传入的 `to_project_member` 字符串当作已有 Account id 转发。绑定会话因此可以虚构收件人、跳过实时名册，并回退到本地提问工具。

## Decision

绑定云端项目的 Desktop 会话同时暴露 `project_members` 与 `ask_user_question.to_project_member`。Electron 发布受 token 保护的 loopback 只读投影，内容为当前 Installation Account、工作区绑定的云端项目，以及带公开 GitHub 登录名的完整名册。Web Host 提供方 `ctx.desktopProjectMembership` 读取该投影；agent preset 把它注入为 `currentAccountResolver`、`boundProjectResolver`、`rosterResolver`、`rosterPresenter` 和 `routeResolver`。纯浏览器 `dsh web` 没有该投影，因此省略 `project_members` 并隐藏 `to_project_member`。

`ask_user_question` 不再虚构 Project 或 origin。路由提问需要 `routeResolver`，仅当当前名册包含收件人时才返回 Project、origin 与匹配到的 Account id。公开登录名匹配对名册 `displayName` 大小写不敏感。成员缺失时在投递前返回 `INELIGIBLE_ADDRESSEE`；缺少发送器或 resolver 时返回 `SENDER_UNAVAILABLE`。测试与模型可见路径不得注入 Account id 以跳过该查找。Account 身份从当前 Installation 快照取样，而不是 Agent cwd。工具与提示组装的取消信号会经 Web Host fetch 与 Desktop Platform 读取中止 resolver。

## Alternatives considered

**保留 `originResolver` 并把 `to_project_member` 当作 Account id。** 否决：模型可见路径是先查名册再路由提问，公开 GitHub 登录名才是操作者面对的标识。转发虚构 Account id 会跳过实时名册。

**从 Agent cwd 或测试注入的 Account id 取样身份。** 否决：Platform Account 属于当前 Installation。cwd 只选择其 Git remote 绑定云端项目的 Workspace。

**在纯浏览器 `dsh web` 挂载 `project_members`。** 否决：该组合没有 Account proof owner，也没有 loopback 投影，工具要么虚构身份，要么每次调用都失败关闭。

## Consequences

绑定 Desktop 会话在存在 `to_project_member` 时不再回退到本地提问工具。Web Host 挂载 `ctx.memberQuestionSender` 但不配置生产投递端口，因此构造出的路由提问在审阅过的 T4 registry transport 组合完成前以 `DELIVERY_UNAVAILABLE` 失败关闭。未绑定会话隐藏路由参数。任意非名册收件人失败关闭。loopback 投影只读；Project 变更仍由 renderer 经 Desktop IPC 执行。

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` 固定公开登录名路由、投递前的 `INELIGIBLE_ADDRESSEE`，以及经 `routeResolver` 与 `boundProjectResolver` 的取消。`packages/platform/project-membership-desktop/tests/desktop-provider.spec.ts` 固定大小写不敏感的登录名匹配，以及待处理 loopback 读取的中止。`packages/platform/project-membership-desktop/tests/loader-composition.spec.ts` 经 Loader 启动 Web Host sender、Desktop membership 桥接与 standard preset 的 `routeResolver`，并钉住绑定路由提问以 `DELIVERY_UNAVAILABLE` 而非 `SENDER_UNAVAILABLE` 失败关闭，使用公开 GitHub 登录名而非注入的 Account id。`apps/desktop/tests/project-membership-agent-runtime.spec.ts` 固定 Installation 取样身份、actor 不匹配、账号切换拒绝与静止处置。`apps/desktop/tests/overlay-isolation.spec.ts` 固定 Web Host 与 Desktop overlay dump 中的 `ctx.memberQuestionSender`。`examples/project-members` 的 keyless snapshot 回放钉住先 `project_members` 再 `ask_user_question`，且 `to_project_member` 是实时公开登录名而非 Account id。
