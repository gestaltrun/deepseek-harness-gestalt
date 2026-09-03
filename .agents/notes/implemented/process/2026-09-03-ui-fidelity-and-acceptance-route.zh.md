# Agent Note: UI 还原度闸门与专用验收路线

Status: implemented

[English](2026-09-03-ui-fidelity-and-acceptance-route.md) | 中文

## 问题

GUI 规格可以链上冻结的 prototype 稿，实现仍然可以长成人类认不出来的样子。票 writer 证明一条 smoke 路径。代码评审把规格当散文读。两个会话都不把正在跑的产品对照稿看，于是布局、chrome 和主操作会漂到 headed 评审才被发现。

同一协调会话随后给用户开 headed 实例。所需数据、Platform 配置和残留进程仍是 writer 的遗留物。人类在被要求整段验收的功能上，卡在第一步。

## 决策

GUI 规格在派发实现前要有两件规划物：[冻结高保真稿](2026-09-02-fused-ui-prototype-variants.zh.md)（[`to-spec`](../../../skills/to-spec/SKILL.md) 已要求），以及一条**体验路线**。路线是范围内每条用户故事的有序走法。每一步写明起始状态、动作、必须与稿对应的屏幕，以及可观察结果。范围外的故事不进路线。

全部 GUI 票落到规格分支之后，[交付编排](../../../skills/orchestrate-dsh-delivery/SKILL.md)派发**还原度 writer**，而不是根会话。该 writer 通过 [`dsh-desktop-test-instance`](../../../skills/dsh-desktop-test-instance/SKILL.md) 启动一个 headless Desktop，打开路线上的每一屏，对照冻结稿（`gif-assets` 上的 PNG/GIF 和 throwaway prototype 分支）。标准是同一套 chrome、组件库、信息层级和主操作。不要求像素级同一。不匹配是给所属票 writer 的发现。headed 人工评审等到这些发现清掉。

然后派发**专用验收环境会话**。该会话不是根会话，也不是票 writer。它停掉该目标的残留实例，启动一个全新的隔离 Desktop，按场景选择 fixture 或 live Platform，种好路线需要的数据，并 headless 走完整条体验路线。卡住的步骤是 writer 修复或报告的人工阻塞，不是 headed 交接。只有完整的 headless 走通才会开 headed 实例。该会话随后把路线、URL 或窗口、以及起始状态交给用户。

[根会话只做编排](2026-09-03-root-session-orchestrates-only.zh.md)仍然禁止协调会话实现、启动验收实例或走路线。

## 曾考虑的替代方案

**把代码评审的 Spec 轴当作视觉还原度。** Spec 评审读 issue。它不会把产品和稿并排打开，因此 chrome 和层级可以通过，看起来却像另一页。

**让每张票的 writer 只证明自己的切片。** 切片 smoke 看不到人类被要求走完的整段。验收会话拥有整条路线。

**让根会话准备 headed 实例。** 那就是残留进程失败。专用会话通过运行时备忘拥有该目标的 Desktop 清单。

**要求像素级截图 diff。** 宿主 chrome、字体栅格和窗口大小会动。对齐产品语言和主操作能抓住用户报告的漂移；像素同一抓不住。

## 后果

没有稿指针和体验路线的 GUI 规格不能交付。实现不能带着未对照的 UI 或卡住的走法进入 headed 评审。人类从路线已经 headless 走通的状态开始。

还原度对照和验收走法各自增加一个 writer 和一个 headless Desktop。它们把 headed 评审推迟到这些 writer 通过。缺少稿、缺少路线或卡住的步骤会停止交付，而不是让用户去调试环境。
