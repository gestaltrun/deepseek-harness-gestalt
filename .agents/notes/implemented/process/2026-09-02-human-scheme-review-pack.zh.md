# Agent Note: 给人看的方案评审材料不是 Agent Note

Status: implemented

[English](2026-09-02-human-scheme-review-pack.md) | 中文

## Problem

技术方案有两类读者。之后实现或审查代码的智能体需要一份持久的 proposed Agent Note：精确的模块名、seam、失败路径和被放弃的替代。被请来拍板的人需要短、有图的说明。把 Note 当评审材料，会把 Agent Note 文风压给人看，或把 unslop 过的口语写进持久记录。

## Decision

[`codebase-design/SCHEME.md`](../../../skills/codebase-design/SCHEME.md) 把制品拆开。proposed Agent Note 放在规划分支的 `.agents/notes/proposed/`，并保持 [dsh-prose-standard](../../../skills/dsh-prose-standard/SKILL.md) 的约定文风。给人看的评审材料是 gitignore 目录 `.agents/local/scheme-review/<slug>/` 下的一份 HTML。该材料按 eli5（大图、少字）、[show-me](../../../skills/show-me/SKILL.md)（一张对准问题的图）和 [unslop](../../../skills/unslop/SKILL.md)（给人听的口语）来写。它是一次性的。不提交。不是第二份 Note。

方案会话与协调 grill 隔离。智能体先自检 Note，再生成材料包并打开 HTML 给人看。冻结后 Note 仍停在 `proposed/`，直到实现 PR 把它改写成 `implemented/`。

[eli5](https://github.com/anthropics/claude-plugins-community/tree/main/eli5/skills/eli5) 社区技能是 Apache-2.0。本仓库不 vendor 它；SCHEME.md 描述同样的「大图、少字」呈现，但不复制该技能目录。`show-me` 和 `unslop` 仍是 `.agents/skills` 里已 pin 的 MIT 副本。

## Alternatives considered

**把 proposed Agent Note 直接给人评审。** Note 必须对后续智能体保持精确。对它做 unslop 会毁掉实现审查需要的约定文风。

**把 HTML 材料包和 Note 一起提交。** 评审材料会在 Note 一改就过期，也会把一次性图片写进历史。`.agents/local/` 已经存放可丢弃的 checkout 状态。

**把 Apache-2.0 的 eli5 技能拷进 `.agents/skills`。** 第三方声明生成器要求拷贝的仓库技能带 MIT License 文件。在 SCHEME.md 里写呈现方式，避免在该表里引入第二类许可证。

**开有窗口 Desktop 实例来展示方案。** 材料包是静态 HTML。Desktop 测试实例用于产品 UI，不是用来读方案。

## Consequences

人可以在不读 Agent Note 标题的情况下批准方案。后续票和 `dsh-code-review` 仍读 Note。本地材料包丢失不会丢掉决策；Note 还在。想看细节的评审者跟随材料包里的链接即可。
