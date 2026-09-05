# dsh-subagent-route-preauthorization-static

`dsh-subagent-route-preauthorization` 的静态 Provider。`allowedModels` 在 Provider 生命周期开始时完成校验、去重和排序。该 Provider 不依赖 Settings，Cordis dispose 会移除服务。
