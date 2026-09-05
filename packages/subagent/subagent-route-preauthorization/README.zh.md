# dsh-subagent-route-preauthorization

用于不可变部署级子 LLM 精确路由授权的 Service Definition。Provider 通过 `ctx.subagentRoutePreauthorization.routes()` 返回分离路由快照；Consumer 只能在组装新的顶层 Session 时采样。
