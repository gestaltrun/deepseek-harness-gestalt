# Agent Note: fakemobilecli capture frames are recognizable 390×844 pictures

Status: implemented

[English](2026-08-30-phone-visible-h264-fixture.md) | 中文

## 问题

fakemobilecli 采集替身对 MJPEG 应答 1×1 JPEG，对 H264 应答六字节 SPS 前缀。浏览器解码器在两条已签名 Host URL 上都得到白屏，因此 U3 可见画面验收无法把真实采集与结构合法的空流区分开。

## 决策

`packages/phone/phone-runtime/tests/fixtures/u3-visible-frames.ts` 在进程内生成两种采集载荷：一张基线 390×844 渐变彩条 JPEG，以及同尺寸、含若干 I_PCM IDR 画面的 Constrained Baseline Annex-B 流。fakemobilecli 在 MJPEG 路径（含双边界 R4 体）上提供该 JPEG，在 `avc` 路径上提供该 Annex-B 流。生成器不依赖 ffmpeg、libx264 或已入库码流。`assertRecognizableH264Picture` 重建首个 I_PCM IDR 的 luma，并要求采样像素匹配 fixture 渐变；JPEG 断言要求 SOF0 为 `390×844`。`GET /phone/stream/<id>/h264` 由该画面检查钉住。

## 曾考虑的替代方案

**入库 ffmpeg 编码的 JPEG 与 Annex-B 文件。**否决：fixture 会依赖宿主编码器，以及 CI 在没有同一工具链时无法重生成的不透明二进制。

**保留 1×1 JPEG 与六字节前缀，只断言 SOI/EOI 与 NAL 起始码。**否决：这些检查会放过浏览器看不见的画面。

**依赖 JPEG 或 H264 库。**否决：该替身是无包导入的 Node spawn 进程，画面必须是本地可检视的码流。

## 后果

当所服务画面不是 390×844，或首个 IDR luma 与渐变不匹配时，采集套件失败。I_PCM 使码流对解码器合法，且无需残差编码器；同画面下该流比压缩 IDR 更大。phone-stream 的 R4 双边界 fixture 仍拥有仅作 multipart 形态占位的 1×1 JPEG。

## 测试

- `pnpm vitest run packages/phone`
- `pnpm exec tsc -b tsconfig.host.json`
