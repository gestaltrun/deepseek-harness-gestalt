# Agent Note: 在启用闸门之后交付 ui-phone tab 骨架

Status: implemented

[English](2026-08-27-ui-phone-tab-skeleton.md) | 中文

## Problem

Issue #356 锁定了「手机」tab 骨架——恒可达入口、第①态空态、两态徽标——并要求先于 mobilecli 引擎落地，但三个约束塑造这条缝：better-sidebar 快照为钉死的上游源码，且不是 client typecheck 图中的 composite project；其徽标契约只能在字符串或数字外渲染一个中性 pill（没有点形或配色路径）；骨架必须把注册/注销对称性作为可执行运行时门禁来保证，而不能只是测试套件内的断言。

## Decision

`packages/client/ui-phone` 在 `ctx.effect` 内通过 `ctx.betterSidebar` 注册，使 disposer 随插件 fiber 生命周期走（HMR 安全）。descriptor 为 `id: 'phone'`、标题 手机、包内自带单色 SVG 图标、排在内置浏览器之后的 `order: 55`，以及永不拒绝的 `available`（`single: true` 保持一个「手机」tab；设备就地切换见[单 tab 改定](../feature/2026-08-29-ui-phone-single-tab-h264.zh.md)）（决策轴 2：入口把首次使用引导放进 tab 内容，而不是置灰菜单行）。`Config.enabled`（schemastery，默认 `false`）是契约占位：注册无条件执行，禁用臂在内容里渲染「手机连接未启用」说明条——经 gate source 响应式读取，拨动开关在同一次失效通知内刷新已挂载的说明条，同时发现、拉起与流路由都不进入本包。徽标与内容清单读取同一个注入的 `PhoneListingSource`；随包实现消费 Host 的 `GET /phone/devices` 路由（见[清单路由笔记](../feature/2026-08-28-phone-device-listing-route.zh.md)），条状取值映射为 `null`（静默）或在线台数。Node 侧 invariant 伴生体在注册自身的 child context 上驱动「先提供者后依赖方」的 fiber 对，以 fake 注册表的注册/注销事实作为同步点；当宿主根已经发布 `betterSidebar` 时（各包套件自己就在练注册）探针让位。探针放在无样式的 `registry.ts` 中，Node 面因此从不引入带样式的组件体或 React 运行时代码。

## Alternatives considered

**直接从 `@deepseek-ai/dsh-client-ui-better-sidebar` 导入 descriptor 与 service 类型。** 拒绝：钉死快照被排除在 composite client 图之外，引用其项目会毒化聚合（其自身非 composite 引用触发 `TS6306`）。消费方改为本地声明结构面——ui-workbench adapter 的先例——`service.ts` 仍是契约所有者。

**把灰点编码成 pill 字符（例如 `·`）。** 拒绝：品牌色 pill 内的魔法字符既不匹配稿中的灰点，也不会被读成一个有文档的状态；静默臂保持 `null`，保真缺口记录在包 README 中，等待徽标契约扩展。

**交付带注册表指针的空 invariant 伴生体。** 拒绝：本票要求把注册/注销关系作为运行时 invariant，而注销对称性正是本包拥有的关系——空形态会用一条「合理理由」掩盖真实回归。

**开机即常驻打开 tab。** 拒绝：常驻约束的是 descriptor 的注册，不是某个已打开的 tab；「+」菜单入口保持唯一打开路径，与 terminal、browser 内置项一致。

## Consequences

设备清单由随包的 `PhoneListingSource` 承载（见[清单路由笔记](../feature/2026-08-28-phone-device-listing-route.zh.md)）；`Config.enabled` 仍是选择器内容固定的组装默认值。就地占用设备已在[单 tab 改定](../feature/2026-08-29-ui-phone-single-tab-h264.zh.md)交付，并使用本注册路径的 `single: true` descriptor。徽标点样式只在 better-sidebar 扩展 pill 契约后落地。宿主根让位使共享测试 invariant host 对自带 `betterSidebar` 的套件保持确定性；在其他任何环境里丢失注册的回归都会在伴生体激活时失败（`the "phone" tab is missing after the plugin fiber activated`）。插件配置标签页向导卡与 Host `ui-phone` 命名空间见[设置向导笔记](2026-08-28-ui-phone-settings-wizard-card.zh.md)。
