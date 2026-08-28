# Agent Note: project_members resolves identity through config-injected provider faces

Status: implemented

[English](2026-08-28-project-members-roster-tool.md) | 中文

## Problem

工单 #342 需要一个面向模型的 `project_members` 读取工具，一次返回完整的项目成员名册——账号引用、展示身份、角色、职能标签、在线状态——而成员关系 Service Definition 的 `roster(actor, projectId)` 需要一个工具拿不到的已认证 `PlatformAccountId`：该 id 在 `ctx.platformAccount` 之后，其会话是 bearer token 加证明的呈现形式，agent 循环并不持有。工具还需要工作区→项目绑定以及 #340 放在 HTTP 消费方中的在线状态／身份修饰，同时工具包不能因此依赖任何平台包，否则面向模型的表面会把 Desktop/Mobile 身份平面拖进每个加载它的组合。

## Decision

`tool-project-members` 只依赖成员关系 Service Definition，并接受三个可选的 Config 函数：解析会话绑定账号的 `currentAccountResolver`、调用省略 `projectId` 时解析工作区绑定项目的 `boundProjectResolver`，以及为一次名册读取附加在线状态与展示身份的 `rosterPresenter`。调用先解析账号、再解析绑定，因此两者皆缺的组合得到 `ACCOUNT_UNAVAILABLE`；绑定不可解析时返回 `PROJECT_UNBOUND`；二者都是稳定的 `HarnessError` 代码，其逐字固定的模型可见文本以代码开头，解析器的抛错会链上原因。未注入 presenter 时，所有成员读作 `presence: "offline"` 且不带身份字段——与已组合但无任何活跃心跳的在线状态注册表给出的结论一致，模型永远看不到第三种"未知"状态。缺失的接口在调用时失败而非注册时失败：只要成员关系服务存在工具就注册，使工具目录在仅有平台接线差异的组合之间保持稳定。包位于 `packages/interaction/`——面向模型的人机协作平面，与 `tool-ask-user` 相邻——而非 `packages/platform/`，后者的章程是与安装无关的身份与会话行为，不是 agent 工具；`tool-*` 叶名使 `packages/*/tool-*` 目录守卫 glob 保持权威。

## Supersession check

两份平台 note 均未被取代。[项目成员关系权威 note](2026-08-27-project-membership-core.zh.md) 继续拥有角色门与名册权威；工具原样调用 `roster()`，不新增权限表面。[在线状态心跳 note](2026-08-28-member-presence-heartbeats.zh.md) 继续拥有在线状态语义与聚合；工具消费 presenter 的结论，刻意不自行推导在线状态，因此"无 presenter 即 offline"是呈现默认值，不是与之竞争的活性来源。

## Alternatives considered

**直接从 `ctx.platformAccount` 读取账号。** 否决：工具将导入平台包，把面向模型的工具耦合到身份平面，而且循环中不持有任何可供工具出示的 bearer token 或证明——该注入点纯属虚构。

**把在线状态与身份提升进 Service Definition 的 `roster()`。** 本里程碑否决：为一个消费方扩宽接缝，而 #340 的 HTTP 消费方已经在另一侧修饰名册；presenter 让工具保持解耦，同时平台组合自行决定接哪个修饰来源。

**给在线状态一个独立取值（例如 `unknown`）。** 否决：输出 schema 将长出在线状态平面从不产生的第三种状态，模型一无所获——对名册服务的每项决策而言，没有活跃心跳的成员就是离线。

**把工具放进 `dsh-base` bundle。** 否决：没有任何随产品发布的默认组合提供 `ctx.projectMembership`，该行将是死的；注册随提供该服务的平台组合落地，如同尚未到来的验收装配。

## Consequences

工具今天即可针对桩接口完成测试，而提供方接口——账号会话解析、工作区 remote 绑定、在线状态接线——仍是组合侧工作；在它们落地之前，真实部署看到的是 `ACCOUNT_UNAVAILABLE` 或 `PROJECT_UNBOUND` 而非名册。解析器契约是 Config 中的普通函数，`cordis.yml` 以 `!!js` 表达式提供、测试以桩注入，无需插件——但除签名外没有任何机制校验解析器的身份，注入错误账号解析器的组合会得到那个账号的名册。包测试中的内存 provider 与桩解析器是装配平台接口的参照。

## Testing

`tests/tool-project-members.spec.ts` 固定规范 JSON 形态、presenter 契约、两条稳定错误路径（含链式原因与先账号后绑定的顺序）、配置错误在加载时失败，以及注册后的释放。`tests/loader-composition.spec.ts` 让工具经真实 Loader 从 `cordis.yml` 启动，其 `!!js` 配置携带函数值接口，端到端证明注入路径与无接口时的错误。`examples/project-members` 的 keyless snapshot 回放钉住真实 agent 循环上一次名册读取的组装 stream-json transcript。
