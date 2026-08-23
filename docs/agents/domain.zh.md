# 领域文档

[English](domain.md) | 中文

Matt 工程 skills（技能）在探索代码库或实现 ticket 前读取本仓库的领域术语和架构决策。

## 阅读顺序

1. 阅读根目录的 [CONTEXT-MAP.md](../../CONTEXT-MAP.md)。
2. 阅读其中映射到当前工作范围的每个 `CONTEXT.md`。
3. 阅读 [`.agents/notes/`](../../.agents/notes/README.zh.md) 下适用于当前工作的活跃 Agent Note。
4. 阅读仓库指令要求的架构、子系统或包参考文档。

某个范围没有映射的 context 文档时，直接继续。只有当工作建立了持久术语或职责归属时，才通过 `domain-modeling` 添加 context。

## 布局

本仓库使用多 context 布局：

```text
/
├── CONTEXT-MAP.md
├── apps/
│   └── desktop/
│       └── CONTEXT.md
└── .agents/
    └── notes/
```

每份 context 文档拥有一个产品或子系统的术语。`CONTEXT-MAP.md` 将 agent 引导到相关 context 文档，无需每个包都拥有一份。

DeepSeek Harness 使用 Agent Note，而不是 `docs/adr/`。不要创建并行的 ADR 层级。需要记录新决策时，遵循 [`.agents/notes/README.md`](../../.agents/notes/README.zh.md)。

## 术语

Issue、规格、实现计划、代码、测试和文档必须使用相关 `CONTEXT.md` 中定义的首选术语，避免使用 `_Avoid_` 明确列出的同义词。

所需术语不存在时，先重新判断现有术语是否已经适用。如果确实存在持久缺口，通过 `domain-modeling` 更新拥有该术语的 context。

## 决策冲突

输出与活跃 Agent Note 冲突时，必须明确指出冲突。不要静默覆盖已记录的决策，也不要把已归档的 Agent Note 当作当前依据。
