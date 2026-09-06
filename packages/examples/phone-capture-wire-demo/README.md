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

### Keyless scripted transcript

#### What the model sees

The shipped [`phone-capture-wire` composition](../../../examples/phone-capture-wire/cordis.yml) invokes no model. Its scenario plugin drives phone operations and writes a JSON transcript to `stdout`; that transcript is test output, not model context. The bin loads the supplied `cordis.yml`, so a different composition owns any model invocation it introduces.

#### Token effect

The shipped scripted composition sends no model request and consumes no model input or output tokens. Its JSON transcript is not evidence of a model run.

#### KV Cache effect

The shipped scripted composition creates no model request prefix and uses no provider KV cache.

## Known Limitations and Deferred Work

- **The bin does not compose phone plugins** — every launch must provide a leaf `cordis.yml` that names host-webserver, phone-runtime, and phone-stream.
- **Lib mode needs the declared build** — `lib/bin.js` is a gitignored artifact; recreate it with `pnpm run build` after a clean checkout.
