# dsh-subagent-route-preauthorization

Service Definition for immutable deployment-owned exact child LLM route authorization. Providers return detached route snapshots through `ctx.subagentRoutePreauthorization.routes()`; Consumers may sample them only when composing a new top-level Session.
