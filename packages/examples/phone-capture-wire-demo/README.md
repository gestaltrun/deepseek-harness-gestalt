# @deepseek-ai/dsh-phone-capture-wire-demo

English | [中文](README.zh.md)

Bin-only app that boots an external `cordis.yml` for the keyless Android capture-source Host wire. The leaf config owns host-webserver, phone-runtime, and phone-stream. `pnpm run build` emits `lib/bin.js` from `src/bin.ts`; `DSH_EXAMPLE_MODE=lib` launches that artifact under plain Node.

## Config discovery

Positional `argv[2]` is required. If it is missing, the bin throws and exits; there is no working-directory fallback. [`dsh-app-boot`](../../boot/app-boot/README.md) makes plugin load failures fatal.

## Exit lifecycle

After the scenario plugin writes its projected transcript, the bin disposes the root fiber and exits.

## stdout is the transcript

stdout carries only the scenario JSON line. The bin and boot guards diagnose on stderr.

## Model Experience

None. The composition is keyless and does not load an LLM.

#### KV Cache effect

No request prefix.

## Known Limitations and Deferred Work

- **The bin does not compose phone plugins** — every launch must provide a leaf `cordis.yml` that names host-webserver, phone-runtime, and phone-stream.
- **Lib mode needs the declared build** — `lib/bin.js` is a gitignored artifact; recreate it with `pnpm run build` after a clean checkout.
