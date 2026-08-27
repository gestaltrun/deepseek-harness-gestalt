# `@deepseek-ai/dsh-project-membership-core`

[English](README.md) | 中文

项目成员 Provider。每次变更——创建、邀请、撤回、原子接受并链接、拒绝、升降级、改标签、移除——都在本进程的单一串行写链下运行,在操作内部执行角色门,对输入响亮校验(`INVALID_PROJECT_NAME`、`INVALID_REMOTE_URL`、`INVALID_TAGS`、`INVALID_LINK`),以 `0600` 权限(`0700` 目录)经原子临时文件重命名整体发布环境文档,然后才发出 `project-membership/roster-invalidated`。并发调用者因此观察到全有或全无的提交:向同一账户并发发出八次邀请,只会落定一条待决邀请与七次 `DUPLICATE_INVITEE` 拒绝。

状态按环境命名空间存放于所配置根目录之下——`<storagePath>/<environment>/project-membership.json`——即便共享同一存储根,开发身份也永不与生产冲突。文档只有完全符合记录形态才能解析(`formatVersion 0`;陌生版本直接失败而非降级),文件缺失即为空的首启。读取派生自刚持久化的内存权威状态。

消费方基于失效事件流与 `rosterVersion(projectId)` 重建缓存 roster 视图;包内的不变量伴侣约束这条已发布流严格单调——每次提交使所属项目的投影版本恰好前进一,移除也不例外,移除永远不会跟随过时的记账。

## Extension Points

配置字段:`storagePath`(持久语料目录)与 `environment`(`'development' | 'production'`,否则加载即报错)。Loader 直接挂载包默认导出:

```yaml
- name: '@deepseek-ai/dsh-project-membership-core'
  config:
    storagePath: '~/.dsh/projects'
    environment: 'development'
```

横向扩展需要按同一 Service Definition 接口换入具备等价比较并交换语义的后端;围绕一个文件多开此类的实例并不能提供。测试只受外部不确定性(uuid、墙钟)影响;组装场景基于真实本地存储 keyless 运行。

## Model Experience

无:项目成员权威数据从不进入智能体会话与模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **单进程写者** —— 一条写链串行化进程内全部变更;指向同一存储根的两个进程没有跨进程锁,可能互相丢更新。扩展靠更换后端,而不是多开实例。
- **评审门下的生产姿态** —— 开发环境经本地存储 keyless 组装;成员提问路由保持 fail-closed,仍受[放置决策 Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-project-membership-core.zh.md) 记录的常设独立加密评审约束。本包不含任何传输、凭据或明文。
- **暂无管理界面** —— 清理已拒绝/已撤回邀请与审计导出推迟到出现消费方之后再做。
