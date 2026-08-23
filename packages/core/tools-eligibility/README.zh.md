# dsh-tools-eligibility

[English](README.md) | 中文

allow-only 工具资格的宿主平面解析器。Preset 许可作为基础；`tool-eligibility` settings 分节按稳定 id 依次添加 Workspace 与 Session 条目。

```yaml
tool-eligibility:
  workspaces:
    workspace-id: [bash]
  sessions:
    session-id: [str_replace_editor]
```

所有配置列表都只做正向添加。最终集合是 preset、匹配 Workspace 与匹配 Session 三份列表的排序并集。三者都不存在时，为兼容既有组装，该 Session 保持不受限。任一声明都会启用 allow-only 资格；最终并集为空时不允许任何末端工具。settings 更新会直接作用于实时 Agent，无需重启。

解析器为每个实时 Agent 持有一条可变注册表贡献。settings 刷新会先提交每个受影响 Agent 的贡献，再发出任何观察者通知；随后为每个受影响 Agent 尝试关系 publication 与注册表变化通知，并在完整扇出后一起传播观察者错误。解析器卸载、HMR 或 Agent 销毁都会移除对应贡献。注册表让模型 schema、查询和分发共用解析后的视图，因此不合格或过期调用会在工具主体运行前被解析为未知工具。发送给模型的精确 schema 已记录在持久 `request/header` 事件中；回放无需读取当前 settings 即可重建模型可见资格。

`session.toolEligibility` 直接读取权威 `ctx.tools` 许可与 schema 目录。settings schema 只包含 `workspaces` 和 `sessions`；内部支持 deny 的 `ctx.tools.restrict()` API 不会投影到用户配置。

## 模型体验

### 最终具资格 schema

#### 模型看到什么

模型只接收 preset、匹配 Workspace 与匹配 Session [工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tools) 的精确正向并集。Code Mode 保留的 `run_code` 传输仍是呈现基础设施；资格会过滤其生成 SDK 投影的末端工具。

#### Token 影响

该服务不添加 prompt 文本。它会移除每个不具资格的末端工具 schema 及其每次请求重复的 token 成本；Code Mode 也会从生成 SDK 中省略这些 binding。

#### KV Cache 影响

settings 变化若改变最终 schema 集合，会从首个变化的工具 schema 或 SDK token 起使请求前缀失效。

## 已知限制与暂缓事项

- Workspace 匹配使用 Session header 的规范 cwd 与实时 Workspace 注册表。位于未注册 Workspace 的 Session 只接收 preset 与 Session 条目。
