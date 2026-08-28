# phone/ — Phone device fleet capability family

English | [中文](README.zh.md)

The phone device fleet over the external mobilecli binary: one Host-half Service owns the loopback server child process, health polling, and the unified device listing; model- or GUI-facing Consumers evolve in their own packages.

| Package | Role | ctx key |
|---|---|---|
| [`phone-runtime/`](phone-runtime/README.md) | mobilecli Provider and Service Definition, folded | `ctx.phoneDevices` |
| [`tool-phone/`](tool-phone/README.md) | Deferred model-facing Consumer | registers on `ctx.tools` |

The subsystem reference is [docs/subsystems/phone-runtime.md](../../docs/subsystems/phone-runtime.md).
