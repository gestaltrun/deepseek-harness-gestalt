# Agent Note: fakemobilecli capture frames are recognizable 390×844 pictures

Status: implemented

English | [中文](2026-08-30-phone-visible-h264-fixture.zh.md)

## Problem

The fakemobilecli capture double answered MJPEG with a 1×1 JPEG and H264 with a six-byte SPS prefix. A browser decoder produced a white screen on both signed Host URLs, so the U3 visible-picture acceptance could not tell a live capture from a structurally valid empty stream.

## Decision

`packages/phone/phone-runtime/tests/fixtures/u3-visible-frames.ts` generates both capture payloads in-process: a baseline 390×844 gradient color-bar JPEG, and a Constrained Baseline Annex-B stream of several I_PCM IDR pictures at the same size. fakemobilecli serves that JPEG on the MJPEG path (including the dual-boundary R4 body) and that Annex-B stream on the `avc` path. The generator has no ffmpeg, libx264, or checked-in bitstream. `assertRecognizableH264Picture` reconstructs luma of the first I_PCM IDR and requires sampled pixels to match the fixture gradient, and JPEG assertions require SOF0 `390×844`. `GET /phone/stream/<id>/h264` is pinned through that picture check.

## Alternatives considered

**Check in ffmpeg-encoded JPEG and Annex-B files.** Rejected: the fixture then depends on a host encoder and opaque binaries that CI cannot regenerate without the same toolchain.

**Keep the 1×1 JPEG and six-byte prefix, asserting only SOI/EOI and NAL start codes.** Rejected: those checks pass for a picture a browser cannot see.

**Depend on a JPEG or H264 library.** Rejected: the fake is a Node-spawned process with no package imports, and the picture must stay a local, inspectable bitstream.

## Consequences

Capture suites now fail when the served picture is not 390×844 or the first IDR luma does not match the gradient. I_PCM keeps the bitstream decoder-legal without a residual encoder; the stream is larger than a compressed IDR of the same picture. The R4 dual-boundary fixture in phone-stream still owns the 1×1 JPEG used only as a multipart-shape stand-in.

## Testing

- `pnpm vitest run packages/phone`
- `pnpm exec tsc -b tsconfig.host.json`
